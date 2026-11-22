// 多國語系的檢查，tools/check.js 用：
// 每種語言的 key 要跟繁體中文一樣、替換值 $1 $2 要對得上、程式用到的 key 都要有、HTML 裡的預設文字要跟繁體中文一樣、
// 程式和 HTML 裡不能還有沒翻到的中文。比對網頁文字用的中文（例如認登入按鈕）在那一行寫 i18n-ignore 跳過。
const HAN = /[㐀-鿿豈-﫿]/;
// 介面的語言，要跟 src/shared/i18n.js 的 i18nLocales() 一樣
const LOCALES = ['zh_TW', 'nan_TW', 'en', 'ja', 'ko', 'de', 'ru', 'th'];
// 版本紀錄（changelog.js）和 GitHub Release 說明只寫這三種，其他語言的介面看英文的
const CHANGELOG_LOCALES = ['zh_TW', 'en', 'ja'];

const placeholdersOf = (text) => [...new Set((text.replace(/\$\$/g, '').match(/\$[1-9]/g) || []))].sort().join(',');

// tn() 在這個語言會挑到的寫法。one、other 每種語言都要有，俄文另外要 few、many。
// 台語跟 i18n.js 的 formatLang() 一樣用台灣華語的規則：Node 沒有台語，會退回這台電腦的語言，每台算出來不一樣。
function pluralFormsOf(langTag) {
  const forms = new Set(['one', 'other']);
  for (const form of new Intl.PluralRules(langTag.startsWith('nan') ? 'zh-Hant-TW' : langTag).resolvedOptions().pluralCategories) forms.add(form);
  return forms;
}
const EXTRA_PLURAL = /_(zero|two|few|many)$/;

// Chrome 載入翻譯檔時，把兩個 $ 中間是英數字的當成具名替換值（例如 $name$），沒定義就整個擴充功能載入失敗。
// 連著寫的 $4$5 也會被讀成 $4$。照 Chrome 的找法找一遍。
function namedPlaceholderIn(text) {
  let from = 0;
  for (;;) {
    const begin = text.indexOf('$', from);
    if (begin < 0) return null;
    const end = text.indexOf('$', begin + 1);
    if (end < 0) return null;
    const name = text.slice(begin + 1, end);
    if (/^[A-Za-z0-9_@]+$/.test(name)) return '$' + name + '$';
    from = begin + 1;
  }
}

function checkMessages(messages) {
  const problems = [];
  const base = Object.keys(messages.zh_TW || {});
  const plurals = base.filter((k) => k.endsWith('_one')).map((k) => k.slice(0, -4));
  for (const loc of LOCALES) {
    if (!messages[loc]) {
      problems.push('_locales/' + loc + '/messages.json 不存在');
      continue;
    }
    const forms = [...pluralFormsOf(messages[loc].lang_tag || loc)].filter((f) => f !== 'one' && f !== 'other');
    const expected = [...base, ...plurals.flatMap((p) => forms.map((f) => p + '_' + f))];
    const keys = Object.keys(messages[loc]);
    for (const k of expected) if (!keys.includes(k)) problems.push(loc + ' 少了 ' + k);
    for (const k of keys) if (!expected.includes(k)) problems.push(loc + ' 多了 ' + k + '，繁體中文沒有');
    for (const [k, text] of Object.entries(messages[loc])) {
      // 俄文的 _few、_many 繁體中文沒有，替換值跟 _one 比
      const source = messages.zh_TW[k] !== undefined ? messages.zh_TW[k] : messages.zh_TW[k.replace(EXTRA_PLURAL, '_one')];
      if (typeof text !== 'string' || !text.trim()) problems.push(loc + ' 的 ' + k + ' 是空的');
      else if (namedPlaceholderIn(text)) problems.push(loc + ' 的 ' + k + ' 有 ' + namedPlaceholderIn(text) + '，Chrome 會讀成沒定義的具名替換值、整個擴充功能載入失敗。替換值中間要隔開');
      else if (/\$(?![1-9$])/.test(text.replace(/\$\$/g, ''))) problems.push(loc + ' 的 ' + k + ' 有單獨的 $，文字裡的 $ 要寫成 $$');
      else if (source !== undefined && placeholdersOf(text) !== placeholdersOf(source)) {
        problems.push(loc + ' 的 ' + k + ' 用的替換值（' + placeholdersOf(text) + '）跟繁體中文（' + placeholdersOf(source) + '）不一樣');
      }
    }
  }
  return problems;
}

