'use strict';
// 快捷鍵（預設 Ctrl+Shift+L）：把目前網站最近用過的那組帳密填進去。
(() => {
  const PK = (globalThis.PK ??= {});
  const { hostFromUrl } = PK.domain;

  // 快捷鍵（預設 Ctrl+Shift+L，manifest.json 的 commands）：把目前網站最近用過的那組帳密填進去
  chrome.commands.onCommand.addListener(async (command) => {
    if (command !== 'fill-login') return;
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || tab.id == null) return;
    const host = hostFromUrl(tab.url || '');
    if (!host) return;
    if (await PK.lock.isLocked()) {
      // 鎖住時改成把小視窗打開讓使用者輸 PIN。舊版 Edge 不給程式開小視窗，失敗就算了。
      try {
        await chrome.action.openPopup();
      } catch (err) {
        console.warn('[密碼小管家] 鎖住時打不開小視窗', err); // i18n-ignore：給開發者看的
      }
      return;
    }
    const entries = PK.entries.rankEntries(await PK.vault.loadEntries(), host);
    if (!entries.length) return;
    try {
      await chrome.tabs.sendMessage(tab.id, { type: 'fill', entry: entries[0] });
    } catch (err) {
      // 擴充功能裝好之前就開著的分頁沒有 content.js，會走到這裡
      console.warn('[密碼小管家] 快捷鍵填入失敗', err); // i18n-ignore：給開發者看的
    }
  });
})();
