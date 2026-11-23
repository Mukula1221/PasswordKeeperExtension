'use strict';
// 管理頁、小視窗、解鎖小視窗共用：叫作業系統的驗證器（WebAuthn）建鑰匙、驗證，再把結果交給背景程式核對。
// 不綁特定作業系統：Windows 跳 Windows Hello，Mac 跳 Touch ID，沒有內建驗證器的（Linux）就讓瀏覽器問安全金鑰或手機。
// 頁面要先載 i18n.js，這裡的文字都用 t() 拿。
(() => {
  const PK = (globalThis.PK ??= {});
  const { t } = PK.i18n;

  function send(msg) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(msg, (res) => {
        if (chrome.runtime.lastError) return resolve({ ok: false, error: chrome.runtime.lastError.message });
        resolve(res || { ok: false, error: t('wa_no_response') });
      });
    });
  }

  function b64url(bytes) {
    const arr = new Uint8Array(bytes);
    let s = '';
    for (const b of arr) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function fromB64url(s) {
    s = String(s || '').replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  }

  function describe(err) {
    if (err && err.name === 'NotAllowedError') return t('wa_cancelled');
    if (err && err.name === 'SecurityError') return t('wa_blocked');
    return (err && err.message) || String(err);
  }

  // 這台電腦叫什麼：按鈕文字用的
  // Windows Hello、Touch ID 是產品名稱，不翻
  function label() {
    const os = PK.platform.osName();
    if (os === 'windows') return 'Windows Hello';
    if (os === 'mac') return 'Touch ID';
    return t('wa_security_key_or_phone');
  }

  // Firefox 有 PublicKeyCredential，但擴充功能頁面不能用擴充功能 ID 當 RP ID，見 platform.js
  function supported() {
    return !!window.PublicKeyCredential && PK.platform.can('extensionWebAuthn');
  }

  // 有沒有內建的驗證器（Windows Hello、Touch ID）。沒有的話建鑰匙時就不限定，讓瀏覽器問安全金鑰或手機。
  async function hasPlatformAuthenticator() {
    try {
      return supported() && (await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable());
    } catch {
      return false;
    }
  }

  // 跳系統驗證建一把新鑰匙，回傳背景程式要核對、存起來的資料，還沒交給背景程式。
  // prfSalt 有給的話順便要 PRF 秘密值（系統驗證加密用），有些瀏覽器建鑰匙時就會給，放在 prf。
  async function create(opts) {
    if (!supported()) throw new Error(t('wa_unsupported'));
    const c = await send({ type: 'webauthn.challenge' });
    if (!c.ok) throw new Error(c.error);
    const platform = await hasPlatformAuthenticator();
    const prfSalt = opts && opts.prfSalt;
    let cred;
    try {
      cred = await navigator.credentials.create({
        publicKey: {
          rp: { name: t('ext_name'), id: c.data.rpId },
          user: { id: crypto.getRandomValues(new Uint8Array(16)), name: 'password-keeper', displayName: t('ext_name') },
          challenge: fromB64url(c.data.challenge),
          pubKeyCredParams: [
            { type: 'public-key', alg: -7 },
            { type: 'public-key', alg: -257 },
          ],
          timeout: 60000,
          attestation: 'none',
          authenticatorSelection: platform
            ? { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'discouraged' }
            : { userVerification: 'required', residentKey: 'discouraged' },
          // 請瀏覽器優先存在這台裝置：存到 Microsoft 密碼管理員這類同步的地方，有些拿不到 PRF 秘密值
          hints: ['client-device'],
          extensions: prfSalt ? { prf: { eval: { first: fromB64url(prfSalt) } } } : undefined,
        },
      });
    } catch (err) {
      throw new Error(describe(err));
    }
    const res = cred.response;
    const spki = res.getPublicKey ? res.getPublicKey() : null;
    if (!spki) throw new Error(t('wa_no_public_key'));
    return {
      id: b64url(cred.rawId),
      alg: res.getPublicKeyAlgorithm(),
      publicKey: b64url(spki),
      clientDataJSON: b64url(res.clientDataJSON),
      transports: res.getTransports ? res.getTransports() : [],
      prf: prfOf(cred),
    };
  }

  function prfOf(cred) {
    const prf = cred.getClientExtensionResults().prf;
    const first = prf && prf.results && prf.results.first;
    return first ? b64url(first) : null;
  }

  // 系統驗證加密的設定：建一把新鑰匙，再用它驗一次拿 PRF 秘密值。
  // 一定要另外驗一次：建鑰匙時給的秘密值，不保證之後解鎖時拿得到，拿不到就會被鎖在外面。
  // onStep(1)、onStep(2) 在跳第幾次系統驗證之前叫，讓畫面告訴使用者為什麼要驗兩次。
  async function setupHello(opts) {
    const onStep = (opts && opts.onStep) || (() => {});
    const prfSalt = b64url(crypto.getRandomValues(new Uint8Array(32)));
    onStep(1);
    const credential = await create({ prfSalt });
    onStep(2);
    const check = await assertion({ credentialId: credential.id, prfSalt });
    if (!check.prf) throw new Error(t('wa_no_prf', label()));
    if (credential.prf && credential.prf !== check.prf) throw new Error(t('wa_prf_unstable', label()));
    delete credential.prf;
    return { credential, assertion: check, prfSalt };
  }

  // 跳一次系統驗證，把簽好的結果整理成背景程式要核對的格式。
  // 沒指定鑰匙就用背景程式存的那把；系統驗證加密時順便要 PRF 秘密值，放在 prf。
  // signal 中斷時照原樣丟出 AbortError，呼叫的地方才分得出是自己中斷的，不會顯示成「驗證被取消」。
  async function assertion(opts) {
    opts = opts || {};
    if (!supported()) throw new Error(t('wa_unsupported'));
    let { credentialId, prfSalt } = opts;
    if (!credentialId) {
      const st = await send({ type: 'webauthn.status' });
      if (!st.ok) throw new Error(st.error);
      if (!st.data.registered) throw new Error(t('wa_not_set_up'));
      credentialId = st.data.id;
      prfSalt = st.data.prfSalt;
    }
    const c = await send({ type: 'webauthn.challenge' });
    if (!c.ok) throw new Error(c.error);
    let a;
    try {
      a = await navigator.credentials.get({
        publicKey: {
          challenge: fromB64url(c.data.challenge),
          rpId: c.data.rpId,
          timeout: 60000,
          userVerification: 'required',
          // 不帶 transports：只帶 internal 的話，Edge 會先查 Windows 列得出來的鑰匙，
          // 但 residentKey: 'discouraged' 建的鑰匙不在清單裡，Edge 就直接說「此裝置上沒有金鑰」，不交給 Windows Hello。
          allowCredentials: [{ type: 'public-key', id: fromB64url(credentialId) }],
          extensions: prfSalt ? { prf: { eval: { first: fromB64url(prfSalt) } } } : undefined,
        },
        signal: opts.signal,
      });
    } catch (err) {
      if (err && err.name === 'AbortError') throw err;
      throw new Error(describe(err));
    }
    const res = a.response;
    return {
      id: b64url(a.rawId),
      clientDataJSON: b64url(res.clientDataJSON),
      authenticatorData: b64url(res.authenticatorData),
      signature: b64url(res.signature),
      prf: prfOf(a),
    };
  }

  async function unlock(opts) {
    const r = await send({ type: 'webauthn.unlock', ...(await assertion({ signal: opts && opts.signal })) });
    if (!r.ok) throw new Error(r.error);
    return r.data;
  }

  PK.webauthnClient = { label, supported, hasPlatformAuthenticator, create, setupHello, assertion, unlock };
})();
