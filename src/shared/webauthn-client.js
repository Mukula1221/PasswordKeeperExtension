// 管理頁、小視窗、解鎖小視窗共用：叫作業系統的驗證器（WebAuthn）建鑰匙、驗證，再把結果交給背景程式核對。
// 不綁特定作業系統：Windows 跳 Windows Hello，Mac 跳 Touch ID，沒有內建驗證器的（Linux）就讓瀏覽器問安全金鑰或手機。
// 頁面要先載 i18n.js，這裡的文字都用 t() 拿。
const pkWebAuthn = (() => {
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
    const p = ((navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '').toLowerCase();
    if (p.includes('win')) return 'Windows Hello';
    if (p.includes('mac')) return 'Touch ID';
    return t('wa_security_key_or_phone');
  }

  function supported() {
    return !!window.PublicKeyCredential;
  }

  // 有沒有內建的驗證器（Windows Hello、Touch ID）。沒有的話建鑰匙時就不限定，讓瀏覽器問安全金鑰或手機。
  async function hasPlatformAuthenticator() {
    try {
      return supported() && (await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable());
    } catch {
      return false;
    }
  }

  // 建鑰匙。背景程式存好公鑰就等於啟用工具鎖定，opts 可以帶 idleMinutes、onStartup。
  async function register(opts) {
    if (!supported()) throw new Error(t('wa_unsupported'));
    const c = await send({ type: 'webauthn.challenge' });
    if (!c.ok) throw new Error(c.error);
    const platform = await hasPlatformAuthenticator();
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
        },
      });
    } catch (err) {
      throw new Error(describe(err));
    }
    const res = cred.response;
    const spki = res.getPublicKey ? res.getPublicKey() : null;
    if (!spki) throw new Error(t('wa_no_public_key'));
    const r = await send({
      type: 'webauthn.register',
      id: b64url(cred.rawId),
      alg: res.getPublicKeyAlgorithm(),
      publicKey: b64url(spki),
      clientDataJSON: b64url(res.clientDataJSON),
      transports: res.getTransports ? res.getTransports() : [],
      idleMinutes: opts && opts.idleMinutes,
      onStartup: opts && opts.onStartup,
    });
    if (!r.ok) throw new Error(r.error);
    return r.data;
  }

  // 跳一次系統驗證，把簽好的結果整理成背景程式要核對的格式。
  // signal 中斷時照原樣丟出 AbortError，呼叫的地方才分得出是自己中斷的，不會顯示成「驗證被取消」。
  async function assertion(signal) {
    if (!supported()) throw new Error(t('wa_unsupported'));
    const st = await send({ type: 'webauthn.status' });
    if (!st.ok) throw new Error(st.error);
    if (!st.data.registered) throw new Error(t('wa_not_set_up'));
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
          allowCredentials: [
            {
              type: 'public-key',
              id: fromB64url(st.data.id),
              transports: st.data.transports && st.data.transports.length ? st.data.transports : undefined,
            },
          ],
        },
        signal,
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
    };
  }

  async function unlock(opts) {
    const r = await send({ type: 'webauthn.unlock', ...(await assertion(opts && opts.signal)) });
    if (!r.ok) throw new Error(r.error);
    return r.data;
  }

  // 停用工具鎖定也要先驗證一次
  async function disable() {
    const r = await send({ type: 'lock.disable', ...(await assertion()) });
    if (!r.ok) throw new Error(r.error);
    return r.data;
  }

  return { label, supported, hasPlatformAuthenticator, register, unlock, disable };
})();
