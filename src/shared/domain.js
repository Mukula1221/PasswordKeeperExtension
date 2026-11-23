'use strict';
// 網域和網址比對。背景程式和網頁裡的 content.js 共用。
(() => {
  const PK = (globalThis.PK ??= {});


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

  PK.domain = { baseDomain, hostFromUrl, originFromUrl, rulePathMatches };
})();
