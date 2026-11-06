// WebAuthn 可行性試驗。只做兩件事：請作業系統的驗證器（Windows Hello、Touch ID）建一把鑰匙，
// 再用那把鑰匙簽一段亂數並驗簽章。走得通，閒置鎖定就能用這套取代 PIN。
// 鑰匙資料只存在這一頁的 localStorage，跟密碼資料無關。

const STORE_KEY = 'pkWebAuthnTest';

function b64url(bytes) {
  const arr = new Uint8Array(bytes);
  let s = '';
  for (const b of arr) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

// WebAuthn 回的 ECDSA 簽章是 DER 格式（30 len 02 len r 02 len s），WebCrypto 驗章要的是 r、s 各 32 bytes 直接接起來
function derToRaw(der) {
  der = new Uint8Array(der);
  if (der[0] !== 0x30) throw new Error('不是 DER 簽章');
  let offset = 2;
  if (der[1] & 0x80) offset = 2 + (der[1] & 0x7f);
  const readInt = () => {
    if (der[offset] !== 0x02) throw new Error('DER 格式不對');
    const len = der[offset + 1];
    let bytes = der.slice(offset + 2, offset + 2 + len);
    offset += 2 + len;
    // 正數開頭多一個 0x00 的要拿掉，不足 32 bytes 的要在前面補 0
    while (bytes.length > 32 && bytes[0] === 0) bytes = bytes.slice(1);
    const out = new Uint8Array(32);
    out.set(bytes, 32 - bytes.length);
    return out;
  };
  const r = readInt();
  const s = readInt();
  const raw = new Uint8Array(64);
  raw.set(r);
  raw.set(s, 32);
  return raw;
}

if (typeof module !== 'undefined') module.exports = { derToRaw };

if (typeof document !== 'undefined') {
  const $ = (id) => document.getElementById(id);
  const lines = [];

  function log(msg) {
    lines.push('[' + new Date().toLocaleTimeString('zh-TW') + '] ' + msg);
    $('log').textContent = lines.join('\n');
    $('log').scrollTop = $('log').scrollHeight;
  }

  function describeError(err) {
    return (err && err.name ? err.name + ': ' : '') + (err && err.message ? err.message : String(err));
  }

  function random(n) {
    return crypto.getRandomValues(new Uint8Array(n));
  }

  async function check() {
    log('網址：' + location.href);
    log('擴充功能 ID（會拿來當 RP ID）：' + location.hostname);
    log('瀏覽器：' + navigator.userAgent);
    log('作業系統：' + ((navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform));
    if (!window.PublicKeyCredential) {
      log('沒有 PublicKeyCredential，這個瀏覽器不支援 WebAuthn。');
      return;
    }
    log('WebAuthn：有');
    try {
      const uv = await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
      log('內建驗證器（Windows Hello / Touch ID）：' + (uv ? '可用' : '不可用'));
    } catch (err) {
      log('查內建驗證器時出錯：' + describeError(err));
    }
    log(localStorage.getItem(STORE_KEY) ? '這一頁已經存了一把鑰匙，可以直接按 3。' : '還沒建立鑰匙。');
  }

  async function create(platformOnly) {
    if (!window.PublicKeyCredential) {
      log('沒有 WebAuthn，做不了。');
      return;
    }
    // 先用擴充功能 ID 當 RP ID；瀏覽器不接受的話，改成不指定再試一次
    const attempts = [{ rpId: location.hostname }, { rpId: null }];
    for (const a of attempts) {
      const publicKey = {
        rp: a.rpId ? { name: '密碼小管家', id: a.rpId } : { name: '密碼小管家' },
        user: { id: random(16), name: 'pk-user', displayName: '密碼小管家使用者' },
        challenge: random(32),
        pubKeyCredParams: [
          { type: 'public-key', alg: -7 },
          { type: 'public-key', alg: -257 },
        ],
        timeout: 60000,
        attestation: 'none',
        authenticatorSelection: platformOnly
          ? { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'discouraged' }
          : { userVerification: 'required', residentKey: 'discouraged' },
      };
      log(
        '建立鑰匙' +
          (a.rpId ? '（RP ID = ' + a.rpId + '）' : '（不指定 RP ID）') +
          (platformOnly ? '，只用內建驗證器' : '，內建或外接都可以') +
          '。應該會跳驗證視窗…'
      );
      try {
        const cred = await navigator.credentials.create({ publicKey });
        const res = cred.response;
        const alg = res.getPublicKeyAlgorithm ? res.getPublicKeyAlgorithm() : null;
        const spki = res.getPublicKey ? res.getPublicKey() : null;
        const record = {
          id: b64url(cred.rawId),
          alg,
          publicKey: spki ? b64url(spki) : null,
          rpId: a.rpId,
          transports: res.getTransports ? res.getTransports() : [],
          attachment: cred.authenticatorAttachment || null,
        };
        localStorage.setItem(STORE_KEY, JSON.stringify(record));
        log(
          '鑰匙建立成功。演算法：' + alg + '（-7 是 ECDSA P-256，-257 是 RSA）。驗證器：' + (record.attachment || '不明') +
            '。transports：' + (record.transports.join(',') || '無') + '。鑰匙編號開頭：' + record.id.slice(0, 16)
        );
        if (!spki) log('瀏覽器沒給公鑰（getPublicKey 不支援），等一下只能驗到「有回應」，驗不到簽章。');
        return;
      } catch (err) {
        log('建立失敗：' + describeError(err));
        if (!a.rpId || !(err && err.name === 'SecurityError')) return;
        log('RP ID 被拒絕，改成不指定再試一次。');
      }
    }
  }

  async function verify() {
    const saved = localStorage.getItem(STORE_KEY);
    if (!saved) {
      log('還沒建立鑰匙，先按 2。');
      return;
    }
    const record = JSON.parse(saved);
    const challenge = random(32);
    const publicKey = {
      challenge,
      timeout: 60000,
      userVerification: 'required',
      allowCredentials: [{ type: 'public-key', id: fromB64url(record.id), transports: record.transports.length ? record.transports : undefined }],
    };
    if (record.rpId) publicKey.rpId = record.rpId;
    log('驗證。應該會跳驗證視窗…');
    let assertion;
    try {
      assertion = await navigator.credentials.get({ publicKey });
    } catch (err) {
      log('驗證失敗：' + describeError(err));
      return;
    }
    const res = assertion.response;
    const authData = new Uint8Array(res.authenticatorData);
    const flags = authData[32];
    log('驗證器有回應。UP=' + (flags & 1 ? 1 : 0) + '，UV=' + (flags & 4 ? 1 : 0) + '（UV=1 代表真的有驗 PIN 或指紋）');
    const clientData = JSON.parse(new TextDecoder().decode(res.clientDataJSON));
    log('clientData：type=' + clientData.type + '，origin=' + clientData.origin + '，challenge 相符=' + (clientData.challenge === b64url(challenge)));
    if (!record.publicKey) {
      log('沒有公鑰，跳過簽章驗證。');
      return;
    }
    try {
      const spki = fromB64url(record.publicKey);
      const clientHash = new Uint8Array(await crypto.subtle.digest('SHA-256', res.clientDataJSON));
      const data = new Uint8Array(authData.length + clientHash.length);
      data.set(authData);
      data.set(clientHash, authData.length);
      let ok;
      if (record.alg === -7) {
        const key = await crypto.subtle.importKey('spki', spki, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
        ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, derToRaw(res.signature), data);
      } else if (record.alg === -257) {
        const key = await crypto.subtle.importKey('spki', spki, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
        ok = await crypto.subtle.verify({ name: 'RSASSA-PKCS1-v1_5' }, key, res.signature, data);
      } else {
        log('不認得的演算法 ' + record.alg + '，跳過簽章驗證。');
        return;
      }
      log(ok ? '簽章驗證成功。整套解鎖流程走得通。' : '簽章驗證失敗，簽章和公鑰對不上。');
    } catch (err) {
      log('驗簽章時出錯：' + describeError(err));
    }
  }

  $('check').addEventListener('click', check);
  $('create').addEventListener('click', () => create(true));
  $('createAny').addEventListener('click', () => create(false));
  $('get').addEventListener('click', verify);
  $('copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      log('已複製到剪貼簿。');
    } catch (err) {
      log('複製失敗：' + describeError(err));
    }
  });
  $('clear').addEventListener('click', () => {
    localStorage.removeItem(STORE_KEY);
    log('已清掉這頁存的鑰匙。Windows 那邊不用清。');
  });

  check();
}
