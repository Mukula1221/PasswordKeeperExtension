'use strict';
// 工具列圖示上的數字（目前網站有幾組帳號），以及分頁切換、關掉時的處理。
(() => {
  const PK = (globalThis.PK ??= {});
  const { t } = PK.i18n;
  const { hostFromUrl } = PK.domain;


  async function badgeText(tab) {
    // 不能在私密視窗用的瀏覽器，私密分頁不顯示數字，跟小視窗一樣當作不能用，見 platform.js 的 privateWindows
    if (PK.platform.privateBlocked(tab.incognito)) return '';
    if (await PK.lock.isLocked()) return t('bg_badge_locked');
    const host = hostFromUrl(tab.url || '');
    if (!host) return '';
    try {
      const n = PK.entries.rankEntries(await PK.vault.loadEntries(), host).length;
      return n ? String(n) : '';
    } catch (err) {
      console.warn('[密碼小管家] 更新圖示數字時讀不到資料', err); // i18n-ignore：給開發者看的
      return '';
    }
  }

  async function updateBadge(tab) {
    if (tab.id == null) return;
    await PK.locale.localeReady();
    const text = await badgeText(tab);
    try {
      await chrome.action.setBadgeText({ tabId: tab.id, text });
    } catch {
      // 分頁已經關掉就會失敗，不用理。
    }
  }

  async function refreshActiveBadges() {
    const tabs = await chrome.tabs.query({ active: true });
    for (const tab of tabs) updateBadge(tab);
  }

  chrome.action.setBadgeBackgroundColor({ color: '#2563eb' });

  chrome.tabs.onActivated.addListener(({ tabId }) => {
    chrome.tabs.get(tabId).then(updateBadge).catch(() => {
      // 分頁在這之間被關掉就會失敗，不用理。
    });
  });

  chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
    if (info.status === 'complete' || info.url) updateBadge(tab);
  });

  chrome.tabs.onRemoved.addListener((tabId) => {
    PK.pending.clearPending(tabId);
    PK.clickRules.clearClickGuard(tabId);
  });

  PK.badge = { refreshActiveBadges };
})();
