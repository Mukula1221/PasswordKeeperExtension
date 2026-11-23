'use strict';
// 用 Windows Hello 這類系統驗證解鎖時，核對驗證結果。
(() => {
  const PK = (globalThis.PK ??= {});
  const { t } = PK.i18n;
  const { b64urlToBytes, bytesToB64url, verifyWebAuthnSignature } = PK.crypto;

  // 頁面負責叫 Windows Hello，背景程式負責發亂數、存公鑰、核對回來的簽章。
  // 鑰匙綁在擴充功能的 ID 上（RP ID），資料夾搬家 ID 會變，鑰匙就失效。

  const WEBAUTHN_CHALLENGE_TTL_MS = 2 * 60 * 1000;

  async function issueWebAuthnChallenge() {
    const challenge = bytesToB64url(crypto.getRandomValues(new Uint8Array(32)));
    const { webauthnChallenges } = await chrome.storage.session.get('webauthnChallenges');
    const now = Date.now();
    const map = {};
    for (const [c, at] of Object.entries(webauthnChallenges || {})) if (now - at < WEBAUTHN_CHALLENGE_TTL_MS) map[c] = at;
    map[challenge] = now;
    await chrome.storage.session.set({ webauthnChallenges: map });
    return challenge;
  }

  // 核對頁面交回來的 clientData：類型對、來源是這個擴充功能、亂數是我們發的而且還沒用過。用過就作廢。
  async function consumeWebAuthnChallenge(clientDataJSONb64url, expectedType) {
    let clientData;
    try {
      clientData = JSON.parse(new TextDecoder().decode(b64urlToBytes(clientDataJSONb64url)));
    } catch {
      throw new Error(t('bg_webauthn_data_unreadable'));
    }
    if (clientData.type !== expectedType) throw new Error(t('bg_webauthn_wrong_type'));
    if (clientData.origin !== PK.platform.extensionOrigin()) throw new Error(t('bg_webauthn_wrong_origin'));
    const { webauthnChallenges } = await chrome.storage.session.get('webauthnChallenges');
    const map = webauthnChallenges || {};
    const at = map[clientData.challenge];
    if (!at || Date.now() - at > WEBAUTHN_CHALLENGE_TTL_MS) throw new Error(t('bg_webauthn_expired'));
    delete map[clientData.challenge];
    await chrome.storage.session.set({ webauthnChallenges: map });
    return clientData;
  }

  async function webAuthnStatus() {
    const { webauthn, vaultKeyLock } = await chrome.storage.local.get(['webauthn', 'vaultKeyLock']);
    return {
      registered: !!webauthn,
      id: webauthn ? webauthn.id : null,
      // transports 記的是鑰匙在哪種驗證器上：internal 是內建（Windows Hello、Touch ID），usb、nfc、hybrid 是安全金鑰或手機
      transports: webauthn ? webauthn.transports || [] : [],
      rpId: chrome.runtime.id,
      // 系統驗證加密時，每次驗證都順便要 PRF 秘密值，頁面要拿這個 salt 去要
      prfSalt: vaultKeyLock && vaultKeyLock.hello ? vaultKeyLock.hello.prfSalt : null,
    };
  }

  // 核對頁面剛建好的系統驗證鑰匙，回傳要存進 storage.local 的 webauthn。亂數要是我們發的、來源要是這個擴充功能，不然不收。
  // 這裡不存：換保護方式時要跟加密過的金鑰一起寫，寫一半失敗會讓鑰匙和金鑰對不上。
  async function checkNewCredential({ id, alg, publicKey, clientDataJSON, transports } = {}) {
    if (!id || !publicKey || (alg !== -7 && alg !== -257)) throw new Error(t('bg_key_data_incomplete'));
    await consumeWebAuthnChallenge(clientDataJSON, 'webauthn.create');
    const list = Array.isArray(transports) ? transports.filter((x) => typeof x === 'string').slice(0, 5) : [];
    return { id, alg, publicKey, transports: list, createdAt: Date.now() };
  }

  // 核對頁面交回來的系統驗證結果。四項都要過：鑰匙編號對、亂數和來源對、真的有驗過本人（UV）、簽章對。
  // credential 沒給就用存著的那把；換保護方式時拿剛建、還沒存的那把來核對。
  async function verifyAssertion({ id, clientDataJSON, authenticatorData, signature }, credential) {
    const webauthn = credential || (await chrome.storage.local.get('webauthn')).webauthn;
    if (!webauthn) throw new Error(t('bg_webauthn_not_set_up'));
    if (id !== webauthn.id) throw new Error(t('bg_webauthn_unknown_key'));
    await consumeWebAuthnChallenge(clientDataJSON, 'webauthn.get');
    const authData = b64urlToBytes(authenticatorData);
    if (authData.length < 37 || !(authData[32] & 0x04)) throw new Error(t('bg_webauthn_no_user_verification'));
    const ok = await verifyWebAuthnSignature({
      alg: webauthn.alg,
      publicKey: b64urlToBytes(webauthn.publicKey),
      authenticatorData: authData,
      clientDataJSON: b64urlToBytes(clientDataJSON),
      signature: b64urlToBytes(signature),
    });
    if (!ok) throw new Error(t('bg_webauthn_bad_signature'));
  }

  PK.webauthn = { checkNewCredential, issueWebAuthnChallenge, verifyAssertion, webAuthnStatus };
})();
