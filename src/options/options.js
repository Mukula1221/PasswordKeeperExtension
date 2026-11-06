// 管理頁：列出所有密碼，可以搜尋、新增、修改、刪除、匯入匯出 CSV、改設定。
const $ = (id) => document.getElementById(id);

function send(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (res) => {
      if (chrome.runtime.lastError) return resolve({ ok: false, error: chrome.runtime.lastError.message });
      resolve(res || { ok: false, error: t('opt_no_response') });
    });
  });
}

let toastTimer = null;
function toast(text) {
  const box = $('toast');
  box.textContent = text;
  box.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => box.classList.remove('show'), 2500);
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

let entries = [];
let settings = { autoFill: true, neverSave: [] };
let editingId = null;
// 表格裡勾選的帳號 id，給「匯出勾選的」用
let selected = new Set();
let lastVisible = [];
let trash = [];
// 回收桶勾選的帳號 id
let trashSelected = new Set();
// 備份紀錄：全部的紀錄、目前的篩選、勾選的紀錄 id
let logItems = [];
let logFilter = 'all';
let logSelected = new Set();
// 這一頁開著期間有沒有通過系統驗證
let pageVerified = false;

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast(t('opt_copied'));
  } catch (err) {
    toast(t('opt_copy_failed', err.message));
  }
}

// 對話框不在 pageMain 裡面，鎖定時不關的話會蓋在驗證畫面上，按「顯示」還看得到密碼。
// 問密碼和選擇的對話框有人在等結果，送 cancel 走跟按 Esc 一樣的取消，等的地方才會收到 null。
function closeDialogsForLock() {
  for (const dlg of document.querySelectorAll('dialog[open]')) {
    dlg.dispatchEvent(new Event('cancel', { cancelable: true }));
    if (dlg.open) dlg.close();
  }
  for (const id of ['fPass', 'pw1', 'pw2']) $(id).value = '';
}

async function load() {
  // 鎖住時整頁只剩輸 PIN 的框
  // 有啟用鎖定的話，每次打開管理頁都要先驗一次；驗過之後這一頁開著期間不用再驗，除非鎖定被觸發
  const lock = await send({ type: 'lock.status' });
  const needVerify = lock.ok && lock.data.enabled && (lock.data.locked || !pageVerified);
  $('lockScreen').hidden = !needVerify;
  $('pageMain').hidden = needVerify;
  if (needVerify) {
    closeDialogsForLock();
    $('helloUnlock').textContent = t('opt_verify_with', pkWebAuthn.label());
    $('lockError').textContent = lock.data.webauthn ? '' : t('opt_lock_broken');
    return;
  }
  const [a, s] = await Promise.all([send({ type: 'entries.all' }), send({ type: 'settings.get' })]);
  if (!a.ok) {
    $('status').textContent = t('opt_load_failed', a.error);
    return;
  }
  $('status').textContent = '';
  entries = a.data;
  if (s.ok) settings = s.data;
  // 被刪掉或復原的帳號，勾選狀態要跟著清掉
  selected = new Set([...selected].filter((id) => entries.some((e) => e.id === id)));
  renderTable();
  renderHealth();
  renderSettings();
  renderBackup();
  renderTrash();
}

function fmtDate(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return d.toLocaleDateString(uiLang()) + ' ' + d.toLocaleTimeString(uiLang(), { hour: '2-digit', minute: '2-digit' });
}

function renderTable() {
  const q = $('search').value.trim().toLowerCase();
  const visible = entries.filter(
    (e) => !q || e.host.includes(q) || e.username.toLowerCase().includes(q) || (e.note || '').toLowerCase().includes(q)
  );
  const tbody = $('rows');
  tbody.textContent = '';
  $('empty').hidden = entries.length > 0;
  lastVisible = visible.map((e) => e.id);
  $('checkAll').checked = visible.length > 0 && visible.every((e) => selected.has(e.id));
  updateExportSelected();

  for (const e of visible) {
    const tr = el('tr');

    const chk = el('td', 'chk');
    const box = el('input');
    box.type = 'checkbox';
    box.checked = selected.has(e.id);
    box.addEventListener('change', () => {
      if (box.checked) selected.add(e.id);
      else selected.delete(e.id);
      $('checkAll').checked = lastVisible.every((id) => selected.has(id));
      updateExportSelected();
    });
    chk.appendChild(box);

    const site = el('td', 'site');
    const link = el('a', null, e.host);
    link.href = e.origin || 'https://' + e.host;
    link.target = '_blank';
    link.rel = 'noopener';
    site.appendChild(link);
    if (e.note) site.appendChild(el('div', 'muted', e.note));

    const user = el('td', null, e.username || t('opt_no_username'));

    // 不能叫 pw：ui.css 的 .pw 是密碼輸入框，裡面的按鈕會被疊到右上角
    const pw = el('td', 'pwcell');
    const mask = el('span', null, '••••••••');
    let shown = false;
    const eye = el('button', 'link small', t('opt_show'));
    eye.addEventListener('click', () => {
      shown = !shown;
      mask.textContent = shown ? e.password : '••••••••';
      eye.textContent = shown ? t('opt_hide') : t('opt_show');
    });
    const copy = el('button', 'link small', t('opt_copy'));
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(e.password);
        toast(t('opt_password_copied'));
      } catch (err) {
        toast(t('opt_copy_failed', err.message));
      }
    });
    pw.appendChild(mask);
    pw.appendChild(eye);
    pw.appendChild(copy);
    // 改過密碼的帳號可以展開看之前的
    let histRow = null;
    if (e.history && e.history.length) {
      const toggle = el('button', 'link small', t('opt_history_toggle', e.history.length));
      toggle.addEventListener('click', () => {
        if (histRow) {
          histRow.remove();
          histRow = null;
          return;
        }
        histRow = renderHistoryRow(e);
        tr.after(histRow);
      });
      pw.appendChild(toggle);
    }

    const used = el('td', 'muted', fmtDate(e.lastUsedAt));

    const ops = el('td', 'ops');
    const edit = el('button', 'small', t('opt_edit'));
    edit.addEventListener('click', () => openDialog(e));
    const del = el('button', 'small danger', t('opt_delete'));
    del.addEventListener('click', async () => {
      if (!confirm(t('opt_confirm_delete', e.host, e.username || t('opt_no_username')))) return;
      const res = await send({ type: 'entries.delete', id: e.id });
      if (!res.ok) {
        toast(t('opt_delete_failed', res.error));
        return;
      }
      toast(tn('opt_moved_to_trash', currentTrashDays()));
      await load();
    });
    ops.appendChild(edit);
    ops.appendChild(del);

    tr.appendChild(chk);
    tr.appendChild(site);
    tr.appendChild(user);
    tr.appendChild(pw);
    tr.appendChild(used);
    tr.appendChild(ops);
    tbody.appendChild(tr);
  }

  if (q && !visible.length && entries.length) {
    const tr = el('tr');
    const td = el('td', 'empty', t('opt_search_no_match', q));
    td.colSpan = 6;
    tr.appendChild(td);
    tbody.appendChild(tr);
  }
}

function renderHistoryRow(e) {
  const tr = el('tr', 'hist');
  const td = el('td');
  td.colSpan = 6;
  for (const h of e.history) {
    const line = el('div', 'old');
    line.appendChild(el('span', 'muted', t('opt_history_replaced_at', fmtDate(h.changedAt))));
    const mask = el('span', null, '••••••••');
    let shown = false;
    const eye = el('button', 'link small', t('opt_show'));
    eye.addEventListener('click', () => {
      shown = !shown;
      mask.textContent = shown ? h.password : '••••••••';
      eye.textContent = shown ? t('opt_hide') : t('opt_show');
    });
    const copy = el('button', 'link small', t('opt_copy'));
    copy.addEventListener('click', () => copyText(h.password));
    line.appendChild(mask);
    line.appendChild(eye);
    line.appendChild(copy);
    td.appendChild(line);
  }
  tr.appendChild(td);
  return tr;
}

function updateExportSelected() {
  const btn = $('exportSelected');
  btn.disabled = selected.size === 0;
  btn.textContent = selected.size ? tn('opt_export_selected_n', selected.size) : t('opt_export_selected');
}

$('checkAll').addEventListener('change', (e) => {
  for (const id of lastVisible) {
    if (e.target.checked) selected.add(id);
    else selected.delete(id);
  }
  renderTable();
});

// ---- 密碼健檢 ----

function charClasses(p) {
  let n = 0;
  if (/[a-z]/.test(p)) n++;
  if (/[A-Z]/.test(p)) n++;
  if (/[0-9]/.test(p)) n++;
  if (/[^A-Za-z0-9]/.test(p)) n++;
  return n;
}

