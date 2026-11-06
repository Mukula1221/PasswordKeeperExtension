// 背景程式。所有密碼的讀寫都在這裡，popup、管理頁、網頁腳本都用 chrome.runtime.sendMessage 來叫它。
// 訊息格式：{ type: 'entries.forHost', ... }，回覆固定是 { ok: true, data } 或 { ok: false, error }。
importScripts('../shared/i18n.js');
importScripts('crypto.js'); 

// ---- 管理頁指定的介面語言 ----
// 背景程式丟給畫面的錯誤訊息、圖示上的「鎖」、備份檔名都要跟著指定的語言。
// 背景程式隨時會被瀏覽器關掉再叫起來，每次啟動都要重讀；讀好之前收到的訊息先等，見 dispatch。

const localeCache = new Map();

// 只留 message，description 是給翻譯的人看的，傳給網頁的 content.js 時少一點資料
async function localeMessages(locale) {
  if (!localeCache.has(locale)) {
    const res = await fetch(localeUrl(locale));
    const raw = await res.json();
    localeCache.set(locale, Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, { message: v.message }])));
  }
  return localeCache.get(locale);
}

async function loadChosenLocale() {
  const locale = await chosenLocale();
  useLocale(locale, locale ? await localeMessages(locale) : null);
}

// 讀不到翻譯檔就照瀏覽器的語言，印錯誤讓 chrome://extensions 的「錯誤」看得到
const followChosenLocale = () =>
  loadChosenLocale().catch((err) => {
    useLocale(null);
    console.error('[密碼小管家] 讀不到指定語言的翻譯檔', err); // i18n-ignore：給開發者看的
  });

let i18nReady = followChosenLocale();

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.uiLanguage) return;
  i18nReady = followChosenLocale().then(() => refreshActiveBadges());
});

// 自動點選的間隔、登出後暫停，最長可以設多少秒
const CLICK_SEC_MAX = 86400;

const DEFAULT_SETTINGS = {
  autoFill: true,
  neverSave: [],
  // 備份提醒：超過這麼多天沒備份、而且期間有改過密碼，就提醒。0 代表不提醒。
  backupReminderDays: 30,
  lastBackupAt: 0,
  // 產生密碼的選項，popup 改過會存回來
  generator: {
    minLength: 16,
    maxLength: 20,
    upper: true,
    lower: true,
    digits: true,
    symbols: true,
    symbolSet: '!@#$%^&*()-_=+[]{};:,.?',
  },
  // 自動備份：每天或每週的指定時間（weekday 0 是星期日）把加密備份存到「下載」底下的子資料夾。密碼存在 vault.meta 裡，不在這。
  // since 是開啟或改時間的時間點，在那之前的指定時間不補做。lastSignature 是上次備份時帳號清單的指紋，沒變就不存。
  autoBackup: {
    enabled: false,
    every: 'day',
    time: '12:00',
    weekday: 1,
    folder: '密碼小管家備份', // i18n-ignore：使用者沒改過設定時，換語言會讓備份跑到別的資料夾
    since: 0,
    lastRunAt: 0,
    lastResult: '',
    lastError: '',
    lastSignature: '',
  },
  // 每次備份的紀錄：什麼時候、用什麼方式、存到哪、幾筆。最多留 100 筆。
  backupLog: [],
  // 回收桶放幾天就永久刪除
  trashDays: 30,
  // 這些網站自動填完帳密就幫忙按登入
  autoSubmitHosts: [],
  // 這些網站不自動填入。autoFill 是總開關，總開關打開時才看這個清單。點欄位跳清單、快捷鍵照樣能用。
  noAutoFillHosts: [],
  // 自動點選的規則，使用者在網頁上選的按鈕。只記網站、網址、怎麼找到按鈕、什麼時候點，沒有帳密，所以放這裡不放 vault。
  // 每條：{ id, host, path, selector, text, when: 'afterFill' | 'onLoad', intervalSec, onMissing, enabled, createdAt }。同一頁有好幾條時照陣列順序點。
  // intervalSec 沒有就用 clickIntervalSec。onMissing 是 'stop' 時，等不到按鈕就不點後面的；沒有就跳過、換下一條。
  clickRules: [],
  // 點過之後隔幾秒才能再點。沒填秒數的規則和「自動填完按登入」共用。
  clickIntervalSec: 300,
  // 按了登出，這個分頁暫停幾秒不自動點。0 就不暫停。
  logoutPauseSec: 300,
  // 工具鎖定：整個工具的鎖，沒碰電腦 idleMinutes 分鐘或瀏覽器重開就鎖，要通過系統驗證才能用。鑰匙存在 storage.local 的 webauthn。
  lock: { enabled: false, idleMinutes: 10, onStartup: true },
};
// 登入送出後，「要不要儲存」的提示最多等這麼久；超過就當作使用者不想存。
const PENDING_TTL_MS = 2 * 60 * 1000;

// 服務工作者閒置幾十秒就會被瀏覽器關掉，所以金鑰只當暫存，每次重開都從 storage.local 再讀。
let keyPromise = null;
function getKey() {
  if (!keyPromise) {
    keyPromise = (async () => {
      const { keyB64 } = await chrome.storage.local.get('keyB64');
      if (keyB64) return importKey(b64ToBytes(keyB64));
      const raw = crypto.getRandomValues(new Uint8Array(32));
      await chrome.storage.local.set({ keyB64: bytesToB64(raw) });
      return importKey(raw);
    })().catch((err) => {
      keyPromise = null;
      throw err;
    });
  }
  return keyPromise;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const HISTORY_MAX = 5;

// vault 解密後的樣子：{ entries: [帳號...], trash: [刪掉的帳號...], meta: { autoBackupPassword } }
async function loadVault() {
  const { vault } = await chrome.storage.local.get('vault');
  if (!vault) return { entries: [], trash: [], meta: {} };
  let text;
  try {
    text = await decrypt(await getKey(), vault);
  } catch (err) {
    console.error('[密碼小管家] 解密失敗', err); // i18n-ignore：給開發者看的
    throw new Error(t('bg_vault_unreadable'));
  }
  const parsed = JSON.parse(text);
  // 1.1 以前整個 vault 就是一個帳號陣列，讀到舊格式就轉成新的
  if (Array.isArray(parsed)) return { entries: parsed, trash: [], meta: {} };
  return { entries: parsed.entries || [], trash: parsed.trash || [], meta: parsed.meta || {} };
}

async function storeVault(vault) {
  const payload = await encrypt(await getKey(), JSON.stringify(vault));
  await chrome.storage.local.set({ vault: payload });
}

async function loadEntries() {
  return (await loadVault()).entries;
}

// 兩個分頁同時存密碼時，後寫的會把先寫的蓋掉，所以寫入全部排隊一次一個。
let writeQueue = Promise.resolve();
function modifyVault(mutator) {
  const run = writeQueue.then(async () => {
    const vault = await loadVault();
    // 順便把回收桶裡放超過保留天數的清掉
    const cutoff = Date.now() - (await getSettings()).trashDays * DAY_MS;
    vault.trash = vault.trash.filter((t) => (t.deletedAt || 0) > cutoff);
    const result = await mutator(vault);
    await storeVault(vault);
    return result;
  });
  writeQueue = run.catch(() => {
    // 失敗的那次已經往外拋給呼叫者了，這裡只是不要讓佇列卡住。
  });
  return run;
}

function modifyEntries(mutator) {
  return modifyVault((vault) => mutator(vault.entries));
}

// 密碼換了就把舊的留在歷史裡，最多 5 筆。網站那邊其實沒改成功的時候，才救得回舊密碼。
function applyPassword(target, newPassword, now) {
  if (target.password === newPassword) return false;
  target.history = [{ password: target.password, changedAt: now }, ...(target.history || [])].slice(0, HISTORY_MAX);
  target.password = newPassword;
  target.passwordChangedAt = now;
  return true;
}

function newEntry(data, now, extra) {
  return {
    id: crypto.randomUUID(),
    note: '',
    history: [],
    ...data,
    createdAt: now,
    updatedAt: now,
    lastUsedAt: now,
    passwordChangedAt: now,
    ...(extra || {}),
  };
}

// ---- 網域比對 ----

// baseDomain 只用在兩段式登入的合併判斷（第一頁和第二頁可能是不同子網域）。
// 帳號和網站的比對不用它，一律要完整網域相同。
// 台灣常見的二級網域，像 xxx.com.tw 要把最後三段當成同一個主網域。
const SECOND_LEVEL = new Set(['com', 'net', 'org', 'gov', 'edu', 'co', 'ac', 'ne', 'or', 'idv', 'game', 'ebiz', 'club', 'mil', 'biz', 'info']);

function baseDomain(host) {
  host = (host || '').toLowerCase();
  // IP、IPv6、localhost 這類沒有子網域概念，只做完全相同的比對。
  if (/^[\d.]+$/.test(host) || host.includes(':') || !host.includes('.')) return host;
  const labels = host.split('.');
  if (labels.length <= 2) return host;
  const [second, last] = labels.slice(-2);
  const take = last.length === 2 && SECOND_LEVEL.has(second) ? 3 : 2;
  return labels.slice(-take).join('.');
}

function hostFromUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.hostname.toLowerCase() : '';
  } catch {
    return '';
  }
}

