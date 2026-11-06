// 工具列圖示點開的小視窗：列出目前網站的帳號，可以填入、複製密碼、新增。
const $ = (id) => document.getElementById(id);

function send(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (res) => {
      if (chrome.runtime.lastError) return resolve({ ok: false, error: chrome.runtime.lastError.message });
      resolve(res || { ok: false, error: t('pop_no_response') });
    });
  });
}

let toastTimer = null;
function toast(text) {
  const box = $('toast');
  box.textContent = text;
  box.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => box.classList.remove('show'), 2000);
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

let tab = null;
let host = '';
let origin = '';

function siteOf(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return { host: u.hostname.toLowerCase(), origin: u.origin };
  } catch {
    return null;
  }
}

// 叫網頁裡的 content.js 做事（填帳密、填產生的密碼）
function sendToPage(msg) {
  return new Promise((resolve) => {
    if (!tab) return resolve({ ok: false, error: t('pop_page_unavailable') });
    chrome.tabs.sendMessage(tab.id, msg, (res) => {
      if (chrome.runtime.lastError) {
        // 擴充功能裝好之前就開著的分頁沒有 content.js，會走到這裡
        return resolve({ ok: false, error: t('pop_page_not_ready') });
      }
      resolve(res || { ok: false, error: t('pop_page_no_response') });
    });
  });
}

function fillInPage(entry) {
  return sendToPage({ type: 'fill', entry });
}

async function copyPassword(entry) {
  try {
    await navigator.clipboard.writeText(entry.password);
    toast(t('pop_password_copied'));
  } catch (err) {
    toast(t('pop_copy_failed', err.message));
  }
}

async function render() {
  const res = await send({ type: 'entries.forHost', host });
  if (!res.ok) {
    $('status').textContent = t('pop_load_failed', res.error);
    return;
  }
  $('status').textContent = '';
  const entries = res.data.entries;
  // 這兩個勾選框只管這個網站，沒存帳號就不用設。管理頁的總開關關著時都不能勾。
  $('autoFillWrap').hidden = !entries.length;
  $('autoSubmitWrap').hidden = !entries.length;
  $('autoFill').checked = !!res.data.siteAutoFill;
  $('autoFill').disabled = !res.data.autoFillMaster;
  $('autoFillOff').hidden = !!res.data.autoFillMaster;
  $('autoSubmit').checked = !!res.data.autoSubmit;
  $('autoSubmit').disabled = !res.data.autoFillMaster || !res.data.siteAutoFill;

  const list = $('list');
  list.textContent = '';
  if (!entries.length) {
    list.appendChild(el('div', 'empty', t('pop_empty')));
  }
  for (const entry of entries) {
    const row = el('div', 'entry');
    const u = el('div', 'u', entry.username || t('pop_no_username'));
    if (entry.host !== host) u.appendChild(el('div', 'h', entry.host));
    const fill = el('button', 'primary small', t('pop_fill'));
    fill.addEventListener('click', async () => {
      const r = await fillInPage(entry);
      if (!r.ok) {
        toast(r.error);
        return;
      }
      window.close();
    });
    const copy = el('button', 'small', t('pop_copy_password'));
    copy.addEventListener('click', () => copyPassword(entry));
    row.appendChild(u);
    row.appendChild(fill);
    row.appendChild(copy);
    list.appendChild(row);
  }
  $('count').textContent = entries.length ? tn('pop_account_count', entries.length) : '';

  const rules = await send({ type: 'clickRules.forHost', host, url: tab.url });
  const pageCount = rules.ok ? rules.data.pageCount : 0;
  $('pickCount').hidden = !pageCount;
  $('pickCount').textContent = tn('pop_page_rule_count', pageCount);
}

function showAddForm(show) {
  $('addForm').classList.toggle('show', show);
  $('addBtn').style.display = show ? 'none' : '';
  $('addError').textContent = '';
  if (show) {
    $('addUser').value = '';
    $('addPass').value = '';
    $('addUser').focus();
  }
}