// 健檢只顯示一行摘要，有問題才給「看詳細」展開清單，不佔版面
function renderHealth() {
  const list = $('healthList');
  const strip = $('healthStrip');
  const summary = $('healthSummary');
  const toggle = $('healthToggle');
  list.textContent = '';
  list.hidden = true;
  toggle.hidden = true;
  toggle.textContent = t('opt_health_show');
  strip.className = 'strip';
  if (!entries.length) {
    summary.textContent = '';
    return;
  }
  const byPassword = new Map();
  for (const e of entries) {
    if (!byPassword.has(e.password)) byPassword.set(e.password, []);
    byPassword.get(e.password).push(e);
  }
  const reused = [...byPassword.values()].filter((g) => g.length >= 2);
  const weak = entries.filter((e) => e.password.length < 8 || charClasses(e.password) < 2);
  const yearAgo = Date.now() - 365 * 24 * 60 * 60 * 1000;
  const old = entries.filter((e) => (e.passwordChangedAt || e.createdAt || 0) < yearAgo);
  if (!reused.length && !weak.length && !old.length) {
    strip.className = 'strip ok';
    summary.textContent = t('opt_health_ok');
    return;
  }
  strip.className = 'strip warn';
  summary.textContent = tn('opt_health_summary', reused.length, weak.length, old.length);
  toggle.hidden = false;
  const who = (e) => t('opt_account_label', e.host, e.username || t('opt_no_username'));
  const addItem = (what, e) => {
    const div = el('div', 'health-item');
    const w = el('div', 'what', what);
    w.appendChild(el('div', 'who', who(e)));
    const btn = el('button', 'small', t('opt_edit'));
    btn.addEventListener('click', () => openDialog(e));
    div.appendChild(w);
    div.appendChild(btn);
    list.appendChild(div);
  };
  reused.forEach((g, i) => {
    for (const e of g) addItem(t('opt_health_reused', i + 1, g.length), e);
  });
  for (const e of weak) {
    addItem(e.password.length < 8 ? tn('opt_health_weak_short', e.password.length) : t('opt_health_weak_classes'), e);
  }
  for (const e of old) addItem(t('opt_health_old', fmtDate(e.passwordChangedAt || e.createdAt)), e);
}

$('healthToggle').addEventListener('click', () => {
  const open = $('healthList').hidden;
  $('healthList').hidden = !open;
  $('healthToggle').textContent = open ? t('opt_health_hide') : t('opt_health_show');
});

// ---- 回收桶 ----

function currentTrashDays() {
  return settings.trashDays || 30;
}

// 放了幾天，滿 24 小時才算一天。背景程式清回收桶也是這樣算，兩邊的「超過幾天」才對得起來。
function ageDays(ts) {
  return Math.floor((Date.now() - (ts || 0)) / (24 * 60 * 60 * 1000));
}

function daysLeft(deletedAt) {
  return Math.max(0, currentTrashDays() - ageDays(deletedAt));
}

function accountLabel(item) {
  return t('opt_account_label', item.host, item.username || t('opt_no_username'));
}

async function renderTrash() {
  // 使用者正在改天數的時候不要把欄位蓋掉
  if (document.activeElement !== $('trashDays')) $('trashDays').value = currentTrashDays();
  updateTrashDaysApply();
  $('deleteAllDays').textContent = currentTrashDays();
  const res = await send({ type: 'trash.list' });
  if (!res.ok) {
    $('trashList').textContent = '';
    $('trashList').appendChild(el('div', 'error', t('opt_trash_load_failed', res.error)));
    return;
  }
  trash = res.data;
  // 已經復原或清掉的，勾選狀態要跟著清掉
  trashSelected = new Set([...trashSelected].filter((id) => trash.some((item) => item.id === id)));
  drawTrash();
}

function drawTrash() {
  const box = $('trashList');
  box.textContent = '';
  $('trashCount').textContent = trash.length ? String(trash.length) : '';
  $('trashEmpty').hidden = trash.length > 0;
  $('trashTools').hidden = trash.length === 0;
  $('purgeAll').disabled = trash.length === 0;
  updateTrashSelection();
  for (const item of trash) {
    const row = el('div', 'entry');
    const chk = el('input');
    chk.type = 'checkbox';
    chk.checked = trashSelected.has(item.id);
    chk.addEventListener('change', () => {
      if (chk.checked) trashSelected.add(item.id);
      else trashSelected.delete(item.id);
      updateTrashSelection();
    });
    const u = el('div', 'u', accountLabel(item));
    u.appendChild(el('div', 'h', tn('opt_trash_item_info', daysLeft(item.deletedAt), fmtDate(item.deletedAt))));
    const restore = el('button', 'small', t('opt_restore'));
    restore.addEventListener('click', async () => {
      const r = await send({ type: 'trash.restore', id: item.id });
      if (!r.ok) {
        toast(r.error);
        return;
      }
      toast(t('opt_restored'));
      await load();
    });
    const purge = el('button', 'small danger', t('opt_purge'));
    purge.addEventListener('click', async () => {
      if (!confirm(t('opt_confirm_purge', item.host, item.username || t('opt_no_username')))) return;
      const r = await send({ type: 'trash.purge', id: item.id });
      if (!r.ok) {
        toast(r.error);
        return;
      }
      await renderTrash();
    });
    row.appendChild(chk);
    row.appendChild(u);
    row.appendChild(restore);
    row.appendChild(purge);
    box.appendChild(row);
  }
}

function updateTrashSelection() {
  const n = trashSelected.size;
  $('trashCheckAll').checked = trash.length > 0 && n === trash.length;
  $('trashRestoreSel').disabled = n === 0;
  $('trashPurgeSel').disabled = n === 0;
  $('trashRestoreSel').textContent = n ? tn('opt_trash_restore_selected_n', n) : t('opt_trash_restore_selected');
  $('trashPurgeSel').textContent = n ? tn('opt_trash_purge_selected_n', n) : t('opt_trash_purge_selected');
}

$('trashCheckAll').addEventListener('change', (e) => {
  trashSelected = e.target.checked ? new Set(trash.map((item) => item.id)) : new Set();
  drawTrash();
});

$('trashRestoreSel').addEventListener('click', async () => {
  if (!trashSelected.size) return;
  const r = await send({ type: 'trash.restoreMany', ids: [...trashSelected] });
  if (!r.ok) {
    toast(t('opt_restore_failed', r.error));
    return;
  }
  trashSelected.clear();
  await load();
  const { restored, skipped } = r.data;
  if (!skipped.length) {
    toast(tn('opt_restored_n', restored));
    return;
  }
  await askChoice({
    title: t('opt_restored_skipped_title', restored, skipped.length),
    text: t('opt_restored_skipped_text'),
    items: skipped.map((item) => ({ text: accountLabel(item) })),
    buttons: [{ label: t('opt_got_it'), value: true, className: 'primary' }],
  });
});

$('trashPurgeSel').addEventListener('click', async () => {
  const n = trashSelected.size;
  if (!n) return;
  if (!confirm(tn('opt_confirm_purge_selected', n))) return;
  const r = await send({ type: 'trash.purgeMany', ids: [...trashSelected] });
  if (!r.ok) {
    toast(r.error);
    return;
  }
  trashSelected.clear();
  toast(tn('opt_purged_n', r.data));
  await renderTrash();
});

$('purgeAll').addEventListener('click', async () => {
  if (!trash.length) return;
  if (!confirm(tn('opt_confirm_purge_all', trash.length))) return;
  const r = await send({ type: 'trash.purgeAll' });
  if (!r.ok) {
    toast(r.error);
    return;
  }
  toast(t('opt_trash_emptied'));
  await renderTrash();
});

// 天數要按「套用」才存：數字框的上下箭頭每按一下都算一次修改，改了就存的話一路按下去會連續跳提示
function updateTrashDaysApply() {
  const n = Number($('trashDays').value);
  $('trashDaysApply').disabled = !(Number.isInteger(n) && n >= 1 && n <= 365) || n === currentTrashDays();
}
$('trashDays').addEventListener('input', updateTrashDaysApply);

$('trashDaysApply').addEventListener('click', async () => {
  const days = Number($('trashDays').value);
  if (!(Number.isInteger(days) && days >= 1 && days <= 365)) {
    toast(t('opt_trash_days_invalid'));
    return;
  }
  const keep = currentTrashDays();
  const expiring = trash.filter((item) => ageDays(item.deletedAt) >= days);
  if (expiring.length) {
    const ok = await askChoice({
      title: tn('opt_trash_days_title', days),
      text: tn('opt_trash_days_expiring', expiring.length),
      items: expiring.map((item) => ({ text: accountLabel(item), note: tn('opt_trash_age', ageDays(item.deletedAt)) })),
      buttons: [
        { label: t('opt_cancel'), value: false },
        { label: t('opt_confirm_delete_button'), value: true, className: 'danger' },
      ],
    });
    if (!ok) {
      $('trashDays').value = keep;
      updateTrashDaysApply();
      return;
    }
  }
  const res = await send({ type: 'trash.setDays', days });
  if (!res.ok) {
    toast(t('opt_setting_failed', res.error));
    return;
  }
  settings.trashDays = res.data.days;
  toast(res.data.purged ? tn('opt_trash_days_set_purged', res.data.days, res.data.purged) : tn('opt_trash_days_set', res.data.days));
  await renderTrash();
});

function renderSettings() {
  $('autoFill').checked = !!settings.autoFill;
  $('reminderDays').value = settings.backupReminderDays == null ? 30 : settings.backupReminderDays;
  const box = $('never');
  box.textContent = '';
  $('neverEmpty').hidden = settings.neverSave.length > 0;
  for (const host of settings.neverSave) {
    const chip = el('span', 'chip', host);
    const x = el('button', null, '✕');
    x.title = t('opt_remove');
    x.addEventListener('click', async () => {
      const res = await send({ type: 'neverSave.remove', host });
      if (!res.ok) {
        toast(t('opt_remove_failed', res.error));
        return;
      }
      settings = res.data;
      renderSettings();
    });
    chip.appendChild(x);
    box.appendChild(chip);
  }
  renderSites();
  renderClickRules();
  renderLock();
}

// ---- 自動點選的規則：在網頁上選按鈕或手動新增，這裡調整，改了馬上存 ----

const CLICK_WHEN = [
  ['afterFill', t('opt_when_after_fill')],
  ['onLoad', t('opt_when_on_load')],
];
const CLICK_MISSING = [
  ['skip', t('opt_missing_skip')],
  ['stop', t('opt_missing_stop')],
];
const RULE_TIPS = {
  host: t('opt_rule_tip_host'),
  path: t('opt_rule_tip_path'),
  selector: t('opt_rule_tip_selector'),
  text: t('opt_rule_tip_text'),
  when: t('opt_rule_tip_when'),
  interval: t('opt_rule_tip_interval'),
  missing: t('opt_rule_tip_missing'),
};
// 使用者開合過的網站。重畫時要留著，不然改一條規則整塊就收起來。
const ruleSiteOpen = new Map();
// 寫法有問題、還沒存的選擇器。重畫時要留著，不然打的內容會不見。鍵是規則 id，值是 { value, error }。
const ruleSelectorDrafts = new Map();