function originFromUrl(url) {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

// 找出目前網站的帳號，最近用過的排前面。
// 只認完整網域相同：jira.example.com 和 gitlab.example.com 是不同系統，帳號不能混用，
// 所以不做「同一個主網域也算」的比對。www.example.com 和 example.com 也因此算兩個網站。
function rankEntries(entries, host) {
  host = (host || '').toLowerCase();
  if (!host) return [];
  return entries
    .filter((e) => (e.host || '').toLowerCase() === host)
    .sort((a, b) => {
      const byUse = (b.lastUsedAt || 0) - (a.lastUsedAt || 0);
      if (byUse !== 0) return byUse;
      return String(a.username).localeCompare(String(b.username));
    });
}

function findExisting(entries, host, username) {
  host = (host || '').toLowerCase();
  username = username || '';
  return entries.find((e) => e.host === host && e.username === username) || null;
}

function normalizeInput(raw) {
  const data = {};
  let host = String(raw.host || '').trim().toLowerCase();
  let origin = String(raw.origin || '').trim();
  const url = String(raw.url || '').trim();
  if (url) {
    // 管理頁和 CSV 匯入給的是網址，不是 host。沒寫 http 開頭的也接受。
    // 寫了別的開頭的不收：Chrome 匯出的手機 App 密碼是 android:// 開頭，補上 https:// 會變成叫 android 的網站
    if (/^[a-z][a-z\d+.-]*:\/\//i.test(url) && !/^https?:\/\//i.test(url)) throw new Error(t('bg_url_scheme_unsupported'));
    const withScheme = /^https?:\/\//i.test(url) ? url : 'https://' + url;
    host = host || hostFromUrl(withScheme);
    origin = origin || originFromUrl(withScheme);
  }
  if (!host) throw new Error(t('bg_site_required'));
  data.host = host;
  data.origin = origin || 'https://' + host;
  data.username = String(raw.username || '').trim();
  data.password = String(raw.password || '');
  if (raw.note != null) data.note = String(raw.note);
  return data;
}

function upsert(entries, raw, id) {
  const data = normalizeInput(raw);
  const now = Date.now();
  const { password, ...rest } = data;
  let target = id ? entries.find((e) => e.id === id) : null;
  if (target) {
    const clash = entries.find((e) => e.id !== id && e.host === data.host && e.username === data.username);
    if (clash) throw new Error(t('bg_duplicate_account'));
    Object.assign(target, rest, { updatedAt: now });
    applyPassword(target, password, now);
    return { entry: target, action: 'updated' };
  }
  target = entries.find((e) => e.host === data.host && e.username === data.username);
  if (target) {
    Object.assign(target, rest, { updatedAt: now, lastUsedAt: now });
    applyPassword(target, password, now);
    return { entry: target, action: 'updated' };
  }
  const entry = newEntry(data, now);
  entries.push(entry);
  return { entry, action: 'added' };
}

// ---- 設定 ----

async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  const stored = settings || {};
  // generator 是一層物件，淺層合併會把後來新增的預設欄位蓋掉，所以單獨再合併一次
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    generator: { ...DEFAULT_SETTINGS.generator, ...(stored.generator || {}) },
    autoBackup: { ...DEFAULT_SETTINGS.autoBackup, ...(stored.autoBackup || {}) },
    lock: { ...DEFAULT_SETTINGS.lock, ...(stored.lock || {}) },
    // 天數壞掉時當預設值。不擋的話回收桶的清除時間會算成 NaN，整個回收桶都被清掉。
    trashDays: Math.min(Math.max(parseInt(stored.trashDays, 10) || DEFAULT_SETTINGS.trashDays, 1), 365),
    // 秒數壞掉時也當預設值。不擋的話防連點會算成 NaN，等於沒有防連點。
    clickIntervalSec: clickSeconds(stored.clickIntervalSec, 1) || DEFAULT_SETTINGS.clickIntervalSec,
    logoutPauseSec: clickSeconds(stored.logoutPauseSec, 0) === null ? DEFAULT_SETTINGS.logoutPauseSec : stored.logoutPauseSec,
  };
}

// ---- 工具鎖定 ----
// 鎖住時背景程式不給任何帳號資料，網頁不自動填、小視窗和管理頁要先通過系統驗證（Windows Hello 之類）。沒有備用 PIN。
// 鎖定狀態放 storage.session：服務工作者重開還在，瀏覽器關掉就清掉。

async function isLocked() {
  const settings = await getSettings();
  if (!settings.lock.enabled) return false;
  const { locked } = await chrome.storage.session.get('locked');
  return !!locked;
}

async function setLocked(locked) {
  await chrome.storage.session.set({ locked: !!locked });
  refreshActiveBadges();
  // 管理頁開著的時候鎖定一觸發要立刻回到驗證畫面，所以也通知擴充功能自己的頁面
  chrome.runtime.sendMessage({ type: 'lockChanged', locked: !!locked }).catch(() => {
    // 沒有頁面開著就會失敗，不用理
  });
  if (!locked) {
    // 開著的分頁要重新自動填，所以廣播一聲
    const tabs = await chrome.tabs.query({});
    for (const t of tabs) {
      if (t.id == null) continue;
      chrome.tabs.sendMessage(t.id, { type: 'unlocked' }).catch(() => {
        // 沒有 content.js 的分頁（瀏覽器自己的頁面）會失敗，不用理
      });
    }
  }
}

async function lockStatus() {
  const settings = await getSettings();
  const { webauthn } = await chrome.storage.local.get('webauthn');
  return { ...settings.lock, locked: await isLocked(), webauthn: !!webauthn };
}

// ---- 用 Windows Hello 解鎖（WebAuthn）----
// 頁面負責叫 Windows Hello，背景程式負責發亂數、存公鑰、核對回來的簽章。
// 鑰匙綁在擴充功能的 ID 上（RP ID），資料夾搬家 ID 會變，鑰匙就失效。

const WEBAUTHN_CHALLENGE_TTL_MS = 2 * 60 * 1000;

function extensionOrigin() {
  return 'chrome-extension://' + chrome.runtime.id;
}

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
  if (clientData.origin !== extensionOrigin()) throw new Error(t('bg_webauthn_wrong_origin'));
  const { webauthnChallenges } = await chrome.storage.session.get('webauthnChallenges');
  const map = webauthnChallenges || {};
  const at = map[clientData.challenge];
  if (!at || Date.now() - at > WEBAUTHN_CHALLENGE_TTL_MS) throw new Error(t('bg_webauthn_expired'));
  delete map[clientData.challenge];
  await chrome.storage.session.set({ webauthnChallenges: map });
  return clientData;
}

async function webAuthnStatus() {
  const { webauthn } = await chrome.storage.local.get('webauthn');
  return {
    registered: !!webauthn,
    id: webauthn ? webauthn.id : null,
    // transports 記的是鑰匙在哪種驗證器上：internal 是內建（Windows Hello、Touch ID），usb、nfc、hybrid 是安全金鑰或手機
    transports: webauthn ? webauthn.transports || [] : [],
    rpId: chrome.runtime.id,
  };
}

