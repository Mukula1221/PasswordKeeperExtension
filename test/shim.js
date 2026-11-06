// 測試用的假 chrome API。讓 background.js 和 content.js 可以直接跑在一般網頁裡。
// storage.local 放在 localStorage（重新整理後還在），storage.session 放在 sessionStorage。
(() => {
  function makeStorage(backing, key) {
    const readAll = () => JSON.parse(backing.getItem(key) || '{}');
    const writeAll = (obj) => backing.setItem(key, JSON.stringify(obj));
    return {
      async get(keys) {
        const all = readAll();
        if (keys == null) return all;
        const out = {};
        for (const k of [].concat(keys)) if (k in all) out[k] = all[k];
        return out;
      },
      async set(obj) {
        writeAll({ ...readAll(), ...obj });
      },
      async remove(keys) {
        const all = readAll();
        for (const k of [].concat(keys)) delete all[k];
        writeAll(all);
      },
    };
  }

  const listeners = [];
  const log = [];
  window.chrome = {
    runtime: {
      id: 'test-extension',
      lastError: null,
      onMessage: { addListener: (fn) => listeners.push(fn) },
      sendMessage(msg, cb) {
        log.push(msg.type);
        let responded = false;
        const respond = (r) => {
          if (responded) return;
          responded = true;
          if (cb) setTimeout(() => cb(r), 0);
        };
        for (const fn of listeners) fn(msg, { tab: { id: 1 } }, respond);
      },
      openOptionsPage() {},
    },
    storage: {
      local: makeStorage(localStorage, 'pk-local'),
      session: makeStorage(sessionStorage, 'pk-session'),
      // 背景程式聽語言設定的變更，測試頁不會換語言，聽了也收不到
      onChanged: { addListener() {} },
    },
    tabs: {
      onActivated: { addListener() {} },
      onUpdated: { addListener() {} },
      onRemoved: { addListener() {} },
      async query() { return [{ id: 1, url: location.href }]; },
      async get() { return { id: 1, url: location.href }; },
    },
    action: {
      setBadgeBackgroundColor() {},
      async setBadgeText() {},
    },
    // 測試頁一律用繁體中文。翻譯檔用同步的 XHR 讀，跟真的 chrome.i18n 一樣叫了馬上有結果。
    i18n: {
      getUILanguage: () => 'zh-TW',
      getMessage(key, subs) {
        if (!zhMessages) {
          const xhr = new XMLHttpRequest();
          xhr.open('GET', '../_locales/zh_TW/messages.json', false);
          xhr.send();
          zhMessages = JSON.parse(xhr.responseText);
        }
        const entry = zhMessages[key];
        if (!entry) return '';
        const list = [].concat(subs == null ? [] : subs);
        return entry.message.replace(/\$(\$|[1-9])/g, (m, d) => (d === '$' ? '$' : String(list[d - 1] ?? '')));
      },
    },
  };
  let zhMessages = null;
  // background.js 在測試頁不會跑 importScripts，content.js 也沒有 manifest 幫它先載 i18n.js，
  // 所以在這裡插進去，排在測試頁後面那幾個 script 前面
  document.write('<script src="../src/shared/i18n.js"><\/script>');
  window.importScripts = () => {};
  window.__pkLog = log;
  // 測試時方便從 console 叫背景程式
  window.__pkSend = (msg) => new Promise((resolve) => chrome.runtime.sendMessage(msg, resolve));
})();

// 正式版的 shadow DOM 是 closed，測試腳本碰不到裡面的按鈕。這裡把它改成 open，只影響測試頁。
(() => {
  const original = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function (init) {
    return original.call(this, { ...init, mode: 'open' });
  };
  window.__pkRoot = () => {
    const host = Array.from(document.querySelectorAll('html > div')).find((d) => d.style.zIndex === '2147483647');
    return host ? host.shadowRoot : null;
  };
})();