// 「自動填完才點」要有帳號、自動填入要開著才會動。不標出來的話，使用者會以為規則壞了。
function clickRuleNote(rule) {
  if (rule.when !== 'afterFill') return '';
  if (!entries.some((e) => e.host === rule.host)) return t('opt_rule_note_no_account');
  if (!settings.autoFill || (settings.noAutoFillHosts || []).includes(rule.host)) return t('opt_rule_note_fill_off');
  return '';
}

// 回傳改好的那條規則，失敗回傳 null
async function updateClickRule(id, patch) {
  const res = await send({ type: 'clickRules.update', id, patch });
  if (!res.ok) {
    toast(t('opt_setting_failed', res.error));
    return null;
  }
  settings = res.data;
  return settings.clickRules.find((r) => r.id === id) || null;
}

function selectorProblem(value) {
  if (!value) return t('opt_selector_empty');
  try {
    document.createDocumentFragment().querySelector(value);
    return '';
  } catch {
    return t('opt_selector_invalid');
  }
}

function ruleCardOf(id) {
  return [...document.querySelectorAll('.rule-card')].find((c) => c.dataset.ruleId === id);
}

async function moveClickRule(rule, siteRules, step) {
  const ids = siteRules.map((r) => r.id);
  const from = ids.indexOf(rule.id);
  ids.splice(from, 1);
  ids.splice(from + step, 0, rule.id);
  const res = await send({ type: 'clickRules.reorder', host: rule.host, ids });
  if (!res.ok) {
    toast(t('opt_reorder_failed', res.error));
    return;
  }
  settings = res.data;
  renderClickRules();
  const card = ruleCardOf(rule.id);
  card.classList.add('moved');
  // 重畫後按鈕換了一顆，焦點要放回去，用鍵盤才能連續移動。移到頭了就換另一顆。
  const order = step < 0 ? ['.rule-up', '.rule-down'] : ['.rule-down', '.rule-up'];
  const next = order.map((s) => card.querySelector(s)).find((b) => !b.disabled);
  if (next) next.focus();
}

// 一個欄位：標籤在上面、欄位在下面。整個包在 label 裡，點標籤文字也會跳到欄位。
function ruleField(className, name, tip, control) {
  const field = el('label', 'rule-field ' + className);
  const title = el('span', 'rule-field-name', name);
  title.appendChild(tipIcon(tip));
  field.appendChild(title);
  field.appendChild(control);
  return field;
}

function ruleSelectorBox(value) {
  const box = el('textarea', 'rule-selector');
  box.rows = 1;
  box.spellcheck = false;
  box.value = value;
  // 選擇器不會換行，Enter 當作改完
  box.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    box.blur();
  });
  return box;
}

function ruleIntervalBox(value) {
  const box = el('input', 'rule-interval');
  box.type = 'number';
  box.min = 1;
  box.max = 86400;
  box.step = 1;
  box.value = value;
  return box;
}

function ruleSelect(className, options, value) {
  const select = el('select', className);
  for (const [optionValue, label] of options) {
    const option = el('option', null, label);
    option.value = optionValue;
    select.appendChild(option);
  }
  select.value = value;
  return select;
}

function ruleCard(rule, index, siteRules, showCount) {
  const card = el('div', 'rule-card');
  card.dataset.ruleId = rule.id;
  card.classList.toggle('off', !rule.enabled);
  const isLast = index === siteRules.length - 1;

  const head = el('div', 'rule-head');
  head.appendChild(el('span', 'rule-no', t('opt_rule_no', index + 1)));
  const up = el('button', 'small rule-up', '▲');
  up.title = t('opt_move_up');
  up.disabled = index === 0;
  up.addEventListener('click', () => moveClickRule(rule, siteRules, -1));
  head.appendChild(up);
  const down = el('button', 'small rule-down', '▼');
  down.title = t('opt_move_down');
  down.disabled = isLast;
  down.addEventListener('click', () => moveClickRule(rule, siteRules, 1));
  head.appendChild(down);

  const enabledLabel = el('label', 'inline push');
  const enabled = el('input', 'rule-enabled');
  enabled.type = 'checkbox';
  enabled.checked = !!rule.enabled;
  enabled.addEventListener('change', async () => {
    const saved = await updateClickRule(rule.id, { enabled: enabled.checked });
    if (saved) rule.enabled = saved.enabled;
    enabled.checked = !!rule.enabled;
    card.classList.toggle('off', !rule.enabled);
    showCount();
  });
  enabledLabel.appendChild(enabled);
  enabledLabel.appendChild(el('span', null, t('opt_rule_enabled')));
  head.appendChild(enabledLabel);

  const del = el('button', 'small danger rule-delete', t('opt_delete'));
  del.addEventListener('click', async () => {
    if (!confirm(t('opt_confirm_delete_rule', rule.host))) return;
    const res = await send({ type: 'clickRules.delete', id: rule.id });
    if (!res.ok) {
      toast(t('opt_delete_failed', res.error));
      return;
    }
    settings = res.data;
    ruleSelectorDrafts.delete(rule.id);
    renderClickRules();
  });
  head.appendChild(del);
  card.appendChild(head);

  const fields = el('div', 'rule-fields');

  const text = el('input', 'rule-text');
  text.type = 'text';
  text.value = rule.text || '';
  text.addEventListener('change', async () => {
    const saved = await updateClickRule(rule.id, { text: text.value });
    if (saved) rule.text = saved.text;
    text.value = rule.text || '';
  });
  fields.appendChild(ruleField('half', t('opt_rule_field_text'), RULE_TIPS.text, text));

  const path = el('input', 'rule-path');
  path.type = 'text';
  path.value = rule.path;
  path.spellcheck = false;
  path.addEventListener('change', async () => {
    const saved = await updateClickRule(rule.id, { path: path.value });
    // 背景程式可能修過（貼整個網址時只留路徑），失敗就放回原本的
    if (saved) rule.path = saved.path;
    path.value = rule.path;
  });
  fields.appendChild(ruleField('half', t('opt_rule_field_path'), RULE_TIPS.path, path));

  const draft = ruleSelectorDrafts.get(rule.id);
  const selector = ruleSelectorBox(draft ? draft.value : rule.selector);
  const selectorError = el('div', 'error', draft ? draft.error : '');
  selector.addEventListener('change', async () => {
    const value = selector.value.trim();
    let error = selectorProblem(value);
    let saved = null;
    if (!error) {
      const res = await send({ type: 'clickRules.update', id: rule.id, patch: { selector: value } });
      if (res.ok) {
        settings = res.data;
        saved = settings.clickRules.find((r) => r.id === rule.id);
      } else {
        error = res.error;
      }
    }
    selectorError.textContent = error;
    if (error) {
      ruleSelectorDrafts.set(rule.id, { value: selector.value, error });
      return;
    }
    ruleSelectorDrafts.delete(rule.id);
    if (!saved) return;
    selector.value = saved.selector;
    rule.selector = saved.selector;
    if (saved.text !== (rule.text || '')) toast(t('opt_rule_text_cleared'));
    rule.text = saved.text;
    text.value = saved.text;
  });
  const selectorField = ruleField('full', t('opt_rule_field_selector'), t('opt_rule_tip_selector_edit', RULE_TIPS.selector), selector);
  selectorField.appendChild(selectorError);
  fields.appendChild(selectorField);

  const when = ruleSelect('rule-when', CLICK_WHEN, rule.when);
  const note = el('div', 'muted rule-note', clickRuleNote(rule));
  when.addEventListener('change', async () => {
    const saved = await updateClickRule(rule.id, { when: when.value });
    if (saved) rule.when = saved.when;
    when.value = rule.when;
    note.textContent = clickRuleNote(rule);
  });
  const whenField = ruleField('third', t('opt_rule_field_when'), RULE_TIPS.when, when);
  whenField.appendChild(note);
  fields.appendChild(whenField);

  const interval = ruleIntervalBox(rule.intervalSec || '');
  interval.placeholder = t('opt_interval_placeholder', settings.clickIntervalSec);
  interval.addEventListener('change', async () => {
    const raw = interval.value.trim();
    const saved = await updateClickRule(rule.id, { intervalSec: raw === '' ? null : Number(raw) });
    if (saved) rule.intervalSec = saved.intervalSec;
    interval.value = rule.intervalSec || '';
  });
  fields.appendChild(ruleField('third', t('opt_rule_field_interval'), RULE_TIPS.interval, interval));

  const missing = ruleSelect('rule-missing', CLICK_MISSING, rule.onMissing === 'stop' ? 'stop' : 'skip');
  // 最後一條後面沒有別條，選哪個都一樣
  missing.disabled = isLast;
  if (isLast) missing.title = t('opt_missing_last_title');
  missing.addEventListener('change', async () => {
    const saved = await updateClickRule(rule.id, { onMissing: missing.value });
    if (saved) rule.onMissing = saved.onMissing;
    missing.value = rule.onMissing === 'stop' ? 'stop' : 'skip';
  });
  fields.appendChild(ruleField('third', t('opt_rule_field_missing'), RULE_TIPS.missing, missing));

  card.appendChild(fields);
  return card;
}

