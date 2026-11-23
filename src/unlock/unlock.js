'use strict';
// 從工具列小視窗按「解鎖」開出來的獨立小視窗。
// 小視窗一失去焦點就會關掉，系統的驗證視窗跳出來時小視窗就沒了，所以要在這個獨立視窗裡做。
// 自訂密碼加密時改成在這裡打自訂密碼，不叫系統驗證。
(() => {
  const PK = (globalThis.PK ??= {});
  const { t } = PK.i18n;
  const pkWebAuthn = PK.webauthnClient;

  const $ = (id) => document.getElementById(id);

  function send(msg) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(msg, (res) => {
        if (chrome.runtime.lastError) return resolve({ ok: false, error: chrome.runtime.lastError.message });
        resolve(res || { ok: false, error: t('wa_no_response') });
      });
    });
  }

  let attempt = 0;
  let controller = null;

  // waiting：已經叫了系統驗證，在等使用者。failed：沒在等，才顯示「再試一次」。done：驗過了，馬上關視窗。password：打自訂密碼。
  function show(state, message) {
    $('waiting').hidden = state !== 'waiting';
    $('failed').hidden = state !== 'failed';
    $('done').hidden = state !== 'done';
    $('pwForm').hidden = state !== 'password';
    $('hello').hidden = state !== 'failed';
    $('close').hidden = state === 'done';
    $('failMsg').textContent = message || '';
    if (state === 'password') $('pw').focus();
  }

  function finish() {
    show('done');
    setTimeout(() => window.close(), 500);
  }

  async function runHello() {
    const mine = ++attempt;
    // 系統驗證可能跳在別的視窗後面。瀏覽器同時只讓叫一次，還在等的那次不先中斷，新叫的會直接失敗。
    if (controller) controller.abort();
    controller = new AbortController();
    show('waiting');
    try {
      await pkWebAuthn.unlock({ signal: controller.signal });
      finish();
    } catch (err) {
      // 按「點這裡重新開啟」中斷的那次不用顯示，畫面交給新的那次
      if (mine !== attempt) return;
      show('failed', err.message);
    }
  }

  $('waitTitle').textContent = t('unl_wait_title', pkWebAuthn.label());
  $('retry').addEventListener('click', runHello);
  $('hello').addEventListener('click', runHello);
  $('close').addEventListener('click', () => window.close());

  $('pwForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('pwError').textContent = '';
    $('pwSubmit').disabled = true;
    try {
      const res = await send({ type: 'lock.unlockPassword', password: $('pw').value });
      if (!res.ok) throw new Error(res.error);
      $('pw').value = '';
      finish();
    } catch (err) {
      $('pwError').textContent = err.message;
    } finally {
      $('pwSubmit').disabled = false;
    }
  });

  (async function start() {
    const res = await send({ type: 'lock.status' });
    const st = res.ok ? res.data : {};
    if (st.mode === 'password') show('password');
    else runHello();
  })();
})();