$('addBtn').addEventListener('click', () => showAddForm(true));
$('addCancel').addEventListener('click', () => showAddForm(false));
$('addEye').addEventListener('click', () => {
  const p = $('addPass');
  const show = p.type === 'password';
  p.type = show ? 'text' : 'password';
  $('addEye').textContent = show ? t('pop_hide') : t('pop_show');
});
$('addSave').addEventListener('click', async () => {
  const username = $('addUser').value.trim();
  const password = $('addPass').value;
  if (!password) {
    $('addError').textContent = t('pop_password_required');
    return;
  }
  const res = await send({ type: 'entries.save', entry: { host, origin, username, password } });
  if (!res.ok) {
    $('addError').textContent = res.error;
    return;
  }
  showAddForm(false);
  toast(res.data.action === 'updated' ? t('pop_updated') : t('pop_added'));
  await render();
});

$('autoFill').addEventListener('change', async (e) => {
  const res = await send({ type: 'autoFill.setSite', host, enabled: e.target.checked });
  if (!res.ok) {
    toast(t('pop_setting_failed', res.error));
    e.target.checked = !e.target.checked;
    return;
  }
  toast(e.target.checked ? t('pop_autofill_on') : t('pop_autofill_off'));
  // 關掉自動填入會一起取消自動按登入，重畫才看得到
  await render();
});

$('manage').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
  window.close();
});

$('autoSubmit').addEventListener('change', async (e) => {
  const res = await send({ type: 'autoSubmit.set', host, enabled: e.target.checked });
  if (!res.ok) {
    toast(t('pop_setting_failed', res.error));
    e.target.checked = !e.target.checked;
    return;
  }
  toast(e.target.checked ? t('pop_autosubmit_on', host) : t('pop_autosubmit_off'));
});

// 小視窗要關掉，使用者才點得到網頁，所以選按鈕的事交給網頁裡的 content.js
$('pickBtn').addEventListener('click', async () => {
  const r = await sendToPage({ type: 'pickStart' });
  if (!r.ok) {
    toast(r.error);
    return;
  }
  window.close();
});

$('pickCount').addEventListener('click', async () => {
  await chrome.tabs.create({ url: chrome.runtime.getURL('src/options/options.html#settings') });
  window.close();
});

// ---- 搜尋所有網站的帳號（登入捷徑）----

let allEntries = null;
let searchResults = [];

async function searchEntries(q) {
  if (!allEntries) {
    const res = await send({ type: 'entries.all' });
    if (!res.ok) {
      toast(res.error);
      return [];
    }
    allEntries = res.data;
  }
  q = q.toLowerCase();
  return allEntries
    .filter((e) => e.host.includes(q) || e.username.toLowerCase().includes(q) || (e.note || '').toLowerCase().includes(q))
    .slice(0, 20);
}

// 開新分頁到那個網站。先記一下「最近用過」，頁面載好自動填的才會是這一組。
async function openSite(entry) {
  await send({ type: 'entries.touch', id: entry.id });
  await chrome.tabs.create({ url: entry.origin || 'https://' + entry.host });
  window.close();
}

async function renderSearch() {
  const q = $('search').value.trim();
  const list = $('searchList');
  if (!q) {
    list.hidden = true;
    $('main').hidden = false;
    searchResults = [];
    return;
  }
  searchResults = await searchEntries(q);
  list.textContent = '';
  list.hidden = false;
  $('main').hidden = true;
  if (!searchResults.length) {
    list.appendChild(el('div', 'empty', t('pop_search_none', q)));
    return;
  }
  for (const entry of searchResults) {
    const row = el('div', 'entry');
    const u = el('div', 'u', entry.username || t('pop_search_no_username'));
    u.appendChild(el('div', 'h', entry.host));
    const open = el('button', 'primary small', t('pop_open'));
    open.addEventListener('click', () => openSite(entry));
    const copy = el('button', 'small', t('pop_copy_password'));
    copy.addEventListener('click', () => copyPassword(entry));
    row.appendChild(u);
    row.appendChild(open);
    row.appendChild(copy);
    list.appendChild(row);
  }
}

$('search').addEventListener('input', () => renderSearch().catch((err) => toast(String(err))));
$('search').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && $('search').value.trim() && searchResults.length) {
    e.preventDefault();
    openSite(searchResults[0]);
  } else if (e.key === 'Escape') {
    $('search').value = '';
    renderSearch();
  }
});

// ---- 工具鎖定：只用系統驗證，沒有 PIN ----

function showLocked(locked) {
  $('lockScreen').hidden = !locked;
  $('main').hidden = locked;
  $('search').hidden = locked;
  $('searchList').hidden = true;
}

