// 加解密工具。background.js 用 importScripts 載入，所以這裡的函式都是全域的。
// 錯誤訊息用 i18n.js 的 t()，載入這個檔的地方也要載入 i18n.js。
// 平常存在瀏覽器裡的那份，金鑰是裝好擴充功能時隨機產生、存在 storage.local 裡的，不是主密碼推出來的。
// 這代表拿得到瀏覽器設定檔的人還是解得開，這層加密只擋「直接翻設定檔看到明文」。
// 加密備份檔不一樣：金鑰是從備份密碼推出來的（deriveKey），沒有密碼打不開。

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
