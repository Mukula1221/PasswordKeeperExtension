'use strict';
// 回答瀏覽器自己跳的「需要驗證」小視窗（HTTP Basic / Digest）。
(() => {
  const PK = (globalThis.PK ??= {});

  // 瀏覽器問之前先攔下來：那個網站有存帳號就直接回答，沒有就讓視窗照常跳出來。
  // 使用者在那個視窗裡手打的帳密，擴充功能看不到也存不了，要先在小視窗新增。

  const authAttempts = new Map();

  async function handleAuthRequired(details) {
    if (details.isProxy) return {};
    // 不能在私密視窗用的瀏覽器，私密分頁的驗證視窗照常跳，見 platform.js 的 privateWindows
    if (PK.platform.privateBlocked(details.incognito)) return {};
    const host = ((details.challenger && details.challenger.host) || '').toLowerCase();
    if (!host) return {};
    // 同一個請求只回答一次。回答錯了瀏覽器會再問，第二次就放給瀏覽器的視窗，不然會無限重試。
    const count = (authAttempts.get(details.requestId) || 0) + 1;
    authAttempts.set(details.requestId, count);
    setTimeout(() => authAttempts.delete(details.requestId), 60 * 1000);
    if (count > 1) return {};
    if (await PK.lock.isLocked()) return {};
    const entries = PK.entries.rankEntries(await PK.vault.loadEntries(), host);
    if (!entries.length) return {};
    // http 的驗證視窗會把帳密用明文送出去。帳號是在 https 存的就不回答，讓瀏覽器的視窗照常跳出來
    if (PK.domain.insecureFill(details.url, entries[0].origin)) return {};
    PK.vault.touchEntry(entries[0].id);
    return { authCredentials: { username: entries[0].username, password: entries[0].password } };
  }

  chrome.webRequest.onAuthRequired.addListener(
    (details, asyncCallback) => {
      handleAuthRequired(details)
        .then(asyncCallback)
        .catch((err) => {
          console.warn('[密碼小管家] 回答驗證視窗失敗', err); // i18n-ignore：給開發者看的
          asyncCallback({});
        });
    },
    { urls: ['http://*/*', 'https://*/*'] },
    ['asyncBlocking']
  );
})();
