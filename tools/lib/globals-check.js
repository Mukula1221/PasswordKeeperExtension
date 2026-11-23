// 擴充功能的程式不定義全域的變數和函式：每個檔包在自己的閉包裡，要給別的檔用的放進全域的 PK。
// 這裡把字串、註解、正規表示式遮掉，只看最外層（不在任何括號裡）的程式碼。
'use strict';

// 回傳遮掉之後的程式碼，長度和換行位置都跟原本一樣，才對得回行號
function maskCode(src) {
  const out = src.split('');
  const blank = (a, b) => {
    for (let k = a; k < b; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  const n = src.length;
  let i = 0;
  let lastSig = '';
  let lastWord = '';
  const tmpl = [];
  const regexOk = () => !lastSig || '(,=:[!&|?{};+-*%<>~^'.includes(lastSig) || /^(return|typeof|case|do|else|in|of|new|delete|void|throw|yield|await)$/.test(lastWord);
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      const e = src.indexOf('\n', i);
      const stop = e < 0 ? n : e;
      blank(i, stop);
      i = stop;
    } else if (c === '/' && d === '*') {
      const e = src.indexOf('*/', i + 2);
      blank(i, e + 2);
      i = e + 2;
    } else if (c === "'" || c === '"') {
      let k = i + 1;
      while (k < n && src[k] !== c) k += src[k] === '\\' ? 2 : 1;
      blank(i + 1, k);
      i = k + 1;
      lastSig = c;
      lastWord = '';
    } else if (c === '`' || (c === '}' && tmpl.length && tmpl[tmpl.length - 1] === 0)) {
      if (c === '}') tmpl.pop();
      let k = i + 1;
      while (k < n && src[k] !== '`' && !(src[k] === '$' && src[k + 1] === '{')) k += src[k] === '\\' ? 2 : 1;
      blank(i + 1, k);
      if (src[k] === '`') {
        i = k + 1;
        lastSig = '`';
      } else {
        tmpl.push(0);
        i = k + 2;
        lastSig = '{';
      }
      lastWord = '';
    } else if (c === '/' && regexOk()) {
      let k = i + 1;
      let inClass = false;
      while (k < n && (inClass || src[k] !== '/')) {
        if (src[k] === '\\') k++;
        else if (src[k] === '[') inClass = true;
        else if (src[k] === ']') inClass = false;
        k++;
      }
      blank(i + 1, k);
      i = k + 1;
      while (/[a-z]/.test(src[i])) i++;
      lastSig = '/';
      lastWord = '';
    } else if (/[\w$]/.test(c)) {
      let k = i;
      while (k < n && /[\w$]/.test(src[k])) k++;
      lastWord = src.slice(i, k);
      lastSig = 'a';
      i = k;
    } else {
      if (c === '{' && tmpl.length) tmpl[tmpl.length - 1]++;
      if (c === '}' && tmpl.length) tmpl[tmpl.length - 1]--;
      if (!/\s/.test(c)) {
        lastSig = c;
        lastWord = '';
      }
      i++;
    }
  }
  return out.join('');
}

// 最外層出現 const、let、var、function、class 就是定義了全域的名稱。
// 也擋 window.xxx = 、globalThis.xxx = 、self.xxx = 這種直接掛到全域物件上的寫法，只放過 globalThis.PK。
function checkGlobals(file, src) {
  const masked = maskCode(src);
  const problems = [];
  const lineOf = (i) => masked.slice(0, i).split('\n').length;
  let depth = 0;
  for (let i = 0; i < masked.length; i++) {
    const c = masked[i];
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (depth === 0 && /[a-z]/.test(c) && !/[\w$.]/.test(masked[i - 1] || '')) {
      const word = masked.slice(i).match(/^[\w$]+/)[0];
      if (/^(const|let|var|function|class|async)$/.test(word)) problems.push(file + ':' + lineOf(i) + ' 最外層不能用 ' + word + ' 定義名稱，請包進閉包');
      i += word.length - 1;
    }
  }
  for (const m of masked.matchAll(/\b(window|globalThis|self)\.([\w$]+)\s*(\?\?=|=(?!=))/g)) {
    if (m[2] === 'PK') continue;
    problems.push(file + ':' + lineOf(m.index) + ' 不能把 ' + m[2] + ' 掛到全域，請放進 PK');
  }
  return problems;
}

module.exports = { maskCode, checkGlobals };