function ruleSite(host, siteRules, onlySite) {
  const site = el('details', 'rule-site');
  // 沒開合過的網站：只有一個網站就展開，好幾個就收著，才看得到全部有哪些網站
  site.open = ruleSiteOpen.has(host) ? ruleSiteOpen.get(host) : onlySite;
  site.addEventListener('toggle', () => ruleSiteOpen.set(host, site.open));

  const summary = el('summary', null, host);
  const count = el('span', 'muted');
  const showCount = () => {
    const off = siteRules.filter((r) => !r.enabled).length;
    count.textContent = off ? tn('opt_rule_count_off', siteRules.length, off) : tn('opt_rule_count', siteRules.length);
  };
  showCount();
  summary.appendChild(count);
  site.appendChild(summary);

  const list = el('div', 'rule-list');
  siteRules.forEach((rule, i) => list.appendChild(ruleCard(rule, i, siteRules, showCount)));
  const add = el('button', 'small rule-add', t('opt_add_button'));
  add.addEventListener('click', () => openRuleDialog(host));
  list.appendChild(add);
  site.appendChild(list);
  return site;
}

function renderClickRules() {
  $('clickInterval').value = settings.clickIntervalSec;
  $('logoutPause').value = settings.logoutPauseSec;
  const rules = settings.clickRules || [];
  $('ruleEmpty').hidden = rules.length > 0;
  $('ruleSites').hidden = rules.length === 0;
  const hosts = [...new Set(rules.map((r) => r.host))].sort((a, b) => a.localeCompare(b));
  const box = $('ruleSites');
  box.textContent = '';
  // 同網站裡的先後就是點的順序，filter 不會打亂
  for (const host of hosts) box.appendChild(ruleSite(host, rules.filter((r) => r.host === host), hosts.length === 1));
}

// 失敗（空白、不是整數）就放回原本的
async function saveClickTiming(field, input) {
  const raw = input.value.trim();
  const res = await send({ type: 'clickRules.timing', [field]: raw === '' ? null : Number(raw) });
  if (res.ok) settings = res.data;
  else toast(t('opt_setting_failed', res.error));
  // 規則的間隔欄要跟著顯示新的預設值
  renderClickRules();
}
$('clickInterval').addEventListener('change', (e) => saveClickTiming('clickIntervalSec', e.target));
$('logoutPause').addEventListener('change', (e) => saveClickTiming('logoutPauseSec', e.target));

// ---- 手動新增自動點選 ----

function newRuleInput(id, placeholder) {
  const input = el('input');
  input.id = id;
  input.type = 'text';
  input.spellcheck = false;
  input.placeholder = placeholder;
  return input;
}

const ruleForm = {
  host: newRuleInput('newRuleHost', 'example.com.tw'),
  path: newRuleInput('newRulePath', t('opt_rule_path_placeholder')),
  selector: ruleSelectorBox(''),
  text: newRuleInput('newRuleText', ''),
  when: ruleSelect('', CLICK_WHEN, 'afterFill'),
  interval: ruleIntervalBox(''),
};
ruleForm.selector.id = 'newRuleSelector';
ruleForm.selector.placeholder = '#login';
ruleForm.when.id = 'newRuleWhen';
ruleForm.interval.id = 'newRuleInterval';

const ruleFormNote = el('div', 'muted rule-note');
const ruleFormErrors = {};

for (const [key, className, name, tip] of [
  ['host', 'half', t('opt_rule_field_host'), RULE_TIPS.host],
  ['path', 'half', t('opt_rule_field_path'), RULE_TIPS.path],
  ['selector', 'full', t('opt_rule_field_selector'), RULE_TIPS.selector],
  ['text', 'third', t('opt_rule_field_text'), RULE_TIPS.text],
  ['when', 'third', t('opt_rule_field_when'), RULE_TIPS.when],
  ['interval', 'third', t('opt_rule_field_interval'), RULE_TIPS.interval],
]) {
  const field = ruleField(className, name, tip, ruleForm[key]);
  if (key === 'when') field.appendChild(ruleFormNote);
  ruleFormErrors[key] = el('div', 'error');
  field.appendChild(ruleFormErrors[key]);
  $('ruleDialogFields').appendChild(field);
}

function showRuleFormErrors(errors) {
  for (const [key, box] of Object.entries(ruleFormErrors)) box.textContent = errors[key] || '';
  $('ruleDialogError').textContent = errors.form || '';
}

function showRuleFormNote() {
  const host = ruleForm.host.value.trim().toLowerCase();
  ruleFormNote.textContent = host ? clickRuleNote({ host, when: ruleForm.when.value }) : '';
}

