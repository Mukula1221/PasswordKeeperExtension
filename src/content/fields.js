'use strict';
// 找網頁上的登入欄位（帳號、密碼）和填值。只看網頁，不跟背景程式溝通。
(() => {
  const PK = (globalThis.PK ??= {});

  // ---- 找登入欄位 ----

  const TEXT_TYPES = new Set(['text', 'email', 'tel']);
  const USER_HINT = /user|email|mail|login|log-in|signin|sign-in|account|acct|member|identity|uid|帳號|账号|信箱|郵件|邮箱|使用者|用户|ユーザー|ユーザ|メール|アカウント/i;
  const SKIP_HINT = /captcha|otp|one-time|verification|verify|vcode|search|query|token|sms|\bpin\b/i;

  function attrText(el) {
    return [el.name, el.id, el.getAttribute('autocomplete'), el.placeholder, el.getAttribute('aria-label')]
      .filter(Boolean)
      .join(' ');
  }

  function isVisible(el) {
    if (!el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none';
  }

  function isUsable(el) {
    return !el.disabled && !el.readOnly && isVisible(el);
  }

  // 自動填入前多看一層：欄位和外面每一層都不能是透明的，也不能被移到頁面外面。
  // 廣告和追蹤程式會在頁面上插看不見的登入表單，等密碼管理工具自動填進去再讀走。
  function seenByUser(el) {
    if (!isVisible(el)) return false;
    let opacity = 1;
    for (let node = el; node; node = node.parentElement) {
      opacity *= parseFloat(getComputedStyle(node).opacity);
      if (opacity < 0.1) return false;
    }
    const r = el.getBoundingClientRect();
    const doc = document.documentElement;
    const left = r.left + window.scrollX;
    const top = r.top + window.scrollY;
    if (left + r.width <= 0 || top + r.height <= 0) return false;
    return left < Math.max(doc.scrollWidth, doc.clientWidth) && top < Math.max(doc.scrollHeight, doc.clientHeight);
  }

  function isTextInput(el) {
    return el instanceof HTMLInputElement && TEXT_TYPES.has(el.type);
  }

  function looksLikeUsername(el) {
    return el.getAttribute('autocomplete') === 'username' || el.type === 'email' || USER_HINT.test(attrText(el));
  }

  function usableInputs(scope) {
    return Array.from(scope.querySelectorAll('input'));
  }

  function precedes(a, b) {
    return !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
  }

  // 密碼欄的「範圍」：有 form 就用 form，沒有就往上找到第一個還包著其他文字欄位的祖先。
  // 這樣網頁頂端的搜尋框才不會被當成帳號欄。
  function containerFor(passEl) {
    if (passEl.form) return passEl.form;
    let node = passEl.parentElement;
    for (let depth = 0; node && depth < 10; depth++, node = node.parentElement) {
      const others = usableInputs(node).filter((el) => el !== passEl && isTextInput(el) && isUsable(el));
      if (others.length) return node;
    }
    return document.body || document.documentElement;
  }

  function findUsernameFor(passEl, scope) {
    const candidates = usableInputs(scope).filter(
      (el) =>
        el !== passEl &&
        isTextInput(el) &&
        isUsable(el) &&
        precedes(el, passEl) &&
        !SKIP_HINT.test(attrText(el)) &&
        el.getAttribute('autocomplete') !== 'one-time-code'
    );
    if (!candidates.length) return null;
    const hinted = candidates.filter(looksLikeUsername);
    const pool = hinted.length ? hinted : candidates;
    // 離密碼欄最近的那個
    return pool[pool.length - 1];
  }

  // 回傳頁面上的登入群組：{ kind, user, pass, passList, container }
  // kind: 'login' 一般登入；'signup' 有兩個以上密碼欄（註冊、改密碼）；'useronly' 只有帳號欄（兩段式登入第一頁）
  function detectGroups() {
    const groups = [];
    const seen = new Set();
    const passFields = Array.from(document.querySelectorAll('input[type=password]')).filter(isUsable);
    for (const pass of passFields) {
      const container = containerFor(pass);
      if (seen.has(container)) continue;
      seen.add(container);
      const passList = Array.from(container.querySelectorAll('input[type=password]')).filter(isUsable);
      const user = findUsernameFor(passList[0], container);
      groups.push({ kind: passList.length >= 2 ? 'signup' : 'login', user, pass: passList[0], passList, container });
    }
    if (passFields.length === 0) {
      for (const el of usableInputs(document)) {
        if (!isTextInput(el) || !isUsable(el)) continue;
        if (SKIP_HINT.test(attrText(el))) continue;
        const strong = el.getAttribute('autocomplete') === 'username';
        if (!strong && !looksLikeUsername(el)) continue;
        const container = el.form || el.closest('form') || el.parentElement || document.body;
        const texts = usableInputs(container).filter((x) => isTextInput(x) && isUsable(x));
        // 一堆文字欄位的通常是註冊或聯絡表單，不是登入
        if (texts.length > 2) continue;
        groups.push({ kind: 'useronly', user: el, pass: null, passList: [], container, strong });
        break;
      }
    }
    return groups;
  }

  const nativeValueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;

  const filledValue = new WeakMap();

  function setValue(el, value) {
    // React 會攔截 input.value 的 setter，直接設 el.value 它不會發現值變了，要用原生的 setter 再補發事件。
    nativeValueSetter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
    filledValue.set(el, value);
  }

  // force=false 時不覆蓋使用者自己打的字，只填空的或我們之前自動填的
  function canFill(el, force) {
    return force || !el.value || filledValue.get(el) === el.value;
  }

  PK.contentFields = { attrText, canFill, detectGroups, isTextInput, isUsable, isVisible, seenByUser, setValue, usableInputs };
})();
