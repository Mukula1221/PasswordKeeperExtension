'use strict';
// 背景程式用的介面語言：讀管理頁指定的語言，錯誤訊息、圖示上的字、備份檔名都照它。
(() => {
  const PK = (globalThis.PK ??= {});
  const { chosenLocale, localeUrl, useLocale } = PK.i18n;

  // 背景程式丟給畫面的錯誤訊息、圖示上的「鎖」、備份檔名都要跟著指定的語言。
  // 背景程式隨時會被瀏覽器關掉再叫起來，每次啟動都要重讀；讀好之前收到的訊息先等，見 dispatch。

  const localeCache = new Map();

  // 只留 message，description 是給翻譯的人看的，傳給網頁的 content.js 時少一點資料
  async function localeMessages(locale) {
    if (!localeCache.has(locale)) {
      const res = await fetch(localeUrl(locale));
      const raw = await res.json();
      localeCache.set(locale, Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, { message: v.message }])));
    }
    return localeCache.get(locale);
  }

  async function loadChosenLocale() {
    const locale = await chosenLocale();
    useLocale(locale, locale ? await localeMessages(locale) : null);
  }

  // 讀不到翻譯檔就照瀏覽器的語言，印錯誤讓 chrome://extensions 的「錯誤」看得到
  const followChosenLocale = () =>
    loadChosenLocale().catch((err) => {
      useLocale(null);
      console.error('[密碼小管家] 讀不到指定語言的翻譯檔', err); // i18n-ignore：給開發者看的
    });

  let i18nReady = followChosenLocale();

  // 別的檔要等語言載好時用這兩個函式。直接拿 i18nReady 的值，換語言之後拿到的會是舊的那一個。
  function localeReady() {
    return i18nReady;
  }

  function reloadLocale() {
    i18nReady = followChosenLocale();
    return i18nReady;
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.uiLanguage) return;
    i18nReady = followChosenLocale().then(() => PK.badge.refreshActiveBadges());
  });

  PK.locale = { localeMessages, localeReady, reloadLocale };
})();
