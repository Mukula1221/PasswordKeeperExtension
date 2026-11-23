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

  // 目前這一頁是不是擴充功能自己的頁面（小視窗、管理頁、解鎖視窗）。
  // 測試頁是 http 開頭，假 API 算出來的網址也在同一個網站底下，所以先排除 http、https。
  function isExtensionPage() {
    if (typeof document === 'undefined' || /^https?:$/.test(location.protocol)) return false;
    return location.href.startsWith(extensionOrigin() + '/');
  }

  // 管理頁提示「到擴充功能管理頁按重新載入」時，要寫哪個瀏覽器、哪個網址
  function browserInfo() {
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

  PK.platform = { extensionOrigin, isExtensionPage, browserInfo, osName };
})();