// 核對頁面交回來的系統驗證結果。四項都要過：鑰匙編號對、亂數和來源對、真的有驗過本人（UV）、簽章對。
async function verifyAssertion({ id, clientDataJSON, authenticatorData, signature }) {
  const { webauthn } = await chrome.storage.local.get('webauthn');
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

async function applyIdleInterval() {
  const settings = await getSettings();
  // chrome.idle 最少 15 秒
  const seconds = Math.max(15, Math.round((settings.lock.idleMinutes || 10) * 60));
  chrome.idle.setDetectionInterval(seconds);
}

chrome.idle.onStateChanged.addListener(async (state) => {
  if (state === 'active') return;
  const settings = await getSettings();
  if (settings.lock.enabled) await setLocked(true);
});

chrome.runtime.onStartup.addListener(async () => {
  const settings = await getSettings();
  if (settings.lock.enabled && settings.lock.onStartup) await chrome.storage.session.set({ locked: true });
  applyIdleInterval();
});
applyIdleInterval();


// 1.5 以前的鎖定是用 PIN。舊的 PIN 紀錄清掉；只有 PIN、沒有系統驗證鑰匙的鎖定直接關掉，不然會被鎖在外面。
async function migrateLock() {
  const { pin, webauthn } = await chrome.storage.local.get(['pin', 'webauthn']);
  if (pin) await chrome.storage.local.remove('pin');
  const settings = await getSettings();
  if (settings.lock.enabled && !webauthn) {
    await setSettings({ lock: { ...settings.lock, enabled: false } });
    await chrome.storage.session.set({ locked: false });
  }
}
migrateLock().catch((err) => console.warn('[密碼小管家] 鎖定設定升級失敗', err)); // i18n-ignore：給開發者看的

// 鎖住時不能叫的訊息。沒列在這裡的（像 entries.forHost、pending.*）自己會判斷鎖定狀態。
const LOCK_REQUIRED = new Set([
  'entries.all',
  'entries.save',
  'entries.delete',
  'entries.deleteAll',
  'entries.touch',
  'entries.import',
  'trash.list',
  'trash.restore',
  'trash.purge',
  'trash.purgeAll',
  'trash.restoreMany',
  'trash.purgeMany',
  'trash.setDays',
  'backup.export',
  'backup.import',
  'backup.download',
  'backupLog.fileStatus',
  'backupLog.delete',
  'autoBackup.set',
  'autoBackup.runNow',
  'settings.set',
  'neverSave.add',
  'neverSave.remove',
  'autoSubmit.set',
  'autoFill.setSite',
  'autoFill.setSites',
  'clickRules.save',
  'clickRules.add',
  'clickRules.update',
  'clickRules.delete',
  'clickRules.reorder',
  'clickRules.timing',
  'lock.settings',
  'webauthn.register',
  // lock.disable 和 webauthn.unlock 自己會核對系統驗證結果，鎖住時也要能叫
]);

async function setSettings(patch) {
  const current = await getSettings();
  const next = { ...current, ...patch };
  if (patch.generator) next.generator = normalizeGeneratorOptions({ ...current.generator, ...patch.generator });
  await chrome.storage.local.set({ settings: next });
  return next;
}

// ---- 產生密碼 ----

const CHAR_SETS = {
  lower: 'abcdefghijklmnopqrstuvwxyz',
  upper: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  digits: '0123456789',
};

// 0 到 maxExclusive-1 的亂數。抽到超過範圍就重抽，避免直接取餘數讓某些數字機率偏高。
function randomInt(maxExclusive) {
  const limit = Math.floor(0x100000000 / maxExclusive) * maxExclusive;
  const buf = new Uint32Array(1);
  let x;
  do {
    crypto.getRandomValues(buf);
    x = buf[0];
  } while (x >= limit);
  return x % maxExclusive;
}

function normalizeGeneratorOptions(raw) {
  const o = { ...DEFAULT_SETTINGS.generator, ...(raw || {}) };
  const clamp = (v, fallback) => {
    const n = parseInt(v, 10);
    return Math.min(Math.max(Number.isFinite(n) ? n : fallback, 4), 128);
  };
  o.minLength = clamp(o.minLength, 16);
  o.maxLength = Math.max(clamp(o.maxLength, 20), o.minLength);
  for (const k of ['upper', 'lower', 'digits', 'symbols']) o[k] = !!o[k];
  o.symbolSet = Array.from(new Set(String(o.symbolSet || '').replace(/\s/g, ''))).join('');
  return o;
}

// 長度在 minLength 到 maxLength 之間隨機；每一種勾選的字元至少出現一次。
function generatePassword(options) {
  const o = normalizeGeneratorOptions(options);
  const pools = [];
  if (o.lower) pools.push(CHAR_SETS.lower);
  if (o.upper) pools.push(CHAR_SETS.upper);
  if (o.digits) pools.push(CHAR_SETS.digits);
  if (o.symbols) {
    if (!o.symbolSet) throw new Error(t('bg_gen_symbols_empty'));
    pools.push(o.symbolSet);
  }
  if (!pools.length) throw new Error(t('bg_gen_no_charset'));
  const length = o.minLength + randomInt(o.maxLength - o.minLength + 1);
  if (length < pools.length) throw new Error(t('bg_gen_too_short'));
  const all = pools.join('');
  const chars = pools.map((pool) => pool[randomInt(pool.length)]);
  while (chars.length < length) chars.push(all[randomInt(all.length)]);
  // 洗牌，不然開頭永遠是「每類一個」的固定順序
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return { password: chars.join(''), options: o };
}

// ---- 加密備份檔 ----
// 檔案是 JSON：{ format, version, kdf: { salt, iterations }, iv, data }。
// 金鑰從備份密碼推出來，沒有密碼打不開，跟平常存在瀏覽器裡那份的保護等級不一樣。

const BACKUP_FORMAT = 'pk-backup';
const BACKUP_ITERATIONS = 600000;

// ids 有給就是「挑幾筆匯出給同事」：只放勾選的那幾筆，設定不帶
async function exportBackup(password, ids) {
  if (String(password || '').length < 8) throw new Error(t('bg_backup_password_too_short'));
  let entries = await loadEntries();
  const settings = await getSettings();
  const partial = Array.isArray(ids);
  if (partial) {
    const wanted = new Set(ids);
    entries = entries.filter((e) => wanted.has(e.id));
    if (!entries.length) throw new Error(t('bg_none_selected'));
  }
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await deriveKey(password, salt, BACKUP_ITERATIONS);
  const body = {
    entries,
    neverSave: partial ? [] : settings.neverSave,
    generator: partial ? undefined : settings.generator,
    clickRules: partial ? undefined : settings.clickRules,
    exportedAt: Date.now(),
  };
  const payload = await encrypt(key, JSON.stringify(body));
  const file = {
    format: BACKUP_FORMAT,
    version: 1,
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: BACKUP_ITERATIONS, salt: bytesToB64(salt) },
    iv: payload.iv,
    data: payload.data,
  };
  return { content: JSON.stringify(file, null, 2), count: entries.length };
}

async function importBackup(password, content) {
  let file;
  try {
    file = JSON.parse(String(content || ''));
  } catch {
    throw new Error(t('bg_not_backup_file'));
  }
  if (!file || file.format !== BACKUP_FORMAT || !file.kdf || !file.kdf.salt || !file.iv || !file.data) {
    throw new Error(t('bg_not_backup_file'));
  }
  const key = await deriveKey(String(password || ''), b64ToBytes(file.kdf.salt), file.kdf.iterations || BACKUP_ITERATIONS);
  let body;
  try {
    body = JSON.parse(await decrypt(key, { iv: file.iv, data: file.data }));
  } catch {
    // AES-GCM 密碼不對會直接解不開，分不出是密碼錯還是檔案壞
    throw new Error(t('bg_wrong_password_or_damaged'));
  }
  const stats = await importEntries(Array.isArray(body.entries) ? body.entries : []);
  if (Array.isArray(body.neverSave) && body.neverSave.length) {
    const settings = await getSettings();
    await setSettings({ neverSave: Array.from(new Set([...settings.neverSave, ...body.neverSave])) });
  }
  stats.clickRules = await importClickRules(Array.isArray(body.clickRules) ? body.clickRules : []);
  refreshActiveBadges();
  return stats;
}

// 還沒備份過的話，從第一筆密碼建立的時間開始算天數，這樣剛開始用的前幾十天不會一直被提醒。
async function backupStatus() {
  const settings = await getSettings();
  const vault = await loadVault();
  const entries = vault.entries;
  const latestChange = entries.reduce((m, e) => Math.max(m, e.updatedAt || 0, e.createdAt || 0), 0);
  const firstCreated = entries.reduce((m, e) => Math.min(m, e.createdAt || Date.now()), Date.now());
  const baseline = settings.lastBackupAt || firstCreated;
  const days = Math.floor((Date.now() - baseline) / DAY_MS);
  const due =
    entries.length > 0 &&
    settings.backupReminderDays > 0 &&
    days >= settings.backupReminderDays &&
    (!settings.lastBackupAt || latestChange > settings.lastBackupAt);
  return {
    lastBackupAt: settings.lastBackupAt,
    days,
    due,
    reminderDays: settings.backupReminderDays,
    count: entries.length,
    autoBackup: autoBackupView(settings.autoBackup, vault),
    log: await getBackupLog(),
  };
}

// ---- 下載檔案、備份紀錄、自動備份 ----

const LOG_MAX = 100;

async function appendBackupLog(item) {
  const settings = await getSettings();
  const log = [{ id: crypto.randomUUID(), at: Date.now(), ...item }, ...settings.backupLog].slice(0, LOG_MAX);
  await setSettings({ backupLog: log });
}

// 1.6 以前的紀錄沒有 id，第一次讀到時補上，刪除時才分得出是哪一筆
async function getBackupLog() {
  const { backupLog } = await getSettings();
  if (backupLog.every((item) => item.id)) return backupLog;
  const log = backupLog.map((item) => (item.id ? item : { ...item, id: crypto.randomUUID() }));
  await setSettings({ backupLog: log });
  return log;
}

// 找出備份紀錄對應的下載項目。只認這個擴充功能自己下載、而且還留在瀏覽器下載清單裡的。
// 1.7 以後的紀錄存了下載編號，之前的只能用完整路徑找。
async function findBackupDownload(item) {
  if (!item.path) return null;
  const found = await chrome.downloads.search(item.downloadId ? { id: item.downloadId } : { filename: item.path });
  return found.find((d) => d.filename === item.path && d.byExtensionId === chrome.runtime.id) || null;
}

// 刪不到的原因，管理頁顯示在檔案位置下面。用到時才取文字，換語言之後才會跟著換。
function fileReason(status) {
  if (status === 'untracked') return t('bg_file_untracked');
  if (status === 'missing') return t('bg_file_missing');
  return '';
}

// deletable：可以一起刪。untracked、missing 見 fileReason。none：這筆紀錄本來就沒有檔案（改位置）。
// 瀏覽器記的「檔案還在」可能是舊的，所以 deletable 的實際刪除還是可能失敗。
async function backupFileStatus(item) {
  if (item.kind === 'location' || !item.path) return 'none';
  const d = await findBackupDownload(item);
  if (!d) return 'untracked';
  return d.exists && d.state === 'complete' ? 'deletable' : 'missing';
}

// 刪紀錄。deleteFiles 是 true 就試著連檔案一起刪，刪不掉的放 failed；false 的話檔案位置放 kept，讓管理頁提醒使用者自己去刪。
async function deleteBackupLog(ids, deleteFiles) {
  const wanted = new Set(ids || []);
  const targets = (await getBackupLog()).filter((item) => wanted.has(item.id));
  const result = { deleted: targets.length, removed: [], failed: [], kept: [] };
  for (const item of targets) {
    if (item.kind === 'location' || !item.path) continue;
    if (!deleteFiles) {
      result.kept.push(item.path);
      continue;
    }
    const d = await findBackupDownload(item);
    if (!d || !d.exists) {
      result.failed.push({ path: item.path, reason: fileReason(d ? 'missing' : 'untracked') });
      continue;
    }
    try {
      await chrome.downloads.removeFile(d.id);
      result.removed.push(item.path);
    } catch (err) {
      result.failed.push({ path: item.path, reason: t('bg_file_delete_failed', err.message) });
    }
  }
  // 刪檔的這段時間自動備份可能又記了一筆，寫回前重新讀一次
  const { backupLog } = await getSettings();
  await setSettings({ backupLog: backupLog.filter((item) => !wanted.has(item.id)) });
  return result;
}

function backupStamp(withTime) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  let s = d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate());
  if (withTime) s += '-' + p(d.getHours()) + p(d.getMinutes());
  return s;
}

