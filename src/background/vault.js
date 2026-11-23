'use strict';
// 密碼庫（vault）：加密存在 storage.local 的帳號資料。所有寫入都排進同一個佇列，才不會互相蓋掉。
(() => {
  const PK = (globalThis.PK ??= {});
  const { t } = PK.i18n;
  const { b64ToBytes, bytesToB64, decrypt, encrypt, importKey } = PK.crypto;

  // vault 的金鑰放在哪，看保護方式：
  // 沒加密（off、screen）：金鑰 keyB64 直接存在 storage.local。
  // 加密（password、hello）：storage.local 只有加密過的 vaultKeyLock。解鎖後的金鑰放 storage.session 的 vaultKey，
  // storage.session 只在記憶體，瀏覽器關掉、擴充功能更新或重新載入就清掉，所以那時候要重新解鎖。
  // 服務工作者閒置幾十秒就會被瀏覽器關掉，所以沒加密的金鑰只當暫存，每次重開都從 storage.local 再讀。
  let keyPromise = null;

  // 換金鑰、清掉資料之後，記著的舊金鑰要丟掉。e2e 清資料時也會叫。
  function forgetCachedKey() {
    keyPromise = null;
  }

  async function getKey() {
    const { vaultKeyLock } = await chrome.storage.local.get('vaultKeyLock');
    if (vaultKeyLock) {
      const { vaultKey } = await chrome.storage.session.get('vaultKey');
      if (!vaultKey) throw PK.lock.lockedError();
      return importKey(b64ToBytes(vaultKey));
    }
    if (!keyPromise) {
      keyPromise = (async () => {
        const { keyB64 } = await chrome.storage.local.get('keyB64');
        if (keyB64) return importKey(b64ToBytes(keyB64));
        const raw = crypto.getRandomValues(new Uint8Array(32));
        await chrome.storage.local.set({ keyB64: bytesToB64(raw) });
        return importKey(raw);
      })().catch((err) => {
        keyPromise = null;
        throw err;
      });
    }
    return keyPromise;
  }

  // 目前 vault 金鑰的原始值（base64）。換保護方式時要拿原始值重新加密，鎖住時拿不到。
  async function currentVaultKeyB64() {
    const { vaultKeyLock } = await chrome.storage.local.get('vaultKeyLock');
    if (vaultKeyLock) {
      const { vaultKey } = await chrome.storage.session.get('vaultKey');
      if (!vaultKey) throw PK.lock.lockedError();
      return vaultKey;
    }
    // 還沒存過任何密碼時 getKey 會先產生一把
    await getKey();
    return (await chrome.storage.local.get('keyB64')).keyB64;
  }

  const DAY_MS = 24 * 60 * 60 * 1000;

  const HISTORY_MAX = 5;

  // vault 解密後的樣子：{ entries: [帳號...], trash: [刪掉的帳號...], meta: {} }
  // 1.14 以前 meta 裡放自動備份密碼 autoBackupPassword，升級時會換成 autoBackupKey 再刪掉，見 migrateAutoBackupPassword。
  async function loadVault() {
    const { vault } = await chrome.storage.local.get('vault');
    if (!vault) return { entries: [], trash: [], meta: {} };
    // 鎖住拿不到金鑰時照原樣往外丟，呼叫的地方才分得出是鎖住、不是資料壞了
    const key = await getKey();
    let text;
    try {
      text = await decrypt(key, vault);
    } catch (err) {
      console.error('[密碼小管家] 解密失敗', err); // i18n-ignore：給開發者看的
      throw new Error(t('bg_vault_unreadable'));
    }
    const parsed = JSON.parse(text);
    // 1.1 以前整個 vault 就是一個帳號陣列，讀到舊格式就轉成新的
    if (Array.isArray(parsed)) return { entries: parsed, trash: [], meta: {} };
    return { entries: parsed.entries || [], trash: parsed.trash || [], meta: parsed.meta || {} };
  }

  async function storeVault(vault) {
    const payload = await encrypt(await getKey(), JSON.stringify(vault));
    await chrome.storage.local.set({ vault: payload });
  }

  async function loadEntries() {
    return (await loadVault()).entries;
  }

  // 兩個分頁同時存密碼時，後寫的會把先寫的蓋掉，所以寫入全部排隊一次一個。
  let writeQueue = Promise.resolve();

  function modifyVault(mutator) {
    const run = writeQueue.then(async () => {
      const vault = await loadVault();
      // 順便把回收桶裡放超過保留天數的清掉
      const cutoff = Date.now() - (await PK.settings.getSettings()).trashDays * DAY_MS;
      vault.trash = vault.trash.filter((t) => (t.deletedAt || 0) > cutoff);
      const result = await mutator(vault);
      await storeVault(vault);
      await PK.autoBackup.refreshAutoBackupReady(vault);
      return result;
    });
    writeQueue = run.catch(() => {
      // 失敗的那次已經往外拋給呼叫者了，這裡只是不要讓佇列卡住。
    });
    return run;
  }

  // 排在寫入佇列的最後面。跟 modifyVault 不同，失敗時不接住，下一次寫入會收到這次的錯誤。
  function queueAfterWrites(fn) {
    const run = writeQueue.then(fn);
    writeQueue = run;
    return run;
  }

  // 換 vault 金鑰或換金鑰的存法：用 newKeyB64 重新加密 vault，跟 items 一起寫進 storage.local，再刪掉 removeKeys。
  // 要排進寫入佇列，不然換到一半有別的寫入，會把用舊金鑰加密的 vault 寫回去。
  function replaceVaultKey(newKeyB64, items, removeKeys) {
    const run = writeQueue.then(async () => {
      const vault = await loadVault();
      const payload = await encrypt(await importKey(b64ToBytes(newKeyB64)), JSON.stringify(vault));
      // 先放好新金鑰再寫 vault：寫進去之後馬上有人讀，才拿得到對的金鑰
      if (items.vaultKeyLock) await chrome.storage.session.set({ vaultKey: newKeyB64 });
      await chrome.storage.local.set({ ...items, vault: payload });
      if (removeKeys.length) await chrome.storage.local.remove(removeKeys);
      forgetCachedKey();
    });
    writeQueue = run.catch(() => {
      // 失敗的那次已經往外拋給呼叫者了，這裡只是不要讓佇列卡住。
    });
    return run;
  }

  function modifyEntries(mutator) {
    return modifyVault((vault) => mutator(vault.entries));
  }

  // 密碼換了就把舊的留在歷史裡，最多 5 筆。網站那邊其實沒改成功的時候，才救得回舊密碼。
  function applyPassword(target, newPassword, now) {
    if (target.password === newPassword) return false;
    target.history = [{ password: target.password, changedAt: now }, ...(target.history || [])].slice(0, HISTORY_MAX);
    target.password = newPassword;
    target.passwordChangedAt = now;
    return true;
  }

  function newEntry(data, now, extra) {
    return {
      id: crypto.randomUUID(),
      note: '',
      history: [],
      ...data,
      createdAt: now,
      updatedAt: now,
      lastUsedAt: now,
      passwordChangedAt: now,
      ...(extra || {}),
    };
  }

  // 忘了自訂密碼、系統驗證壞了：vault 解不開，只能整個清掉，再用備份檔匯入。設定和自動備份的金鑰留著。
  function resetVault() {
    const run = writeQueue.then(async () => {
      await chrome.storage.local.remove(['vault', 'vaultKeyLock', 'keyB64', 'webauthn', 'autoBackupReady']);
      await chrome.storage.session.remove(['vaultKey', 'locked']);
      forgetCachedKey();
      const settings = await PK.settings.getSettings();
      await PK.settings.setSettings({ lock: { ...settings.lock, mode: 'off', enabled: false } });
    });
    writeQueue = run.catch(() => {
      // 失敗的那次已經往外拋給呼叫者了，這裡只是不要讓佇列卡住。
    });
    return run;
  }

  async function touchEntry(id) {
    await modifyEntries((entries) => {
      const e = entries.find((x) => x.id === id);
      if (e) e.lastUsedAt = Date.now();
    });
  }

  PK.vault = { DAY_MS, HISTORY_MAX, applyPassword, currentVaultKeyB64, forgetCachedKey, loadEntries, loadVault, modifyEntries, modifyVault, newEntry, queueAfterWrites, replaceVaultKey, resetVault, touchEntry };
})();
