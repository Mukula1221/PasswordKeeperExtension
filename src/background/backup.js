'use strict';
// 加密備份檔的格式、匯出和匯入。
(() => {
  const PK = (globalThis.PK ??= {});
  const { t } = PK.i18n;
  const { b64ToBytes, bytesToB64, decrypt, deriveKey, encrypt, openSealed, openWrappedKey, sealToPublicKey } = PK.crypto;

  // 兩種格式，都要有備份密碼才打得開，跟平常存在瀏覽器裡那份的保護等級不一樣。
  // version 1（手動匯出、挑幾筆匯出）：{ format, version, kdf: { salt, iterations }, iv, data }，金鑰從備份密碼推出來。
  // version 2（自動備份、立即備份）：{ format, version, wrappedKey, payload }，用公鑰加密，見 crypto.js 的 createBackupKeyPair。
  // version 2 的密文刻意不放最外層：1.14 以前的版本讀到會說「不是備份檔」，不會說「密碼錯誤」讓人以為忘了密碼。

  const BACKUP_FORMAT = 'pk-backup';

  const BACKUP_VERSION_MAX = 2;

  const BACKUP_ITERATIONS = 600000;

  function backupBody(entries, settings, partial) {
    return {
      entries,
      neverSave: partial ? [] : settings.neverSave,
      generator: partial ? undefined : settings.generator,
      clickRules: partial ? undefined : settings.clickRules,
      exportedAt: Date.now(),
    };
  }

  // ids 有給就是「挑幾筆匯出給同事」：只放勾選的那幾筆，設定不帶
  async function exportBackup(password, ids) {
    if (String(password || '').length < 8) throw new Error(t('bg_backup_password_too_short'));
    let entries = await PK.vault.loadEntries();
    const settings = await PK.settings.getSettings();
    const partial = Array.isArray(ids);
    if (partial) {
      const wanted = new Set(ids);
      entries = entries.filter((e) => wanted.has(e.id));
      if (!entries.length) throw new Error(t('bg_none_selected'));
    }
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const key = await deriveKey(password, salt, BACKUP_ITERATIONS);
    const body = backupBody(entries, settings, partial);
    const payload = await encrypt(key, JSON.stringify(body));
    const file = {
      format: BACKUP_FORMAT,
      version: 1,
      kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: BACKUP_ITERATIONS, salt: bytesToB64(salt) },
      iv: payload.iv,
      data: payload.data,
    };
    return { content: JSON.stringify(file, null, 2), count: entries.length };
  }

  // 自動備份用公鑰加密，不需要備份密碼。私鑰用備份密碼加密過，每個檔案都放一份，換電腦也能還原。
  async function exportAutoBackup(backupKey, entries, settings) {
    const file = {
      format: BACKUP_FORMAT,
      version: 2,
      wrappedKey: backupKey.wrappedKey,
      payload: await sealToPublicKey(backupKey.publicKey, JSON.stringify(backupBody(entries, settings, false))),
    };
    return { content: JSON.stringify(file, null, 2), count: entries.length };
  }

  function isBackupFile(file) {
    if (!file || file.format !== BACKUP_FORMAT) return false;
    if (file.version > BACKUP_VERSION_MAX) return true;
    if (file.version === 2) {
      const w = file.wrappedKey;
      const p = file.payload;
      return !!(w && w.kdf && w.kdf.salt && w.iv && w.data && p && p.ephemeralPublicKey && p.salt && p.iv && p.data);
    }
    return !!(file.kdf && file.kdf.salt && file.iv && file.data);
  }

  async function decryptBackup(password, file) {
    if (file.version === 2) return openSealed(await openWrappedKey(password, file.wrappedKey), file.payload);
    const key = await deriveKey(password, b64ToBytes(file.kdf.salt), file.kdf.iterations || BACKUP_ITERATIONS);
    return decrypt(key, { iv: file.iv, data: file.data });
  }

  async function importBackup(password, content) {
    let file;
    try {
      file = JSON.parse(String(content || ''));
    } catch {
      throw new Error(t('bg_not_backup_file'));
    }
    if (!isBackupFile(file)) throw new Error(t('bg_not_backup_file'));
    if (file.version > BACKUP_VERSION_MAX) throw new Error(t('bg_backup_too_new'));
    let body;
    try {
      body = JSON.parse(await decryptBackup(String(password || ''), file));
    } catch {
      // AES-GCM 密碼不對會直接解不開，分不出是密碼錯還是檔案壞
      throw new Error(t('bg_wrong_password_or_damaged'));
    }
    const stats = await PK.entries.importEntries(Array.isArray(body.entries) ? body.entries : []);
    if (Array.isArray(body.neverSave) && body.neverSave.length) {
      const settings = await PK.settings.getSettings();
      await PK.settings.setSettings({ neverSave: Array.from(new Set([...settings.neverSave, ...body.neverSave])) });
    }
    stats.clickRules = await PK.clickRules.importClickRules(Array.isArray(body.clickRules) ? body.clickRules : []);
    PK.badge.refreshActiveBadges();
    return stats;
  }

  // 還沒備份過的話，從第一筆密碼建立的時間開始算天數，這樣剛開始用的前幾十天不會一直被提醒。
  async function backupStatus() {
    const settings = await PK.settings.getSettings();
    const vault = await PK.vault.loadVault();
    const entries = vault.entries;
    const latestChange = entries.reduce((m, e) => Math.max(m, e.updatedAt || 0, e.createdAt || 0), 0);
    const firstCreated = entries.reduce((m, e) => Math.min(m, e.createdAt || Date.now()), Date.now());
    const baseline = settings.lastBackupAt || firstCreated;
    const days = Math.floor((Date.now() - baseline) / PK.vault.DAY_MS);
    const due =
      entries.length > 0 &&
      settings.backupReminderDays > 0 &&
      days >= settings.backupReminderDays &&
      (!settings.lastBackupAt || latestChange > settings.lastBackupAt);
    return {
      lastBackupAt: settings.lastBackupAt,
      days,
      due,
      reminderDays: settings.backupReminderDays,
      count: entries.length,
      autoBackup: PK.autoBackup.autoBackupView(settings.autoBackup, !!(await PK.autoBackup.getAutoBackupKey())),
      log: await PK.backupFiles.getBackupLog(),
    };
  }

  PK.backup = { BACKUP_ITERATIONS, backupStatus, decryptBackup, exportAutoBackup, exportBackup, importBackup };
})();
