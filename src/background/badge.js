'use strict';
// 工具列圖示上的數字（目前網站有幾組帳號），以及分頁切換、關掉時的處理。
(() => {
  const PK = (globalThis.PK ??= {});
  const { t } = PK.i18n;
  const { hostFromUrl } = PK.domain;


  async function updateBadge(tabId, url) {
    if (tabId == null) return;
    await PK.locale.localeReady();
    let text = '';
    const host = hostFromUrl(url || '');
    if (await PK.lock.isLocked()) {
      text = t('bg_badge_locked');
    } else if (host) {
      try {
        const n = PK.entries.rankEntries(await PK.vault.loadEntries(), host).length;
        text = n ? String(n) : '';
      } catch (err) {
        console.warn('[密碼小管家] 更新圖示數字時讀不到資料', err); // i18n-ignore：給開發者看的
      }
    }
    try {
      await chrome.action.setBadgeText({ tabId, text });
    } catch {
      // 分頁已經關掉就會失敗，不用理。
    }
  }

  async function refreshActiveBadges() {
    const tabs = await chrome.tabs.query({ active: true });
    for (const t of tabs) updateBadge(t.id, t.url);
  }

  chrome.action.setBadgeBackgroundColor({ color: '#2563eb' });

  chrome.tabs.onActivated.addListener(({ tabId }) => {
    chrome.tabs.get(tabId).then((t) => updateBadge(tabId, t.url)).catch(() => {
      // 分頁在這之間被關掉就會失敗，不用理。
    });
  });

  chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
    if (info.status === 'complete' || info.url) updateBadge(tabId, tab.url);
  });

  chrome.tabs.onRemoved.addListener((tabId) => {
    PK.pending.clearPending(tabId);
    PK.clickRules.clearClickGuard(tabId);
  });

  PK.badge = { refreshActiveBadges };
})();
