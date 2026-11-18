// 加解密工具。background.js 用 importScripts 載入，所以這裡的函式都是全域的。
// 錯誤訊息用 i18n.js 的 t()，載入這個檔的地方也要載入 i18n.js。
// 平常存在瀏覽器裡的那份，金鑰是裝好擴充功能時隨機產生、存在 storage.local 裡的，不是主密碼推出來的。
// 這代表拿得到瀏覽器設定檔的人還是解得開，這層加密只擋「直接翻設定檔看到明文」。
// 加密備份檔不一樣：金鑰是從備份密碼推出來的（deriveKey），沒有密碼打不開。
// 自動備份不存備份密碼，改用公鑰加密：擴充功能只留公鑰和用備份密碼加密過的私鑰，見 createBackupKeyPair。

function bytesToB64(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function b64ToBytes(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

// WebAuthn 用的是 base64url（+ 換 -、/ 換 _、不補 =）
function bytesToB64url(bytes) {
  return bytesToB64(new Uint8Array(bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlToBytes(s) {
  s = String(s || '').replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return b64ToBytes(s);
}

function importKey(rawBytes) {
  return crypto.subtle.importKey('raw', rawBytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

// 從密碼推出金鑰。iterations 越高越難暴力破解，但匯出匯入會跟著變慢，60 萬次大約半秒。
async function deriveKey(password, saltBytes, iterations) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: saltBytes, iterations, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

async function encrypt(key, text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(text));
  return { iv: bytesToB64(iv), data: bytesToB64(new Uint8Array(data)) };
}

async function decrypt(key, payload) {
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: b64ToBytes(payload.iv) },
    key,
    b64ToBytes(payload.data)
  );
  return new TextDecoder().decode(plain);
}

// ---- 自動備份的公鑰加密 ----
// 用公鑰加密不需要密碼，背景程式自己就能定時備份；解密要私鑰，私鑰只有備份密碼解得開。
// 做法是 ECDH P-256 + HKDF + AES-GCM：每次加密臨時產生一對金鑰，跟存著的公鑰算出這次專用的 AES 金鑰。

const ECDH_P256 = { name: 'ECDH', namedCurve: 'P-256' };
// 改了這串，舊的自動備份檔就算不出同一把金鑰
const SEAL_INFO = new TextEncoder().encode('pk-backup v2');

async function sealKey(privateKey, publicKey, salt) {
  const bits = await crypto.subtle.deriveBits({ name: 'ECDH', public: publicKey }, privateKey, 256);
  const base = await crypto.subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: SEAL_INFO },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

// 回傳 { publicKey, wrappedKey }，兩樣都可以放心存：wrappedKey 是用備份密碼加密過的私鑰。
async function createBackupKeyPair(password, iterations) {
  const pair = await crypto.subtle.generateKey(ECDH_P256, true, ['deriveBits']);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  const locked = await encrypt(await deriveKey(password, salt, iterations), bytesToB64(pkcs8));
  return {
    publicKey: bytesToB64(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))),
    wrappedKey: {
      kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations, salt: bytesToB64(salt) },
      iv: locked.iv,
      data: locked.data,
    },
  };
}

// 密碼不對時 AES-GCM 會直接丟錯，呼叫的地方自己決定要顯示什麼
async function openWrappedKey(password, wrappedKey) {
  const key = await deriveKey(password, b64ToBytes(wrappedKey.kdf.salt), wrappedKey.kdf.iterations);
  const pkcs8 = b64ToBytes(await decrypt(key, wrappedKey));
  return crypto.subtle.importKey('pkcs8', pkcs8, ECDH_P256, false, ['deriveBits']);
}

async function sealToPublicKey(publicKeyB64, text) {
  const publicKey = await crypto.subtle.importKey('raw', b64ToBytes(publicKeyB64), ECDH_P256, false, []);
  const ephemeral = await crypto.subtle.generateKey(ECDH_P256, true, ['deriveBits']);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const payload = await encrypt(await sealKey(ephemeral.privateKey, publicKey, salt), text);
  return {
    ephemeralPublicKey: bytesToB64(new Uint8Array(await crypto.subtle.exportKey('raw', ephemeral.publicKey))),
    salt: bytesToB64(salt),
    iv: payload.iv,
    data: payload.data,
  };
}

async function openSealed(privateKey, sealed) {
  const ephemeral = await crypto.subtle.importKey('raw', b64ToBytes(sealed.ephemeralPublicKey), ECDH_P256, false, []);
  return decrypt(await sealKey(privateKey, ephemeral, b64ToBytes(sealed.salt)), sealed);
}

// ---- Windows Hello（WebAuthn）的簽章驗證 ----

// WebAuthn 回的 ECDSA 簽章是 DER 格式（30 len 02 len r 02 len s），WebCrypto 驗章要的是 r、s 各 32 bytes 直接接起來
function derToRaw(der) {
  der = new Uint8Array(der);
  if (der[0] !== 0x30) throw new Error(t('bg_der_not_signature'));
  let offset = 2;
  if (der[1] & 0x80) offset = 2 + (der[1] & 0x7f);
  const readInt = () => {
    if (der[offset] !== 0x02) throw new Error(t('bg_der_bad_format'));
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

// 驗證器簽的內容是 authenticatorData 接上 SHA-256(clientDataJSON)。alg -7 是 ECDSA P-256，-257 是 RSA。
async function verifyWebAuthnSignature({ alg, publicKey, authenticatorData, clientDataJSON, signature }) {
  const clientHash = new Uint8Array(await crypto.subtle.digest('SHA-256', clientDataJSON));
  const data = new Uint8Array(authenticatorData.length + clientHash.length);
  data.set(authenticatorData);
  data.set(clientHash, authenticatorData.length);
  if (alg === -7) {
    const key = await crypto.subtle.importKey('spki', publicKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    return crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, derToRaw(signature), data);
  }
  if (alg === -257) {
    const key = await crypto.subtle.importKey('spki', publicKey, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    return crypto.subtle.verify({ name: 'RSASSA-PKCS1-v1_5' }, key, signature, data);
  }
  throw new Error(t('bg_unsupported_sig_alg', alg));
}