// 自動備份只能放在「下載」底下的一層子資料夾，把 Windows 不准用的字元換掉
function safeFolder(name) {
  const cleaned = String(name || '')
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/^[\s.]+|[\s.]+$/g, '')
    .slice(0, 60);
  return cleaned || DEFAULT_SETTINGS.autoBackup.folder;
}

// 等下載結束，回傳檔案在電腦上的完整路徑，備份紀錄記的就是這個
function waitForDownload(id) {
  return new Promise((resolve, reject) => {
    const check = async () => {
      const [item] = await chrome.downloads.search({ id });
      if (!item) return reject(new Error(t('bg_download_not_found')));
      if (item.state === 'complete') return resolve(item.filename);
      if (item.state === 'interrupted') {
        return reject(new Error(item.error ? t('bg_download_interrupted_reason', item.error) : t('bg_download_interrupted')));
      }
      setTimeout(() => check().catch(reject), 300);
    };
    check().catch(reject);
  });
}

// service worker 沒有 URL.createObjectURL，檔案內容用 data URL 交給下載。
// 下載編號也回傳，備份紀錄存起來，之後刪紀錄時才找得到檔案。
async function saveFile({ content, filename, mime, saveAs }) {
  const url = 'data:' + mime + ';base64,' + bytesToB64(new TextEncoder().encode(content));
  let id;
  try {
    id = await chrome.downloads.download({ url, filename, saveAs: !!saveAs, conflictAction: 'uniquify' });
  } catch (err) {
    throw new Error(/cancel/i.test(err.message) ? t('common_cancelled') : t('bg_download_failed', err.message));
  }
  return { id, path: await waitForDownload(id) };
}

// 手動匯出（加密備份、CSV、挑選匯出）都走這裡：跳另存新檔讓使用者選位置，存完記一筆紀錄
async function downloadBackup({ content, filename, mime, kind, count }) {
  const { id, path } = await saveFile({ content, filename, mime, saveAs: true });
  await appendBackupLog({ kind, path, count, downloadId: id });
  // 挑幾筆給同事的不算完整備份
  if (kind !== 'selected') await setSettings({ lastBackupAt: Date.now() });
  return { path };
}

// ---- 自動備份的時間 ----

const AUTO_BACKUP_ALARM = 'auto-backup';

function parseTime(text) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(text || ''));
  return m ? [Math.min(+m[1], 23), Math.min(+m[2], 59)] : [12, 0];
}

// 最近一個已經過去的指定時間：每天是今天或昨天的那個時刻，每週是最近一個指定星期幾的那個時刻。
// 用 setDate 加減天數而不是加減毫秒，日光節約時間切換那天才不會差一小時。
function lastSlot(ab, now) {
  const [h, m] = parseTime(ab.time);
  const d = new Date(now);
  d.setHours(h, m, 0, 0);
  const week = ab.every === 'week';
  if (week) d.setDate(d.getDate() - ((d.getDay() - ab.weekday + 7) % 7));
  if (d.getTime() > now) d.setDate(d.getDate() - (week ? 7 : 1));
  return d.getTime();
}

function nextSlot(ab, now) {
  const d = new Date(lastSlot(ab, now));
  d.setDate(d.getDate() + (ab.every === 'week' ? 7 : 1));
  return d.getTime();
}

// 背景程式每次被叫醒都會從頭跑這支檔案。計時器已經排在對的時間就不要重建：
// 重建會讓倒數重來，1.6 以前就是這樣，瀏覽器開著不關的話自動備份幾乎不會跑。
async function scheduleAutoBackup() {
  const ab = (await getSettings()).autoBackup;
  if (!ab.enabled) {
    await chrome.alarms.clear(AUTO_BACKUP_ALARM);
    return;
  }
  const when = nextSlot(ab, Date.now());
  const alarm = await chrome.alarms.get(AUTO_BACKUP_ALARM);
  if (!alarm || Math.abs(alarm.scheduledTime - when) > 1000) await chrome.alarms.create(AUTO_BACKUP_ALARM, { when });
}

// 帳號清單的指紋：有哪幾筆、各自的修改時間。新增、修改、刪除、復原、匯入都會讓指紋變。
// 只看修改時間的話，刪除和復原不會變，匯入的帳號又帶著檔案裡的舊時間，自動備份會以為沒改過。
// 自動點選的規則也算進去，備份檔才會帶到新規則。沒有規則時指紋跟以前一樣，升級後不會多存一份。
async function entriesSignature(entries, clickRules) {
  let text = entries.map((e) => e.id + ':' + (e.updatedAt || 0)).sort().join('|');
  if (clickRules.length) text += '|' + JSON.stringify(clickRules);
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return bytesToB64(new Uint8Array(hash));
}

// 給管理頁看的狀態：密碼本身不給，只說有沒有設。有啟用就算好下次備份的時間。
function autoBackupView(ab, vault) {
  return { ...ab, hasPassword: !!vault.meta.autoBackupPassword, nextAt: ab.enabled ? nextSlot(ab, Date.now()) : 0 };
}

async function autoBackupInfo() {
  const settings = await getSettings();
  return autoBackupView(settings.autoBackup, await loadVault());
}

// 備份跑的這幾秒內使用者可能改了設定，寫回前重新讀一次，只蓋這次要改的欄位
async function patchAutoBackup(patch) {
  const current = (await getSettings()).autoBackup;
  await setSettings({ autoBackup: { ...current, ...patch } });
}

async function setAutoBackup({ enabled, every, time, weekday, folder, password }) {
  const current = (await getSettings()).autoBackup;
  const patch = {};
  if (every != null) patch.every = every === 'week' ? 'week' : 'day';
  if (time != null) {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(time))) throw new Error(t('bg_time_format'));
    patch.time = String(time);
  }
  if (weekday != null) {
    const n = parseInt(weekday, 10);
    if (!(n >= 0 && n <= 6)) throw new Error(t('bg_weekday_invalid'));
    patch.weekday = n;
  }
  if (folder != null) {
    patch.folder = safeFolder(folder);
    if (patch.folder !== current.folder) {
      await appendBackupLog({
        kind: 'location',
        path: patch.folder,
        count: 0,
        note: t('bg_backup_location_changed', current.folder, patch.folder),
      });
    }
  }
  if (password != null) {
    if (String(password).length < 8) throw new Error(t('bg_backup_password_too_short'));
    await modifyVault((vault) => {
      vault.meta.autoBackupPassword = String(password);
    });
  }
  if (enabled != null) {
    if (enabled && !(await loadVault()).meta.autoBackupPassword) throw new Error(t('bg_enable_needs_password'));
    patch.enabled = !!enabled;
    patch.lastError = '';
  }
  // 剛打開開關或改了時間，之前已經過去的指定時間不補做，等下一個
  const next = { ...current, ...patch };
  const rescheduled = next.every !== current.every || next.time !== current.time || next.weekday !== current.weekday;
  if (rescheduled || (next.enabled && !current.enabled)) patch.since = Date.now();
  await patchAutoBackup(patch);
  await scheduleAutoBackup();
  return autoBackupInfo();
}

// 計時器、背景程式醒來時的檢查、「立即備份」可能同時叫到，排隊一次一個，不然會存出兩份
let autoBackupQueue = Promise.resolve();
function runAutoBackup(force) {
  const run = autoBackupQueue.then(() => autoBackupOnce(force));
  autoBackupQueue = run.catch(() => {
    // 失敗的那次已經往外拋給呼叫者了，這裡只是不要讓佇列卡住。
  });
  return run;
}

// 過了指定時間、而且上次備份之後帳號有變，才真的寫檔。
// force=true 是「立即備份」：不看時間也不看有沒有變，紀錄記成 now，算手動。
async function autoBackupOnce(force) {
  // 排程叫起背景程式時可能還沒讀好語言，檔名和錯誤訊息要用指定的語言
  await i18nReady;
  const settings = await getSettings();
  const ab = settings.autoBackup;
  const now = Date.now();
  if (!force && (!ab.enabled || lastSlot(ab, now) <= Math.max(ab.lastRunAt || 0, ab.since || 0))) {
    return { ran: false, reason: 'not-due' };
  }
  const vault = await loadVault();
  const password = vault.meta.autoBackupPassword;
  if (!password) {
    await patchAutoBackup({ lastRunAt: now, lastResult: 'failed', lastError: t('bg_auto_backup_no_password') });
    throw new Error(t('bg_auto_backup_no_password'));
  }
  if (!vault.entries.length) {
    await patchAutoBackup({ lastRunAt: now, lastResult: 'empty', lastError: '' });
    return { ran: false, reason: 'empty' };
  }
  const signature = await entriesSignature(vault.entries, settings.clickRules);
  if (!force && signature === ab.lastSignature) {
    await patchAutoBackup({ lastRunAt: now, lastResult: 'unchanged', lastError: '' });
    return { ran: false, reason: 'no-change' };
  }
  try {
    const { content, count } = await exportBackup(password, null);
    const stamp = backupStamp(true);
    const name = force ? t('bg_backup_file_now', stamp) : t('bg_backup_file_auto', stamp);
    const filename = safeFolder(ab.folder) + '/' + name + '.pkbak';
    const { id, path } = await saveFile({ content, filename, mime: 'application/json', saveAs: false });
    await appendBackupLog({ kind: force ? 'now' : 'auto', path, count, downloadId: id });
    await patchAutoBackup({ lastRunAt: Date.now(), lastResult: 'saved', lastError: '', lastSignature: signature });
    await setSettings({ lastBackupAt: Date.now() });
    return { ran: true, path, count };
  } catch (err) {
    await patchAutoBackup({ lastRunAt: Date.now(), lastResult: 'failed', lastError: err.message });
    throw err;
  }
}