// 貼整個網址時拆成網站和網址。跟在網頁上選按鈕時記的一樣：不留查詢字串，#/ 或 #! 開頭的 hash 才算路徑。
// 只打網域、沒有路徑時 path 是空字串。看不懂就回傳 null。
function splitRuleUrl(raw) {
  const text = raw.trim();
  const hasScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(text);
  if (text.startsWith('/') || (hasScheme && !/^https?:\/\//i.test(text))) return null;
  let url;
  try {
    url = new URL(hasScheme ? text : 'https://' + text);
  } catch {
    return null;
  }
  // new URL 不會擋空白和 *，會變成 %20、%2A。和 background.js 的 CLICK_RULE_HOST 一樣。
  if (!/^(\[[\da-f:.]+\]|[a-z\d_-]+(\.[a-z\d_-]+)*)$/.test(url.hostname)) return null;
  const route = /^#[/!]/.test(url.hash) ? url.hash.split('?')[0] : '';
  const hasPath = /[/?#]/.test(text.replace(/^https?:\/\//i, ''));
  return { host: url.hostname, path: hasPath ? url.pathname + route : '' };
}

function openRuleDialog(host) {
  ruleForm.host.value = host || '';
  ruleForm.path.value = '';
  ruleForm.selector.value = '';
  ruleForm.text.value = '';
  ruleForm.when.value = 'afterFill';
  ruleForm.interval.value = '';
  ruleForm.interval.placeholder = t('opt_interval_placeholder', settings.clickIntervalSec);
  showRuleFormErrors({});
  showRuleFormNote();
  $('ruleDialog').showModal();
  (host ? ruleForm.path : ruleForm.host).focus();
}

$('ruleAdd').addEventListener('click', () => openRuleDialog(''));
$('ruleDialogCancel').addEventListener('click', () => $('ruleDialog').close());
ruleForm.when.addEventListener('change', showRuleFormNote);

ruleForm.host.addEventListener('change', () => {
  const site = splitRuleUrl(ruleForm.host.value);
  if (site) {
    ruleForm.host.value = site.host;
    if (site.path) ruleForm.path.value = site.path;
  }
  showRuleFormNote();
});

// 整個網址貼到這一欄也要拆開，留著查詢字串的話，下次網址不一樣就不會點
ruleForm.path.addEventListener('change', () => {
  if (!/^https?:\/\//i.test(ruleForm.path.value.trim())) return;
  const site = splitRuleUrl(ruleForm.path.value);
  if (!site) return;
  ruleForm.path.value = site.path || '/';
  if (!ruleForm.host.value.trim()) ruleForm.host.value = site.host;
  showRuleFormNote();
});

$('ruleDialogSave').addEventListener('click', async () => {
  const site = splitRuleUrl(ruleForm.host.value);
  const path = ruleForm.path.value.trim();
  const selector = ruleForm.selector.value.trim();
  const rawInterval = ruleForm.interval.value.trim();
  const intervalSec = Number(rawInterval);
  const errors = {
    host: ruleForm.host.value.trim() ? (site ? '' : t('opt_rule_host_invalid')) : t('opt_rule_host_empty'),
    path: path ? '' : t('opt_rule_path_empty'),
    selector: selectorProblem(selector),
    interval: !rawInterval || (Number.isInteger(intervalSec) && intervalSec >= 1 && intervalSec <= 86400) ? '' : t('opt_rule_interval_invalid'),
  };
  showRuleFormErrors(errors);
  if (Object.values(errors).some(Boolean)) return;
  const rule = { host: site.host, path, selector, text: ruleForm.text.value, when: ruleForm.when.value };
  if (rawInterval) rule.intervalSec = intervalSec;
  const res = await send({ type: 'clickRules.add', rule });
  if (!res.ok) {
    showRuleFormErrors({ form: res.error });
    return;
  }
  settings = res.data;
  $('ruleDialog').close();
  ruleSiteOpen.set(site.host, true);
  renderClickRules();
  const siteRules = settings.clickRules.filter((r) => r.host === site.host);
  const card = ruleCardOf(siteRules[siteRules.length - 1].id);
  card.classList.add('moved');
  card.scrollIntoView({ block: 'nearest' });
  toast(t('opt_added'));
});

// ---- 各網站的自動填入、自動填完按登入：改了先記著，按「套用」才存 ----

// 還沒套用的改動：網站 → { fill, submit }。跟已存的設定一樣就不留。
let siteDraft = new Map();
// 目前表格列出的網站，「全選」「清除所有」只動這些
let siteListed = [];

function savedSite(host) {
  return { fill: !(settings.noAutoFillHosts || []).includes(host), submit: (settings.autoSubmitHosts || []).includes(host) };
}

function siteState(host) {
  return siteDraft.get(host) || savedSite(host);
}

// 自動填入取消時，自動按登入跟著取消，跟背景程式存檔的規則一樣
function setSiteState(host, next) {
  if (!next.fill) next.submit = false;
  const saved = savedSite(host);
  if (next.fill === saved.fill && next.submit === saved.submit) siteDraft.delete(host);
  else siteDraft.set(host, next);
}

// 列出有存帳號的網站。總開關關著時整張表不能改，這個網站的自動填入關著時不能勾自動按登入。
function renderSites() {
  const counts = new Map();
  for (const e of entries) counts.set(e.host, (counts.get(e.host) || 0) + 1);
  // 帳號刪光的網站，或在小視窗改成一樣的網站，就不算還沒套用
  for (const [host, s] of [...siteDraft]) {
    if (counts.has(host)) setSiteState(host, { ...s });
    else siteDraft.delete(host);
  }
  const q = $('siteSearch').value.trim().toLowerCase();
  siteListed = [...counts.keys()].sort().filter((h) => !q || h.includes(q));
  const master = !!settings.autoFill;
  $('siteMasterOff').hidden = master;
  $('siteEmpty').hidden = counts.size > 0;
  for (const id of ['siteTools', 'siteTableWrap', 'siteActions']) $(id).hidden = counts.size === 0;
  const tbody = $('siteRows');
  tbody.textContent = '';
  for (const host of siteListed) {
    const s = siteState(host);
    const tr = el('tr', siteDraft.has(host) ? 'dirty' : null);
    tr.appendChild(el('td', null, host));
    tr.appendChild(el('td', 'center', String(counts.get(host))));
    tr.appendChild(siteCheckbox(s.fill, !master, (on) => setSiteState(host, { ...s, fill: on })));
    tr.appendChild(siteCheckbox(s.submit, !master || !s.fill, (on) => setSiteState(host, { ...s, submit: on })));
    tbody.appendChild(tr);
  }
  if (q && !siteListed.length && counts.size) {
    const tr = el('tr');
    const td = el('td', 'empty', t('opt_site_search_no_match', q));
    td.colSpan = 4;
    tr.appendChild(td);
    tbody.appendChild(tr);
  }
  for (const b of document.querySelectorAll('#siteTable .colbtns button')) b.disabled = !master || !siteListed.length;
  $('siteDirty').textContent = siteDraft.size ? tn('opt_site_dirty', siteDraft.size) : '';
  $('siteDirty').hidden = !siteDraft.size;
  $('siteApply').disabled = !siteDraft.size;
  $('siteCancel').disabled = !siteDraft.size;
}

function siteCheckbox(checked, disabled, onChange) {
  const td = el('td', 'center');
  const box = el('input');
  box.type = 'checkbox';
  box.checked = checked;
  box.disabled = disabled;
  box.addEventListener('change', () => {
    onChange(box.checked);
    renderSites();
  });
  td.appendChild(box);
  return td;
}

// 自動填入關著的網站不能勾自動按登入，所以「自動填完按登入」的全選會跳過那些網站
for (const b of document.querySelectorAll('#siteTable .colbtns button')) {
  b.addEventListener('click', () => {
    const on = b.dataset.val === '1';
    for (const host of siteListed) {
      const s = siteState(host);
      if (b.dataset.col === 'fill') setSiteState(host, { ...s, fill: on });
      else if (!on || s.fill) setSiteState(host, { ...s, submit: on });
    }
    renderSites();
  });
}

$('siteApply').addEventListener('click', async () => {
  const sites = [...siteDraft].map(([host, s]) => ({ host, autoFill: s.fill, autoSubmit: s.submit }));
  if (!sites.length) return;
  const res = await send({ type: 'autoFill.setSites', sites });
  if (!res.ok) {
    toast(t('opt_apply_failed', res.error));
    return;
  }
  settings = res.data;
  siteDraft.clear();
  toast(tn('opt_site_applied', sites.length));
  renderSites();
  renderClickRules();
});

$('siteCancel').addEventListener('click', () => {
  siteDraft.clear();
  renderSites();
});

$('siteSearch').addEventListener('input', renderSites);

// ---- 工具鎖定：只用系統驗證（Windows Hello、Touch ID、安全金鑰），沒有 PIN ----

async function renderLock() {
  const res = await send({ type: 'lock.status' });
  if (!res.ok) {
    $('lockInfo').textContent = res.error;
    return;
  }
  const st = res.data;
  const name = pkWebAuthn.label();
  // 區塊預設收合，標題旁邊要看得出有沒有開
  $('lockState').textContent = st.enabled ? t('opt_lock_state_on') : t('opt_lock_state_off');
  $('lockEnabled').checked = !!st.enabled;
  $('lockEnabledLabel').textContent = t('opt_lock_enable_with', name);
  $('lockMinutes').value = st.idleMinutes;
  $('lockOnStartup').checked = !!st.onStartup;
  $('lockMinutes').disabled = !st.enabled;
  $('lockOnStartup').disabled = !st.enabled;
  if (!pkWebAuthn.supported()) {
    $('lockEnabled').disabled = true;
    $('lockInfo').textContent = t('opt_lock_unsupported');
    return;
  }
  $('lockEnabled').disabled = false;
  if (st.enabled) {
    $('lockInfo').textContent = t('opt_lock_info_on', name);
    return;
  }
  const hasPlatform = await pkWebAuthn.hasPlatformAuthenticator();
  $('lockInfo').textContent = hasPlatform ? t('opt_lock_info_off', name) : t('opt_lock_info_no_platform');
}

// 勾起來就跳系統驗證建鑰匙，取消也要先驗一次
$('lockEnabled').addEventListener('change', async (e) => {
  const box = e.target;
  const turningOn = box.checked;
  box.disabled = true;
  try {
    if (turningOn) {
      await pkWebAuthn.register({ idleMinutes: $('lockMinutes').value, onStartup: $('lockOnStartup').checked });
      pageVerified = true;
      toast(t('opt_lock_turned_on'));
    } else {
      await pkWebAuthn.disable();
      toast(t('opt_lock_turned_off'));
    }
  } catch (err) {
    toast(turningOn ? t('opt_lock_enable_failed', err.message) : t('opt_lock_disable_failed', err.message));
    box.checked = !turningOn;
  } finally {
    box.disabled = false;
  }
  await renderLock();
});

async function onLockSettingChange() {
  const res = await send({ type: 'lock.settings', idleMinutes: $('lockMinutes').value, onStartup: $('lockOnStartup').checked });
  if (!res.ok) toast(res.error);
  await renderLock();
}
$('lockMinutes').addEventListener('change', onLockSettingChange);
$('lockOnStartup').addEventListener('change', onLockSettingChange);

$('helloUnlock').addEventListener('click', async () => {
  $('lockError').textContent = '';
  $('helloUnlock').disabled = true;
  try {
    await pkWebAuthn.unlock();
    pageVerified = true;
    await load();
  } catch (err) {
    $('lockError').textContent = err.message;
  } finally {
    $('helloUnlock').disabled = false;
  }
});

// 管理頁開著的時候鎖定被觸發（閒置、小視窗按鎖定），背景程式會廣播，這裡立刻回到驗證畫面
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'lockChanged' && msg.locked) {
    pageVerified = false;
    load();
  }
  // 在別的分頁選了新的按鈕，那個網站要展開才看得到新規則
  if (msg && msg.type === 'clickRulesChanged') {
    if (msg.host) ruleSiteOpen.set(msg.host, true);
    send({ type: 'settings.get' }).then((res) => {
      if (!res.ok) return;
      settings = res.data;
      renderClickRules();
    });
  }
});

// ---- 新增 / 修改 ----

function openDialog(entry) {
  editingId = entry ? entry.id : null;
  $('dialogTitle').textContent = entry ? t('opt_dialog_edit_title') : t('opt_dialog_add_title');
  $('fUrl').value = entry ? entry.origin || 'https://' + entry.host : '';
  $('fUser').value = entry ? entry.username : '';
  $('fPass').value = entry ? entry.password : '';
  $('fPass').type = 'password';
  $('fEye').textContent = t('opt_show');
  $('fNote').value = entry ? entry.note || '' : '';
  $('fError').textContent = '';
  $('dialog').showModal();
  ($('fUrl').value ? $('fUser') : $('fUrl')).focus();
}

$('add').addEventListener('click', () => openDialog(null));
$('fCancel').addEventListener('click', () => $('dialog').close());
$('fEye').addEventListener('click', () => {
  const p = $('fPass');
  const show = p.type === 'password';
  p.type = show ? 'text' : 'password';
  $('fEye').textContent = show ? t('opt_hide') : t('opt_show');
});
$('fSave').addEventListener('click', async () => {
  const entry = {
    url: $('fUrl').value.trim(),
    username: $('fUser').value.trim(),
    password: $('fPass').value,
    note: $('fNote').value.trim(),
  };
  if (!entry.url) {
    $('fError').textContent = t('opt_url_empty');
    return;
  }
  if (!entry.password) {
    $('fError').textContent = t('opt_password_empty');
    return;
  }
  const res = await send({ type: 'entries.save', entry, id: editingId || undefined });
  if (!res.ok) {
    $('fError').textContent = res.error;
    return;
  }
  $('dialog').close();
  toast(res.data.action === 'updated' ? t('opt_updated') : t('opt_added'));
  await load();
});

// ---- 匯入 / 匯出 CSV（欄位和 Edge、Chrome 匯出的格式一樣：name,url,username,password,note）----
// 這個格式 Chrome、Edge、Firefox、Safari 都能直接匯入。匯入這邊另外看得懂 Firefox、Safari 和常見密碼管理程式的檔案。

// 瀏覽器匯出的是 UTF-8。用 Excel 打開再存檔會變成 Big5，UTF-8 解不開就改用 Big5 讀。
async function readCsvText(file) {
  const buf = await file.arrayBuffer();
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder('big5').decode(buf);
  }
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  text = text.replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += c;
    }
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((v) => v !== ''));
}

// Chrome / Edge：name,url,username,password,note
// Firefox：url,username,password,httpRealm,formActionOrigin,guid,timeCreated,timeLastUsed,timePasswordChanged
// Safari：Title,URL,Username,Password,Notes,OTPAuth
// 欄位名稱不分大小寫，順序不拘，認不得的欄位不管
const HEADER_ALIASES = {
  url: ['url', 'login_uri', 'website', 'site', 'web site', 'hostname', 'origin'],
  username: ['username', 'login_username', 'user', 'login', 'account'],
  password: ['password', 'login_password', 'pass'],
  note: ['note', 'notes', 'comment', 'comments', 'extra'],
  // Firefox 的時間是毫秒，有的話新增的帳號沿用，也拿來判斷檔案裡的密碼是不是比較舊
  createdAt: ['timecreated'],
  lastUsedAt: ['timelastused'],
  passwordChangedAt: ['timepasswordchanged'],
};

