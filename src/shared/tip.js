'use strict';
// 欄位旁邊的「?」說明，管理頁和小視窗共用。HTML 裡寫 <span class="tip" data-tip="說明">?</span>，程式裡用 PK.tip.tipIcon('說明')。
// 被 text-overflow: ellipsis 截成「…」的字也用同一個框，滑鼠移上去顯示全文，不用另外標記。
// 瀏覽器內建的 title 要停約一秒才出現，鍵盤也叫不出來，所以自己畫。
(() => {
  const PK = (globalThis.PK ??= {});

  const GAP = 6;
  const box = document.createElement('div');
  box.className = 'tip-box';
  box.setAttribute('role', 'tooltip');
  box.hidden = true;
  let current = null;

  function place() {
    const r = current.getBoundingClientRect();
    const left = r.left + r.width / 2 - box.offsetWidth / 2;
    const below = r.bottom + GAP;
    const fitsBelow = below + box.offsetHeight <= innerHeight - GAP;
    box.style.left = Math.max(GAP, Math.min(left, innerWidth - box.offsetWidth - GAP)) + 'px';
    box.style.top = (fitsBelow ? below : Math.max(GAP, r.top - GAP - box.offsetHeight)) + 'px';
  }

  function show(target, text) {
    current = target;
    box.textContent = text;
    // 開著的對話框蓋在所有東西上面，要放進對話框裡才看得到
    (target.closest('dialog') || document.body).appendChild(box);
    box.hidden = false;
    place();
  }

  function hide() {
    current = null;
    box.hidden = true;
    // 小視窗「最近產生的」按了顯示，框裡會是密碼，收起來就清掉
    box.textContent = '';
  }

  const iconOf = (e) => (e.target instanceof Element ? e.target.closest('.tip') : null);

  // 滑鼠下面或外層第一個設了 ellipsis 的元素，真的放不下、被截掉才算
  function clippedOf(e) {
    for (let node = e.target instanceof Element ? e.target : null; node && node !== document.body; node = node.parentElement) {
      if (getComputedStyle(node).textOverflow === 'ellipsis') return node.scrollWidth > node.clientWidth ? node : null;
    }
    return null;
  }

  document.addEventListener('mouseover', (e) => {
    const icon = iconOf(e);
    const clipped = icon ? null : clippedOf(e);
    if (icon) show(icon, icon.dataset.tip);
    else if (clipped) show(clipped, clipped.innerText);
    // 畫面重畫時，滑鼠下面的「?」可能被換掉，不會有 mouseout
    else if (current && !current.isConnected) hide();
  });
  document.addEventListener('mouseout', (e) => {
    // 移到自己裡面的元素不算移開，例如帳號底下那行網站
    if (!current || !current.contains(e.target) || current.contains(e.relatedTarget)) return;
    // 用 Tab 移過來或點過的，滑鼠移開還要留著
    if (document.activeElement !== current) hide();
  });
  document.addEventListener('focusin', (e) => {
    const icon = iconOf(e);
    if (icon) show(icon, icon.dataset.tip);
  });
  document.addEventListener('focusout', (e) => {
    if (iconOf(e)) hide();
  });
  // 「?」常放在 label 裡，點它不該勾到旁邊的方框
  document.addEventListener('click', (e) => {
    if (iconOf(e)) e.preventDefault();
  });
  // 「?」也可能放在區塊標題裡，按 Enter 或空白鍵不該把區塊收起來。空白鍵是放開時才算按下，所以兩個都要擋。
  function blockActivation(e) {
    if ((e.key === 'Enter' || e.key === ' ') && iconOf(e)) e.preventDefault();
  }
  document.addEventListener('keydown', blockActivation);
  document.addEventListener('keyup', blockActivation);
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !current) return;
    // 在對話框裡的話，這一下只關說明，不關對話框
    e.preventDefault();
    hide();
  });
  // 捲動時跟著移，不能收掉：用 Tab 移到畫面外的「?」時，瀏覽器會自己捲過去
  window.addEventListener(
    'scroll',
    () => {
      if (current) place();
    },
    true
  );

  function setUp(icon) {
    icon.tabIndex = 0;
    icon.setAttribute('role', 'img');
    icon.setAttribute('aria-label', icon.dataset.tip);
  }

  document.querySelectorAll('.tip').forEach(setUp);

  function tipIcon(text) {
    const icon = document.createElement('span');
    icon.className = 'tip';
    icon.dataset.tip = text;
    icon.textContent = '?';
    setUp(icon);
    return icon;
  }

  PK.tip = { tipIcon };
})();