// 背景程式每次醒來都檢查一次：錯過的時間（關機、瀏覽器沒開、計時器被清掉）在這裡補做，做完把計時器排到下一次
function autoBackupTick() {
  runAutoBackup(false)
    .catch((err) => console.warn('[密碼小管家] 自動備份失敗', err)) // i18n-ignore：給開發者看的
    .then(() => scheduleAutoBackup())
    .catch((err) => console.warn('[密碼小管家] 排自動備份的時間失敗', err)); // i18n-ignore：給開發者看的
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === AUTO_BACKUP_ALARM) autoBackupTick();
});
autoBackupTick();

// ---- 剛送出、還沒決定要不要存的帳密 ----
// 存在 storage.session（只在記憶體，關瀏覽器就清掉），用分頁 id 當 key。
// 登入表單送出後通常會跳頁，舊頁面的腳本已經死了，所以要靠背景程式把資料傳給新頁面。

function pendingKey(tabId) {
  return 'pending:' + tabId;
}

async function getPending(tabId) {
  if (tabId == null) return null;
  const key = pendingKey(tabId);
  const stored = await chrome.storage.session.get(key);
  const p = stored[key];
  if (!p) return null;
  if (Date.now() - p.at > PENDING_TTL_MS) {
    await chrome.storage.session.remove(key);
    return null;
  }
  return p;
}

async function setPending(tabId, data) {
  if (tabId == null) return null;
  let old = await getPending(tabId);
  // 兩段式登入（第一頁打帳號、第二頁才打密碼）要把兩頁的資料合併成一筆。
  // 但換到別的網站就不能合併，不然 A 站的帳號會配到 B 站的密碼。
  if (old && baseDomain(old.host) !== baseDomain(data.host)) old = null;
  const merged = { ...(old || {}), at: Date.now() };
  // submitUrl 是按下登入時的網址（不含查詢字串），新頁面用它判斷是不是登入失敗被退回同一頁
  for (const k of ['host', 'origin', 'username', 'password', 'submitUrl']) {
    if (data[k] != null && data[k] !== '') merged[k] = data[k];
  }
  await chrome.storage.session.set({ [pendingKey(tabId)]: merged });
  return merged;
}

async function clearPending(tabId) {
  if (tabId != null) await chrome.storage.session.remove(pendingKey(tabId));
}

async function touchEntry(id) {
  await modifyEntries((entries) => {
    const e = entries.find((x) => x.id === id);
    if (e) e.lastUsedAt = Date.now();
  });
}

// 決定要不要跳「儲存密碼？」：已經存過一模一樣的就不問，帳號相同但密碼不同就問要不要更新。
async function pendingDecision(tabId) {
  const p = await getPending(tabId);
  if (!p || !p.password || !p.host) return { pending: null, mode: null };
  // 鎖住時不跳儲存提示，暫存留著，解鎖後下一頁再問
  if (await isLocked()) return { pending: null, mode: null };
  const settings = await getSettings();
  if (settings.neverSave.includes(p.host)) {
    await clearPending(tabId);
    return { pending: null, mode: null };
  }
  const entries = await loadEntries();
  let existing = findExisting(entries, p.host, p.username || '');
  // 改密碼的表單通常沒有帳號欄。這個網站只存了一組帳號的話，就當作是要更新那一組。
  if (!existing && !p.username) {
    const candidates = rankEntries(entries, p.host);
    if (candidates.length === 1) existing = candidates[0];
  }
  if (existing && existing.password === p.password) {
    await clearPending(tabId);
    await touchEntry(existing.id);
    return { pending: null, mode: null };
  }
  const { at, ...pending } = p;
  return {
    pending,
    mode: existing ? 'update' : 'new',
    existingId: existing ? existing.id : null,
    existingUsername: existing ? existing.username : null,
  };
}

// ---- 工具列圖示上的數字：目前網站有幾組帳號 ----

async function updateBadge(tabId, url) {
  if (tabId == null) return;
  await i18nReady;
  let text = '';
  const host = hostFromUrl(url || '');
  if (await isLocked()) {
    text = t('bg_badge_locked');
  } else if (host) {
    try {
      const n = rankEntries(await loadEntries(), host).length;
      text = n ? String(n) : '';
    } catch (err) {
      console.warn('[密碼小管家] 更新圖示數字時讀不到資料', err); // i18n-ignore：給開發者看的
    }
  }
  try {
    await chrome.action.setBadgeText({ tabId, text });
  } catch {
    // 分頁已經關掉就會失敗，不用理。
  }
}

async function refreshActiveBadges() {
  const tabs = await chrome.tabs.query({ active: true });
  for (const t of tabs) updateBadge(t.id, t.url);
}

chrome.action.setBadgeBackgroundColor({ color: '#2563eb' });

chrome.tabs.onActivated.addListener(({ tabId }) => {
  chrome.tabs.get(tabId).then((t) => updateBadge(tabId, t.url)).catch(() => {
    // 分頁在這之間被關掉就會失敗，不用理。
  });
});

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status === 'complete' || info.url) updateBadge(tabId, tab.url);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  clearPending(tabId);
  clearClickGuard(tabId);
});

// 快捷鍵（預設 Ctrl+Shift+L，manifest.json 的 commands）：把目前網站最近用過的那組帳密填進去
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'fill-login') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || tab.id == null) return;
  const host = hostFromUrl(tab.url || '');
  if (!host) return;
  if (await isLocked()) {
    // 鎖住時改成把小視窗打開讓使用者輸 PIN。舊版 Edge 不給程式開小視窗，失敗就算了。
    try {
      await chrome.action.openPopup();
    } catch (err) {
      console.warn('[密碼小管家] 鎖住時打不開小視窗', err); // i18n-ignore：給開發者看的
    }
    return;
  }
  const entries = rankEntries(await loadEntries(), host);
  if (!entries.length) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'fill', entry: entries[0] });
  } catch (err) {
    // 擴充功能裝好之前就開著的分頁沒有 content.js，會走到這裡
    console.warn('[密碼小管家] 快捷鍵填入失敗', err); // i18n-ignore：給開發者看的
  }
});

// ---- 瀏覽器自己跳的「需要驗證」小視窗（HTTP Basic / Digest auth）----
// 瀏覽器問之前先攔下來：那個網站有存帳號就直接回答，沒有就讓視窗照常跳出來。
// 使用者在那個視窗裡手打的帳密，擴充功能看不到也存不了，要先在小視窗新增。

const authAttempts = new Map();

async function handleAuthRequired(details) {
  if (details.isProxy) return {};
  const host = ((details.challenger && details.challenger.host) || '').toLowerCase();
  if (!host) return {};
  // 同一個請求只回答一次。回答錯了瀏覽器會再問，第二次就放給瀏覽器的視窗，不然會無限重試。
  const count = (authAttempts.get(details.requestId) || 0) + 1;
  authAttempts.set(details.requestId, count);
  setTimeout(() => authAttempts.delete(details.requestId), 60 * 1000);
  if (count > 1) return {};
  if (await isLocked()) return {};
  const entries = rankEntries(await loadEntries(), host);
  if (!entries.length) return {};
  touchEntry(entries[0].id);
  return { authCredentials: { username: entries[0].username, password: entries[0].password } };
}

chrome.webRequest.onAuthRequired.addListener(
  (details, asyncCallback) => {
    handleAuthRequired(details)
      .then(asyncCallback)
      .catch((err) => {
        console.warn('[密碼小管家] 回答驗證視窗失敗', err); // i18n-ignore：給開發者看的
        asyncCallback({});
      });
  },
  { urls: ['http://*/*', 'https://*/*'] },
  ['asyncBlocking']
);

// 匯入 CSV 或備份檔：同網站同帳號且密碼相同的略過，密碼不同的更新，其他新增。
// 檔案裡的密碼如果是這邊已經換掉的舊密碼，或檔案記的改密碼時間比這邊早，也略過：
// 和瀏覽器來回搬的時候，瀏覽器那份常常是舊的，不能把這邊的新密碼蓋回去。
// skipped 是全部略過的筆數，same / older / invalid 是細分：密碼一樣、檔案的比較舊、不是網站或沒有密碼。
function importEntries(rows) {
  return modifyEntries((entries) => {
    const s = { added: 0, updated: 0, skipped: 0, same: 0, older: 0, invalid: 0 };
    const skip = (why) => {
      s[why]++;
      s.skipped++;
    };
    for (const row of rows || []) {
      let data;
      try {
        data = normalizeInput(row);
      } catch {
        skip('invalid');
        continue;
      }
      if (!data.password) {
        skip('invalid');
        continue;
      }
      const existing = entries.find((e) => e.host === data.host && e.username === data.username);
      if (existing) {
        if (existing.password === data.password) {
          skip('same');
          continue;
        }
        const replaced = (existing.history || []).some((h) => h.password === data.password);
        const olderTime = row.passwordChangedAt && row.passwordChangedAt < (existing.passwordChangedAt || 0);
        if (replaced || olderTime) {
          skip('older');
          continue;
        }
        const now = Date.now();
        const { password, ...rest } = data;
        // 瀏覽器匯出的檔案常常沒有備註，空的備註不要把這邊寫的清掉
        if (!rest.note) delete rest.note;
        Object.assign(existing, rest, { updatedAt: now });
        applyPassword(existing, password, now);
        s.updated++;
      } else {
        const now = Date.now();
        // 備份檔裡有原本的時間和舊密碼就沿用，CSV 沒有就用現在
        entries.push(
          newEntry(data, now, {
            history: Array.isArray(row.history) ? row.history.slice(0, HISTORY_MAX) : [],
            createdAt: row.createdAt || now,
            updatedAt: row.updatedAt || now,
            lastUsedAt: row.lastUsedAt || 0,
            passwordChangedAt: row.passwordChangedAt || row.createdAt || now,
          })
        );
        s.added++;
      }
    }
    return s;
  });
}

