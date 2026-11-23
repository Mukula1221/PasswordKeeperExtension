'use strict';
// 剛送出登入、還沒決定要不要存的帳密。每個分頁一筆，放 2 分鐘。
(() => {
  const PK = (globalThis.PK ??= {});
  const { baseDomain } = PK.domain;

  // 登入送出後，「要不要儲存」的提示最多等這麼久；超過就當作使用者不想存。
  const PENDING_TTL_MS = 2 * 60 * 1000;

  // 存在 storage.session（只在記憶體，關瀏覽器就清掉），用分頁 id 當 key。
  // 登入表單送出後通常會跳頁，舊頁面的腳本已經死了，所以要靠背景程式把資料傳給新頁面。

  function pendingKey(tabId) {
    return 'pending:' + tabId;
  }

  async function getPending(tabId) {
    if (tabId == null) return null;
    const key = pendingKey(tabId);
    const stored = await chrome.storage.session.get(key);
    const p = stored[key];
    if (!p) return null;
    if (Date.now() - p.at > PENDING_TTL_MS) {
      await chrome.storage.session.remove(key);
      return null;
    }
    return p;
  }

  async function setPending(tabId, data) {
    if (tabId == null) return null;
    let old = await getPending(tabId);
    // 兩段式登入（第一頁打帳號、第二頁才打密碼）要把兩頁的資料合併成一筆。
    // 但換到別的網站就不能合併，不然 A 站的帳號會配到 B 站的密碼。
    if (old && baseDomain(old.host) !== baseDomain(data.host)) old = null;
    const merged = { ...(old || {}), at: Date.now() };
    // submitUrl 是按下登入時的網址（不含查詢字串），新頁面用它判斷是不是登入失敗被退回同一頁
    for (const k of ['host', 'origin', 'username', 'password', 'submitUrl']) {
      if (data[k] != null && data[k] !== '') merged[k] = data[k];
    }
    await chrome.storage.session.set({ [pendingKey(tabId)]: merged });
    return merged;
  }

  async function clearPending(tabId) {
    if (tabId != null) await chrome.storage.session.remove(pendingKey(tabId));
  }

  // 決定要不要跳「儲存密碼？」：已經存過一模一樣的就不問，帳號相同但密碼不同就問要不要更新。
  async function pendingDecision(tabId) {
    const p = await getPending(tabId);
    if (!p || !p.password || !p.host) return { pending: null, mode: null };
    // 鎖住時不跳儲存提示，暫存留著，解鎖後下一頁再問
    if (await PK.lock.isLocked()) return { pending: null, mode: null };
    const settings = await PK.settings.getSettings();
    if (settings.neverSave.includes(p.host)) {
      await clearPending(tabId);
      return { pending: null, mode: null };
    }
    const entries = await PK.vault.loadEntries();
    let existing = PK.entries.findExisting(entries, p.host, p.username || '');
    // 改密碼的表單通常沒有帳號欄。這個網站只存了一組帳號的話，就當作是要更新那一組。
    if (!existing && !p.username) {
      const candidates = PK.entries.rankEntries(entries, p.host);
      if (candidates.length === 1) existing = candidates[0];
    }
    if (existing && existing.password === p.password) {
      await clearPending(tabId);
      await PK.vault.touchEntry(existing.id);
      return { pending: null, mode: null };
    }
    const { at, ...pending } = p;
    return {
      pending,
      mode: existing ? 'update' : 'new',
      existingId: existing ? existing.id : null,
      existingUsername: existing ? existing.username : null,
    };
  }

  PK.pending = { clearPending, getPending, pendingDecision, setPending };
})();