// 程式和 HTML 用到的 key。key 要寫死在程式裡，不能用字串拼出來，不然這裡找不到。
function usedKeys(text) {
  const keys = new Set();
  for (const m of text.matchAll(/\bt\(\s*'([A-Za-z0-9_]+)'/g)) keys.add(m[1]);
  for (const m of text.matchAll(/\btn\(\s*'([A-Za-z0-9_]+)'/g)) {
    keys.add(m[1] + '_one');
    keys.add(m[1] + '_other');
  }
  for (const m of text.matchAll(/data-i18n(?:-[a-z-]+)?="([A-Za-z0-9_]+)"/g)) keys.add(m[1]);
  for (const m of text.matchAll(/dataset\.i18n[A-Za-z]*\s*=\s*'([A-Za-z0-9_]+)'/g)) keys.add(m[1]);
  for (const m of text.matchAll(/__MSG_([A-Za-z0-9_]+)__/g)) keys.add(m[1]);
  return keys;
}

const lineOf = (text, index) => text.slice(0, index).split('\n').length;
const ignored = (text, index) => {
  const start = text.lastIndexOf('\n', index) + 1;
  const end = text.indexOf('\n', index);
  return /i18n-ignore/.test(text.slice(start, end < 0 ? text.length : end));
};

// 找出字串裡沒翻到的中文。跳過註解和正規表示式，正規表示式裡的中文是拿來比對網頁文字的。
function untranslatedInJs(name, text) {
  const problems = [];
  const regexAfterWord = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw', 'yield', 'await']);
  let prev = '';
  let word = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i);
      i = end < 0 ? text.length : end;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 2;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < text.length && text[j] !== c) j += text[j] === '\\' ? 2 : 1;
      const literal = text.slice(i + 1, j);
      if (HAN.test(literal) && !ignored(text, i)) problems.push(name + ':' + lineOf(text, i) + ' 還有沒翻到的中文：' + literal.slice(0, 40));
      i = j + 1;
      prev = c;
      word = '';
      continue;
    }
    if (c === '/' && (/[(,=:[!&|?{};+\-*%<>~^]/.test(prev) || prev === '' || regexAfterWord.has(word))) {
      let j = i + 1;
      let inClass = false;
      while (j < text.length && text[j] !== '\n') {
        if (text[j] === '\\') j++;
        else if (text[j] === '[') inClass = true;
        else if (text[j] === ']') inClass = false;
        else if (text[j] === '/' && !inClass) break;
        j++;
      }
      i = j + 1;
      prev = '/';
      word = '';
      continue;
    }
    if (/[A-Za-z0-9_$]/.test(c)) {
      let j = i;
      while (j < text.length && /[A-Za-z0-9_$]/.test(text[j])) j++;
      word = text.slice(i, j);
      prev = 'a';
      i = j;
      continue;
    }
    if (!/\s/.test(c)) {
      prev = c;
      word = '';
    }
    i++;
  }
  return problems;
}

const ATTRS = { placeholder: 'data-i18n-placeholder', title: 'data-i18n-title', 'aria-label': 'data-i18n-aria-label', 'data-tip': 'data-i18n-tip' };

const decode = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');

// HTML：有中文的地方都要掛 data-i18n，掛了的預設文字要跟繁體中文一字不差
function checkHtml(name, html, zh) {
  const problems = [];
  const clean = html.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' ')).replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, (m) => m.replace(/[^\n]/g, ' '));
  for (const tag of clean.matchAll(/<([a-zA-Z][\w-]*)\b([^>]*)>/g)) {
    const attrs = {};
    for (const a of tag[2].matchAll(/([\w-]+)="([^"]*)"/g)) attrs[a[1]] = decode(a[2]);
    for (const [attr, i18nAttr] of Object.entries(ATTRS)) {
      if (attrs[attr] === undefined || !HAN.test(attrs[attr])) continue;
      const key = attrs[i18nAttr];
      if (!key) problems.push(name + ':' + lineOf(clean, tag.index) + ' 的 ' + attr + ' 沒有掛 ' + i18nAttr + '：' + attrs[attr].slice(0, 30));
      else if (zh[key] !== undefined && zh[key] !== attrs[attr]) problems.push(name + ':' + lineOf(clean, tag.index) + ' 的 ' + attr + ' 跟繁體中文的 ' + key + ' 不一樣');
    }
  }
  let rest = clean.replace(/<([a-zA-Z][\w-]*)\b[^>]*\bdata-i18n="([A-Za-z0-9_]+)"[^>]*>([^<]*)<\/\1>/g, (m, tagName, key, inner, index) => {
    const text = decode(inner).trim();
    if (zh[key] !== undefined && text !== zh[key]) problems.push(name + ':' + lineOf(clean, index) + ' 的預設文字跟繁體中文的 ' + key + ' 不一樣：' + text.slice(0, 30));
    return m.replace(/[^\n]/g, ' ');
  });
  rest = rest.replace(/<[^>]*>/g, (m) => m.replace(/[^\n]/g, ' '));
  for (const m of rest.matchAll(/[^\s]*[㐀-鿿豈-﫿][^\n<]*/g)) {
    problems.push(name + ':' + lineOf(rest, m.index) + ' 還有沒掛 data-i18n 的中文：' + m[0].trim().slice(0, 40));
  }
  return problems;
}

// i18n.js 的 i18nLocales() 和管理頁語言選單的選項，都要跟 LOCALES 一樣
function checkLocaleLists(i18nJs, optionsHtml) {
  const problems = [];
  const same = (list) => list.length === LOCALES.length && LOCALES.every((loc) => list.includes(loc));
  const m = i18nJs.match(/function i18nLocales\(\) \{\s*return (\[[^\]]*\])/);
  const fromJs = m ? JSON.parse(m[1].replace(/'/g, '"')) : null;
  if (!fromJs) problems.push('src/shared/i18n.js 找不到 i18nLocales() 的清單');
  else if (!same(fromJs)) problems.push('src/shared/i18n.js 的 i18nLocales()（' + fromJs.join(', ') + '）跟 tools/lib/i18n-check.js 的 LOCALES（' + LOCALES.join(', ') + '）不一樣');
  const select = optionsHtml.match(/<select id="langSelect"[\s\S]*?<\/select>/);
  const fromHtml = select ? [...select[0].matchAll(/<option value="([^"]+)"/g)].map((x) => x[1]).filter((v) => v !== 'auto') : [];
  if (!same(fromHtml)) problems.push('管理頁語言選單的選項（' + fromHtml.join(', ') + '）跟 LOCALES（' + LOCALES.join(', ') + '）不一樣');
  return problems;
}

module.exports = { LOCALES, CHANGELOG_LOCALES, HAN, checkMessages, checkLocaleLists, usedKeys, untranslatedInJs, checkHtml };