// ---- 自動點選 ----

function normalizeRulePath(raw) {
  let path = String(raw == null ? '' : raw).trim();
  if (!path) throw new Error(t('bg_rule_path_required'));
  // 使用者可能直接貼整個網址
  if (/^https?:\/\//i.test(path)) {
    try {
      const u = new URL(path);
      path = u.pathname + u.search + u.hash;
    } catch {
      throw new Error(t('bg_rule_url_invalid'));
    }
  }
  return path.startsWith('/') || path.startsWith('*') ? path : '/' + path;
}

// 秒數要是整數，而且在範圍內。不對就回傳 null，由呼叫的地方決定要報錯還是用預設值。
function clickSeconds(raw, min) {
  return Number.isInteger(raw) && raw >= min && raw <= CLICK_SEC_MAX ? raw : null;
}

function requireClickSeconds(raw, min, label) {
  const sec = clickSeconds(raw, min);
  if (sec === null) throw new Error(t('bg_seconds_range', label, min, CLICK_SEC_MAX));
  return sec;
}

// 跟網頁上讀到的按鈕文字整理成一樣，比對時才對得上
function cleanRuleText(raw) {
  return String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim().slice(0, 80);
}

function normalizeClickRule(raw) {
  const host = String(raw.host || '').trim().toLowerCase();
  const selector = String(raw.selector || '').trim();
  if (!host) throw new Error(t('bg_site_required'));
  if (!selector) throw new Error(t('bg_rule_no_button'));
  const rule = {
    host,
    path: normalizeRulePath(raw.path),
    selector,
    text: String(raw.text || '').slice(0, 80),
    when: raw.when === 'afterFill' ? 'afterFill' : 'onLoad',
  };
  // 這兩個是選填。在網頁上重選同一顆按鈕時沒帶到，存檔才不會蓋掉使用者調過的值。
  const intervalSec = clickSeconds(raw.intervalSec, 1);
  if (intervalSec !== null) rule.intervalSec = intervalSec;
  if (raw.onMissing === 'stop') rule.onMissing = 'stop';
  return rule;
}

function sameClickRule(a, b) {
  return a.host === b.host && a.path === b.path && a.selector === b.selector;
}

// content.js 是拿 location.hostname 完全比對，寫成別的樣子（像 *.example.com）的規則永遠不會點。
// options.js 的 splitRuleUrl 有一份一樣的，管理頁要先拆好才看得到結果。
const CLICK_RULE_HOST = /^(\[[\da-f:.]+\]|[a-z\d_-]+(\.[a-z\d_-]+)*)$/;

// 管理頁改一條規則，沒帶到的欄位不動
function patchClickRule(rule, patch) {
  const next = { ...rule };
  if (patch.enabled != null) next.enabled = !!patch.enabled;
  if (patch.when != null) next.when = patch.when === 'afterFill' ? 'afterFill' : 'onLoad';
  if (patch.path != null) next.path = normalizeRulePath(patch.path);
  if (patch.selector != null) {
    next.selector = String(patch.selector).trim();
    if (!next.selector) throw new Error(t('bg_selector_required'));
    // 文字留著的話，新按鈕對不上舊文字就點不到，還可能用舊文字點回舊按鈕
    if (next.selector !== rule.selector) next.text = '';
  }
  if (patch.text != null) next.text = cleanRuleText(patch.text);
  // null 是清掉，回到共用的間隔預設值
  if (patch.intervalSec === null) delete next.intervalSec;
  else if (patch.intervalSec !== undefined) next.intervalSec = requireClickSeconds(patch.intervalSec, 1, t('bg_label_interval'));
  if (patch.onMissing === 'stop') next.onMissing = 'stop';
  else if (patch.onMissing != null) delete next.onMissing;
  return next;
}

// 管理頁改完欄位馬上按別的按鈕時，兩個訊息會同時進來。不排隊的話，後存的會蓋掉先存的。
let clickRulesQueue = Promise.resolve();
function updateClickRules(change) {
  const run = clickRulesQueue.then(async () => setSettings(change(await getSettings())));
  clickRulesQueue = run.catch(() => {
    // 失敗的那次已經往外拋給呼叫者了，這裡只是不要讓佇列卡住。
  });
  return run;
}

// 規則的網址比對，* 代表任意字元。沒寫 ? 或 # 就只比路徑，因為查詢字串常常每次都不一樣（像 ?returnUrl=...）。
// content.js 有一份一樣的，content script 不能 import。
function rulePathMatches(pattern, url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  let target = u.pathname;
  if (pattern.includes('?')) target += u.search + u.hash;
  else if (pattern.includes('#')) target += u.hash.split('?')[0];
  const body = pattern
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp('^' + body + '$', 'i').test(target);
}

// 備份檔裡的規則：同網站、同網址、同按鈕的略過，其他新增。回傳新增幾條。
async function importClickRules(rows) {
  const rules = (await getSettings()).clickRules.slice();
  let added = 0;
  for (const row of rows) {
    let data;
    try {
      data = normalizeClickRule(row);
    } catch (err) {
      // 壞掉的規則略過就好，不要讓整份備份匯不進來
      console.warn('[密碼小管家] 略過備份檔裡壞掉的自動點選規則', err); // i18n-ignore：給開發者看的
      continue;
    }
    if (rules.some((r) => sameClickRule(r, data))) continue;
    rules.push({ id: crypto.randomUUID(), enabled: row.enabled !== false, createdAt: row.createdAt || Date.now(), ...data });
    added++;
  }
  if (added) await setSettings({ clickRules: rules });
  return added;
}

// 防連點：同一個分頁裡，同一條規則隔夠久才能再點，也不自動點剛按過登出的網站。
// 不擋的話，密碼錯被退回登入頁會一直重試，帳號可能被鎖；按登出也會馬上被登回去。
// 記錄放 storage.session，因為頁面重新載入後 content.js 的變數就沒了。樣子：{ 分頁 id: { 代號: 時間 } }。

// 同一個分頁的好幾個 frame 可能同時來問，排隊一次一個，不然會一起通過
let clickGuardQueue = Promise.resolve();
function updateClickGuard(mutator) {
  const run = clickGuardQueue.then(async () => {
    const { clickGuard } = await chrome.storage.session.get('clickGuard');
    const map = clickGuard || {};
    const result = mutator(map);
    await chrome.storage.session.set({ clickGuard: map });
    return result;
  });
  clickGuardQueue = run.catch(() => {
    // 失敗的那次已經往外拋給呼叫者了，這裡只是不要讓佇列卡住。
  });
  return run;
}

// 取出這個分頁的紀錄。存的是點的時間，有沒有過期等要用時照當下的設定算，這樣改短間隔馬上有效。
// 超過最長間隔的一定用不到了，順便清掉。
function tabClickGuard(map, tabId) {
  const now = Date.now();
  const guard = map[tabId] || {};
  for (const [key, at] of Object.entries(guard)) {
    if (now - at >= CLICK_SEC_MAX * 1000) delete guard[key];
  }
  map[tabId] = guard;
  return guard;
}

function clearClickGuard(tabId) {
  return updateClickGuard((map) => {
    delete map[tabId];
  });
}

// ---- 訊息處理 ----

