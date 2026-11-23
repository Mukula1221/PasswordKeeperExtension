'use strict';
// 帳號的比對、新增、更新和 CSV 匯入。
(() => {
  const PK = (globalThis.PK ??= {});
  const { t } = PK.i18n;
  const { hostFromUrl, originFromUrl } = PK.domain;

  // 找出目前網站的帳號，最近用過的排前面。
  // 只認完整網域相同：jira.example.com 和 gitlab.example.com 是不同系統，帳號不能混用，
  // 所以不做「同一個主網域也算」的比對。www.example.com 和 example.com 也因此算兩個網站。
  function rankEntries(entries, host) {
    host = (host || '').toLowerCase();
    if (!host) return [];
    return entries
      .filter((e) => (e.host || '').toLowerCase() === host)
      .sort((a, b) => {
        const byUse = (b.lastUsedAt || 0) - (a.lastUsedAt || 0);
        if (byUse !== 0) return byUse;
        return String(a.username).localeCompare(String(b.username));
      });
  }

  function findExisting(entries, host, username) {
    host = (host || '').toLowerCase();
    username = username || '';
    return entries.find((e) => e.host === host && e.username === username) || null;
  }

  function normalizeInput(raw) {
    const data = {};
    let host = String(raw.host || '').trim().toLowerCase();
    let origin = String(raw.origin || '').trim();
    const url = String(raw.url || '').trim();
    if (url) {
      // 管理頁和 CSV 匯入給的是網址，不是 host。沒寫 http 開頭的也接受。
      // 寫了別的開頭的不收：Chrome 匯出的手機 App 密碼是 android:// 開頭，補上 https:// 會變成叫 android 的網站
      if (/^[a-z][a-z\d+.-]*:\/\//i.test(url) && !/^https?:\/\//i.test(url)) throw new Error(t('bg_url_scheme_unsupported'));
      const withScheme = /^https?:\/\//i.test(url) ? url : 'https://' + url;
      host = host || hostFromUrl(withScheme);
      origin = origin || originFromUrl(withScheme);
    }
    if (!host) throw new Error(t('bg_site_required'));
    data.host = host;
    data.origin = origin || 'https://' + host;
    data.username = String(raw.username || '').trim();
    data.password = String(raw.password || '');
    if (raw.note != null) data.note = String(raw.note);
    return data;
  }

  function upsert(entries, raw, id) {
    const data = normalizeInput(raw);
    const now = Date.now();
    const { password, ...rest } = data;
    let target = id ? entries.find((e) => e.id === id) : null;
    if (target) {
      const clash = entries.find((e) => e.id !== id && e.host === data.host && e.username === data.username);
      if (clash) throw new Error(t('bg_duplicate_account'));
      Object.assign(target, rest, { updatedAt: now });
      PK.vault.applyPassword(target, password, now);
      return { entry: target, action: 'updated' };
    }
    target = entries.find((e) => e.host === data.host && e.username === data.username);
    if (target) {
      Object.assign(target, rest, { updatedAt: now, lastUsedAt: now });
      PK.vault.applyPassword(target, password, now);
      return { entry: target, action: 'updated' };
    }
    const entry = PK.vault.newEntry(data, now);
    entries.push(entry);
    return { entry, action: 'added' };
  }

  // 匯入 CSV 或備份檔：同網站同帳號且密碼相同的略過，密碼不同的更新，其他新增。
  // 檔案裡的密碼如果是這邊已經換掉的舊密碼，或檔案記的改密碼時間比這邊早，也略過：
  // 和瀏覽器來回搬的時候，瀏覽器那份常常是舊的，不能把這邊的新密碼蓋回去。
  // skipped 是全部略過的筆數，same / older / invalid 是細分：密碼一樣、檔案的比較舊、不是網站或沒有密碼。
  function importEntries(rows) {
    return PK.vault.modifyEntries((entries) => {
      const s = { added: 0, updated: 0, skipped: 0, same: 0, older: 0, invalid: 0 };
      const skip = (why) => {
        s[why]++;
        s.skipped++;
      };
      for (const row of rows || []) {
        let data;
        try {
          data = normalizeInput(row);
        } catch {
          skip('invalid');
          continue;
        }
        if (!data.password) {
          skip('invalid');
          continue;
        }
        const existing = entries.find((e) => e.host === data.host && e.username === data.username);
        if (existing) {
          if (existing.password === data.password) {
            skip('same');
            continue;
          }
          const replaced = (existing.history || []).some((h) => h.password === data.password);
          const olderTime = row.passwordChangedAt && row.passwordChangedAt < (existing.passwordChangedAt || 0);
          if (replaced || olderTime) {
            skip('older');
            continue;
          }
          const now = Date.now();
          const { password, ...rest } = data;
          // 瀏覽器匯出的檔案常常沒有備註，空的備註不要把這邊寫的清掉
          if (!rest.note) delete rest.note;
          Object.assign(existing, rest, { updatedAt: now });
          PK.vault.applyPassword(existing, password, now);
          s.updated++;
        } else {
          const now = Date.now();
          // 備份檔裡有原本的時間和舊密碼就沿用，CSV 沒有就用現在
          entries.push(
            PK.vault.newEntry(data, now, {
              history: Array.isArray(row.history) ? row.history.slice(0, PK.vault.HISTORY_MAX) : [],
              createdAt: row.createdAt || now,
              updatedAt: row.updatedAt || now,
              lastUsedAt: row.lastUsedAt || 0,
              passwordChangedAt: row.passwordChangedAt || row.createdAt || now,
            })
          );
          s.added++;
        }
      }
      return s;
    });
  }

  PK.entries = { findExisting, importEntries, normalizeInput, rankEntries, upsert };
})();
