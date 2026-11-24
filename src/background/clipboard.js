'use strict';
// 複製密碼後自動清除剪貼簿。秒數在管理頁「設定」分頁選，0 是不清除，預設不清除。
// 只記複製的那段文字的 SHA-256，放在 storage.session，不寫進硬碟。
// 時間到時剪貼簿裡還是那段文字才清，使用者後來自己複製的東西不動。
(() => {
  const PK = (globalThis.PK ??= {});

  const ALARM = 'clipboardClear';
  const SESSION_KEY = 'clipboardCopied';
  const CHOICES = [30, 60, 120];
  const OFFSCREEN_URL = 'src/offscreen/clipboard.html';

  // 剪貼簿的權限是選用的，使用者在管理頁打開這個功能時瀏覽器才問。Edge、Chrome 另外要開 offscreen document 的權限。
  function clipboardPermissions() {
    return PK.platform.can('offscreenClipboard') ? ['clipboardRead', 'clipboardWrite', 'offscreen'] : ['clipboardRead', 'clipboardWrite'];
  }

  function clearSeconds(settings) {
    const n = Number(settings.clipboardClearSeconds);
    return CHOICES.includes(n) ? n : 0;
  }

  async function sha256(text) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(text)));
    return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
  }

  async function permitted() {
    try {
      return await chrome.permissions.contains({ permissions: clipboardPermissions() });
    } catch {
      return false;
    }
  }

  // 小視窗、管理頁、網頁上的「產生強密碼」複製了密碼之後叫這個。沒打開這個功能、或沒給權限就不做事。
  async function noteCopied(text) {
    const seconds = clearSeconds(await PK.settings.getSettings());
    if (!seconds || !text || !(await permitted())) return false;
    await chrome.storage.session.set({ [SESSION_KEY]: await sha256(text) });
    await chrome.alarms.create(ALARM, { when: Date.now() + seconds * 1000 });
    return true;
  }

  // Edge、Chrome 的背景程式不能碰剪貼簿，交給看不到的 offscreen document 比對和清除。
  // 一次只能開一個 offscreen document，已經開著時 createDocument 會丟例外，照樣送訊息就好。
  async function clearWithOffscreen(hash) {
    try {
      await chrome.offscreen.createDocument({
        url: OFFSCREEN_URL,
        reasons: ['CLIPBOARD'],
        justification: 'Clear a password this extension copied to the clipboard.',
      });
    } catch (err) {
      if (!/single offscreen|already/i.test(String(err && err.message))) throw err;
    }
    try {
      const res = await chrome.runtime.sendMessage({ target: 'offscreen-clipboard', hash });
      if (res && res.error) throw new Error(res.error);
      return !!(res && res.cleared);
    } finally {
      await chrome.offscreen.closeDocument().catch(() => {
        // 已經關掉了，不用理
      });
    }
  }

  // Firefox 的背景程式是一般的頁面，自己就能讀寫剪貼簿
  async function clearInBackgroundPage(hash) {
    const text = await navigator.clipboard.readText();
    if ((await sha256(text)) !== hash) return false;
    await navigator.clipboard.writeText('');
    return true;
  }

  // 時間到或工具鎖上時叫這個。剪貼簿裡還是小管家複製的那段文字才清，回傳有沒有清。
  async function clearClipboardIfOurs() {
    const stored = await chrome.storage.session.get(SESSION_KEY);
    const hash = stored[SESSION_KEY];
    if (!hash) return false;
    await chrome.storage.session.remove(SESSION_KEY);
    await chrome.alarms.clear(ALARM);
    if (!(await permitted())) return false;
    return PK.platform.can('offscreenClipboard') ? clearWithOffscreen(hash) : clearInBackgroundPage(hash);
  }

  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== ALARM) return;
    clearClipboardIfOurs().catch((err) => console.warn('[密碼小管家] 清除剪貼簿失敗', err)); // i18n-ignore：給開發者看的
  });

  PK.clipboard = { clearClipboardIfOurs, clipboardPermissions, noteCopied };
})();
