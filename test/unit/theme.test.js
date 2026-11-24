// 三套色系的顏色：每一套定的變數要一樣，文字和底色的對比要夠。
// 執行：node --test test/unit/
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { loadBackground, OPTIONS } = require('./load-background');

const ROOT = path.join(__dirname, '..', '..');
const THEMES = ['teal', 'white', 'dark'];

// ui.css 裡 :root[data-theme="xxx"] { ... } 那幾塊的變數
function cssPalettes() {
  const css = fs.readFileSync(path.join(ROOT, 'src/shared/ui.css'), 'utf8');
  const palettes = {};
  for (const theme of THEMES) {
    const block = css.match(new RegExp(':root\\[data-theme="' + theme + '"\\]\\s*\\{([^}]*)\\}'));
    assert.ok(block, 'ui.css 沒有 ' + theme + ' 這一套');
    palettes[theme] = Object.fromEntries([...block[1].matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
  }
  return palettes;
}

// WCAG 的相對亮度和對比
function luminance(hex) {
  const n = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// [文字, 底色]：一般文字要 4.5:1
const TEXT_PAIRS = [
  ['text', 'bg'],
  ['text', 'card'],
  ['text', 'card-alt'],
  ['text', 'hover'],
  ['text', 'selected'],
  ['muted', 'bg'],
  ['muted', 'card'],
  ['muted', 'card-alt'],
  ['muted', 'selected'],
  ['on-primary', 'primary'],
  ['on-primary', 'primary-hover'],
  ['link', 'card'],
  ['link', 'primary-soft'],
  ['primary-soft-text', 'primary-soft'],
  ['warn-text', 'warn-bg'],
  ['warn-text', 'warn-hover'],
  ['ok-text', 'ok-bg'],
  ['danger', 'card'],
  ['danger', 'danger-bg'],
  ['chrome-text', 'chrome-bg'],
  ['chrome-muted', 'chrome-bg'],
  ['chrome-text', 'chrome-field'],
  ['chrome-muted', 'chrome-field'],
  ['chrome-active-text', 'chrome-active'],
  ['tip-text', 'tip-bg'],
];

// [圖形, 底色]：按鈕、開關、圖示這種要 3:1
const SHAPE_PAIRS = [
  ['primary', 'card'],
  ['switch-off', 'card'],
  ['logo-fg', 'logo-bg'],
  ['knob-on', 'primary'],
];

test('三套色系定的變數一樣', () => {
  const p = cssPalettes();
  const keys = Object.keys(p.teal).sort();
  for (const theme of THEMES) assert.deepEqual(Object.keys(p[theme]).sort(), keys, theme + ' 跟青綠定的變數不一樣');
});

test('文字和底色的對比至少 4.5:1', () => {
  const p = cssPalettes();
  const low = [];
  for (const theme of THEMES) {
    for (const [fg, bg] of TEXT_PAIRS) {
      const ratio = contrast(p[theme][fg], p[theme][bg]);
      if (ratio < 4.5) low.push(theme + ' ' + fg + ' / ' + bg + ' = ' + ratio.toFixed(2));
    }
  }
  assert.deepEqual(low, []);
});

test('按鈕、開關、圖示和底色的對比至少 3:1', () => {
  const p = cssPalettes();
  const low = [];
  for (const theme of THEMES) {
    for (const [fg, bg] of SHAPE_PAIRS) {
      const ratio = contrast(p[theme][fg], p[theme][bg]);
      if (ratio < 3) low.push(theme + ' ' + fg + ' / ' + bg + ' = ' + ratio.toFixed(2));
    }
  }
  assert.deepEqual(low, []);
});

test('theme.set 只收跟著系統、白色、深色、青綠', async () => {
  const bg = loadBackground();
  await bg.settle();
  const stored = async () => (await bg.chrome.storage.local.get('uiTheme')).uiTheme;
  for (const theme of ['white', 'dark', 'teal']) {
    const res = await bg.send({ type: 'theme.set', theme }, OPTIONS);
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(await stored(), theme);
  }
  assert.equal((await bg.send({ type: 'theme.set', theme: 'system' }, OPTIONS)).ok, true);
  assert.equal(await stored(), undefined, '跟著系統時不存');
  for (const theme of ['pink', '', null, 'DARK', { toString: () => 'dark' }]) {
    const res = await bg.send({ type: 'theme.set', theme }, OPTIONS);
    assert.equal(res.ok, false, '應該拒絕 ' + JSON.stringify(theme));
    assert.equal(res.error, bg.text('bg_theme_invalid'));
  }
  assert.equal(await stored(), undefined);
});

// 網頁上的畫面（src/content/ui.js）不用 CSS 變數，三套顏色寫在 PALETTES
function contentPalettes() {
  const vm = require('vm');
  const sandbox = { PK: { i18n: { uiLocale: () => 'zh_TW' } } };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/content/ui.js'), 'utf8'), sandbox);
  return JSON.parse(JSON.stringify(sandbox.PK.contentUi.PALETTES));
}

const CONTENT_TEXT_PAIRS = [
  ['text', 'card'],
  ['muted', 'card'],
  ['text', 'selected'],
  ['muted', 'selected'],
  ['onPrimary', 'primary'],
  ['softText', 'soft'],
  ['link', 'card'],
  ['buttonText', 'button'],
  ['buttonText', 'buttonHover'],
  ['warnText', 'warnBg'],
  ['text', 'field'],
  ['barText', 'barBg'],
  ['barMuted', 'barBg'],
  ['barLink', 'barBg'],
  ['barText', 'barHover'],
  ['barText', 'barField'],
  ['barOnPrimary', 'barPrimary'],
  ['toastText', 'toastBg'],
];

test('網頁上的畫面：三套色系的顏色一樣多，文字對比至少 4.5:1', () => {
  const p = contentPalettes();
  assert.deepEqual(Object.keys(p).sort(), [...THEMES].sort());
  const keys = Object.keys(p.teal).sort();
  const low = [];
  for (const theme of THEMES) {
    assert.deepEqual(Object.keys(p[theme]).sort(), keys, theme + ' 跟青綠的顏色不一樣多');
    for (const [fg, bg] of CONTENT_TEXT_PAIRS) {
      const ratio = contrast(p[theme][fg], p[theme][bg]);
      if (ratio < 4.5) low.push(theme + ' ' + fg + ' / ' + bg + ' = ' + ratio.toFixed(2));
    }
    for (const [fg, bg] of [['logoFg', 'logoBg'], ['primary', 'card']]) {
      const ratio = contrast(p[theme][fg], p[theme][bg]);
      if (ratio < 3) low.push(theme + ' ' + fg + ' / ' + bg + ' = ' + ratio.toFixed(2));
    }
  }
  assert.deepEqual(low, []);
});
