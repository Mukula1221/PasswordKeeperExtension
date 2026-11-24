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

  // 三套色系，跟 src/shared/ui.css 的顏色對應。網頁上的畫面在 closed shadow DOM 裡，不用 CSS 變數：
  // 變數會從外框繼承，網頁的樣式表可以改外框的變數，把小管家的畫面改成透明或換顏色。顏色直接寫進樣式，網頁就碰不到。
  // test/unit/theme.test.js 會檢查三套的顏色一樣多、文字對比夠不夠。
  const PALETTES = {
    teal: {
      card: '#FFFFFF', text: '#10201E', muted: '#51625F', border: '#DDE7E5', divider: '#EEF3F2', field: '#FFFFFF', fieldBorder: '#B9C9C5',
      primary: '#0B7A6E', onPrimary: '#FFFFFF', soft: '#E3F3F0', softText: '#075A51', selected: '#E3F3F0', link: '#075A51',
      button: '#EEF3F2', buttonText: '#10201E', buttonHover: '#E3ECEA', warnBg: '#FFF1DC', warnText: '#7A4500',
      barBg: '#0F2A2E', barText: '#E9F3F1', barMuted: '#A9C9C4', barBorder: '#0F2A2E', barButtonBorder: '#2D4E52', barHover: '#173B3F',
      barField: '#183A3E', barLink: '#7FE3D5', barPrimary: '#19C2AD', barOnPrimary: '#0F2A2E',
      logoBg: '#19C2AD', logoFg: '#0F2A2E', toastBg: '#10201E', toastText: '#FFFFFF', shadow: 'rgba(15,42,46,.25)',
    },
    white: {
      card: '#FFFFFF', text: '#18202B', muted: '#5B6675', border: '#E4E8EE', divider: '#EEF1F5', field: '#FFFFFF', fieldBorder: '#C3CBD6',
      primary: '#2563EB', onPrimary: '#FFFFFF', soft: '#E8F0FE', softText: '#1D4ED8', selected: '#EAF1FE', link: '#1D4ED8',
      button: '#EEF1F5', buttonText: '#18202B', buttonHover: '#E4E8EE', warnBg: '#FFF4E0', warnText: '#7A4500',
      barBg: '#FFFFFF', barText: '#18202B', barMuted: '#5B6675', barBorder: '#E4E8EE', barButtonBorder: '#D5DBE3', barHover: '#F1F4F8',
      barField: '#F5F7FA', barLink: '#1D4ED8', barPrimary: '#2563EB', barOnPrimary: '#FFFFFF',
      logoBg: '#2563EB', logoFg: '#FFFFFF', toastBg: '#18202B', toastText: '#FFFFFF', shadow: 'rgba(24,32,43,.18)',
    },
    dark: {
      card: '#161B22', text: '#E6EDF3', muted: '#9AA7B4', border: '#2A323D', divider: '#222A34', field: '#0E1116', fieldBorder: '#3E4855',
      primary: '#A99BFF', onPrimary: '#15112E', soft: '#2A2550', softText: '#D9D2FF', selected: '#2A2550', link: '#C9C0FF',
      button: '#1F2630', buttonText: '#E6EDF3', buttonHover: '#2A323D', warnBg: '#3A2A12', warnText: '#F5C77E',
      barBg: '#161B22', barText: '#E6EDF3', barMuted: '#9AA7B4', barBorder: '#2A323D', barButtonBorder: '#3E4855', barHover: '#1F2630',
      barField: '#0E1116', barLink: '#C9C0FF', barPrimary: '#A99BFF', barOnPrimary: '#15112E',
      logoBg: '#A99BFF', logoFg: '#15112E', toastBg: '#2A323D', toastText: '#E6EDF3', shadow: 'rgba(0,0,0,.5)',
    },
  };

  // 目前用哪一套。content.js 讀到使用者選的色系後用 setTheme() 換
  let theme = 'teal';

  // 每次重新產生：管理頁換了語言，字型要跟著換；換了色系，顏色要跟著換
  const CSS = () => {
    const c = PALETTES[theme];
    return `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: ${fontStack()}; font-size: 14px; line-height: 1.4; color: ${c.text}; }
    [hidden] { display: none !important; }
    svg { display: block; width: 100%; height: 100%; }
    .logo { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; padding: 6px; border-radius: 8px; background: ${c.logoBg}; color: ${c.logoFg}; }
    .logo * { color: inherit; }
    .banner { position: fixed; top: 12px; right: 12px; width: 340px; max-width: calc(100vw - 24px); background: ${c.card}; border: 1px solid ${c.border}; border-radius: 12px; box-shadow: 0 12px 30px ${c.shadow}; padding: 14px; }
    .banner h2 { margin: 0 0 4px; font-size: 15px; font-weight: 700; display: flex; align-items: center; gap: 8px; }
    .banner h2 .logo { width: 22px; height: 22px; padding: 4px; border-radius: 6px; }
    .site { color: ${c.muted}; font-size: 12px; margin-bottom: 6px; word-break: break-all; }
    label { display: block; font-size: 12px; color: ${c.muted}; margin-top: 8px; }
    input { width: 100%; padding: 7px 9px; border: 1px solid ${c.fieldBorder}; border-radius: 8px; font-size: 14px; background: ${c.field}; color: ${c.text}; outline: none; }
    input:focus { border-color: ${c.primary}; }
    .pwwrap { position: relative; }
    .pwwrap input { padding-right: 64px; }
    .pwwrap button { position: absolute; right: 4px; top: 4px; padding: 3px 8px; background: transparent; color: ${c.link}; }
    .row { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; justify-content: flex-end; align-items: center; }
    button { border: 0; border-radius: 8px; padding: 7px 12px; cursor: pointer; font-size: 13px; background: ${c.button}; color: ${c.buttonText}; white-space: nowrap; }
    button:hover { background: ${c.buttonHover}; }
    button.primary { background: ${c.primary}; color: ${c.onPrimary}; font-weight: 600; }
    button.primary:hover { filter: brightness(1.08); }
    button.link { background: transparent; color: ${c.muted}; margin-right: auto; padding-left: 0; font-size: 12px; }
    button:focus-visible { outline: 2px solid ${c.primary}; outline-offset: 2px; }
    .bar { left: 50%; right: auto; transform: translateX(-50%); width: min(640px, calc(100vw - 24px)); max-width: none; padding: 10px 12px 10px 14px; background: ${c.barBg}; border-color: ${c.barBorder}; }
    .bar * { color: ${c.barText}; }
    .bar .logo, .bar .logo * { color: ${c.logoFg}; }
    .bar-top { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; }
    .bar-text { flex: 1 1 220px; min-width: 0; }
    .bar-title { font-size: 14px; font-weight: 700; }
    .bar-sub { display: flex; align-items: baseline; gap: 6px; font-size: 12px; }
    .bar-sub .who { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: ${c.barMuted}; font-size: 12px; }
    .bar-sub button { flex: none; margin: 0; padding: 0; background: transparent; color: ${c.barLink}; font-size: 12px; text-decoration: underline; }
    .bar-actions { display: flex; align-items: center; gap: 8px; margin-left: auto; }
    .bar-actions button { height: 34px; padding: 0 14px; border: 1px solid ${c.barButtonBorder}; background: transparent; color: ${c.barText}; }
    .bar-actions button:hover { background: ${c.barHover}; }
    .bar-actions button.link { margin: 0; padding: 0 6px; border: 0; color: ${c.barMuted}; font-size: 13px; }
    .bar-actions button.primary { border: 0; background: ${c.barPrimary}; color: ${c.barOnPrimary}; }
    .bar-form { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 12px; margin-top: 8px; padding-top: 4px; border-top: 1px solid ${c.barButtonBorder}; }
    .bar-form label { color: ${c.barMuted}; }
    .bar-form input { background: ${c.barField}; border-color: ${c.barButtonBorder}; color: ${c.barText}; }
    .bar-form input:focus { border-color: ${c.barPrimary}; }
    .bar-form .pwwrap button { background: transparent; color: ${c.barLink}; border: 0; }
    @media (max-width: 520px) { .bar-form { grid-template-columns: minmax(0, 1fr); } }
    .dropdown { position: fixed; background: ${c.card}; border: 1px solid ${c.border}; border-radius: 10px; box-shadow: 0 10px 26px ${c.shadow}; min-width: 220px; max-width: 360px; overflow: hidden; }
    .dropdown .head { padding: 6px 12px; font-size: 11px; color: ${c.muted}; border-bottom: 1px solid ${c.divider}; }
    .dropdown .head.warn { padding: 8px 12px; font-size: 12px; color: ${c.warnText}; background: ${c.warnBg}; }
    .dropdown .item { display: flex; align-items: center; gap: 10px; padding: 8px 12px; cursor: pointer; }
    .dropdown .item:hover, .dropdown .item.active { background: ${c.selected}; }
    .dropdown .item .initial { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px; border-radius: 7px; background: ${c.soft}; color: ${c.softText}; font-size: 12px; font-weight: 700; text-transform: uppercase; }
    .dropdown .item.active .initial { background: ${c.primary}; color: ${c.onPrimary}; }
    .dropdown .item .texts { flex: 1; min-width: 0; }
    .dropdown .item .key { flex: none; font-size: 11px; color: ${c.muted}; visibility: hidden; }
    .dropdown .item.active .key { visibility: visible; }
    .dropdown .item.gen { border-bottom: 1px solid ${c.divider}; }
    .dropdown .item.gen .u { color: ${c.link}; }
    .dropdown .item.locked { color: ${c.warnText}; background: ${c.warnBg}; cursor: default; font-size: 13px; }
    .dropdown .item .u { font-weight: 600; word-break: break-all; }
    .dropdown .item .h { font-size: 11px; color: ${c.muted}; }
    .field-icon { position: fixed; display: flex; align-items: center; justify-content: center; padding: 4px; border-radius: 6px; background: ${c.soft}; color: ${c.softText}; pointer-events: none; }
    .field-icon * { color: inherit; }
    .toast { position: fixed; top: 12px; right: 12px; background: ${c.toastBg}; color: ${c.toastText}; padding: 10px 14px; border-radius: 8px; font-size: 13px; box-shadow: 0 6px 18px ${c.shadow}; }
    .pick-box { position: fixed; border: 3px solid #f97316; background: rgba(249,115,22,.25); box-shadow: 0 0 0 1px #fff; border-radius: 4px; pointer-events: none; }
    .pick-hint { position: fixed; top: 12px; left: 50%; transform: translateX(-50%); background: ${c.toastBg}; color: ${c.toastText}; padding: 8px 14px; border-radius: 8px; font-size: 13px; box-shadow: 0 6px 18px ${c.shadow}; pointer-events: none; }
    .picked { font-weight: 600; word-break: break-all; }
    label.radio { display: flex; align-items: center; gap: 6px; font-size: 13px; color: ${c.text}; margin-top: 6px; cursor: pointer; }
    label.radio input { width: auto; margin: 0; padding: 0; accent-color: ${c.primary}; }
    .note { font-size: 12px; color: ${c.warnText}; margin-top: 6px; }
    .note:empty { display: none; }
  `;
  };

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

  // 換成 PALETTES 的其中一套，畫面已經建好的話馬上換顏色
  function setTheme(name) {
    theme = Object.hasOwn(PALETTES, name) ? name : 'teal';
    refreshShadowStyle();
  }

  // 方塊鎖頭：儲存提示的圖示、帳號欄位右邊的小鎖頭
  const SVG_NS = 'http://www.w3.org/2000/svg';
  function logoMark(className) {
    const box = el('span', className);
    box.setAttribute('aria-hidden', 'true');
    const svg = document.createElementNS(SVG_NS, 'svg');
    for (const [k, v] of [['viewBox', '0 0 24 24'], ['fill', 'none'], ['stroke', 'currentColor'], ['stroke-width', '2.4'], ['stroke-linecap', 'round'], ['stroke-linejoin', 'round']]) svg.setAttribute(k, v);
    const rect = document.createElementNS(SVG_NS, 'rect');
    for (const [k, v] of [['x', '5'], ['y', '11'], ['width', '14'], ['height', '9'], ['rx', '2']]) rect.setAttribute(k, v);
    const lock = document.createElementNS(SVG_NS, 'path');
    lock.setAttribute('d', 'M8 11V8a4 4 0 0 1 8 0v3');
    svg.appendChild(rect);
    svg.appendChild(lock);
    box.appendChild(svg);
    return box;
  }

  PK.contentUi = { PALETTES, el, hiddenFromUser, host, logoMark, refreshShadowStyle, root, setTheme, toast, ui };
})();
