'use strict';
// 自動點選：找到使用者選的那顆按鈕、產生之後找得回來的選擇器、按下去。
(() => {
  const PK = (globalThis.PK ??= {});
  const { isVisible } = PK.contentFields;
  const TAG = '[密碼小管家]'; // i18n-ignore：console 訊息的前綴，給開發者看的，跟 content.js 的一樣

  // ---- 自動點選：找到使用者選的按鈕 ----

  const CLICKABLE = 'button, a, input, label, summary, [role=button], [role=link], [role=menuitem], [role=tab], [onclick]';

  // 使用者常常點到按鈕裡面的文字或圖示，要往外找到真正的按鈕
  function clickableOf(node) {
    const hit = node.closest(CLICKABLE);
    if (hit && hit !== document.body && hit !== document.documentElement) return hit;
    // 非標準的按鈕常常是 <div> 加 cursor: pointer。游標樣式會往內層繼承，所以一路往外找到最外層還是 pointer 的那個。
    if (getComputedStyle(node).cursor !== 'pointer') return node;
    let cur = node;
    while (cur.parentElement && cur.parentElement !== document.body && getComputedStyle(cur.parentElement).cursor === 'pointer') {
      cur = cur.parentElement;
    }
    return cur;
  }

  // 只有按鈕類的 input 才讀 value。文字欄和密碼欄的 value 是使用者打的內容，不能存進規則。
  function elementText(node) {
    let text = '';
    if (node.matches('input[type=submit], input[type=button], input[type=reset]')) text = node.value;
    else if (!node.matches('input, textarea, select')) text = node.innerText || node.textContent || '';
    if (!text.trim()) text = node.getAttribute('aria-label') || node.getAttribute('title') || node.getAttribute('alt') || '';
    return text.replace(/\s+/g, ' ').trim().slice(0, 80);
  }

  // 自動產生的 id、class 每次載入都可能變（像 ember123、css-1a2b3c、j_idt45），不能當定位依據
  const UNSTABLE_NAME = /\d{3,}|[0-9a-f]{8}|^(ember|ext-gen|j_idt|css-|sc-|jss|ng-)|-\d+$/i;
  // 這些 class 會隨狀態出現或消失，例如按鈕要等帳密填好才拿掉 disabled。
  // 選按鈕時滑鼠一定停在按鈕上，Ext JS 這時會多一個 x-btn-over，記下來下次就對不上。
  const STATE_CLASS = /(^|[-_])(active|hover|over|focus|focused|focusvisible|disabled|selected|pressed|open|show|loading)($|[-_])|^(is|has)-/i;

  // 這支檔案的 CSS 是產生畫面樣式表的函式，瀏覽器內建的 CSS 物件要寫 window.CSS
  const escapeCss = (text) => window.CSS.escape(text);

  function isUniqueSelector(selector, node) {
    const found = document.querySelectorAll(selector);
    return found.length === 1 && found[0] === node;
  }

  function selectorFor(node) {
    const tag = escapeCss(node.tagName.toLowerCase());
    if (node.id && !UNSTABLE_NAME.test(node.id)) {
      const byId = '#' + escapeCss(node.id);
      if (isUniqueSelector(byId, node)) return byId;
    }
    for (const attr of ['name', 'data-testid', 'data-test', 'data-qa', 'aria-label', 'title']) {
      const value = node.getAttribute(attr);
      if (!value || UNSTABLE_NAME.test(value)) continue;
      const byAttr = tag + '[' + attr + '="' + escapeCss(value) + '"]';
      if (isUniqueSelector(byAttr, node)) return byAttr;
    }
    const classes = Array.from(node.classList).filter((c) => !UNSTABLE_NAME.test(c) && !STATE_CLASS.test(c));
    if (classes.length) {
      const byClass = tag + classes.map((c) => '.' + escapeCss(c)).join('');
      if (isUniqueSelector(byClass, node)) return byClass;
    }
    // 都不夠唯一，就從最近有穩定 id 的祖先開始，一層一層記第幾個
    const parts = [];
    let cur = node;
    while (cur && cur !== document.documentElement) {
      if (cur !== node && cur.id && !UNSTABLE_NAME.test(cur.id) && isUniqueSelector('#' + escapeCss(cur.id), cur)) {
        parts.unshift('#' + escapeCss(cur.id));
        break;
      }
      const curTag = escapeCss(cur.tagName.toLowerCase());
      const twins = cur.parentElement ? Array.from(cur.parentElement.children).filter((c) => c.tagName === cur.tagName) : [cur];
      parts.unshift(twins.length > 1 ? curTag + ':nth-of-type(' + (twins.indexOf(cur) + 1) + ')' : curTag);
      cur = cur.parentElement;
    }
    return parts.join(' > ');
  }

  // pointer-events: none 真人也按不到，Nexus 的按鈕還不能按時就是這樣
  function clickReady(node) {
    return isVisible(node) && !node.disabled && node.getAttribute('aria-disabled') !== 'true' && getComputedStyle(node).pointerEvents !== 'none';
  }

  // 跟欄位的共同祖先越深，表示離得越近
  function sharedDepth(node, field) {
    let shared = node;
    while (shared && !shared.contains(field)) shared = shared.parentElement;
    let depth = 0;
    for (; shared; shared = shared.parentElement) depth++;
    return depth;
  }

  // 量按鈕中心點最上面是誰。不在視窗內的量不出來，當作沒被遮。
  function onTop(node) {
    const r = node.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) return true;
    const hit = document.elementFromPoint(x, y);
    return !hit || hit === PK.contentUi.host() || node.contains(hit);
  }

  // 同樣文字的按鈕不只一顆時（Nexus 右上角和登入框都叫 Sign in），留下離剛填好的欄位最近、沒被遮住的
  function narrowTargets(list, group) {
    if (list.length < 2) return list;
    const field = group && (group.pass || group.user);
    let rest = list;
    if (field) {
      const depths = list.map((node) => sharedDepth(node, field));
      const deepest = Math.max(...depths);
      rest = list.filter((node, i) => depths[i] === deepest);
    }
    return rest.length < 2 ? rest : rest.filter(onTop);
  }

  // 先用選的時候記下的位置找，文字也要對得上。網站改版後同一個位置可能變成別的按鈕，這時改用文字找，留下剛好一個才算數。
  // 還不能按的按鈕也要算進來一起比，不然它在等帳密驗證的時候，會改點到別顆同名的。
  function findClickTarget(rule, group) {
    const sameText = (node) => !rule.text || elementText(node) === rule.text;
    let found = [];
    try {
      found = Array.from(document.querySelectorAll(rule.selector)).filter(sameText);
    } catch (err) {
      console.warn(TAG, '自動點選的位置寫法有問題', rule.selector, err); // i18n-ignore：console 訊息給開發者看
    }
    // 按鈕在但還不能按（像要等帳密填好），就等它，不要改點別顆
    if (found.length) return narrowTargets(found.filter(isVisible), group).find(clickReady) || null;
    if (!rule.text) return null;
    const byText = narrowTargets(Array.from(document.querySelectorAll(CLICKABLE)).filter((node) => sameText(node) && isVisible(node)), group);
    return byText.length === 1 && clickReady(byText[0]) ? byText[0] : null;
  }

  // 非標準的按鈕常常綁在 mousedown 或 pointerdown，只發 click 不會有反應，所以照真的滑鼠點一下的順序全部發一次
  function fireClick(target) {
    const r = target.getBoundingClientRect();
    const init = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      button: 0,
      clientX: r.left + r.width / 2,
      clientY: r.top + r.height / 2,
    };
    const pointer = { ...init, pointerType: 'mouse', isPrimary: true };
    target.dispatchEvent(new PointerEvent('pointerdown', { ...pointer, buttons: 1 }));
    target.dispatchEvent(new MouseEvent('mousedown', { ...init, buttons: 1 }));
    if (typeof target.focus === 'function') target.focus({ preventScroll: true });
    target.dispatchEvent(new PointerEvent('pointerup', pointer));
    target.dispatchEvent(new MouseEvent('mouseup', init));
    // 最後一下交給 page-click.js 按，它收到會 preventDefault。沒收到（測試頁沒載它）才自己按。
    const detail = JSON.stringify({ clientX: init.clientX, clientY: init.clientY });
    const handled = !target.dispatchEvent(new CustomEvent('__pkClick', { cancelable: true, detail }));
    if (!handled) target.dispatchEvent(new MouseEvent('click', init));
  }

  PK.clickTarget = { CLICKABLE, clickableOf, elementText, findClickTarget, fireClick, selectorFor };
})();
