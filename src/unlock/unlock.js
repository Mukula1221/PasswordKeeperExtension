// 從工具列小視窗按「用系統驗證解鎖」開出來的獨立小視窗。
// 小視窗一失去焦點就會關掉，系統的驗證視窗跳出來時小視窗就沒了，所以要在這個獨立視窗裡做。
const $ = (id) => document.getElementById(id);

let attempt = 0;
let controller = null;

// waiting：已經叫了系統驗證，在等使用者。failed：沒在等，才顯示「再試一次」。done：驗過了，馬上關視窗。
function show(state, message) {
  $('waiting').hidden = state !== 'waiting';
  $('failed').hidden = state !== 'failed';
  $('done').hidden = state !== 'done';
  $('hello').hidden = state !== 'failed';
  $('close').hidden = state === 'done';
  $('failMsg').textContent = message || '';
}

async function runHello() {
  const mine = ++attempt;
  // 系統驗證可能跳在別的視窗後面。瀏覽器同時只讓叫一次，還在等的那次不先中斷，新叫的會直接失敗。
  if (controller) controller.abort();
  controller = new AbortController();
  show('waiting');
  try {
    await pkWebAuthn.unlock({ signal: controller.signal });
    show('done');
    setTimeout(() => window.close(), 500);
  } catch (err) {
    // 按「點這裡重新開啟」中斷的那次不用顯示，畫面交給新叫的那次
    if (mine !== attempt) return;
    show('failed', err.message);
  }
}

$('waitTitle').textContent = t('unl_wait_title', pkWebAuthn.label());
$('retry').addEventListener('click', runHello);
$('hello').addEventListener('click', runHello);
$('close').addEventListener('click', () => window.close());

runHello();
