// 介面文字的多國語系：從 _locales/<語言>/messages.json 拿文字。
// 管理頁右上角可以指定語言，存在 storage 的 uiLanguage。沒指定就照瀏覽器的介面語言，瀏覽器語言不是繁中、英文、日文時用英文。
// 小視窗、管理頁、解鎖視窗、網頁裡的 content.js 和背景程式都會載入這個檔。
//
// HTML：<span data-i18n="ext_name">密碼小管家</span>。屬性用 data-i18n-placeholder、data-i18n-title、data-i18n-aria-label、data-i18n-tip。
// 程式：t('ext_name')。有替換值的寫 t(key, 值1, 值2)，訊息裡用 $1、$2 對應。
// 數量會影響英文單複數時用 tn('pop_account_count', 數量)，翻譯檔要有 pop_account_count_one 和 pop_account_count_other。
//
// 這個檔只宣告函式和 var，不宣告 const、let：test/ 的測試頁會重複載入這個檔，const 重複宣告會出錯。

// chrome.i18n 只會照瀏覽器的語言，指定了別的語言時改查 messages。forced 是 zh_TW、en、ja，沒指定是 null。
var pkLocale = pkLocale || { forced: null, messages: null };

function i18nLocales() {
  return ['zh_TW', 'en', 'ja'];
}

// $1～$9 換成替換值、$$ 換成 $，跟 chrome.i18n.getMessage 一樣
function fillMessage(message, subs) {
  return message.replace(/\$(\$|[1-9])/g, (m, d) => (d === '$' ? '$' : d <= subs.length ? String(subs[d - 1]) : ''));
}

// 找不到翻譯時顯示 key 本身，畫面上才看得出漏了哪一個
function t(key, ...subs) {
  let text;
  if (pkLocale.messages) {
    const entry = pkLocale.messages[key];
    text = entry ? fillMessage(entry.message, subs) : '';
  } else {
    text = chrome.i18n.getMessage(key, subs.map(String));
  }
  if (!text) {
    console.warn('缺少翻譯：' + key); // i18n-ignore：給開發者看的
    return key;
  }
  return text;
}

// 英文 1 和其他數量的寫法不一樣：key_one 給 1，key_other 給其他數量。中文、日文兩個寫一樣就好。
// 數量本身是第一個替換值 $1。
function tn(key, count, ...subs) {
  return t(key + (count === 1 ? '_one' : '_other'), count, ...subs);
}

// 瀏覽器自己挑的是哪一份翻譯：zh_TW、en、ja
function browserLocale() {
  return chrome.i18n.getMessage('locale_code') || 'en';
}

// 目前畫面用的是哪一份翻譯
function uiLocale() {
  return pkLocale.forced || browserLocale();
}

// 一筆資料帶三種語言的（例如 changelog.js），挑目前語言那份，沒有就用英文
function pickLocale(byLocale) {
  return byLocale[uiLocale()] || byLocale.en || byLocale.zh_TW;
}

// 日期、時間、數字的格式跟著介面語言
function uiLang() {
  return pkLocale.messages ? pkLocale.messages.lang_tag.message : chrome.i18n.getMessage('lang_tag') || 'en';
}

// 改用指定語言的翻譯。locale 是 null、或跟瀏覽器挑的一樣時，回到 chrome.i18n。
function useLocale(locale, messages) {
  const forced = locale && messages && locale !== browserLocale();
  pkLocale.forced = forced ? locale : null;
  pkLocale.messages = forced ? messages : null;
}

// storage 裡記的指定語言，沒指定或不認得的回傳 null
async function chosenLocale() {
  const { uiLanguage } = await chrome.storage.local.get('uiLanguage');
  return i18nLocales().includes(uiLanguage) ? uiLanguage : null;
}

// 小視窗、管理頁、解鎖視窗一打開就要用對的語言畫，等 storage 回來會先閃一下別的語言，
// 所以管理頁換語言時另外在 localStorage 存一份。真正以 storage 為準，對不上時見下面自動套用那段。
function rememberLocale(locale) {
  if (locale) localStorage.setItem('pk.uiLanguage', locale);
  else localStorage.removeItem('pk.uiLanguage');
}

function localeUrl(locale) {
  return chrome.runtime.getURL('_locales/' + locale + '/messages.json');
}

// 程式產生的區塊也可以傳進來套用，root 自己帶 data-i18n 的也算
function applyI18n(root = document) {
  const all = (selector) => [...(root.matches && root.matches(selector) ? [root] : []), ...root.querySelectorAll(selector)];
  for (const el of all('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const [prop, attr] of [
    ['i18nPlaceholder', 'placeholder'],
    ['i18nTitle', 'title'],
    ['i18nAriaLabel', 'aria-label'],
    ['i18nTip', 'data-tip'],
  ]) {
    const selector = '[data-' + prop.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase()) + ']';
    for (const el of all(selector)) el.setAttribute(attr, t(el.dataset[prop]));
  }
}

// 只在擴充功能自己的頁面自動套用。content.js 跑在別人的網頁上，網頁自己也可能用 data-i18n，不能去改。
// 要在 tip.js 之前載入：tip.js 一載入就拿 data-tip 當「?」的語音說明。
if (typeof document !== 'undefined' && location.protocol === 'chrome-extension:') {
  const remembered = localStorage.getItem('pk.uiLanguage');
  if (i18nLocales().includes(remembered) && remembered !== browserLocale()) {
    // 翻譯檔是擴充功能自己的檔案，同步讀很快，畫面才不會先畫成別的語言
    const xhr = new XMLHttpRequest();
    xhr.open('GET', localeUrl(remembered), false);
    xhr.send();
    useLocale(remembered, JSON.parse(xhr.responseText));
  }
  document.documentElement.lang = uiLang();
  applyI18n();
  // localStorage 跟 storage 對不上時（例如其中一邊被清掉），以 storage 為準，更新後重新整理這一頁
  chosenLocale().then((locale) => {
    if ((locale || null) === (i18nLocales().includes(remembered) ? remembered : null)) return;
    rememberLocale(locale);
    location.reload();
  });
}
