'use strict';
// 自動備份的排程、金鑰和執行。
(() => {
  const PK = (globalThis.PK ??= {});
  const { t } = PK.i18n;
  const { bytesToB64, createBackupKeyPair } = PK.crypto;


  const AUTO_BACKUP_ALARM = 'auto-backup';

  function parseTime(text) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(text || ''));
    return m ? [Math.min(+m[1], 23), Math.min(+m[2], 59)] : [12, 0];
  }

  // 最近一個已經過去的指定時間：每天是今天或昨天的那個時刻，每週是最近一個指定星期幾的那個時刻。
  // 用 setDate 加減天數而不是加減毫秒，日光節約時間切換那天才不會差一小時。
  function lastSlot(ab, now) {
    const [h, m] = parseTime(ab.time);
    const d = new Date(now);
    d.setHours(h, m, 0, 0);
    const week = ab.every === 'week';
    if (week) d.setDate(d.getDate() - ((d.getDay() - ab.weekday + 7) % 7));
    if (d.getTime() > now) d.setDate(d.getDate() - (week ? 7 : 1));
    return d.getTime();
  }

  function nextSlot(ab, now) {
    const d = new Date(lastSlot(ab, now));
    d.setDate(d.getDate() + (ab.every === 'week' ? 7 : 1));
    return d.getTime();
  }

  // 背景程式每次被叫醒都會從頭跑這支檔案。計時器已經排在對的時間就不要重建：
  // 重建會讓倒數重來，1.6 以前就是這樣，瀏覽器開著不關的話自動備份幾乎不會跑。
  async function scheduleAutoBackup() {
    const ab = (await PK.settings.getSettings()).autoBackup;
    if (!ab.enabled) {
      await chrome.alarms.clear(AUTO_BACKUP_ALARM);
      return;
    }
    const when = nextSlot(ab, Date.now());
    const alarm = await chrome.alarms.get(AUTO_BACKUP_ALARM);
    if (!alarm || Math.abs(alarm.scheduledTime - when) > 1000) await chrome.alarms.create(AUTO_BACKUP_ALARM, { when });
  }

  // 帳號清單的指紋：有哪幾筆、各自的修改時間。新增、修改、刪除、復原、匯入都會讓指紋變。
  // 只看修改時間的話，刪除和復原不會變，匯入的帳號又帶著檔案裡的舊時間，自動備份會以為沒改過。
  // 自動點選的規則也算進去，備份檔才會帶到新規則。沒有規則時指紋跟以前一樣，升級後不會多存一份。
  async function entriesSignature(entries, clickRules) {
    let text = entries.map((e) => e.id + ':' + (e.updatedAt || 0)).sort().join('|');
    if (clickRules.length) text += '|' + JSON.stringify(clickRules);
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return bytesToB64(new Uint8Array(hash));
  }

  // 給管理頁看的狀態：只說有沒有設備份密碼。有啟用就算好下次備份的時間。
  function autoBackupView(ab, hasPassword) {
    return { ...ab, hasPassword, nextAt: ab.enabled ? nextSlot(ab, Date.now()) : 0 };
  }

  async function autoBackupInfo() {
    const settings = await PK.settings.getSettings();
    return autoBackupView(settings.autoBackup, !!(await getAutoBackupKey()));
  }

  // 1.14 以前把自動備份密碼存在 vault 裡。升級後用那組密碼產生 autoBackupKey，再把密碼刪掉，使用者不用重設。
  // 背景程式每次醒來都會跑一次。讀 autoBackupKey 之前要先等這裡做完，不然自動備份會以為還沒設密碼。
  async function migrateAutoBackupPassword() {
    // 選了加密的保護方式之前一定已經轉換過，而且鎖住時讀不到 vault
    const { vaultKeyLock } = await chrome.storage.local.get('vaultKeyLock');
    if (vaultKeyLock) return;
    const vault = await PK.vault.loadVault();
    const password = vault.meta.autoBackupPassword;
    if (!password) return;
    const { autoBackupKey } = await chrome.storage.local.get('autoBackupKey');
    if (!autoBackupKey) await chrome.storage.local.set({ autoBackupKey: await createBackupKeyPair(password, PK.backup.BACKUP_ITERATIONS) });
    await forgetOldBackupPassword();
  }

  async function forgetOldBackupPassword() {
    if (!(await PK.vault.loadVault()).meta.autoBackupPassword) return;
    await PK.vault.modifyVault((vault) => {
      delete vault.meta.autoBackupPassword;
    });
  }

  const autoBackupKeyMigrated = migrateAutoBackupPassword().catch((err) =>
    console.warn('[密碼小管家] 自動備份密碼升級失敗', err) // i18n-ignore：給開發者看的
  );

  // { publicKey, wrappedKey }，沒設過備份密碼就是 null
  async function getAutoBackupKey() {
    await autoBackupKeyMigrated;
    const { autoBackupKey } = await chrome.storage.local.get('autoBackupKey');
    return autoBackupKey || null;
  }

  // 加密的保護方式鎖住時讀不到 vault，自動備份改存這份事先加密好的內容 autoBackupReady：{ content, count, signature }。
  // vault 或備份會帶的設定改了就重算，改得到就代表那時候是解鎖狀態。沒加密的保護方式用不到，清掉。
  // 算失敗不能讓存密碼跟著失敗，所以這裡只印警告不往外丟；到時間拿不到這份內容，自動備份會記一筆失敗。
  async function refreshAutoBackupReady(vault) {
    try {
      const settings = await PK.settings.getSettings();
      const { autoBackupKey, autoBackupReady } = await chrome.storage.local.get(['autoBackupKey', 'autoBackupReady']);
      if (!PK.lock.isEncryptedMode(settings.lock.mode)) {
        if (autoBackupReady) await chrome.storage.local.remove('autoBackupReady');
        return;
      }
      // 不能用 getAutoBackupKey：它會等升級轉換，升級轉換在寫入佇列裡又會等這裡，互相等就卡死了
      if (!autoBackupKey) return;
      const v = vault || (await PK.vault.loadVault());
      const { content, count } = await PK.backup.exportAutoBackup(autoBackupKey, v.entries, settings);
      const signature = await entriesSignature(v.entries, settings.clickRules);
      await chrome.storage.local.set({ autoBackupReady: { content, count, signature } });
    } catch (err) {
      if (!err.locked) console.warn('[密碼小管家] 準備自動備份的內容失敗', err); // i18n-ignore：給開發者看的
    }
  }

  // 從寫入佇列外面叫：排在正在寫的 vault 後面，才不會拿舊的 vault 算完再蓋掉新的
  function refreshAutoBackupReadyLater() {
    return PK.vault.queueAfterWrites(() => refreshAutoBackupReady());
  }

  // 備份跑的這幾秒內使用者可能改了設定，寫回前重新讀一次，只蓋這次要改的欄位
  async function patchAutoBackup(patch) {
    const current = (await PK.settings.getSettings()).autoBackup;
    await PK.settings.setSettings({ autoBackup: { ...current, ...patch } });
  }

  async function setAutoBackup({ enabled, every, time, weekday, folder, password }) {
    const current = (await PK.settings.getSettings()).autoBackup;
    const patch = {};
    if (every != null) patch.every = every === 'week' ? 'week' : 'day';
    if (time != null) {
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(time))) throw new Error(t('bg_time_format'));
      patch.time = String(time);
    }
    if (weekday != null) {
      const n = parseInt(weekday, 10);
      if (!(n >= 0 && n <= 6)) throw new Error(t('bg_weekday_invalid'));
      patch.weekday = n;
    }
    if (folder != null) {
      patch.folder = PK.backupFiles.safeFolder(folder);
      if (patch.folder !== current.folder) {
        await PK.backupFiles.appendBackupLog({
          kind: 'location',
          path: patch.folder,
          count: 0,
          note: t('bg_backup_location_changed', current.folder, patch.folder),
        });
      }
    }
    // 換密碼就換一對新的金鑰。舊的備份檔裡放的是舊的私鑰，還是要用舊密碼開。
    if (password != null) {
      if (String(password).length < 8) throw new Error(t('bg_backup_password_too_short'));
      // 升級轉換還在跑的話，等它做完再寫，不然新密碼的金鑰會被舊密碼的蓋掉
      await autoBackupKeyMigrated;
      await chrome.storage.local.set({ autoBackupKey: await createBackupKeyPair(String(password), PK.backup.BACKUP_ITERATIONS) });
      await forgetOldBackupPassword();
      // 事先加密好的內容裡帶的是舊的私鑰，要用新的重算
      await refreshAutoBackupReadyLater();
    }
    if (enabled != null) {
      if (enabled && !(await getAutoBackupKey())) throw new Error(t('bg_enable_needs_password'));
      patch.enabled = !!enabled;
      patch.lastError = '';
    }
    // 剛打開開關或改了時間，之前已經過去的指定時間不補做，等下一個
    const next = { ...current, ...patch };
    const rescheduled = next.every !== current.every || next.time !== current.time || next.weekday !== current.weekday;
    if (rescheduled || (next.enabled && !current.enabled)) patch.since = Date.now();
    await patchAutoBackup(patch);
    await scheduleAutoBackup();
    return autoBackupInfo();
  }

  // 計時器、背景程式醒來時的檢查、「立即備份」可能同時叫到，排隊一次一個，不然會存出兩份
  let autoBackupQueue = Promise.resolve();

  function runAutoBackup(force) {
    const run = autoBackupQueue.then(() => autoBackupOnce(force));
    autoBackupQueue = run.catch(() => {
      // 失敗的那次已經往外拋給呼叫者了，這裡只是不要讓佇列卡住。
    });
    return run;
  }

  // 備份內容從哪來：讀得到 vault 就當場加密；加密的保護方式鎖著時，用事先加密好的 autoBackupReady。兩種都沒有回傳 null。
  async function autoBackupSource(backupKey, settings) {
    try {
      const vault = await PK.vault.loadVault();
      return {
        count: vault.entries.length,
        signature: await entriesSignature(vault.entries, settings.clickRules),
        build: () => PK.backup.exportAutoBackup(backupKey, vault.entries, settings),
      };
    } catch (err) {
      if (!err.locked) throw err;
    }
    const { autoBackupReady } = await chrome.storage.local.get('autoBackupReady');
    if (!autoBackupReady) return null;
    return {
      count: autoBackupReady.count,
      signature: autoBackupReady.signature,
      build: async () => ({ content: autoBackupReady.content, count: autoBackupReady.count }),
    };
  }

  // 過了指定時間、而且上次備份之後帳號有變，才真的寫檔。
  // force=true 是「立即備份」：不看時間也不看有沒有變，紀錄記成 now，算手動。
  async function autoBackupOnce(force) {
    // 排程叫起背景程式時可能還沒讀好語言，檔名和錯誤訊息要用指定的語言
    await PK.locale.localeReady();
    const settings = await PK.settings.getSettings();
    const ab = settings.autoBackup;
    const now = Date.now();
    if (!force && (!ab.enabled || lastSlot(ab, now) <= Math.max(ab.lastRunAt || 0, ab.since || 0))) {
      return { ran: false, reason: 'not-due' };
    }
    const backupKey = await getAutoBackupKey();
    if (!backupKey) {
      await patchAutoBackup({ lastRunAt: now, lastResult: 'failed', lastError: t('bg_auto_backup_no_password') });
      throw new Error(t('bg_auto_backup_no_password'));
    }
    const source = await autoBackupSource(backupKey, settings);
    if (!source) {
      await patchAutoBackup({ lastRunAt: now, lastResult: 'failed', lastError: t('bg_auto_backup_not_ready') });
      throw new Error(t('bg_auto_backup_not_ready'));
    }
    if (!source.count) {
      await patchAutoBackup({ lastRunAt: now, lastResult: 'empty', lastError: '' });
      return { ran: false, reason: 'empty' };
    }
    const signature = source.signature;
    if (!force && signature === ab.lastSignature) {
      await patchAutoBackup({ lastRunAt: now, lastResult: 'unchanged', lastError: '' });
      return { ran: false, reason: 'no-change' };
    }
    try {
      const { content, count } = await source.build();
      const stamp = PK.backupFiles.backupStamp(true);
      const name = force ? t('bg_backup_file_now', stamp) : t('bg_backup_file_auto', stamp);
      const filename = PK.backupFiles.safeFolder(ab.folder) + '/' + name + '.pkbak';
      const { id, path } = await PK.backupFiles.saveFile({ content, filename, mime: 'application/json', saveAs: false });
      await PK.backupFiles.appendBackupLog({ kind: force ? 'now' : 'auto', path, count, downloadId: id });
      await patchAutoBackup({ lastRunAt: Date.now(), lastResult: 'saved', lastError: '', lastSignature: signature });
      await PK.settings.setSettings({ lastBackupAt: Date.now() });
      return { ran: true, path, count };
    } catch (err) {
      await patchAutoBackup({ lastRunAt: Date.now(), lastResult: 'failed', lastError: err.message });
      throw err;
    }
  }

  // 背景程式每次醒來都檢查一次：錯過的時間（關機、瀏覽器沒開、計時器被清掉）在這裡補做，做完把計時器排到下一次
  function autoBackupTick() {
    runAutoBackup(false)
      .catch((err) => console.warn('[密碼小管家] 自動備份失敗', err)) // i18n-ignore：給開發者看的
      .then(() => scheduleAutoBackup())
      .catch((err) => console.warn('[密碼小管家] 排自動備份的時間失敗', err)); // i18n-ignore：給開發者看的
  }

  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === AUTO_BACKUP_ALARM) autoBackupTick();
  });

  autoBackupTick();

  PK.autoBackup = { autoBackupInfo, autoBackupView, entriesSignature, getAutoBackupKey, migrateAutoBackupPassword, refreshAutoBackupReady, refreshAutoBackupReadyLater, runAutoBackup, setAutoBackup };
})();
