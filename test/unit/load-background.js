// 單元測試用：把 src/background/background.js 載進 Node 的 vm，配一份放在記憶體的假 chrome API。
// 每次叫 loadBackground() 都是全新的背景程式和空的 storage，測試之間不會互相影響。
// 只用 Node 內建的東西，不用裝套件。
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { webcrypto } = require('crypto');

const ROOT = path.join(__dirname, '..', '..');
const EXT_ID = 'unittestextensionid';
const EXT_ORIGIN = 'chrome-extension://' + EXT_ID;
const ZH = JSON.parse(fs.readFileSync(path.join(ROOT, '_locales', 'zh_TW', 'messages.json'), 'utf8'));
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));

// PK 底下各檔匯出的東西攤平成一個物件
const FLAT_PK = 'Object.assign({}, ...Object.values(globalThis.PK || {}))';

function memoryStorage() {
  const data = {};
  return {
    data,
    async get(keys) {
      if (keys == null) return structuredClone(data);
      const out = {};
      for (const k of [].concat(keys)) if (k in data) out[k] = structuredClone(data[k]);
      return out;
    },
    async set(obj) {
      Object.assign(data, structuredClone(obj));
    },
    async remove(keys) {
      for (const k of [].concat(keys)) delete data[k];
    },
  };
}

function events() {
  const listeners = [];
  return { listeners, addListener: (fn) => listeners.push(fn), removeListener() {} };
}

function fakeChrome(origin) {
  const local = memoryStorage();
  const session = memoryStorage();
  const onMessage = events();
  return {
    storage: { local, session, onChanged: events() },
    runtime: {
      id: EXT_ID,
      lastError: undefined,
      getURL: (p) => origin + '/' + p,
      getManifest: () => structuredClone(MANIFEST),
      onMessage,
      onStartup: events(),
      onInstalled: events(),
      sendMessage: async () => undefined,
      openOptionsPage: async () => undefined,
    },
    i18n: {
      getUILanguage: () => 'zh-TW',
      getMessage(key, subs) {
        const entry = ZH[key];
        if (!entry) return '';
        const list = [].concat(subs == null ? [] : subs);
        return entry.message.replace(/\$(\$|[1-9])/g, (m, d) => (d === '$' ? '$' : String(list[d - 1] ?? '')));
      },
    },
    alarms: { create: async () => undefined, get: async () => undefined, clear: async () => false, onAlarm: events() },
    idle: { setDetectionInterval() {}, onStateChanged: events() },
    tabs: {
      query: async () => [],
      get: async (id) => ({ id, url: '' }),
      sendMessage: async () => undefined,
      create: async (opts) => ({ id: 99, url: opts.url }),
      onActivated: events(),
      onUpdated: events(),
      onRemoved: events(),
    },
    action: { setBadgeText: async () => undefined, setBadgeBackgroundColor: async () => undefined, openPopup: async () => undefined },
    commands: { onCommand: events() },
    webRequest: { onAuthRequired: events() },
    downloads: { download: async () => 1, search: async () => [], removeFile: async () => undefined },
    windows: { create: async () => ({ id: 9 }) },
    // 載入解壓縮的開發版。測試商店版時改成 normal。
    management: { getSelf: async () => ({ installType: 'development' }) },
  };
}

// origin 是擴充功能自己的網址開頭，要模擬 Firefox 就給 moz-extension://<UUID>
function loadBackground({ origin = EXT_ORIGIN } = {}) {
  const chrome = fakeChrome(origin);
  const sandbox = {
    chrome,
    console,
    crypto: webcrypto,
    URL,
    TextEncoder,
    TextDecoder,
    atob,
    btoa,
    structuredClone,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    AbortController,
    location: { href: origin + '/src/background/background.js' },
    // 測試不該連網，有人叫到就讓它失敗
    fetch: async (url) => {
      throw new Error('unit test: fetch is not allowed: ' + url);
    },
  };
  const context = vm.createContext(sandbox);
  sandbox.self = vm.runInContext('globalThis', context);
  const load = (file) => vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
  sandbox.importScripts = (...files) => {
    for (const f of files) load(path.join(ROOT, 'src', 'background', f));
  };
  load(path.join(ROOT, 'src', 'background', 'background.js'));

  const [listener] = chrome.runtime.onMessage.listeners;
  // 照瀏覽器的方式叫背景程式的 onMessage，回傳 sendResponse 收到的 { ok, data | error }。
  // 回傳的物件來自 vm 裡的另一個 realm，deepStrictEqual 比原型會不相等，所以轉成一般物件。
  function send(msg, sender) {
    return new Promise((resolve) => {
      listener(msg, sender, (res) => resolve(JSON.parse(JSON.stringify(res))));
    });
  }
  return {
    chrome,
    send,
    // 背景程式啟動時會在背後改設定（例如 migrateLock），測試要直接改 storage 前先等它跑完。
    // 假的 storage 不會真的等，排一個 setTimeout 就能讓前面所有的 Promise 跑完。
    settle: () => new Promise((resolve) => setTimeout(resolve, 0)),
    // 拿背景程式裡的 const、function，例如 run('MESSAGE_RULES')。
    // 背景程式的函式都在 PK.<檔名> 底下，這裡用 with 攤平成這次執行的區域名稱，不會變成全域。
    run: (code) => vm.runInContext('(function () { with (' + FLAT_PK + ') { return (' + code + '); } })()', context),
    pk: () => vm.runInContext('globalThis.PK', context),
    text: (key, ...subs) => chrome.i18n.getMessage(key, subs),
    // 這個背景程式的管理頁。origin 不是預設的時候，用下面匯出的 OPTIONS 會被當成別人的頁面。
    OPTIONS: { url: origin + '/src/options/options.html', tab: { id: 50, url: origin + '/src/options/options.html' } },
  };
}

// 擴充功能自己的頁面
const OPTIONS = { url: EXT_ORIGIN + '/src/options/options.html', tab: { id: 50, url: EXT_ORIGIN + '/src/options/options.html' } };
const POPUP = { url: EXT_ORIGIN + '/src/popup/popup.html' };

// 網頁裡的 content.js，frameId 不是 0 代表 iframe
function page(url, tabId = 7, frameId = 0) {
  return { url, frameId, tab: { id: tabId, url } };
}

module.exports = { loadBackground, OPTIONS, POPUP, page, ROOT };