function mapHeader(headerRow) {
  const lower = headerRow.map((h) => h.trim().toLowerCase());
  const idx = {};
  for (const [key, names] of Object.entries(HEADER_ALIASES)) {
    idx[key] = lower.findIndex((h) => names.includes(h));
  }
  return idx;
}

// 只是給使用者看「讀到的是哪種檔」，認不出來也照樣匯入
function csvSource(headerRow) {
  const h = headerRow.map((x) => x.trim().toLowerCase());
  if (h.includes('timepasswordchanged') || h.includes('httprealm')) return 'Firefox';
  if (h.includes('otpauth') && h.includes('title') && !h.includes('favorite')) return 'Safari';
  if (h[0] === 'name' && ['url', 'username', 'password'].every((k) => h.includes(k))) return 'Chrome / Edge';
  return '';
}

// 小提示幾秒就消失，細項留在備份分頁上
function showImportResult(s, what) {
  toast(t('opt_import_done', s.added, s.updated, s.skipped));
  const why = [];
  if (s.same) why.push(t('opt_import_why_same', s.same));
  if (s.older) why.push(t('opt_import_why_older', s.older));
  if (s.invalid) why.push(t('opt_import_why_invalid', s.invalid));
  const reasons = why.length ? t('opt_import_reasons', why.join(t('opt_list_sep'))) : '';
  const rules = s.clickRules ? tn('opt_import_rules', s.clickRules) : '';
  // 原因和自動點選接在「略過 N」後面。不能在翻譯裡寫成連著的 $4$5$6：Chrome 會把 $4$ 當成具名替換值，整個擴充功能載入失敗
  $('backupResult').textContent = t('opt_import_result', what, s.added, s.updated, s.skipped) + reasons + rules + t('opt_import_result_end');
}

$('import').addEventListener('click', () => $('file').click());
$('file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const rows = parseCsv(await readCsvText(file));
  if (rows.length < 2) {
    toast(t('opt_import_no_data'));
    return;
  }
  const idx = mapHeader(rows[0]);
  if (idx.url < 0 || idx.password < 0) {
    toast(t('opt_import_bad_header'));
    return;
  }
  const cell = (r, key) => (idx[key] >= 0 ? r[idx[key]] || '' : '');
  const data = rows.slice(1).map((r) => {
    const row = { url: cell(r, 'url'), username: cell(r, 'username'), password: cell(r, 'password'), note: cell(r, 'note') };
    for (const key of ['createdAt', 'lastUsedAt', 'passwordChangedAt']) {
      const time = Number(cell(r, key));
      if (time > 0) row[key] = time;
    }
    return row;
  });
  const res = await send({ type: 'entries.import', rows: data });
  if (!res.ok) {
    toast(t('opt_import_failed', res.error));
    return;
  }
  const source = csvSource(rows[0]);
  showImportResult(res.data, source ? tn('opt_import_what_csv_from', data.length, source) : tn('opt_import_what_csv', data.length));
  await load();
});

function csvField(v) {
  return '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
}

function dateStamp() {
  const d = new Date();
  return d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
}

// 所有匯出都交給背景程式存檔：會跳另存新檔讓你選位置，存完記進備份紀錄
async function saveExport({ content, filename, mime, kind, count }) {
  const res = await send({ type: 'backup.download', content, filename, mime, kind, count });
  if (!res.ok) {
    toast(res.error === t('common_cancelled') ? t('common_cancelled') : t('opt_save_failed', res.error));
    return null;
  }
  toast(t('opt_saved_to', res.data.path));
  await renderBackup();
  return res.data.path;
}

// Chrome、Edge 一個檔案最多匯入 3000 筆，超過的話整個檔案都不收，所以分成幾個檔。
// 單一欄位太長的那一筆也會被略過：網址 2048 字，帳號、密碼、備註各 1000 字。
const BROWSER_CSV_MAX_ROWS = 3000;

function tooLongForBrowser(e) {
  return (e.origin || '').length > 2048 || (e.username || '').length > 1000 || e.password.length > 1000 || (e.note || '').length > 1000;
}

$('export').addEventListener('click', async () => {
  if (!entries.length) {
    toast(t('opt_export_nothing'));
    return;
  }
  const parts = Math.ceil(entries.length / BROWSER_CSV_MAX_ROWS);
  for (let p = 0; p < parts; p++) {
    const chunk = entries.slice(p * BROWSER_CSV_MAX_ROWS, (p + 1) * BROWSER_CSV_MAX_ROWS);
    const lines = ['name,url,username,password,note'];
    for (const e of chunk) {
      lines.push([e.host, e.origin || 'https://' + e.host, e.username, e.password, e.note || ''].map(csvField).join(','));
    }
    // 加 BOM 讓 Excel 直接開也能正確顯示中文。BOM 黏在第一欄 name 上，瀏覽器本來就不讀 name，不影響匯入。
    const path = await saveExport({
      content:'\uFEFF' + lines.join('\r\n'),
      filename: t('opt_csv_filename', dateStamp() + (parts > 1 ? '-' + (p + 1) : '')) + '.csv',
      mime: 'text/csv;charset=utf-8',
      kind: 'csv',
      count: chunk.length,
    });
    if (!path) return;
  }
  const notes = [];
  if (parts > 1) notes.push(t('opt_csv_split_note', parts));
  const long = entries.filter(tooLongForBrowser).length;
  if (long) notes.push(tn('opt_csv_long_note', long));
  $('backupResult').textContent = notes.length ? t('opt_csv_export_notes', notes.join(t('opt_note_sep'))) : '';
});

// ---- 加密備份 ----

// 跳對話框要備份密碼。confirm=true 要輸入兩次（匯出用），false 只輸入一次（匯入用）。取消回傳 null。
function askPassword({ title, hint, confirm, label, minLength }) {
  return new Promise((resolve) => {
    const dlg = $('pwDialog');
    const min = minLength == null ? 8 : minLength;
    $('pwTitle').textContent = title;
    $('pwHint').textContent = hint || '';
    $('pw1Label').textContent = label || t('opt_backup_password');
    $('pw1').value = '';
    $('pw2').value = '';
    $('pwError').textContent = '';
    $('pw2').hidden = !confirm;
    $('pw2Label').hidden = !confirm;

    let finish = null;
    const onOk = () => {
      const a = $('pw1').value;
      if (!a) {
        $('pwError').textContent = t('opt_pw_required');
        return;
      }
      if (confirm && a.length < min) {
        $('pwError').textContent = tn('opt_pw_too_short', min);
        return;
      }
      if (confirm && a !== $('pw2').value) {
        $('pwError').textContent = t('opt_pw_mismatch');
        return;
      }
      finish(a);
    };
    const onCancel = () => finish(null);
    const onKey = (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        onOk();
      }
    };
    // 按 Esc 瀏覽器會自己關掉 dialog，要攔下來走同一條取消的路
    const onEsc = (e) => {
      e.preventDefault();
      onCancel();
    };
    finish = (value) => {
      $('pwOk').removeEventListener('click', onOk);
      $('pwCancel').removeEventListener('click', onCancel);
      dlg.removeEventListener('keydown', onKey);
      dlg.removeEventListener('cancel', onEsc);
      dlg.close();
      resolve(value);
    };
    $('pwOk').addEventListener('click', onOk);
    $('pwCancel').addEventListener('click', onCancel);
    dlg.addEventListener('keydown', onKey);
    dlg.addEventListener('cancel', onEsc);
    dlg.showModal();
    $('pw1').focus();
  });
}

$('exportBak').addEventListener('click', async () => {
  if (!entries.length) {
    toast(t('opt_export_nothing'));
    return;
  }
  const password = await askPassword({
    title: t('opt_pw_backup_title'),
    hint: t('opt_pw_backup_hint'),
    confirm: true,
  });
  if (password == null) return;
  const res = await send({ type: 'backup.export', password });
  if (!res.ok) {
    toast(t('opt_export_failed', res.error));
    return;
  }
  await saveExport({
    content: res.data.content,
    filename: t('opt_backup_filename', dateStamp()) + '.pkbak',
    mime: 'application/json',
    kind: 'manual',
    count: res.data.count,
  });
});

$('exportSelected').addEventListener('click', async () => {
  if (!selected.size) return;
  const password = await askPassword({
    title: t('opt_pw_share_title'),
    hint: tn('opt_pw_share_hint', selected.size),
    confirm: true,
  });
  if (password == null) return;
  const res = await send({ type: 'backup.export', password, ids: [...selected] });
  if (!res.ok) {
    toast(t('opt_export_failed', res.error));
    return;
  }
  await saveExport({
    content: res.data.content,
    filename: t('opt_share_filename', dateStamp()) + '.pkbak',
    mime: 'application/json',
    kind: 'selected',
    count: res.data.count,
  });
});

$('importBak').addEventListener('click', () => $('bakFile').click());
$('bakFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const content = await file.text();
  const password = await askPassword({ title: t('opt_pw_import_title'), hint: t('opt_pw_import_hint'), confirm: false });
  if (password == null) return;
  const res = await send({ type: 'backup.import', password, content });
  if (!res.ok) {
    toast(t('opt_import_failed', res.error));
    return;
  }
  showImportResult(res.data, t('opt_import_what_backup', file.name));
  await load();
});

