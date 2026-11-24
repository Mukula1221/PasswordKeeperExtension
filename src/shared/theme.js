'use strict';
// 介面的色系：白色、深色、青綠。管理頁左側欄的「色系」選單可以選，存在 storage 的 uiTheme。
// 沒選就跟著系統：系統是淺色模式用青綠，深色模式用深色。
// 小視窗、管理頁、解鎖視窗在 <head> 載入這個檔，畫面還沒畫就把 <html data-theme> 設好。
// 網頁裡的 content.js 也載入這個檔，只用 resolveTheme() 和 chosenTheme()，網頁上畫面的顏色見 ui.js。
(() => {
  const PK = (globalThis.PK ??= {});
  if (PK.theme) return;

  // 要跟 messages.js 的 theme.set 收的值一樣（再加上 system）
  const THEMES = ['white', 'dark', 'teal'];

  const darkQuery = () => (typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null);

  // 選的色系：THEMES 其中一個，或 system（跟著系統）
  function normalizeChoice(value) {
    return THEMES.includes(value) ? value : 'system';
  }

  // 實際要畫的那一套：system 照系統的深淺色換成 teal 或 dark
  function resolveTheme(choice) {
    if (THEMES.includes(choice)) return choice;
    const q = darkQuery();
    return q && q.matches ? 'dark' : 'teal';
  }

  async function chosenTheme() {
    const { uiTheme } = await chrome.storage.local.get('uiTheme');
    return normalizeChoice(uiTheme);
  }

  // 系統切換深淺色時叫 callback。只有選「跟著系統」時畫面才會變，由呼叫的地方判斷。
  function onSystemChange(callback) {
    const q = darkQuery();
    if (q) q.addEventListener('change', callback);
  }

  // 下面是擴充功能自己的畫面才做的事。content.js 跑在別人的網頁上，不能改網頁的 <html>。
  let current = 'system';

  function apply() {
    document.documentElement.dataset.theme = resolveTheme(current);
  }

  // 跟語言一樣在 localStorage 多存一份，下次打開畫面時同步讀，才不會先閃一下別的顏色
  function remember(choice) {
    try {
      if (choice === 'system') localStorage.removeItem('pk.uiTheme');
      else localStorage.setItem('pk.uiTheme', choice);
    } catch {
      // 瀏覽器不給用 localStorage 時，只是打開畫面那一下可能閃一下別的顏色
    }
  }

  // 管理頁的選單選了之後先換畫面，不等 storage 的變更通知
  function useTheme(choice) {
    current = normalizeChoice(choice);
    remember(current);
    apply();
  }

  function currentChoice() {
    return current;
  }

  if (PK.platform.isExtensionPage()) {
    let remembered = null;
    try {
      remembered = localStorage.getItem('pk.uiTheme');
    } catch {
      // 見 remember()
    }
    current = normalizeChoice(remembered);
    apply();
    onSystemChange(() => {
      if (current === 'system') apply();
    });
    // localStorage 跟 storage 對不上時（例如其中一邊被清掉），以 storage 為準。換顏色不用重新整理。
    chosenTheme().then((choice) => {
      if (choice !== current) useTheme(choice);
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.uiTheme) useTheme(changes.uiTheme.newValue);
    });
  }

  PK.theme = { THEMES, chosenTheme, currentChoice, normalizeChoice, onSystemChange, resolveTheme, useTheme };
})();
