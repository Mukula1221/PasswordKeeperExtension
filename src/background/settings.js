'use strict';
// 設定的預設值和讀寫。
(() => {
  const PK = (globalThis.PK ??= {});

  // 自動點選的間隔、登出後暫停，最長可以設多少秒
  const CLICK_SEC_MAX = 86400;

  const DEFAULT_SETTINGS = {
    autoFill: true,
    neverSave: [],
    // 備份提醒：超過這麼多天沒備份、而且期間有改過密碼，就提醒。0 代表不提醒。
    backupReminderDays: 30,
    lastBackupAt: 0,
    // 產生密碼的選項，popup 改過會存回來。mode：chars 隨機字元，words 好記的密碼（見 generator.js）
    generator: {
      mode: 'chars',
      minLength: 16,
      maxLength: 20,
      upper: true,
      lower: true,
      digits: true,
      symbols: true,
      symbolSet: '!@#$%^&*()-_=+[]{};:,.?',
      words: 6,
      separator: '-',
      capitalize: true,
      addNumber: true,
    },
    // 自動備份：每天或每週的指定時間（weekday 0 是星期日）把加密備份存到「下載」底下的子資料夾。
    // 備份密碼不存。加密用的公鑰在 storage.local 的 autoBackupKey，見 getAutoBackupKey。
    // since 是開啟或改時間的時間點，在那之前的指定時間不補做。lastSignature 是上次備份時帳號清單的指紋，沒變就不存。
    autoBackup: {
      enabled: false,
      every: 'day',
      time: '12:00',
      weekday: 1,
      // 預設用英文，不跟著介面語言：跟著翻的話，使用者沒改過設定時，換語言會讓備份跑到別的資料夾。
      // 1.13.0 以前的預設是「密碼小管家備份」。存過設定的人 settings 裡已經寫著舊名稱，會照舊存到原本的資料夾，不會被搬走。
      folder: 'password-keeper',
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
    // 複製密碼後幾秒清除剪貼簿：0 不清除，可以選 30、60、120。見 clipboard.js
    clipboardClearSeconds: 0,
    // 健檢裡「還在用 HTTP」按過忽略的帳號 id。公司內部設備很多只有 http
    healthIgnoreHttp: [],
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
    // 工具鎖定：整個工具的鎖，沒碰電腦 idleMinutes 分鐘或瀏覽器重開就鎖，要通過系統驗證或自訂密碼才能用。
    // mode 是保護方式：off 不鎖、screen 只鎖畫面（1.15.0 以前的舊設定）、password 自訂密碼加密、hello 系統驗證加密（Windows Hello、Touch ID）。見 normalizeLock。
    // 系統驗證的鑰匙存在 storage.local 的 webauthn。
    lock: { enabled: false, idleMinutes: 10, onStartup: true },
    // 每天到 GitHub 問一次有沒有新版，只有正式版會自動問。見「檢查新版」。
    updateCheck: true,
  };


  async function getSettings() {
    const { settings } = await chrome.storage.local.get('settings');
    const stored = settings || {};
    // generator 是一層物件，淺層合併會把後來新增的預設欄位蓋掉，所以單獨再合併一次
    return {
      ...DEFAULT_SETTINGS,
      ...stored,
      generator: { ...DEFAULT_SETTINGS.generator, ...(stored.generator || {}) },
      autoBackup: { ...DEFAULT_SETTINGS.autoBackup, ...(stored.autoBackup || {}) },
      lock: PK.lock.normalizeLock(stored.lock),
      // 天數壞掉時當預設值。不擋的話回收桶的清除時間會算成 NaN，整個回收桶都被清掉。
      trashDays: Math.min(Math.max(parseInt(stored.trashDays, 10) || DEFAULT_SETTINGS.trashDays, 1), 365),
      // 秒數壞掉時也當預設值。不擋的話防連點會算成 NaN，等於沒有防連點。
      clickIntervalSec: clickSeconds(stored.clickIntervalSec, 1) || DEFAULT_SETTINGS.clickIntervalSec,
      logoutPauseSec: clickSeconds(stored.logoutPauseSec, 0) === null ? DEFAULT_SETTINGS.logoutPauseSec : stored.logoutPauseSec,
    };
  }

  // 自動備份會帶這幾項設定，改了要重算事先加密好的備份內容
  const BACKUP_SETTING_KEYS = ['clickRules', 'neverSave', 'generator'];

  async function setSettings(patch) {
    const current = await getSettings();
    const next = { ...current, ...patch };
    if (patch.generator) next.generator = PK.generator.normalizeGeneratorOptions({ ...current.generator, ...patch.generator });
    await chrome.storage.local.set({ settings: next });
    // 不等它算完：setSettings 可能在寫入佇列裡被叫到，等的話會卡住佇列
    if (BACKUP_SETTING_KEYS.some((k) => k in patch)) PK.autoBackup.refreshAutoBackupReadyLater();
    return next;
  }

  // 秒數要是整數，而且在範圍內。不對就回傳 null，由呼叫的地方決定要報錯還是用預設值。
  function clickSeconds(raw, min) {
    return Number.isInteger(raw) && raw >= min && raw <= CLICK_SEC_MAX ? raw : null;
  }

  PK.settings = { CLICK_SEC_MAX, DEFAULT_SETTINGS, clickSeconds, getSettings, setSettings };
})();