async function renderBackup() {
  const res = await send({ type: 'backup.status' });
  const box = $('backupStatus');
  if (!res.ok) {
    box.textContent = t('opt_backup_status_failed', res.error);
    return;
  }
  const s = res.data;
  box.classList.toggle('due', !!s.due);
  if (!s.count) {
    box.textContent = t('opt_backup_status_empty');
  } else if (!s.lastBackupAt) {
    box.textContent = t('opt_backup_status_never');
  } else {
    const last = fmtDate(s.lastBackupAt);
    box.textContent = s.due ? tn('opt_backup_status_due', s.days, last) : tn('opt_backup_status_last', s.days, last);
  }
  renderAutoBackup(s.autoBackup || {});
  renderLog(s.log || []);
}

// ---- 自動備份、備份紀錄 ----

const WEEKDAY_SHORT = [t('opt_wd_sun'), t('opt_wd_mon'), t('opt_wd_tue'), t('opt_wd_wed'), t('opt_wd_thu'), t('opt_wd_fri'), t('opt_wd_sat')];

// 選每週的時候要對得起來是星期幾，所以下次備份時間多帶星期
function fmtWithWeekday(ts) {
  const d = new Date(ts);
  const time = d.toLocaleTimeString(uiLang(), { hour: '2-digit', minute: '2-digit' });
  return t('opt_date_weekday_time', d.toLocaleDateString(uiLang()), WEEKDAY_SHORT[d.getDay()], time);
}

const RESULT_TEXT = {
  saved: t('opt_ab_result_saved'),
  unchanged: t('opt_ab_result_unchanged'),
  empty: t('opt_ab_result_empty'),
};

function renderAutoBackup(ab) {
  $('abPwStatus').textContent = ab.hasPassword ? t('opt_ab_pw_set') : t('opt_ab_pw_unset');
  $('abPassword').textContent = ab.hasPassword ? t('opt_ab_change_password') : t('opt_ab_set_password');
  $('abEvery').value = ab.every || 'day';
  $('abWeekday').value = String(ab.weekday == null ? 1 : ab.weekday);
  $('abWeekday').hidden = ab.every !== 'week';
  // 使用者正在打字的時候不要把欄位蓋掉
  if (document.activeElement !== $('abFolder')) $('abFolder').value = ab.folder || '';
  if (document.activeElement !== $('abTime')) $('abTime').value = ab.time || '12:00';
  $('abEnabled').checked = !!ab.enabled;
  // 密碼沒設之前，開關和立即備份都不給按
  $('abEnabled').disabled = !ab.hasPassword;
  $('abRunNow').disabled = !ab.hasPassword;
  $('abNext').textContent = ab.enabled && ab.nextAt ? t('opt_ab_next', fmtWithWeekday(ab.nextAt)) : '';
  $('abNext').hidden = !$('abNext').textContent;
  const info = $('abInfo');
  const result = RESULT_TEXT[ab.lastResult];
  info.classList.toggle('abErr', !!ab.lastError);
  if (ab.lastError) info.textContent = t('opt_ab_last_failed', fmtDate(ab.lastRunAt), ab.lastError);
  else if (!ab.hasPassword) info.textContent = t('opt_ab_need_password');
  else if (!ab.enabled) info.textContent = t('opt_ab_not_enabled');
  else if (ab.lastRunAt) info.textContent = result ? t('opt_ab_last_check_result', fmtDate(ab.lastRunAt), result) : t('opt_ab_last_check', fmtDate(ab.lastRunAt));
  else info.textContent = t('opt_ab_waiting_first');
}

const KIND_LABEL = {
  auto: t('opt_kind_auto'),
  now: t('opt_kind_now'),
  manual: t('opt_kind_manual'),
  csv: t('opt_kind_csv'),
  selected: t('opt_kind_selected'),
  location: t('opt_kind_location'),
};
// 篩選用的大類。「立即備份」是使用者自己按的，算手動。
const KIND_CATEGORY = { auto: 'auto', now: 'manual', manual: 'manual', csv: 'manual', selected: 'manual', location: 'location' };
const CATEGORY_LABEL = { all: t('opt_log_cat_all'), auto: t('opt_log_cat_auto'), manual: t('opt_log_cat_manual'), location: t('opt_log_cat_location') };

function logCategory(item) {
  return KIND_CATEGORY[item.kind] || 'manual';
}

function logVisible() {
  return logItems.filter((item) => logFilter === 'all' || logCategory(item) === logFilter);
}

function renderLog(log) {
  logItems = log;
  // 已經刪掉的紀錄，勾選狀態要跟著清掉
  logSelected = new Set([...logSelected].filter((id) => log.some((item) => item.id === id)));
  $('logCount').textContent = log.length ? tn('opt_log_count', log.length) : '';
  const counts = { all: log.length, auto: 0, manual: 0, location: 0 };
  for (const item of log) counts[logCategory(item)]++;
  for (const b of document.querySelectorAll('#logFilter button')) {
    b.textContent = CATEGORY_LABEL[b.dataset.cat] + ' ' + counts[b.dataset.cat];
    b.classList.toggle('active', b.dataset.cat === logFilter);
  }
  const visible = logVisible();
  const tbody = $('logRows');
  tbody.textContent = '';
  $('logEmpty').textContent = log.length ? t('opt_log_empty_filtered') : t('opt_log_empty');
  $('logEmpty').hidden = visible.length > 0;
  $('logTableWrap').hidden = visible.length === 0;
  for (const item of visible) {
    const tr = el('tr');
    const chk = el('td', 'chk');
    const box = el('input');
    box.type = 'checkbox';
    box.checked = logSelected.has(item.id);
    box.addEventListener('change', () => {
      if (box.checked) logSelected.add(item.id);
      else logSelected.delete(item.id);
      updateLogSelection();
    });
    chk.appendChild(box);
    tr.appendChild(chk);
    tr.appendChild(el('td', 'nowrap', fmtDate(item.at)));
    tr.appendChild(el('td', 'nowrap', KIND_LABEL[item.kind] || item.kind));
    tr.appendChild(el('td', null, item.note || item.path || ''));
    tr.appendChild(el('td', 'nowrap', item.kind === 'location' ? '' : String(item.count == null ? '' : item.count)));
    const ops = el('td', 'ops');
    const del = el('button', 'small danger', t('opt_delete'));
    del.addEventListener('click', () => deleteOneLog(item));
    ops.appendChild(del);
    tr.appendChild(ops);
    tbody.appendChild(tr);
  }
  updateLogSelection();
}

function updateLogSelection() {
  const visible = logVisible();
  $('logCheckAll').checked = visible.length > 0 && visible.every((item) => logSelected.has(item.id));
  const n = logSelected.size;
  $('logDelete').disabled = n === 0;
  $('logDelete').textContent = n ? tn('opt_log_delete_selected_n', n) : t('opt_log_delete_selected');
}

for (const b of document.querySelectorAll('#logFilter button')) {
  b.addEventListener('click', () => {
    logFilter = b.dataset.cat;
    // 換篩選就清掉勾選，免得刪到畫面上看不到的紀錄
    logSelected.clear();
    renderLog(logItems);
  });
}

$('logCheckAll').addEventListener('change', (e) => {
  for (const item of logVisible()) {
    if (e.target.checked) logSelected.add(item.id);
    else logSelected.delete(item.id);
  }
  renderLog(logItems);
});

// 刪紀錄和回收桶用的對話框：標題、說明、清單、幾顆按鈕。回傳按下那顆的 value，按 Esc 回傳 null。
// copy 是 true 時多一顆「複製位置」，讓使用者貼到檔案總管自己去刪。
let choiceCopyText = '';
function askChoice({ title, text, items, copy, buttons }) {
  return new Promise((resolve) => {
    const dlg = $('choiceDialog');
    $('choiceTitle').textContent = title;
    $('choiceText').textContent = text || '';
    const list = $('choiceList');
    list.textContent = '';
    for (const it of items || []) {
      const li = el('li', null, it.text);
      if (it.note) li.appendChild(el('span', 'muted', it.note));
      list.appendChild(li);
    }
    list.hidden = !(items && items.length);
    choiceCopyText = (items || []).map((it) => it.text).join('\r\n');
    $('choiceCopyRow').hidden = !copy;
    const box = $('choiceButtons');
    box.textContent = '';
    let finish = null;
    // 按 Esc 瀏覽器會自己關掉 dialog，要攔下來走同一條取消的路
    const onEsc = (e) => {
      e.preventDefault();
      finish(null);
    };
    finish = (value) => {
      dlg.removeEventListener('cancel', onEsc);
      dlg.close();
      resolve(value);
    };
    for (const b of buttons) {
      const btn = el('button', b.className || null, b.label);
      btn.addEventListener('click', () => finish(b.value));
      box.appendChild(btn);
    }
    dlg.addEventListener('cancel', onEsc);
    dlg.showModal();
    // 預設停在第一顆（取消或知道了），不小心按 Enter 不會刪東西
    box.firstChild.focus();
  });
}
$('choiceCopy').addEventListener('click', () => copyText(choiceCopyText));

async function deleteLogs(ids, withFiles) {
  const res = await send({ type: 'backupLog.delete', ids, deleteFiles: withFiles });
  if (!res.ok) {
    toast(t('opt_delete_failed', res.error));
    return null;
  }
  await renderBackup();
  return res.data;
}

// 檔案刪不掉的提示，單筆和批次共用：列出位置，請使用者自己去刪
function showFileFailures(r) {
  return askChoice({
    title: tn('opt_files_not_deleted', r.failed.length),
    text: t('opt_delete_yourself'),
    items: r.failed.map((f) => ({ text: f.path, note: f.reason })),
    copy: true,
    buttons: [{ label: t('opt_got_it'), value: true, className: 'primary' }],
  });
}

const DELETE_CHOICES = [
  { label: t('opt_cancel'), value: null },
  { label: t('opt_delete_record_only'), value: 'record' },
  { label: t('opt_delete_both'), value: 'both', className: 'danger' },
];

