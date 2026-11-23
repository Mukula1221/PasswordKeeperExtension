'use strict';
// 把檔案存到「下載」資料夾，和備份紀錄。
(() => {
  const PK = (globalThis.PK ??= {});
  const { t } = PK.i18n;
  const { bytesToB64 } = PK.crypto;


  const LOG_MAX = 100;

  async function appendBackupLog(item) {
    const settings = await PK.settings.getSettings();
    const log = [{ id: crypto.randomUUID(), at: Date.now(), ...item }, ...settings.backupLog].slice(0, LOG_MAX);
    await PK.settings.setSettings({ backupLog: log });
  }

  // 1.6 以前的紀錄沒有 id，第一次讀到時補上，刪除時才分得出是哪一筆
  async function getBackupLog() {
    const { backupLog } = await PK.settings.getSettings();
    if (backupLog.every((item) => item.id)) return backupLog;
    const log = backupLog.map((item) => (item.id ? item : { ...item, id: crypto.randomUUID() }));
    await PK.settings.setSettings({ backupLog: log });
    return log;
  }

  // 找出備份紀錄對應的下載項目。只認這個擴充功能自己下載、而且還留在瀏覽器下載清單裡的。
  // 1.7 以後的紀錄存了下載編號，之前的只能用完整路徑找。
  async function findBackupDownload(item) {
    if (!item.path) return null;
    const found = await chrome.downloads.search(item.downloadId ? { id: item.downloadId } : { filename: item.path });
    return found.find((d) => d.filename === item.path && d.byExtensionId === chrome.runtime.id) || null;
  }

  // 刪不到的原因，管理頁顯示在檔案位置下面。用到時才取文字，換語言之後才會跟著換。
  function fileReason(status) {
    if (status === 'untracked') return t('bg_file_untracked');
    if (status === 'missing') return t('bg_file_missing');
    return '';
  }

  // deletable：可以一起刪。untracked、missing 見 fileReason。none：這筆紀錄本來就沒有檔案（改位置）。
  // 瀏覽器記的「檔案還在」可能是舊的，所以 deletable 的實際刪除還是可能失敗。
  async function backupFileStatus(item) {
    if (item.kind === 'location' || !item.path) return 'none';
    const d = await findBackupDownload(item);
    if (!d) return 'untracked';
    return d.exists && d.state === 'complete' ? 'deletable' : 'missing';
  }

  // 刪紀錄。deleteFiles 是 true 就試著連檔案一起刪，刪不掉的放 failed；false 的話檔案位置放 kept，讓管理頁提醒使用者自己去刪。
  async function deleteBackupLog(ids, deleteFiles) {
    const wanted = new Set(ids || []);
    const targets = (await getBackupLog()).filter((item) => wanted.has(item.id));
    const result = { deleted: targets.length, removed: [], failed: [], kept: [] };
    for (const item of targets) {
      if (item.kind === 'location' || !item.path) continue;
      if (!deleteFiles) {
        result.kept.push(item.path);
        continue;
      }
      const d = await findBackupDownload(item);
      if (!d || !d.exists) {
        result.failed.push({ path: item.path, reason: fileReason(d ? 'missing' : 'untracked') });
        continue;
      }
      try {
        await chrome.downloads.removeFile(d.id);
        result.removed.push(item.path);
      } catch (err) {
        result.failed.push({ path: item.path, reason: t('bg_file_delete_failed', err.message) });
      }
    }
    // 刪檔的這段時間自動備份可能又記了一筆，寫回前重新讀一次
    const { backupLog } = await PK.settings.getSettings();
    await PK.settings.setSettings({ backupLog: backupLog.filter((item) => !wanted.has(item.id)) });
    return result;
  }

  function backupStamp(withTime) {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    let s = d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate());
    if (withTime) s += '-' + p(d.getHours()) + p(d.getMinutes());
    return s;
  }

  // 自動備份只能放在「下載」底下的一層子資料夾，把 Windows 不准用的字元換掉
  function safeFolder(name) {
    const cleaned = String(name || '')
      .replace(/[\\/:*?"<>|]/g, '-')
      .replace(/^[\s.]+|[\s.]+$/g, '')
      .slice(0, 60);
    return cleaned || PK.settings.DEFAULT_SETTINGS.autoBackup.folder;
  }

  // 等下載結束，回傳檔案在電腦上的完整路徑，備份紀錄記的就是這個
  function waitForDownload(id) {
    return new Promise((resolve, reject) => {
      const check = async () => {
        const [item] = await chrome.downloads.search({ id });
        if (!item) return reject(new Error(t('bg_download_not_found')));
        if (item.state === 'complete') return resolve(item.filename);
        if (item.state === 'interrupted') {
          return reject(new Error(item.error ? t('bg_download_interrupted_reason', item.error) : t('bg_download_interrupted')));
        }
        setTimeout(() => check().catch(reject), 300);
      };
      check().catch(reject);
    });
  }

  // service worker 沒有 URL.createObjectURL，檔案內容用 data URL 交給下載。
  // 下載編號也回傳，備份紀錄存起來，之後刪紀錄時才找得到檔案。
  async function saveFile({ content, filename, mime, saveAs }) {
    const url = 'data:' + mime + ';base64,' + bytesToB64(new TextEncoder().encode(content));
    let id;
    try {
      id = await chrome.downloads.download({ url, filename, saveAs: !!saveAs, conflictAction: 'uniquify' });
    } catch (err) {
      throw new Error(/cancel/i.test(err.message) ? t('common_cancelled') : t('bg_download_failed', err.message));
    }
    return { id, path: await waitForDownload(id) };
  }

  // 手動匯出（加密備份、CSV、挑選匯出）都走這裡：跳另存新檔讓使用者選位置，存完記一筆紀錄
  async function downloadBackup({ content, filename, mime, kind, count }) {
    const { id, path } = await saveFile({ content, filename, mime, saveAs: true });
    await appendBackupLog({ kind, path, count, downloadId: id });
    // 挑幾筆給同事的不算完整備份
    if (kind !== 'selected') await PK.settings.setSettings({ lastBackupAt: Date.now() });
    return { path };
  }

  PK.backupFiles = { appendBackupLog, backupFileStatus, backupStamp, deleteBackupLog, downloadBackup, fileReason, getBackupLog, safeFolder, saveFile };
})();
