'use strict';
// 網頁上的畫面（儲存提示、帳號清單、提示訊息）都畫在一個 closed shadow DOM 裡，網頁本身的 CSS 和 JS 碰不到。
// 這個檔負責建那個 shadow DOM、樣式和建元素的小工具。
(() => {
  const PK = (globalThis.PK ??= {});
  const { uiLocale } = PK.i18n;

  // ---- 畫面：shadow DOM ----

  // 日文介面要用日文字型：用中文字型的話，假名會排得很開、標點在字的正中間，按鈕也會擠到換行。
  // 韓文、泰文也指定各自的字型，跟 ui.css 一樣。
  const FONTS = {
    ja: '"Yu Gothic UI", Meiryo, "Hiragino Sans", "Noto Sans JP"',
    ko: '"Malgun Gothic", "Apple SD Gothic Neo", "Noto Sans KR"',
    th: '"Leelawadee UI", Thonburi, "Noto Sans Thai"',
  };
  const fontStack = () => '-apple-system, "Segoe UI", ' + (FONTS[uiLocale()] || '"Microsoft JhengHei", "PingFang TC", "Noto Sans TC"') + ', sans-serif';

  // 每次重新產生：管理頁換了語言，字型要跟著換
  const CSS = () => `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: ${fontStack()}; font-size: 14px; line-height: 1.4; color: #1f2937; }
    .banner { position: fixed; top: 12px; right: 12px; width: 340px; max-width: calc(100vw - 24px); background: #fff; border: 1px solid #d1d5db; border-radius: 10px; box-shadow: 0 8px 24px rgba(0,0,0,.18); padding: 14px; }
    .banner h2 { margin: 0 0 4px; font-size: 15px; font-weight: 600; display: flex; align-items: center; gap: 8px; }
    .banner h2 .logo { width: 18px; height: 18px; border-radius: 5px; background: #2563eb; display: inline-block; }
    .site { color: #6b7280; font-size: 12px; margin-bottom: 6px; word-break: break-all; }
    label { display: block; font-size: 12px; color: #6b7280; margin-top: 8px; }
    input { width: 100%; padding: 7px 8px; border: 1px solid #d1d5db; border-radius: 6px; font-size: 14px; background: #fff; color: #111; outline: none; }
    input:focus { border-color: #2563eb; }
    .pwwrap { position: relative; }
    .pwwrap input { padding-right: 64px; }
    .pwwrap button { position: absolute; right: 4px; top: 4px; padding: 3px 8px; background: transparent; color: #2563eb; }
    .row { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; justify-content: flex-end; align-items: center; }
    button { border: 0; border-radius: 6px; padding: 7px 12px; cursor: pointer; font-size: 13px; background: #e5e7eb; color: #111; white-space: nowrap; }
    button:hover { filter: brightness(.95); }
    button.primary { background: #2563eb; color: #fff; }
    button.link { background: transparent; color: #6b7280; margin-right: auto; padding-left: 0; font-size: 12px; }
    .dropdown { position: fixed; background: #fff; border: 1px solid #d1d5db; border-radius: 8px; box-shadow: 0 6px 18px rgba(0,0,0,.15); min-width: 220px; max-width: 360px; overflow: hidden; }
    .dropdown .head { padding: 5px 12px; font-size: 11px; color: #6b7280; background: #f9fafb; border-bottom: 1px solid #e5e7eb; }
    .dropdown .head.warn { padding: 8px 12px; font-size: 12px; color: #92400e; background: #fef3c7; }
    .dropdown .item { padding: 8px 12px; cursor: pointer; }
    .dropdown .item:hover, .dropdown .item.active { background: #eff6ff; }
    .dropdown .item.gen { color: #2563eb; border-bottom: 1px solid #e5e7eb; }
    .dropdown .item.locked { color: #92400e; background: #fef3c7; cursor: default; font-size: 13px; }
    .dropdown .item.gen .u { color: #2563eb; }
    .dropdown .item .u { font-weight: 600; word-break: break-all; }
    .dropdown .item .h { font-size: 11px; color: #6b7280; }
    .toast { position: fixed; top: 12px; right: 12px; background: #111827; color: #fff; padding: 10px 14px; border-radius: 8px; font-size: 13px; box-shadow: 0 6px 18px rgba(0,0,0,.2); }
    .pick-box { position: fixed; border: 3px solid #f97316; background: rgba(249,115,22,.25); box-shadow: 0 0 0 1px #fff; border-radius: 4px; pointer-events: none; }
    .pick-hint { position: fixed; top: 12px; left: 50%; transform: translateX(-50%); background: #111827; color: #fff; padding: 8px 14px; border-radius: 8px; font-size: 13px; box-shadow: 0 6px 18px rgba(0,0,0,.2); pointer-events: none; }
    .picked { font-weight: 600; word-break: break-all; }
    label.radio { display: flex; align-items: center; gap: 6px; font-size: 13px; color: #1f2937; margin-top: 6px; cursor: pointer; }
    label.radio input { width: auto; margin: 0; padding: 0; }
    .note { font-size: 12px; color: #92400e; margin-top: 6px; }
    .note:empty { display: none; }
  `;

  let shadowHost = null;
  let shadow = null;
  // CSSStyleSheet 或 <style>，換語言時用 refreshShadowStyle() 換字型
  let shadowStyle = null;
  // 外框的 style 屬性。瀏覽器會把寫進去的字串整理過，所以存整理後的樣子，之後才比得出網頁有沒有改過
  let hostStyle = '';

  function ui() {
    if (shadow && shadowHost.isConnected) return shadow;
    if (!shadow) {
      shadowHost = document.createElement('div');
      shadowHost.style.cssText = 'all:initial; position:fixed; top:0; left:0; width:0; height:0; z-index:2147483647;';
      hostStyle = shadowHost.getAttribute('style');
      shadow = shadowHost.attachShadow({ mode: 'closed' });
      // 有些網站的 CSP 會擋掉 <style>，adoptedStyleSheets 不受 CSP 管，優先用它。
      try {
        shadowStyle = new CSSStyleSheet();
        shadowStyle.replaceSync(CSS());
        shadow.adoptedStyleSheets = [shadowStyle];
      } catch {
        shadowStyle = document.createElement('style');
        shadowStyle.textContent = CSS();
        shadow.appendChild(shadowStyle);
      }
    }
    // 掛在 <html> 底下而不是 <body>，網頁整個換掉 body 時才不會跟著消失
    document.documentElement.appendChild(shadowHost);
    keepOnTop();
    return shadow;
  }

  // 網頁在 <html> 最後面再加一層、z-index 跟小管家一樣大時，那層會蓋在小管家的畫面上面。
  // 帳號清單或儲存提示開著時，有東西加到後面就把畫面移回最後面。
  // 跟網頁或別的擴充功能一直互搶時，一秒最多移 10 次。點下去那一刻 hiddenFromUser() 還會再檢查一次。
  let topObserver = null;
  let moves = { at: 0, count: 0 };
  function keepOnTop() {
    if (topObserver) return;
    topObserver = new MutationObserver(() => {
      if (!shadowHost.isConnected || document.documentElement.lastElementChild === shadowHost) return;
      if (!shadow.querySelector('.dropdown, .banner')) return;
      const now = Date.now();
      if (now - moves.at > 1000) moves = { at: now, count: 0 };
      if (++moves.count > 10) return;
      document.documentElement.appendChild(shadowHost);
    });
    topObserver.observe(document.documentElement, { childList: true });
  }

  // popover、modal dialog、全螢幕的元素在瀏覽器的最上層（top layer），z-index 再大都蓋不過。
  // whole 是會把整頁蓋住的：modal dialog 有整頁的背景遮罩，全螢幕就是整個畫面。
  function topLayerElements() {
    const found = [];
    for (const [selector, whole] of [
      [':popover-open', false],
      [':modal', true],
      [':fullscreen', true],
    ]) {
      try {
        for (const node of document.querySelectorAll(selector)) found.push({ node, whole });
      } catch {
        // 舊版瀏覽器不認得這個選擇器，也就不會有這種元素
      }
    }
    return found;
  }

  // 點擊劫持（clickjacking）的防線。網頁可能把小管家的畫面設成透明，或蓋一層假按鈕上去，騙使用者點下去。
  // 使用者點小管家的帳號清單、儲存提示時，先確認那塊畫面真的看得見，看不見就回 true，不能照點的做。
  // box 是被點的那塊畫面，point 是滑鼠點的位置。鍵盤操作沒有位置，改看那塊畫面的中間。
  function hiddenFromUser(box, point) {
    if (!shadowHost || !shadowHost.isConnected || !box.isConnected) return true;
    // 網頁改了外框的樣式就改回來，這一下不算
    if (shadowHost.getAttribute('style') !== hostStyle) {
      shadowHost.setAttribute('style', hostStyle);
      return true;
    }
    if (document.documentElement.lastElementChild !== shadowHost) {
      document.documentElement.appendChild(shadowHost);
      return true;
    }
    // 畫面掛在 html 底下，往上只有外框和 html 兩層。這兩層有讓畫面變淡、變糊、被裁掉的樣式都不算看得見。
    for (const node of [shadowHost, document.documentElement]) {
      const cs = getComputedStyle(node);
      if (cs.opacity !== '1' || cs.visibility !== 'visible' || cs.display === 'none') return true;
      if (/opacity|blur|brightness\(0|contrast\(0/.test(cs.filter) || cs.clipPath !== 'none' || (cs.maskImage && cs.maskImage !== 'none')) return true;
    }
    const r = box.getBoundingClientRect();
    if (r.width < 40 || r.height < 16) return true;
    const x = point ? point.x : r.left + r.width / 2;
    const y = point ? point.y : r.top + r.height / 2;
    if (document.elementFromPoint(x, y) !== shadowHost) return true;
    // 最上層的元素設成讓點擊穿過去時，elementFromPoint 查不到，所以另外找。popover 只看有沒有疊到這塊畫面。
    for (const { node, whole } of topLayerElements()) {
      if (node === shadowHost) continue;
      if (whole) return true;
      const lr = node.getBoundingClientRect();
      if (lr.right > r.left && lr.left < r.right && lr.bottom > r.top && lr.top < r.bottom) return true;
    }
    return false;
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  let toastTimer = null;
  function toast(text) {
    const root = ui();
    const old = root.querySelector('.toast');
    if (old) old.remove();
    const box = el('div', 'toast', text);
    root.appendChild(box);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => box.remove(), 2500);
  }

  function refreshShadowStyle() {
    if (!shadowStyle) return;
    if (shadowStyle instanceof CSSStyleSheet) shadowStyle.replaceSync(CSS());
    else shadowStyle.textContent = CSS();
  }

  // 別的檔要知道「這個元素是不是我們自己的畫面」時用。畫面還沒建之前是 null。
  function host() {
    return shadowHost;
  }

  function root() {
    return shadow;
  }

  PK.contentUi = { el, hiddenFromUser, host, refreshShadowStyle, root, toast, ui };
})();