async function refreshLockUi() {
  const res = await send({ type: 'lock.status' });
  const st = res.ok ? res.data : { enabled: false, locked: false };
  $('lockNow').hidden = !(st.enabled && !st.locked);
  $('helloBtn').textContent = t('pop_unlock_with', pkWebAuthn.label());
  showLocked(!!st.locked);
  return st;
}

// 小視窗一失去焦點就會關掉，系統的驗證視窗一跳出來它就沒了，所以要開一個獨立的小視窗來做
$('helloBtn').addEventListener('click', async () => {
  await chrome.windows.create({ url: chrome.runtime.getURL('src/unlock/unlock.html'), type: 'popup', width: 460, height: 300, focused: true });
  window.close();
});

$('lockNow').addEventListener('click', async () => {
  const res = await send({ type: 'lock.now' });
  if (!res.ok) {
    toast(res.error);
    return;
  }
  await refreshLockUi();
});

// ---- 產生密碼 ----

const GEN_FIELD_IDS = ['genMin', 'genMax', 'genUpper', 'genLower', 'genDigits', 'genSymbols', 'genSymbolSet'];

function readGenOptions() {
  return {
    minLength: $('genMin').value,
    maxLength: $('genMax').value,
    upper: $('genUpper').checked,
    lower: $('genLower').checked,
    digits: $('genDigits').checked,
    symbols: $('genSymbols').checked,
    symbolSet: $('genSymbolSet').value,
  };
}

function writeGenOptions(o) {
  if (!o) return;
  $('genMin').value = o.minLength;
  $('genMax').value = o.maxLength;
  $('genUpper').checked = !!o.upper;
  $('genLower').checked = !!o.lower;
  $('genDigits').checked = !!o.digits;
  $('genSymbols').checked = !!o.symbols;
  $('genSymbolSet').value = o.symbolSet || '';
}

// 每次產生都把選項存回設定，網頁清單裡的「產生強密碼」用的就是這一組
async function regenerate() {
  $('genError').textContent = '';
  const res = await send({ type: 'password.generate', options: readGenOptions(), save: true });
  if (!res.ok) {
    $('genError').textContent = res.error;
    $('genOut').value = '';
    return;
  }
  $('genOut').value = res.data.password;
  // 背景程式會把超出範圍的值修正回來（例如上限比下限小），寫回畫面讓使用者看到實際用的值
  writeGenOptions(res.data.options);
}

function showGenPanel(show) {
  $('genPanel').classList.toggle('show', show);
  $('genBtn').style.display = show ? 'none' : '';
  if (show) regenerate();
}

$('genBtn').addEventListener('click', () => showGenPanel(true));
$('genClose').addEventListener('click', () => showGenPanel(false));
$('genAgain').addEventListener('click', regenerate);
for (const id of GEN_FIELD_IDS) $(id).addEventListener('change', regenerate);
$('genCopy').addEventListener('click', async () => {
  const value = $('genOut').value;
  if (!value) return;
  try {
    await navigator.clipboard.writeText(value);
    toast(t('pop_copied'));
  } catch (err) {
    toast(t('pop_copy_failed', err.message));
  }
});
$('genFill').addEventListener('click', async () => {
  const value = $('genOut').value;
  if (!value) return;
  const r = await sendToPage({ type: 'fill', generatedPassword: value });
  toast(r.ok ? t('pop_gen_filled') : r.error);
});

// ---- 備份提醒 ----

async function renderBackupBar() {
  const res = await send({ type: 'backup.status' });
  if (!res.ok || !res.data.due) return;
  const bar = $('backupBar');
  bar.textContent = res.data.lastBackupAt ? tn('pop_backup_days', res.data.days) : t('pop_backup_never');
  bar.hidden = false;
  bar.addEventListener('click', async () => {
    // 直接開到管理頁的「備份」分頁
    await chrome.tabs.create({ url: chrome.runtime.getURL('src/options/options.html#backup') });
    window.close();
  });
}

(async function init() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  tab = tabs[0] || null;
  const site = tab ? siteOf(tab.url || '') : null;
  const settings = await send({ type: 'settings.get' });
  if (settings.ok) writeGenOptions(settings.data.generator);
  const lock = await refreshLockUi();
  if (!lock.locked) renderBackupBar();
  if (!site) {
    $('site').textContent = t('pop_unsupported_page');
    $('addBtn').disabled = true;
    $('pickBtn').disabled = true;
    return;
  }
  host = site.host;
  origin = site.origin;
  $('site').textContent = host;
  if (!lock.locked) await render();
})();
