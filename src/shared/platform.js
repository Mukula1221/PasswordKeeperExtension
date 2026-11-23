'use strict';
// 各瀏覽器、作業系統不一樣的地方集中在這裡，其他檔不要自己看 userAgent 或寫死 chrome-extension://。
// tools/check.js 會擋。這個檔不用別的檔，要最先載入。
(() => {
  const PK = (globalThis.PK ??= {});
  if (PK.platform) return;

  // 擴充功能自己的網址開頭，例如 chrome-extension://<ID>。Firefox 是 moz-extension://。
  // 不用 URL 的 origin：這種網址開頭照網址規格 origin 會是 "null"。
  // 測試頁的假 API 回傳相對路徑，所以要給基準網址。
  function extensionOrigin() {
    return new URL(chrome.runtime.getURL(''), self.location.href).href.replace(/\/$/, '');
  }

  // 瀏覽器核心：firefox，或 chromium（Edge、Chrome、Opera 這些）。看擴充功能網址的開頭，不看 userAgent。
  function engine() {
    return extensionOrigin().startsWith('moz-extension:') ? 'firefox' : 'chromium';
  }

  // 目前這一頁是不是擴充功能自己的畫面（小視窗、管理頁、解鎖視窗），畫面都放在 src/ 底下。
  // Firefox 的背景程式是瀏覽器產生的 /_generated_background_page.html，有 document 但不是畫面，不能自動套用介面文字。
  // 測試頁是 http 開頭，假 API 算出來的網址也在同一個網站底下，所以先排除 http、https。
  function isExtensionPage() {
    if (typeof document === 'undefined' || /^https?:$/.test(location.protocol)) return false;
    return location.href.startsWith(extensionOrigin() + '/src/');
  }

  // 各瀏覽器核心能做、不能做的事。其他檔用 can('能力名稱') 問，不自己判斷是哪個瀏覽器。
  // 加新的瀏覽器時在這裡加一列，每個能力都要寫。
  //   extensionWebAuthn：擴充功能自己的頁面能叫系統驗證（WebAuthn），而且用擴充功能 ID 當 RP ID。
  //     Firefox 150 起才讓擴充功能頁面用 WebAuthn，RP ID 也只能填一般網站的網域，填擴充功能自己的會被拒絕。
  //   screenLockEvents：閒置偵測會回報「鎖螢幕」。Firefox 只回報使用中和閒置，鎖螢幕後要等閒置時間到才會鎖。
  //   privateWindows：能在私密視窗用。AMO 規定 "Data from private browsing sessions must not be stored."，
  //     所以 Firefox 版在私密視窗整個停用，見 privateBlocked()。
  const CAPABILITIES = {
    chromium: { extensionWebAuthn: true, screenLockEvents: true, privateWindows: true },
    firefox: { extensionWebAuthn: false, screenLockEvents: false, privateWindows: false },
  };

  function can(capability) {
    const table = CAPABILITIES[engine()];
    if (!Object.hasOwn(table, capability)) throw new Error('platform.js 沒有這個能力：' + capability); // i18n-ignore：給開發者看的
    return table[capability];
  }

  // 目前這個頁面或網頁裡的腳本是不是在私密視窗。測試頁的假 API 沒有 chrome.extension。
  function inPrivateContext() {
    return !!(chrome.extension && chrome.extension.inIncognitoContext);
  }

  // 在私密視窗、而且這個瀏覽器不能在私密視窗用，就整個擋下來。
  // incognito 由呼叫的地方給：分頁的 tab.incognito、webRequest 的 details.incognito、網頁裡的腳本給 inPrivateContext()。
  function privateBlocked(incognito) {
    return !!incognito && !can('privateWindows');
  }

  // 管理頁提示「到擴充功能管理頁按重新載入」時，要寫哪個瀏覽器、哪個網址。
  // Firefox 直接載入資料夾的是「暫時載入的附加元件」，重新載入的按鈕在 about:debugging。
  function browserInfo() {
    if (engine() === 'firefox') return { name: 'Firefox', extensionsUrl: 'about:debugging#/runtime/this-firefox' };
    const brands = (navigator.userAgentData && navigator.userAgentData.brands) || [];
    const isEdge = brands.some((b) => /Edge/i.test(b.brand)) || /Edg\//.test(navigator.userAgent);
    return isEdge ? { name: 'Edge', extensionsUrl: 'edge://extensions' } : { name: 'Chrome', extensionsUrl: 'chrome://extensions' };
  }

  // 系統驗證的按鈕文字要寫 Windows Hello 還是 Touch ID
  function osName() {
    const p = ((navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '').toLowerCase();
    if (p.includes('win')) return 'windows';
    if (p.includes('mac')) return 'mac';
    return 'other';
  }

  PK.platform = { extensionOrigin, engine, isExtensionPage, can, inPrivateContext, privateBlocked, browserInfo, osName };
})();