const handlers = {
  async ping() {
    return 'pong';
  },

  async 'entries.forHost'({ host }, sender) {
    const settings = await getSettings();
    host = String(host || '').toLowerCase();
    // autoFill 是這個網站實際要不要自動填，content.js 看這個。小視窗另外要知道總開關和這個網站自己的開關。
    const siteAutoFill = !settings.noAutoFillHosts.includes(host);
    const flags = {
      autoFill: settings.autoFill && siteAutoFill,
      autoFillMaster: settings.autoFill,
      siteAutoFill,
      autoSubmit: settings.autoSubmitHosts.includes(host),
    };
    if (await isLocked()) return { entries: [], autoFillEntry: null, ...flags, locked: true };
    const pending = sender.tab ? await getPending(sender.tab.id) : null;
    const entries = rankEntries(await loadEntries(), host);
    // 兩段式登入的第二頁只有密碼欄。第一頁打的帳號有存過就填那一組，沒存過就不能拿別組帳號的密碼來填。
    let autoFillEntry = entries[0] || null;
    if (pending && pending.username && !pending.password) {
      autoFillEntry = entries.find((e) => e.username === pending.username) || null;
    }
    return { entries, autoFillEntry, ...flags, locked: false };
  },

  // 只開關這一個網站的自動填入。關掉時一起取消這個網站的自動按登入，不然之後打開自動填入，自動按登入會跟著悄悄恢復。
  async 'autoFill.setSite'({ host, enabled }) {
    host = String(host || '').toLowerCase();
    if (!host) throw new Error(t('bg_site_required'));
    const settings = await getSettings();
    const off = settings.noAutoFillHosts.filter((h) => h !== host);
    if (!enabled) off.push(host);
    const patch = { noAutoFillHosts: off };
    if (!enabled) patch.autoSubmitHosts = settings.autoSubmitHosts.filter((h) => h !== host);
    return setSettings(patch);
  },

  // 管理頁「各網站」表按套用時，一次存好幾個網站。sites：[{ host, autoFill, autoSubmit }]。
  // 跟單一網站的規則一樣：自動填入關掉的網站，自動按登入一律取消。
  async 'autoFill.setSites'({ sites }) {
    const settings = await getSettings();
    const off = new Set(settings.noAutoFillHosts);
    const submit = new Set(settings.autoSubmitHosts);
    for (const s of sites || []) {
      const host = String(s.host || '').toLowerCase();
      if (!host) continue;
      if (s.autoFill) off.delete(host);
      else off.add(host);
      if (s.autoFill && s.autoSubmit) submit.add(host);
      else submit.delete(host);
    }
    return setSettings({ noAutoFillHosts: [...off], autoSubmitHosts: [...submit] });
  },

  async 'autoSubmit.set'({ host, enabled }) {
    host = String(host || '').toLowerCase();
    const settings = await getSettings();
    // 自動按登入接在自動填入後面，這個網站的自動填入關著就沒有東西可以按
    if (enabled && settings.noAutoFillHosts.includes(host)) throw new Error(t('bg_autofill_off_for_site'));
    const hosts = settings.autoSubmitHosts.filter((h) => h !== host);
    if (host && enabled) hosts.push(host);
    return setSettings({ autoSubmitHosts: hosts });
  },

  // content.js 拿這個網站啟用中的規則。小視窗多帶 url，要知道這一頁有幾條。
  async 'clickRules.forHost'({ host, url }) {
    if (await isLocked()) return { rules: [], pageCount: 0, locked: true };
    host = String(host || '').toLowerCase();
    const rules = (await getSettings()).clickRules.filter((r) => r.enabled && r.host === host);
    return { rules, pageCount: url ? rules.filter((r) => rulePathMatches(r.path, url)).length : 0, locked: false };
  },

  // 同一頁重選同一顆按鈕算改設定，不會多一條
  async 'clickRules.save'({ rule }) {
    const data = normalizeClickRule(rule || {});
    await updateClickRules(({ clickRules }) => {
      const rules = clickRules.slice();
      const i = rules.findIndex((r) => sameClickRule(r, data));
      if (i >= 0) rules[i] = { ...rules[i], ...data, enabled: true };
      else rules.push({ id: crypto.randomUUID(), enabled: true, createdAt: Date.now(), ...data });
      return { clickRules: rules };
    });
    // 管理頁可能開在別的分頁，通知它重畫。host 讓它把新規則那個網站展開。
    chrome.runtime.sendMessage({ type: 'clickRulesChanged', host: data.host }).catch(() => {
      // 沒有頁面開著就會失敗，不用理
    });
    return true;
  },

  // 管理頁手動新增。跟在網頁上重選按鈕不一樣，相同的規則要報錯，手動填的內容不該悄悄蓋掉舊設定。
  async 'clickRules.add'({ rule }) {
    const raw = rule || {};
    const data = normalizeClickRule({ ...raw, text: cleanRuleText(raw.text) });
    if (!CLICK_RULE_HOST.test(data.host)) throw new Error(t('bg_site_invalid'));
    if (raw.intervalSec !== undefined) requireClickSeconds(raw.intervalSec, 1, t('bg_label_interval'));
    return updateClickRules(({ clickRules }) => {
      if (clickRules.some((r) => sameClickRule(r, data))) throw new Error(t('bg_duplicate_click_rule'));
      return { clickRules: [...clickRules, { id: crypto.randomUUID(), enabled: true, createdAt: Date.now(), ...data }] };
    });
  },

  async 'clickRules.update'({ id, patch }) {
    return updateClickRules(({ clickRules }) => ({
      clickRules: clickRules.map((r) => {
        if (r.id !== id) return r;
        const next = patchClickRule(r, patch);
        if (clickRules.some((other) => other.id !== id && sameClickRule(other, next))) throw new Error(t('bg_duplicate_click_rule'));
        return next;
      }),
    }));
  },

  async 'clickRules.delete'({ id }) {
    return updateClickRules(({ clickRules }) => ({ clickRules: clickRules.filter((r) => r.id !== id) }));
  },

  // ids 是這個網站所有規則排好的順序。別的網站的規則留在原位。
  async 'clickRules.reorder'({ host, ids }) {
    return updateClickRules(({ clickRules }) => {
      const own = clickRules.filter((r) => r.host === host);
      const queue = (ids || []).map((id) => own.find((r) => r.id === id));
      // 管理頁開著時，規則可能在別的分頁新增或刪掉了。對不上就不動，不然規則會不見。
      if (queue.length !== own.length || new Set(queue).size !== own.length || queue.includes(undefined)) {
        throw new Error(t('bg_rules_changed'));
      }
      return { clickRules: clickRules.map((r) => (r.host === host ? queue.shift() : r)) };
    });
  },

  // 間隔預設值和登出後暫停，沒帶到的不動
  async 'clickRules.timing'({ clickIntervalSec, logoutPauseSec }) {
    const patch = {};
    if (clickIntervalSec !== undefined) patch.clickIntervalSec = requireClickSeconds(clickIntervalSec, 1, t('bg_label_interval'));
    if (logoutPauseSec !== undefined) patch.logoutPauseSec = requireClickSeconds(logoutPauseSec, 0, t('bg_label_pause'));
    return updateClickRules(() => patch);
  },

  // content.js 每次要自動點之前先問這個。通過就記一筆，所以問一次就算點一次。
  // peek 只看現在能不能點，不記。ruleId 是哪條規則，用它自己的間隔；沒帶（自動填完按登入）或沒填就用共用的預設值。
  async 'clickRules.claim'({ key, host, ruleId, peek }, sender) {
    if (!sender.tab) return { allowed: false, reason: 'no-tab' };
    if (await isLocked()) return { allowed: false, reason: 'locked' };
    const settings = await getSettings();
    const rule = ruleId && settings.clickRules.find((r) => r.id === ruleId);
    const intervalMs = ((rule && rule.intervalSec) || settings.clickIntervalSec) * 1000;
    const pauseMs = settings.logoutPauseSec * 1000;
    const logoutKey = 'logout:' + baseDomain(host);
    return updateClickGuard((map) => {
      const guard = tabClickGuard(map, sender.tab.id);
      const now = Date.now();
      if (guard[logoutKey] && now - guard[logoutKey] < pauseMs) return { allowed: false, reason: 'logout' };
      if (guard[key] && now - guard[key] < intervalMs) return { allowed: false, reason: 'cooldown' };
      if (!peek) guard[key] = now;
      return { allowed: true };
    });
  },

  // 使用者按了登出。用主網域記，因為單一驗證的網址常常跟系統不同，但主網域相同。
  async 'clickRules.pause'({ host }, sender) {
    if (!sender.tab) return false;
    await updateClickGuard((map) => {
      tabClickGuard(map, sender.tab.id)['logout:' + baseDomain(host)] = Date.now();
    });
    return true;
  },

  // 選取模式是每個 frame 各跑各的，其中一個選好或按 Esc，其他 frame 也要收掉
  async 'clickRules.pickDone'(_, sender) {
    if (!sender.tab) return false;
    chrome.tabs.sendMessage(sender.tab.id, { type: 'pickStop' }).catch(() => {
      // 分頁可能已經跳頁或關掉，不用理
    });
    return true;
  },

  async 'lock.status'() {
    return lockStatus();
  },

  // 改閒置分鐘數或「重開就鎖」不用再驗，反正已經是解鎖狀態才改得到
  async 'lock.settings'({ idleMinutes, onStartup }) {
    const settings = await getSettings();
    const next = { ...settings.lock };
    if (idleMinutes != null) next.idleMinutes = Math.min(Math.max(parseInt(idleMinutes, 10) || 10, 1), 720);
    if (onStartup != null) next.onStartup = !!onStartup;
    await setSettings({ lock: next });
    applyIdleInterval();
    return lockStatus();
  },

  // 停用要先通過一次系統驗證，通過就把鑰匙一起清掉
  async 'lock.disable'(assertion) {
    await verifyAssertion(assertion);
    const settings = await getSettings();
    await setSettings({ lock: { ...settings.lock, enabled: false } });
    await chrome.storage.local.remove('webauthn');
    await setLocked(false);
    return lockStatus();
  },

  async 'lock.now'() {
    const settings = await getSettings();
    if (!settings.lock.enabled) throw new Error(t('bg_lock_not_enabled'));
    await setLocked(true);
    return lockStatus();
  },

  async 'webauthn.status'() {
    return webAuthnStatus();
  },

  async 'webauthn.challenge'() {
    return { challenge: await issueWebAuthnChallenge(), rpId: chrome.runtime.id };
  },

  // 管理頁建好鑰匙後把公鑰交過來存，存好就等於啟用工具鎖定
  async 'webauthn.register'({ id, alg, publicKey, clientDataJSON, transports, idleMinutes, onStartup }) {
    if (!id || !publicKey || (alg !== -7 && alg !== -257)) throw new Error(t('bg_key_data_incomplete'));
    await consumeWebAuthnChallenge(clientDataJSON, 'webauthn.create');
    const list = Array.isArray(transports) ? transports.filter((x) => typeof x === 'string').slice(0, 5) : [];
    await chrome.storage.local.set({ webauthn: { id, alg, publicKey, transports: list, createdAt: Date.now() } });
    const settings = await getSettings();
    const next = { ...settings.lock, enabled: true };
    if (idleMinutes != null) next.idleMinutes = Math.min(Math.max(parseInt(idleMinutes, 10) || 10, 1), 720);
    if (onStartup != null) next.onStartup = !!onStartup;
    await setSettings({ lock: next });
    await chrome.storage.session.set({ locked: false });
    applyIdleInterval();
    refreshActiveBadges();
    return lockStatus();
  },

  async 'webauthn.unlock'(assertion) {
    await verifyAssertion(assertion);
    await setLocked(false);
    return lockStatus();
  },

  async 'entries.all'() {
    const entries = await loadEntries();
    entries.sort((a, b) => a.host.localeCompare(b.host) || a.username.localeCompare(b.username));
    return entries;
  },

  async 'entries.save'({ entry, id }) {
    const result = await modifyEntries((entries) => upsert(entries, entry || {}, id));
    refreshActiveBadges();
    return result;
  },

  // 刪掉的先進回收桶，放滿保留天數（預設 30 天）之前都可以復原
  async 'entries.delete'({ id }) {
    const removed = await modifyVault((vault) => {
      const i = vault.entries.findIndex((e) => e.id === id);
      if (i < 0) return false;
      const [entry] = vault.entries.splice(i, 1);
      vault.trash.unshift({ ...entry, deletedAt: Date.now() });
      return true;
    });
    refreshActiveBadges();
    return removed;
  },

  async 'entries.deleteAll'() {
    await modifyVault((vault) => {
      const now = Date.now();
      vault.trash.unshift(...vault.entries.map((e) => ({ ...e, deletedAt: now })));
      vault.entries.length = 0;
    });
    refreshActiveBadges();
    return true;
  },

  async 'trash.list'() {
    // 走 modifyVault 是為了順便把過期的清掉
    return modifyVault((vault) => vault.trash.slice().sort((a, b) => (b.deletedAt || 0) - (a.deletedAt || 0)));
  },

  async 'trash.restore'({ id }) {
    const entry = await modifyVault((vault) => {
      const i = vault.trash.findIndex((x) => x.id === id);
      if (i < 0) throw new Error(t('bg_trash_not_found'));
      const item = vault.trash[i];
      if (vault.entries.some((e) => e.host === item.host && e.username === item.username)) {
        throw new Error(t('bg_restore_duplicate'));
      }
      vault.trash.splice(i, 1);
      const { deletedAt, ...restored } = item;
      vault.entries.push(restored);
      return restored;
    });
    refreshActiveBadges();
    return entry;
  },

  async 'trash.purge'({ id }) {
    return modifyVault((vault) => {
      const i = vault.trash.findIndex((t) => t.id === id);
      if (i < 0) return false;
      vault.trash.splice(i, 1);
      return true;
    });
  },

  async 'trash.purgeAll'() {
    await modifyVault((vault) => {
      vault.trash.length = 0;
    });
    return true;
  },

  // 批次復原：同網站已經有同一個帳號的那幾筆跳過，其他照常復原，回傳跳過哪幾筆。
  // 一筆一筆檢查，所以勾到兩筆同網站同帳號的（刪掉、新增、又刪掉）時，只會復原第一筆。
  async 'trash.restoreMany'({ ids }) {
    const result = await modifyVault((vault) => {
      const out = { restored: 0, skipped: [] };
      for (const id of ids || []) {
        const i = vault.trash.findIndex((t) => t.id === id);
        if (i < 0) continue;
        const t = vault.trash[i];
        if (vault.entries.some((e) => e.host === t.host && e.username === t.username)) {
          out.skipped.push({ host: t.host, username: t.username });
          continue;
        }
        vault.trash.splice(i, 1);
        const { deletedAt, ...restored } = t;
        vault.entries.push(restored);
        out.restored++;
      }
      return out;
    });
    refreshActiveBadges();
    return result;
  },

  async 'trash.purgeMany'({ ids }) {
    const wanted = new Set(ids || []);
    return modifyVault((vault) => {
      const before = vault.trash.length;
      vault.trash = vault.trash.filter((t) => !wanted.has(t.id));
      return before - vault.trash.length;
    });
  },

  // 改保留天數。改短的話，已經放超過新天數的會在這次寫入時一起清掉，回傳清掉幾筆。
  // 管理頁會先列出會被清掉的讓使用者確認，這裡不再問。
  async 'trash.setDays'({ days }) {
    const n = parseInt(days, 10);
    if (!(n >= 1 && n <= 365)) throw new Error(t('bg_trash_days_range'));
    const cutoff = Date.now() - n * DAY_MS;
    const expired = (await loadVault()).trash.filter((x) => (x.deletedAt || 0) <= cutoff).length;
    await setSettings({ trashDays: n });
    await modifyVault(() => {});
    return { days: n, purged: expired };
  },

  async 'entries.touch'({ id }) {
    await touchEntry(id);
    return true;
  },

  // rows: [{ url, username, password, note }]，管理頁從 CSV 讀出來的。
  // Firefox 匯出的檔案有時間，會多帶 createdAt、lastUsedAt、passwordChangedAt（毫秒）。
  async 'entries.import'({ rows }) {
    const stats = await importEntries(rows);
    refreshActiveBadges();
    return stats;
  },

  // options 有給就用給的（popup 會順便存起來），沒給就用設定裡存的
  async 'password.generate'({ options, save }) {
    const result = generatePassword(options || (await getSettings()).generator);
    if (save && options) await setSettings({ generator: result.options });
    return result;
  },

  async 'backup.export'({ password, ids }) {
    return exportBackup(password, ids);
  },

  async 'backup.import'({ password, content }) {
    return importBackup(password, content);
  },

  async 'backup.status'() {
    return backupStatus();
  },

  // content 是檔案內容，kind 是 manual / csv / selected，管理頁組好內容後叫這個存檔
  async 'backup.download'({ content, filename, mime, kind, count }) {
    return downloadBackup({ content, filename, mime: mime || 'application/json', kind, count });
  },

  // 單筆刪紀錄前，管理頁先問這個，看要問「要不要一起刪檔案」還是提醒使用者自己去刪
  async 'backupLog.fileStatus'({ id }) {
    const item = (await getBackupLog()).find((x) => x.id === id);
    if (!item) throw new Error(t('bg_log_not_found'));
    const status = await backupFileStatus(item);
    return { status, reason: fileReason(status) };
  },

  async 'backupLog.delete'({ ids, deleteFiles }) {
    return deleteBackupLog(ids, !!deleteFiles);
  },

  async 'autoBackup.get'() {
    return autoBackupInfo();
  },

  async 'autoBackup.set'(data) {
    return setAutoBackup(data);
  },

  async 'autoBackup.runNow'() {
    return runAutoBackup(true);
  },

  async 'settings.get'() {
    return getSettings();
  },

  // 管理頁右上角的語言選單。auto 是跟著瀏覽器，browserLocale 是瀏覽器挑的那一種。
  async 'language.get'() {
    return { language: (await chosenLocale()) || 'auto', browserLocale: browserLocale() };
  },

  // 鎖住時也能換：語言只是怎麼顯示，看不懂驗證畫面的人也要能換回看得懂的語言
  async 'language.set'({ language }) {
    if (language === 'auto') await chrome.storage.local.remove('uiLanguage');
    else if (i18nLocales().includes(language)) await chrome.storage.local.set({ uiLanguage: language });
    else throw new Error(t('bg_language_invalid'));
    // storage 的變更通知會晚一點才到，這裡先換好，管理頁重新整理後的第一個訊息就會是新語言
    i18nReady = followChosenLocale();
    await i18nReady;
    return { language };
  },

  // 網頁裡的 content.js 拿指定語言的翻譯。沒指定時 messages 是 null，照瀏覽器的語言。
  // 直接讀 storage，不用背景程式自己記的：content.js 收到語言變更通知時，背景程式可能還沒收到
  async 'i18n.current'() {
    const locale = await chosenLocale();
    return { locale, messages: locale && locale !== browserLocale() ? await localeMessages(locale) : null };
  },

  async 'settings.set'({ patch }) {
    return setSettings(patch || {});
  },

  async 'neverSave.add'({ host }) {
    host = String(host || '').toLowerCase();
    const settings = await getSettings();
    if (host && !settings.neverSave.includes(host)) settings.neverSave.push(host);
    return setSettings({ neverSave: settings.neverSave });
  },

  async 'neverSave.remove'({ host }) {
    const settings = await getSettings();
    return setSettings({ neverSave: settings.neverSave.filter((h) => h !== host) });
  },

  async 'pending.set'(data, sender) {
    if (!sender.tab) return null;
    return setPending(sender.tab.id, {
      host: String(data.host || '').toLowerCase(),
      origin: data.origin,
      username: data.username,
      password: data.password,
      submitUrl: data.submitUrl,
    });
  },

  async 'pending.get'(_, sender) {
    if (!sender.tab) return { pending: null, mode: null };
    return pendingDecision(sender.tab.id);
  },

  async 'pending.clear'(_, sender) {
    if (sender.tab) await clearPending(sender.tab.id);
    return true;
  },

};