// 單筆：先問背景程式這個檔案是不是擴充功能自己存、刪不刪得到。刪得到才問要不要一起刪，刪不到就提醒位置。
async function deleteOneLog(item) {
  let withFiles = false;
  if (item.kind === 'location') {
    if (!confirm(t('opt_confirm_delete_location_log'))) return;
  } else {
    const st = await send({ type: 'backupLog.fileStatus', id: item.id });
    if (!st.ok) {
      toast(st.error);
      return;
    }
    if (st.data.status === 'deletable') {
      const choice = await askChoice({
        title: t('opt_delete_log'),
        text: t('opt_delete_files_too'),
        items: [{ text: item.path }],
        buttons: DELETE_CHOICES,
      });
      if (!choice) return;
      withFiles = choice === 'both';
    } else {
      const ok = await askChoice({
        title: t('opt_delete_log'),
        text: t('opt_file_may_remain'),
        items: [{ text: item.path, note: st.data.reason }],
        copy: true,
        buttons: [
          { label: t('opt_cancel'), value: false },
          { label: t('opt_delete_log'), value: true, className: 'danger' },
        ],
      });
      if (!ok) return;
    }
  }
  const r = await deleteLogs([item.id], withFiles);
  if (!r) return;
  if (r.failed.length) await showFileFailures(r);
  else toast(r.removed.length ? t('opt_deleted_log_and_file') : t('opt_deleted_log'));
}

// 批次：先問要不要一起刪檔案。一起刪的話刪不掉的最後列出來；只刪紀錄的話列出檔案位置，提醒使用者自己去刪。
$('logDelete').addEventListener('click', async () => {
  const ids = [...logSelected];
  if (!ids.length) return;
  const hasFiles = logItems.some((item) => logSelected.has(item.id) && item.kind !== 'location');
  let withFiles = false;
  if (hasFiles) {
    const choice = await askChoice({
      title: tn('opt_delete_logs_title', ids.length),
      text: t('opt_delete_files_too'),
      buttons: DELETE_CHOICES,
    });
    if (!choice) return;
    withFiles = choice === 'both';
  } else if (!confirm(tn('opt_confirm_delete_location_logs', ids.length))) {
    return;
  }
  const r = await deleteLogs(ids, withFiles);
  if (!r) return;
  if (r.failed.length) {
    await showFileFailures(r);
  } else if (r.kept.length) {
    await askChoice({
      title: tn('opt_deleted_logs', r.deleted),
      text: t('opt_files_kept'),
      items: r.kept.map((path) => ({ text: path })),
      copy: true,
      buttons: [{ label: t('opt_got_it'), value: true, className: 'primary' }],
    });
  } else {
    toast(r.removed.length ? tn('opt_deleted_logs_files', r.deleted, r.removed.length) : tn('opt_deleted_logs', r.deleted));
  }
});

async function applyAutoBackup(patch, onOk) {
  const res = await send({ type: 'autoBackup.set', ...patch });
  if (!res.ok) {
    toast(res.error);
    return null;
  }
  renderAutoBackup(res.data);
  if (onOk) onOk(res.data);
  return res.data;
}

$('abEnabled').addEventListener('change', async (e) => {
  const ok = await applyAutoBackup({ enabled: e.target.checked });
  if (!ok) e.target.checked = !e.target.checked;
});
$('abEvery').addEventListener('change', (e) => applyAutoBackup({ every: e.target.value }));
$('abWeekday').addEventListener('change', (e) => applyAutoBackup({ weekday: e.target.value }));
$('abTime').addEventListener('change', (e) => {
  // 時間欄位打到一半或清空時值是空的，等打完再存
  if (e.target.value) applyAutoBackup({ time: e.target.value });
});
$('abFolder').addEventListener('change', async (e) => {
  const ab = await applyAutoBackup({ folder: e.target.value });
  if (ab) {
    toast(t('opt_ab_folder_changed', ab.folder));
    await renderBackup();
  }
});
$('abPassword').addEventListener('click', async () => {
  const password = await askPassword({
    title: t('opt_ab_pw_title'),
    hint: t('opt_ab_pw_hint'),
    confirm: true,
  });
  if (password == null) return;
  await applyAutoBackup({ password }, () => toast(t('opt_ab_pw_saved')));
});
$('abRunNow').addEventListener('click', async () => {
  const res = await send({ type: 'autoBackup.runNow' });
  if (!res.ok) toast(t('opt_backup_failed', res.error));
  else toast(res.data.ran ? t('opt_backed_up_to', res.data.path) : t('opt_nothing_to_back_up'));
  await renderBackup();
});

$('reminderDays').addEventListener('change', async (e) => {
  const days = Math.max(0, Math.min(365, parseInt(e.target.value, 10) || 0));
  e.target.value = days;
  const res = await send({ type: 'settings.set', patch: { backupReminderDays: days } });
  if (!res.ok) {
    toast(t('opt_setting_failed', res.error));
    return;
  }
  settings = res.data;
  renderBackup();
});

// ---- 設定、危險區 ----

$('autoFill').addEventListener('change', async (e) => {
  const res = await send({ type: 'settings.set', patch: { autoFill: e.target.checked } });
  if (!res.ok) {
    toast(t('opt_setting_failed', res.error));
    return;
  }
  settings = res.data;
  renderSites();
  renderClickRules();
});

$('deleteAll').addEventListener('click', async () => {
  if (!entries.length) {
    toast(t('opt_no_passwords'));
    return;
  }
  if (!confirm(tn('opt_confirm_delete_all', entries.length, currentTrashDays()))) return;
  const res = await send({ type: 'entries.deleteAll' });
  if (!res.ok) {
    toast(t('opt_delete_failed', res.error));
    return;
  }
  toast(t('opt_all_moved_to_trash'));
  await load();
});

$('search').addEventListener('input', renderTable);

// 依照使用的瀏覽器顯示對應的擴充功能頁面網址
(function browserHint() {
  const ua = navigator.userAgent;
  const brands = (navigator.userAgentData && navigator.userAgentData.brands) || [];
  const isEdge = brands.some((b) => /Edge/i.test(b.brand)) || /Edg\//.test(ua);
  const name = isEdge ? 'Edge' : 'Chrome';
  const url = isEdge ? 'edge://extensions' : 'chrome://extensions';
  $('browserHint').textContent = t('opt_browser_hint', name, url);
})();

// ---- 分頁：網址後面的 #backup 之類會直接開到那一頁，小視窗的備份提醒就是這樣連過來的 ----

const TABS = ['passwords', 'backup', 'settings', 'trash', 'help', 'versions'];

function showTab(name) {
  if (!TABS.includes(name)) name = 'passwords';
  for (const tab of TABS) $('tab-' + tab).hidden = tab !== name;
  for (const b of document.querySelectorAll('.tab')) b.classList.toggle('active', b.dataset.tab === name);
  if (location.hash !== '#' + name) history.replaceState(null, '', '#' + name);
}

for (const b of document.querySelectorAll('.tab')) b.addEventListener('click', () => showTab(b.dataset.tab));
window.addEventListener('hashchange', () => showTab(location.hash.slice(1)));
showTab(location.hash.slice(1));

// 捲軸從表格標題下面才開始，要知道標題多高。各網站表的標題有兩行，視窗窄時字會折行，所以用量的。
const tableHeadObserver = new ResizeObserver((items) => {
  for (const { target } of items) {
    target.closest('.table-frame').style.setProperty('--head-height', target.getBoundingClientRect().height + 'px');
  }
});
for (const head of document.querySelectorAll('.table-frame thead')) tableHeadObserver.observe(head);

// ---- 版本功能歷程：資料在 changelog.js，目前版本從 manifest 讀 ----

function renderVersions() {
  const current = (chrome.runtime.getManifest && chrome.runtime.getManifest().version) || '';
  $('versionNow').textContent = current ? t('opt_version_now', current) : '';
  $('headerVersion').textContent = current ? 'v' + current : '';
  const list = $('versionList');
  list.textContent = '';
  for (const v of CHANGELOG) {
    const isCurrent = v.version === current;
    const box = el('div', 'ver');
    const h3 = el('h3');
    h3.appendChild(el('span', null, v.version));
    h3.appendChild(el('span', 'date', v.date));
    if (isCurrent) h3.appendChild(el('span', 'tag', t('opt_version_current')));
    box.appendChild(h3);
    const ul = el('ul');
    for (const item of pickLocale(v.items)) ul.appendChild(el('li', null, item));
    box.appendChild(ul);
    for (const n of v.notes ? pickLocale(v.notes) : []) box.appendChild(el('div', 'note', t('opt_version_note', n)));
    list.appendChild(box);
  }
}

$('headerVersion').addEventListener('click', () => showTab('versions'));
renderVersions();

// ---- 介面語言：頁首的語言選單 ----

async function renderLanguagePicker() {
  const res = await send({ type: 'language.get' });
  if (!res.ok) {
    toast(t('opt_lang_failed', res.error));
    return;
  }
  const names = { zh_TW: t('lang_name_zh_TW'), en: t('lang_name_en'), ja: t('lang_name_ja') };
  $('langAuto').textContent = t('opt_lang_auto', names[res.data.browserLocale] || names.en);
  $('langSelect').value = res.data.language;
}

// 選了就存起來，這一頁重新整理成新的語言。小視窗、解鎖視窗下次打開就是新語言，開著的網頁會收到變更自己換
$('langSelect').addEventListener('change', async (e) => {
  const language = e.target.value;
  const res = await send({ type: 'language.set', language });
  if (!res.ok) {
    toast(t('opt_lang_failed', res.error));
    await renderLanguagePicker();
    return;
  }
  rememberLocale(language === 'auto' ? null : language);
  location.reload();
});

renderLanguagePicker();

load();