// popup 按「填入」會用 chrome.tabs.sendMessage 叫網頁裡的 content.js，測試頁沒有 content.js，會收到「不認得的訊息」
chrome.tabs.sendMessage = (tabId, msg, cb) =>
  new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (r) => {
      if (cb) cb(r);
      resolve(r);
    });
  });

// 快捷鍵的 API，測試頁用不到，只要讓 background.js 能註冊
chrome.commands = { onCommand: { addListener() {} } };

// 下載和排程的假物件：下載不真的寫檔，只回一個假路徑讓備份紀錄有東西可以記。
// 要模擬「清過下載紀錄」就把項目從 __pkDownloads 拿掉，模擬「檔案被搬走」就把那一項的 exists 改成 false。
chrome.downloads = {
  _items: [],
  _next: 1,
  async download(opts) {
    const id = this._next++;
    const filename = 'C:\\Users\\test\\Downloads\\' + String(opts.filename).split('/').join('\\');
    this._items.push({ id, state: "complete", filename, saveAs: !!opts.saveAs, byExtensionId: chrome.runtime.id, exists: true });
    return id;
  },
  async search(query) {
    return this._items.filter((i) => (query.id == null || i.id === query.id) && (query.filename == null || i.filename === query.filename));
  },
  async removeFile(id) {
    const item = this._items.find((i) => i.id === id);
    if (!item || item.state !== 'complete' || !item.exists) throw new Error('Download file already deleted');
    item.exists = false;
  },
};
// 計時器只記下排在什麼時候，不會真的響。要模擬響了就叫 window.__pkAlarm({ name: 'auto-backup' })。
chrome.alarms = {
  _alarms: {},
  async create(name, info) {
    this._alarms[name] = { name, scheduledTime: info.when || Date.now() + (info.delayInMinutes || info.periodInMinutes || 0) * 60000 };
  },
  async get(name) {
    return this._alarms[name];
  },
  async clear(name) {
    const had = name in this._alarms;
    delete this._alarms[name];
    return had;
  },
  onAlarm: { addListener(fn) { window.__pkAlarm = fn; } },
};
chrome.runtime.onStartup = { addListener() {} };
window.__pkDownloads = chrome.downloads._items;
window.__pkAlarms = chrome.alarms._alarms;

// 閒置偵測、驗證視窗、開分頁、開小視窗的假物件。測試頁用 window.__pkIdle / __pkAuth 直接呼叫註冊的函式。
chrome.idle = {
  setDetectionInterval() {},
  onStateChanged: { addListener(fn) { window.__pkIdle = fn; } },
};
chrome.webRequest = {
  onAuthRequired: { addListener(fn) { window.__pkAuth = fn; } },
};
chrome.tabs.create = async (opts) => {
  (window.__pkCreatedTabs = window.__pkCreatedTabs || []).push(opts.url);
  return { id: 2, url: opts.url };
};
chrome.action.openPopup = async () => {
  window.__pkPopupOpened = (window.__pkPopupOpened || 0) + 1;
};

// 開獨立視窗、取擴充功能內的網址
chrome.windows = {
  create: async (opts) => {
    (window.__pkWindows = window.__pkWindows || []).push(opts);
    return { id: 9 };
  },
};
chrome.runtime.getURL = (p) => '../' + p;

// 背景程式會用 promise 形式叫 chrome.runtime.sendMessage（沒給 callback），假物件也要回 promise
const __pkOrigSend = chrome.runtime.sendMessage;
chrome.runtime.sendMessage = (msg, cb) =>
  new Promise((resolve) => {
    __pkOrigSend(msg, (r) => {
      if (cb) cb(r);
      resolve(r);
    });
  });

// 版本分頁要讀 manifest 的版本號，測試頁由 page-harness 先抓好放在 window.__pkManifestVersion
chrome.runtime.getManifest = () => ({ version: window.__pkManifestVersion || '0.0.0' });