async function dispatch(msg, sender) {
  await i18nReady;
  if (LOCK_REQUIRED.has(msg.type) && (await isLocked())) {
    const err = new Error(t('bg_locked'));
    err.locked = true;
    throw err;
  }
  return handlers[msg.type](msg, sender);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const fn = msg && handlers[msg.type];
  if (!fn) {
    sendResponse({ ok: false, error: t('bg_unknown_message', msg && msg.type) });
    return false;
  }
  dispatch(msg, sender).then(
    (data) => sendResponse({ ok: true, data }),
    (err) => {
      // 已鎖定、欄位填錯這類拒絕是寫給使用者看的訊息（一般 Error），會回給畫面顯示，不算程式出錯。
      // 印成 console.error 會讓 chrome://extensions 冒出紅色「錯誤」按鈕，所以只印 TypeError 這類真的意外。
      if (!(err && (err.locked || err.constructor === Error))) {
        console.error('[密碼小管家] 處理訊息失敗', msg.type, err); // i18n-ignore：給開發者看的
      }
      sendResponse({ ok: false, error: err && err.message ? err.message : String(err), locked: !!(err && err.locked) });
    }
  );
  // 回傳 true 告訴瀏覽器 sendResponse 會晚一點才叫，不然通道會先被關掉。
  return true;
});
