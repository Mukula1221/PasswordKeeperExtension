'use strict';
// 管理頁：列出所有密碼，可以搜尋、新增、修改、刪除、匯入匯出 CSV、改設定。
(() => {
  const PK = (globalThis.PK ??= {});
  const { formatLang, pickLocale, rememberLocale, t, tn } = PK.i18n;
  const pkWebAuthn = PK.webauthnClient;
  const { tipIcon } = PK.tip;
  const CHANGELOG = PK.changelog;

  const { $, el } = PK.page;
  const { send, toast } = PK.page.pageHelpers({ noResponse: () => t('opt_no_response'), toastMs: 2500 });

  let entries = [];
  // 檢查新版的狀態，版本分頁和關於分頁都用
  let updateInfo = null;
  // 工具鎖定的狀態，renderLock() 讀好放這裡
  let lockSt = null;
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
    // 鎖住時整頁只剩驗證畫面。沒鎖就直接進去，在小視窗解鎖過不用再驗一次。
    const lock = await send({ type: 'lock.status' });
    const needVerify = lock.ok && lock.data.enabled && lock.data.locked;
    $('lockScreen').hidden = !needVerify;
    $('pageMain').hidden = needVerify;
    document.body.classList.toggle('locked', needVerify);
    if (needVerify) {
      closeDialogsForLock();
      renderLockScreen(lock.data);
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
    renderHealth();
    renderList();
    renderAbout();
    renderSettings();
    renderBackup();
    renderTrash();
  }

  // 用 createElementNS 建圖示，不用 HTML 字串。d 是一條 path，stroke 用文字顏色
  const SVG_NS = 'http://www.w3.org/2000/svg';
  function svgIcon(d, className) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    for (const [k, v] of [['viewBox', '0 0 24 24'], ['fill', 'none'], ['stroke', 'currentColor'], ['stroke-width', '2'], ['stroke-linecap', 'round'], ['stroke-linejoin', 'round'], ['aria-hidden', 'true']]) svg.setAttribute(k, v);
    if (className) svg.setAttribute('class', className);
    const line = document.createElementNS(SVG_NS, 'path');
    line.setAttribute('d', d);
    svg.appendChild(line);
    return svg;
  }

  function iconBox(d, className) {
    const box = el('span', className || 'tile-icon');
    box.appendChild(svgIcon(d));
    return box;
  }

  const ICON = {
    save: 'M5 4h11l3 3v13H5zM8 4v5h7V4M8 14h8',
    fill: 'M4 7h16M4 12h10M4 17h7M17 14l3 3-3 3',
    keyboard: 'M3 7h18v10H3zM7 11h.01M11 11h.01M15 11h.01M8 14h8',
    lock: 'M6 11h12a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2zM8 11V7a4 4 0 0 1 8 0v4',
    key: 'M12 15a4 4 0 1 1-8 0a4 4 0 1 1 8 0zM10.8 12.2L20 3m-3 3l3 3m-6 0l2 2',
    click: 'M9 4v2M4 9h2M5.5 5.5L7 7M12 9l8 3-3.5 1.5L15 17z',
    history: 'M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l3 2',
    shield: 'M12 3l7 3v5c0 4.5-3 8.3-7 10-4-1.7-7-5.5-7-10V6z',
    shieldOk: 'M12 3l7 3v5c0 4.5-3 8.3-7 10-4-1.7-7-5.5-7-10V6zM8.5 12l2.5 2.5 4.5-5',
    backup: 'M4 4h16a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zM5 9v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9M10 13h4',
    computer: 'M4 5h16v11H4zM8 20h8M12 16v4',
    globe: 'M21 12a9 9 0 1 1-18 0a9 9 0 1 1 18 0zM3 12h18M12 3c3 3.2 3 14.8 0 18M12 3c-3 3.2-3 14.8 0 18',
    code: 'M8 6l-6 6 6 6M16 6l6 6-6 6',
    chat: 'M4 5h16v11H8l-4 4zM8 9h8M8 12h5',
    download: 'M12 4v11M7 10l5 5 5-5M4 20h16',
    warning: 'M12 4l9 16H3zM12 10v4M12 17h.01',
    doc: 'M5 4h10l4 4v12H5zM9 12h6M9 16h6',
    external: 'M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
    trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13',
  };

  // 卡片上、清單上比較短的日期時間，例如 11/25 12:00
  function fmtShort(ts) {
    return new Date(ts).toLocaleString(formatLang(), { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  function fmtDate(ts) {
    if (!ts) return '—';
    const d = new Date(ts);
    return d.toLocaleDateString(formatLang()) + ' ' + d.toLocaleTimeString(formatLang(), { hour: '2-digit', minute: '2-digit' });
  }

  // ---- 密碼分頁：左邊帳號清單，右邊詳細資料 ----

  // 右邊顯示的帳號 id
  let currentId = null;
  // 視窗窄於 900px 時一次只顯示一邊：true 是顯示詳細資料，false 是顯示清單
  let showDetail = false;
  // 勾選模式：清單每一列前面才出現方框，給「匯出勾選的」用
  let selecting = false;
  // 健檢標籤的篩選：null 是不篩，其他是 HEALTH_KINDS 其中一個
  let healthFilter = null;
  // 每個帳號的健檢問題：id → [{ kind, text, action }]，renderHealth() 算好
  let issuesById = new Map();

  const MASK = '••••••••';
  const narrow = matchMedia('(max-width: 900px)');

  function siteUrl(e) {
    return e.origin || 'https://' + e.host;
  }

  // 帳號前面的字首方塊。用 Array.from 拆字，emoji 這種兩個字元的字才不會被切一半
  function initialOf(text, big) {
    const box = el('span', big ? 'initial big' : 'initial', Array.from(String(text || '?').trim() || '?')[0]);
    box.setAttribute('aria-hidden', 'true');
    return box;
  }

  async function copyPassword(password) {
    try {
      await navigator.clipboard.writeText(password);
      send({ type: 'clipboard.copied', text: password });
      toast(t('opt_password_copied'));
    } catch (err) {
      toast(t('opt_copy_failed', err.message));
    }
  }

  function visibleEntries() {
    const q = $('search').value.trim().toLowerCase();
    return entries.filter(
      (e) =>
        (!q || e.host.includes(q) || e.username.toLowerCase().includes(q) || (e.note || '').toLowerCase().includes(q)) &&
        (!healthFilter || (issuesById.get(e.id) || []).some((i) => i.kind === healthFilter))
    );
  }

  // 清單上的小標籤，一列最多兩個
  function healthTag(kind) {
    const text = {
      breached: () => t('opt_health_tag_breached'),
      reused: () => t('opt_health_tag_reused'),
      weak: () => t('opt_health_tag_weak'),
      old: () => t('opt_health_tag_old'),
      http: () => t('opt_health_tag_http'),
      dup: () => t('opt_health_tag_dup'),
    }[kind];
    return el('span', 'tag warn', text());
  }

  function renderList() {
    const q = $('search').value.trim();
    const visible = visibleEntries();
    const box = $('rows');
    box.textContent = '';
    $('empty').hidden = entries.length > 0;
    $('entryCount').textContent = entries.length ? tn('opt_entry_count', entries.length) : '';
    lastVisible = visible.map((e) => e.id);
    $('selectMode').hidden = selecting || !entries.length;
    $('selectBar').hidden = !selecting;
    $('checkAll').checked = visible.length > 0 && visible.every((e) => selected.has(e.id));
    updateExportSelected();
    // 右邊那筆被刪掉、或被搜尋和篩選擋掉時，寬的視窗改顯示清單第一筆。窄的視窗回到清單。
    if (!visible.some((e) => e.id === currentId)) {
      currentId = narrow.matches || !visible.length ? null : visible[0].id;
      showDetail = false;
    }

    for (const e of visible) {
      const row = el('div', e.id === currentId ? 'entry-row current' : 'entry-row');
      row.setAttribute('role', 'listitem');
      if (selecting) {
        const check = el('input');
        check.type = 'checkbox';
        check.checked = selected.has(e.id);
        check.setAttribute('aria-label', accountLabel(e));
        check.addEventListener('change', () => {
          if (check.checked) selected.add(e.id);
          else selected.delete(e.id);
          $('checkAll').checked = lastVisible.every((id) => selected.has(id));
          updateExportSelected();
        });
        row.appendChild(check);
      }
      const open = el('button', 'entry-open');
      if (e.id === currentId) open.setAttribute('aria-current', 'true');
      open.appendChild(initialOf(e.host));
      const texts = el('span', 'texts');
      texts.appendChild(el('span', 'host', e.host));
      texts.appendChild(el('span', 'user', e.username || t('opt_no_username')));
      open.appendChild(texts);
      const kinds = [...new Set((issuesById.get(e.id) || []).map((i) => i.kind))];
      if (kinds.length) {
        const tags = el('span', 'tags');
        for (const kind of kinds.slice(0, 2)) tags.appendChild(healthTag(kind));
        open.appendChild(tags);
      }
      open.addEventListener('click', () => {
        currentId = e.id;
        showDetail = true;
        renderList();
        // 窄的視窗整頁換成詳細資料，焦點移到「回到清單」，讀螢幕軟體才知道畫面換了
        if (narrow.matches) {
          const back = $('detailPane').querySelector('.back');
          if (back) back.focus();
        }
      });
      row.appendChild(open);
      box.appendChild(row);
    }
    if (q && !visible.length && entries.length) box.appendChild(el('div', 'empty', t('opt_search_no_match', q)));
    renderDetail();
  }

  // 詳細資料的一列：名稱、值、右邊的按鈕
  function fieldRow(label, value, className) {
    const row = el('div', 'field');
    row.appendChild(el('span', 'label', label));
    const v = el('span', className ? 'value ' + className : 'value', value);
    row.appendChild(v);
    const ops = el('span', 'ops');
    row.appendChild(ops);
    return { row, value: v, ops };
  }

  function linkButton(text, onClick) {
    const btn = el('button', 'link small', text);
    btn.addEventListener('click', onClick);
    return btn;
  }

  // 密碼先遮起來，按「顯示」才看得到
  function maskToggle(valueEl, secret) {
    let shown = false;
    const btn = linkButton(t('opt_show'), () => {
      shown = !shown;
      valueEl.textContent = shown ? secret : MASK;
      btn.textContent = shown ? t('opt_hide') : t('opt_show');
    });
    return btn;
  }

  function switchRow(text, checked, disabled, onChange) {
    const label = el('label', 'switch-row');
    label.appendChild(el('span', null, text));
    const box = el('input', 'switch');
    box.type = 'checkbox';
    box.setAttribute('role', 'switch');
    box.checked = checked;
    box.disabled = disabled;
    box.addEventListener('change', () => onChange(box.checked));
    label.appendChild(box);
    return label;
  }

  // 這個網站的自動填入、自動按登入，切了馬上存。設定分頁「各網站」那張表改的是同一個設定
  async function setSiteSwitch(type, host, enabled) {
    const res = await send({ type, host, enabled });
    if (!res.ok) toast(t('opt_setting_failed', res.error));
    else settings = res.data;
    renderSites();
    renderDetail();
  }

  function renderDetail() {
    const pane = $('detailPane');
    pane.textContent = '';
    $('tab-passwords').classList.toggle('show-detail', showDetail && !!currentId);
    const e = entries.find((x) => x.id === currentId);
    if (!e) {
      if (entries.length) pane.appendChild(el('div', 'detail-empty', t('opt_detail_empty')));
      return;
    }
    const box = el('div', 'detail');

    const back = el('button', 'small back', t('opt_back_to_list'));
    back.addEventListener('click', () => {
      showDetail = false;
      renderList();
      const row = $('rows').querySelector('.entry-row.current .entry-open');
      if (row) row.focus();
    });
    box.appendChild(back);

    const head = el('div', 'detail-head');
    head.appendChild(initialOf(e.host, true));
    const title = el('div', 'grow');
    title.appendChild(el('h2', null, e.host));
    title.appendChild(el('div', 'muted', t('opt_detail_dates', fmtDate(e.lastUsedAt), fmtDate(e.createdAt))));
    head.appendChild(title);
    const site = el('a', 'button', t('opt_open_site'));
    site.href = siteUrl(e);
    site.target = '_blank';
    site.rel = 'noopener';
    head.appendChild(site);
    const edit = el('button', 'primary', t('opt_edit'));
    edit.addEventListener('click', () => openDialog(e));
    head.appendChild(edit);
    box.appendChild(head);

    for (const issue of issuesById.get(e.id) || []) {
      const div = el('div', 'issue');
      div.appendChild(el('span', 'grow', issue.text));
      if (issue.action) div.appendChild(issue.action);
      box.appendChild(div);
    }

    const fields = el('div', 'card fields');
    const user = fieldRow(t('opt_col_username'), e.username || t('opt_no_username'));
    if (e.username) user.ops.appendChild(linkButton(t('opt_copy'), () => copyText(e.username)));
    fields.appendChild(user.row);
    const pw = fieldRow(t('opt_col_password'), MASK, 'mono');
    pw.ops.appendChild(maskToggle(pw.value, e.password));
    pw.ops.appendChild(linkButton(t('opt_copy'), () => copyPassword(e.password)));
    fields.appendChild(pw.row);
    const url = fieldRow(t('opt_field_url'), siteUrl(e));
    url.ops.appendChild(linkButton(t('opt_copy'), () => copyText(siteUrl(e))));
    fields.appendChild(url.row);
    const note = fieldRow(t('opt_field_note'), e.note || t('opt_note_empty'), e.note ? 'note' : 'note empty');
    note.ops.appendChild(linkButton(e.note ? t('opt_edit') : t('opt_note_write'), () => editNote(e, note.row)));
    fields.appendChild(note.row);
    // 改過密碼的帳號可以展開看之前的
    if (e.history && e.history.length) {
      const more = el('div', 'more');
      const list = el('div');
      list.hidden = true;
      for (const h of e.history) {
        const line = el('div', 'old');
        line.appendChild(el('span', 'muted', t('opt_history_replaced_at', fmtDate(h.changedAt))));
        const mask = el('span', null, MASK);
        line.appendChild(mask);
        line.appendChild(maskToggle(mask, h.password));
        line.appendChild(linkButton(t('opt_copy'), () => copyPassword(h.password)));
        list.appendChild(line);
      }
      const toggle = linkButton(t('opt_history_toggle', e.history.length), () => {
        list.hidden = !list.hidden;
        toggle.setAttribute('aria-expanded', String(!list.hidden));
      });
      toggle.setAttribute('aria-expanded', 'false');
      more.appendChild(toggle);
      more.appendChild(list);
      fields.appendChild(more);
    }
    box.appendChild(fields);

    const master = !!settings.autoFill;
    const fillOn = !(settings.noAutoFillHosts || []).includes(e.host);
    const submitOn = (settings.autoSubmitHosts || []).includes(e.host);
    const switches = el('div', 'card switches');
    switches.appendChild(switchRow(t('opt_site_col_fill'), fillOn, !master, (on) => setSiteSwitch('autoFill.setSite', e.host, on)));
    switches.appendChild(switchRow(t('opt_site_col_submit'), submitOn, !master || !fillOn, (on) => setSiteSwitch('autoSubmit.set', e.host, on)));
    if (!master) switches.appendChild(el('div', 'help', t('opt_site_master_off')));
    box.appendChild(switches);

    const del = el('button', 'danger', t('opt_move_to_trash'));
    del.style.alignSelf = 'flex-start';
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
    box.appendChild(del);
    pane.appendChild(box);
  }

  // 備註原地改：那一列換成輸入框。Ctrl+Enter 存，Esc 放棄
  function editNote(e, row) {
    row.classList.add('editing');
    row.textContent = '';
    row.appendChild(el('span', 'label', t('opt_field_note')));
    const box = el('div', 'note-edit');
    const area = el('textarea');
    area.rows = 3;
    area.value = e.note || '';
    area.setAttribute('aria-label', t('opt_field_note'));
    const actions = el('div', 'row end');
    const cancel = el('button', 'small', t('opt_cancel'));
    const save = el('button', 'primary small', t('opt_save'));
    actions.appendChild(cancel);
    actions.appendChild(save);
    box.appendChild(area);
    box.appendChild(actions);
    row.appendChild(box);
    area.focus();
    cancel.addEventListener('click', renderDetail);
    save.addEventListener('click', () => saveNote(e, area.value));
    area.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        renderDetail();
      } else if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) {
        ev.preventDefault();
        saveNote(e, area.value);
      }
    });
  }

  // 網址、帳號、密碼照舊送回去，只換備註。密碼沒變，背景程式不會多記一筆舊密碼
  async function saveNote(e, value) {
    const res = await send({ type: 'entries.save', id: e.id, entry: { url: siteUrl(e), username: e.username, password: e.password, note: value.trim() } });
    if (!res.ok) {
      toast(t('opt_note_failed', res.error));
      return;
    }
    toast(t('opt_note_saved'));
    await load();
  }

  narrow.addEventListener('change', renderList);

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
    renderList();
  });

  $('selectMode').addEventListener('click', () => {
    selecting = true;
    renderList();
    $('checkAll').focus();
  });

  $('selectCancel').addEventListener('click', () => {
    selecting = false;
    selected.clear();
    renderList();
    $('selectMode').focus();
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

  // 外洩檢查的結果：帳號 id → 在外洩名單出現過幾次。只放在這一頁，不存，關掉管理頁就沒了
  let breachCounts = null;

  // 重複的項目：網站只差開頭的 www.，帳號和密碼都一樣。jira.example.com 和 gitlab.example.com 是不同系統，不算重複
  const sameSite = (host) => String(host || '').toLowerCase().replace(/^www\./, '');

  // 清單上方是健檢的標籤，只列有問題的項目。點一個標籤，清單只列有那個問題的帳號，再點一次取消。
  // 每個帳號的問題寫在右邊詳細資料的最上面。
  function renderHealth() {
    issuesById = new Map();
    const chips = $('healthChips');
    const summary = $('healthSummary');
    chips.textContent = '';
    summary.textContent = '';
    summary.className = '';
    $('breachWrap').hidden = !entries.length;
    if (!entries.length) {
      healthFilter = null;
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
    // 還在用 http 的網址。公司內部設備很多只有 http，按過「忽略」的不列
    const ignored = new Set(settings.healthIgnoreHttp || []);
    const httpAll = entries.filter((e) => /^http:/i.test(e.origin || ''));
    const http = httpAll.filter((e) => !ignored.has(e.id));
    const ignoredCount = httpAll.length - http.length;
    const bySite = new Map();
    for (const e of entries) {
      const key = sameSite(e.host) + '\n' + e.username + '\n' + e.password;
      if (!bySite.has(key)) bySite.set(key, []);
      bySite.get(key).push(e);
    }
    const dups = [...bySite.values()].filter((g) => g.length >= 2);
    const breached = breachCounts ? entries.filter((e) => breachCounts.has(e.id)) : [];

    const add = (e, kind, text, action) => {
      if (!issuesById.has(e.id)) issuesById.set(e.id, []);
      issuesById.get(e.id).push({ kind, text, action });
    };
    // 同一組裡其他的帳號，例如「gitlab.example.com、mail.example.com」
    const others = (group, e) =>
      [...new Set(group.filter((x) => x !== e).map((x) => accountLabel(x)))].join(t('opt_health_part_sep'));
    for (const e of breached) add(e, 'breached', tn('opt_health_breached', breachCounts.get(e.id)));
    for (const g of reused) for (const e of g) add(e, 'reused', t('opt_health_reused_with', others(g, e)));
    for (const e of weak) add(e, 'weak', e.password.length < 8 ? tn('opt_health_weak_short', e.password.length) : t('opt_health_weak_classes'));
    for (const e of old) add(e, 'old', t('opt_health_old', fmtDate(e.passwordChangedAt || e.createdAt)));
    for (const e of http) add(e, 'http', t('opt_health_http'), linkButton(t('opt_health_http_ignore'), () => setHttpIgnored([...ignored, e.id])));
    for (const g of dups) for (const e of g) add(e, 'dup', t('opt_health_dup_with', others(g, e)));

    const parts = [
      ['breached', breached.length && tn('opt_health_part_breached', breached.length)],
      ['reused', reused.length && tn('opt_health_part_reused', reused.length)],
      ['weak', weak.length && tn('opt_health_part_weak', weak.length)],
      ['old', old.length && tn('opt_health_part_old', old.length)],
      ['http', http.length && tn('opt_health_part_http', http.length)],
      ['dup', dups.length && tn('opt_health_part_dup', dups.length)],
    ].filter(([, text]) => text);
    if (healthFilter && !parts.some(([kind]) => kind === healthFilter)) healthFilter = null;
    if (!parts.length) {
      summary.textContent = t('opt_health_ok');
      summary.className = 'health-ok';
    }
    for (const [kind, text] of parts) {
      const chip = el('button', 'chip-btn', text);
      chip.setAttribute('aria-pressed', String(healthFilter === kind));
      chip.title = t('opt_health_filter_title');
      chip.addEventListener('click', () => {
        healthFilter = healthFilter === kind ? null : kind;
        renderHealth();
        renderList();
      });
      chips.appendChild(chip);
    }
    if (ignoredCount) {
      chips.appendChild(el('span', 'muted', tn('opt_health_http_ignored', ignoredCount)));
      chips.appendChild(linkButton(t('opt_health_http_restore'), () => setHttpIgnored([])));
    }
  }

  async function setHttpIgnored(ids) {
    const res = await send({ type: 'settings.set', patch: { healthIgnoreHttp: [...new Set(ids)] } });
    if (!res.ok) {
      toast(t('opt_setting_failed', res.error));
      return;
    }
    settings = res.data;
    renderHealth();
    renderList();
  }

  // 外洩密碼檢查。Firefox 要先跳同意視窗，permissions.request 要在使用者按的當下叫，前面不能先 await 別的東西
  $('breachCheck').addEventListener('click', () => {
    const consent = PK.platform.can('dataCollectionConsent') ? chrome.permissions.request({ data_collection: ['authenticationInfo'] }) : Promise.resolve(true);
    consent.then(
      async (granted) => {
        if (!granted) {
          toast(t('opt_breach_need_consent'));
          return;
        }
        const btn = $('breachCheck');
        btn.disabled = true;
        btn.textContent = t('opt_breach_checking');
        const res = await send({ type: 'breach.check' });
        btn.disabled = false;
        btn.textContent = t('opt_breach_check');
        if (!res.ok) {
          toast(res.error);
          return;
        }
        breachCounts = new Map(res.data.found.map((f) => [f.id, f.count]));
        // 有外洩的話，清單直接只列外洩的帳號
        healthFilter = res.data.found.length ? 'breached' : healthFilter;
        renderHealth();
        renderList();
        if (res.data.found.length) toast(tn('opt_breach_found', res.data.found.length));
        else toast(tn('opt_breach_none', res.data.checked));
      },
      (err) => toast(t('bg_breach_failed', err.message))
    );
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

  // 剩幾天：快清掉的寫「今天清掉」「明天清掉」，3 天以內用黃色
  function trashLeft(item) {
    const left = daysLeft(item.deletedAt);
    const text = left <= 0 ? t('opt_trash_left_today') : left === 1 ? t('opt_trash_left_tomorrow') : tn('opt_trash_left', left);
    return el('span', left <= 3 ? 'tag warn' : 'tag plain', text);
  }

  function drawTrash() {
    const box = $('trashList');
    box.textContent = '';
    $('trashCount').textContent = trash.length ? String(trash.length) : '';
    $('trashTotal').textContent = trash.length ? tn('opt_trash_count', trash.length) : '';
    $('trashCard').hidden = trash.length === 0;
    $('trashEmpty').hidden = trash.length > 0;
    $('trashEmptySub').textContent = tn('opt_trash_empty_sub', currentTrashDays());
    $('purgeAll').disabled = trash.length === 0;
    updateTrashSelection();
    for (const item of trash) {
      const row = el('div', 'entry trash-row');
      const chk = el('input');
      chk.type = 'checkbox';
      chk.checked = trashSelected.has(item.id);
      chk.setAttribute('aria-label', accountLabel(item));
      chk.addEventListener('change', () => {
        if (chk.checked) trashSelected.add(item.id);
        else trashSelected.delete(item.id);
        updateTrashSelection();
      });
      const texts = el('div', 'texts');
      texts.appendChild(el('div', 'host', item.host));
      const age = ageDays(item.deletedAt);
      const when = age ? tn('opt_trash_deleted_ago', age) : t('opt_trash_deleted_today');
      texts.appendChild(el('div', 'muted', t('opt_trash_row_info', item.username || t('opt_no_username'), when)));
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
      const purge = el('button', 'icon-btn danger');
      purge.appendChild(svgIcon(ICON.trash));
      purge.title = t('opt_purge');
      purge.setAttribute('aria-label', t('opt_purge'));
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
      row.appendChild(initialOf(item.host));
      row.appendChild(texts);
      row.appendChild(trashLeft(item));
      row.appendChild(restore);
      row.appendChild(purge);
      box.appendChild(row);
    }
    renderAbout();
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
    $('clipClear').value = String(settings.clipboardClearSeconds || 0);
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
    // new URL 不會擋空白和 *，會變成 %20、%2A。和 src/background/click-rules.js 的 CLICK_RULE_HOST 一樣。
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
      tr.appendChild(siteCheckbox(s.fill, !master, (on) => setSiteState(host, { ...s, fill: on }), host + ' ' + t('opt_site_col_fill')));
      tr.appendChild(siteCheckbox(s.submit, !master || !s.fill, (on) => setSiteState(host, { ...s, submit: on }), host + ' ' + t('opt_site_col_submit')));
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

  function siteCheckbox(checked, disabled, onChange, label) {
    const td = el('td', 'center');
    const box = el('input', 'switch');
    box.type = 'checkbox';
    box.setAttribute('role', 'switch');
    box.setAttribute('aria-label', label);
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

  function openBlock(id) {
    const block = $(id);
    block.open = true;
    block.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  for (const b of document.querySelectorAll('.jump button')) b.addEventListener('click', () => openBlock(b.dataset.jump));

  // ---- 工具鎖定：保護方式 ----
  // off 關閉、password 自訂密碼加密、hello 系統驗證加密（Windows Hello、Touch ID、安全金鑰）。
  // screen 只鎖畫面是 1.15.0 以前的設定：舊使用者照常用，但畫面上沒有這個選項，改選別的就回不去。
  // 換方式的規則在背景程式的 setLockMode，這裡負責跳該跳的驗證和對話框。

  const isEncryptedLock = (mode) => mode === 'password' || mode === 'hello';

  function lockModeName(mode, name) {
    if (mode === 'screen') return t('opt_lock_mode_screen_with', name);
    if (mode === 'password') return t('opt_lock_mode_password');
    if (mode === 'hello') return t('opt_lock_mode_hello_with', name);
    return t('opt_lock_mode_off');
  }

  async function renderLock() {
    const res = await send({ type: 'lock.status' });
    if (!res.ok) {
      $('lockInfo').textContent = res.error;
      return;
    }
    const st = (lockSt = res.data);
    const name = pkWebAuthn.label();
    // 區塊預設收合，標題旁邊要看得出用哪種
    $('lockState').textContent = st.mode === 'off' ? t('opt_lock_state_off') : lockModeName(st.mode, name);
    // 加密的是綠色，舊版的只鎖畫面是黃色，請使用者改選
    $('lockState').className = 'sec-state' + (isEncryptedLock(st.mode) ? ' ok' : st.mode === 'screen' ? ' warn' : '');
    $('lockModeHello').textContent = lockModeName('hello', name);
    $('lockHowHello').textContent = t('opt_lock_how_hello', name);
    // 舊的只鎖畫面沒有卡片，三張都不會選到，上面多一行請使用者改選
    $('lockLegacy').hidden = st.mode !== 'screen';
    for (const radio of document.querySelectorAll('input[name="lockMode"]')) radio.checked = radio.value === st.mode;
    // 不支援系統驗證的瀏覽器（例如 Firefox，見 platform.js）不顯示系統驗證加密，只能選關閉和自訂密碼加密
    $('lockCardHello').hidden = !pkWebAuthn.supported();
    $('lockChangePw').hidden = st.mode !== 'password';
    const encrypted = isEncryptedLock(st.mode);
    $('lockMinutes').value = st.idleMinutes;
    // 加密的保護方式，瀏覽器重開後金鑰就不在記憶體，一定要重新解鎖，不給取消
    $('lockOnStartup').checked = encrypted || !!st.onStartup;
    $('lockMinutes').disabled = !st.enabled;
    $('lockIdleTip').hidden = PK.platform.can('screenLockEvents');
    $('lockOnStartup').disabled = !st.enabled || encrypted;
    $('lockInfo').textContent = pkWebAuthn.supported() ? '' : t('opt_lock_info_no_hello');
    // 沒有 Windows Hello、Touch ID 的電腦，系統驗證加密要靠安全金鑰或手機，就不推薦
    $('lockRecommend').hidden = !(await pkWebAuthn.hasPlatformAuthenticator());
    // 還沒設自動備份密碼的話，加密的兩張卡片直接寫出來，不用點了才知道
    const ab = isEncryptedLock(st.mode) ? null : await send({ type: 'autoBackup.get' });
    const needsBackup = !!(ab && ab.ok && !ab.data.hasPassword);
    for (const note of document.querySelectorAll('.lock-card-note')) note.hidden = !needsBackup;
    renderAbout();
  }

  // 跟背景程式的 needsProof 一樣：拿掉加密、關掉鎖定、改自訂密碼要再驗一次
  function lockNeedsProof(current, target) {
    if (current === target) return current === 'password';
    if (target === 'off') return current !== 'off';
    return false;
  }

  // 原本是自訂密碼加密就打自訂密碼，其他跳系統驗證。取消回傳 null。
  async function askLockProof(mode) {
    if (mode === 'password') {
      const password = await askPassword({ title: t('opt_master_pw_verify_title'), label: t('opt_master_password'), confirm: false });
      return password == null ? null : { password };
    }
    return { assertion: await pkWebAuthn.assertion() };
  }

  function askMasterPassword(title) {
    return askPassword({
      title,
      hint: t('opt_master_pw_hint', lockSt.masterPasswordMin),
      label: t('opt_master_password'),
      confirm: true,
      minLength: lockSt.masterPasswordMin,
    });
  }

  // 換保護方式。回傳 cancelled（使用者取消）或 done。
  async function changeLockMode(target) {
    const st = lockSt;
    if (isEncryptedLock(target)) {
      const ab = await send({ type: 'autoBackup.get' });
      if (!ab.ok) throw new Error(ab.error);
      if (!ab.data.hasPassword) throw new Error(t('opt_lock_needs_backup_password'));
    }
    if (isEncryptedLock(st.mode) && !isEncryptedLock(target)) {
      const ok = await askChoice({
        title: t('opt_lock_downgrade_title'),
        text: t('opt_lock_downgrade_text'),
        buttons: [
          { label: t('opt_cancel'), value: false },
          { label: t('opt_lock_downgrade_confirm'), value: true, className: 'danger' },
        ],
      });
      if (!ok) return 'cancelled';
    }
    const msg = { type: 'lock.setMode', mode: target, idleMinutes: $('lockMinutes').value, onStartup: $('lockOnStartup').checked, setup: {} };
    if (lockNeedsProof(st.mode, target)) {
      msg.proof = await askLockProof(st.mode);
      if (!msg.proof) return 'cancelled';
    }
    if (target === 'password') {
      const password = await askMasterPassword(t('opt_master_pw_title'));
      if (password == null) return 'cancelled';
      msg.setup.password = password;
    }
    if (target === 'hello') {
      // 會跳兩次系統驗證，卡片下面寫現在是第幾次、在做什麼，使用者才不會以為第一次沒成功
      const name = pkWebAuthn.label();
      const step = $('lockStep');
      const onStep = (n) => {
        step.textContent = n === 1 ? t('opt_hello_step_create', name) : t('opt_hello_step_verify', name);
        step.hidden = false;
      };
      try {
        Object.assign(msg.setup, await pkWebAuthn.setupHello({ onStep }));
      } finally {
        step.hidden = true;
      }
    }
    const res = await send(msg);
    if (!res.ok) throw new Error(res.error);
    return 'done';
  }

  for (const radio of document.querySelectorAll('input[name="lockMode"]')) {
    radio.addEventListener('change', async () => {
      if (!radio.checked) return;
      const name = pkWebAuthn.label();
      for (const r of document.querySelectorAll('input[name="lockMode"]')) r.disabled = true;
      try {
        if ((await changeLockMode(radio.value)) === 'done') toast(t('opt_lock_mode_changed', lockModeName(radio.value, name)));
      } catch (err) {
        toast(t('opt_lock_mode_failed', err.message));
      }
      // 失敗或取消時，選項要回到實際的保護方式
      await renderLock();
      for (const r of document.querySelectorAll('input[name="lockMode"]')) r.disabled = false;
    });
  }

  $('lockChangePw').addEventListener('click', async () => {
    try {
      const proof = await askLockProof('password');
      if (!proof) return;
      const password = await askMasterPassword(t('opt_master_pw_new_title'));
      if (password == null) return;
      const res = await send({ type: 'lock.setMode', mode: 'password', proof, setup: { password } });
      if (!res.ok) throw new Error(res.error);
      toast(t('opt_master_pw_changed'));
    } catch (err) {
      toast(t('opt_lock_mode_failed', err.message));
    }
    await renderLock();
  });

  // 驗證畫面：自訂密碼加密只給輸入框，其他給系統驗證的按鈕。
  function renderLockScreen(st) {
    const passwordOnly = st.mode === 'password';
    $('helloRow').hidden = passwordOnly || !st.webauthn;
    $('helloUnlock').textContent = t('opt_verify_with', pkWebAuthn.label());
    $('lockPwForm').hidden = !passwordOnly;
    $('lockForgotRow').hidden = !isEncryptedLock(st.mode);
    $('lockError').textContent = (st.mode === 'screen' || st.mode === 'hello') && !st.webauthn ? t('opt_lock_broken') : '';
    if (passwordOnly) $('lockPw').focus();
  }

  $('lockPwForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('lockError').textContent = '';
    $('lockPwSubmit').disabled = true;
    try {
      const res = await send({ type: 'lock.unlockPassword', password: $('lockPw').value });
      if (!res.ok) throw new Error(res.error);
      $('lockPw').value = '';
      await load();
    } catch (err) {
      $('lockError').textContent = err.message;
    } finally {
      $('lockPwSubmit').disabled = false;
    }
  });

  // 忘了自訂密碼、系統驗證壞了：只能清掉這台的密碼，再用備份檔匯入
  $('lockForgot').addEventListener('click', async () => {
    const ok = await askChoice({
      title: t('opt_lock_reset_title'),
      text: t('opt_lock_reset_text'),
      buttons: [
        { label: t('opt_cancel'), value: false },
        { label: t('opt_lock_reset_next'), value: true, className: 'danger' },
      ],
    });
    if (!ok) return;
    // 清掉就沒辦法復原，所以再問一次：先讓使用者看到有沒有備份可以還原，還要照打一個字才按得下去
    const st = await send({ type: 'lock.status' });
    const last = st.ok ? st.data.lastBackupAt : 0;
    const sure = await askChoice({
      title: t('opt_lock_reset_again_title'),
      text: last ? t('opt_lock_reset_last_backup', fmtDate(last)) : t('opt_lock_reset_no_backup'),
      confirmWord: t('opt_lock_reset_word'),
      buttons: [
        { label: t('opt_cancel'), value: false },
        { label: t('opt_lock_reset_confirm'), value: true, className: 'danger', typed: true },
      ],
    });
    if (!sure) return;
    const res = await send({ type: 'lock.reset' });
    if (!res.ok) {
      $('lockError').textContent = res.error;
      return;
    }
    await load();
    showTab('backup');
    toast(t('opt_lock_reset_done'));
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
      await load();
    } catch (err) {
      $('lockError').textContent = err.message;
    } finally {
      $('helloUnlock').disabled = false;
    }
  });

  // 管理頁開著的時候鎖定被觸發（閒置、小視窗按鎖定），背景程式會廣播，這裡立刻回到驗證畫面。
  // 停在驗證畫面時在小視窗解鎖了，也直接進去。
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'lockChanged' && (msg.locked || !$('lockScreen').hidden)) load();
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

  $('moveHow').addEventListener('click', () => $('browserMove').showModal());
  $('moveClose').addEventListener('click', () => $('browserMove').close());

  // 「給同事幾筆」直接跳到密碼分頁，打開勾選
  $('shareGo').addEventListener('click', () => {
    showTab('passwords');
    selecting = true;
    renderList();
    $('checkAll').focus();
  });

  async function renderBackup() {
    const res = await send({ type: 'backup.status' });
    if (!res.ok) {
      $('backupHero').className = 'hero warn';
      $('backupHeroTitle').textContent = t('opt_backup_status_failed', res.error);
      $('backupHeroSub').textContent = '';
      return;
    }
    const s = res.data;
    renderBackupHero(s);
    renderAutoBackup(s.autoBackup || {});
    renderLog(s.log || []);
  }

  // 最上面的狀態卡片：上次備份多久前、之後有沒有改過密碼、下次自動備份。
  // 黃色的判斷跟小視窗的備份提醒一樣：沒備份過，或超過提醒天數之後又改過密碼。
  function renderBackupHero(s) {
    const ab = s.autoBackup || {};
    let kind = '';
    let title = t('opt_backup_hero_empty');
    let sub = t('opt_backup_hero_empty_sub');
    if (s.count && !s.lastBackupAt) {
      kind = 'warn';
      title = t('opt_backup_status_never');
      sub = t('opt_backup_hero_never_sub');
    } else if (s.count) {
      kind = s.due ? 'warn' : 'ok';
      title = s.days ? tn('opt_backup_hero_days', s.days) : t('opt_backup_hero_today');
      const last = fmtDate(s.lastBackupAt);
      if (s.due) sub = t('opt_backup_hero_sub_due', last);
      else sub = ab.enabled ? t('opt_backup_hero_sub_auto', last) : t('opt_backup_hero_sub_manual', last);
    }
    $('backupHero').className = kind ? 'hero ' + kind : 'hero';
    $('backupHeroTitle').textContent = title;
    $('backupHeroSub').textContent = sub;
    $('backupStatCount').textContent = String(s.count || 0);
    $('backupStatNext').textContent = ab.enabled && ab.nextAt ? fmtShort(ab.nextAt) : t('opt_backup_stat_off');
  }

  // ---- 自動備份、備份紀錄 ----

  const WEEKDAY_SHORT = [t('opt_wd_sun'), t('opt_wd_mon'), t('opt_wd_tue'), t('opt_wd_wed'), t('opt_wd_thu'), t('opt_wd_fri'), t('opt_wd_sat')];

  // 選每週的時候要對得起來是星期幾，所以下次備份時間多帶星期
  function fmtWithWeekday(ts) {
    const d = new Date(ts);
    const time = d.toLocaleTimeString(formatLang(), { hour: '2-digit', minute: '2-digit' });
    return t('opt_date_weekday_time', d.toLocaleDateString(formatLang()), WEEKDAY_SHORT[d.getDay()], time);
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

  const LOG_TAG = { auto: 'tag', manual: 'tag plain', location: 'tag warn' };

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
      const kind = el('td', 'nowrap');
      kind.appendChild(el('span', LOG_TAG[logCategory(item)], KIND_LABEL[item.kind] || item.kind));
      tr.appendChild(kind);
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
  // confirmWord：要使用者照打這個字，buttons 裡標了 typed 的按鈕才按得下去。刪了救不回來的動作用。
  function askChoice({ title, text, items, copy, buttons, confirmWord }) {
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
      const typed = [];
      for (const b of buttons) {
        const btn = el('button', b.className || null, b.label);
        btn.addEventListener('click', () => finish(b.value));
        if (confirmWord && b.typed) typed.push(btn);
        box.appendChild(btn);
      }
      const input = $('choiceType');
      $('choiceTypeRow').hidden = !confirmWord;
      $('choiceTypeLabel').textContent = confirmWord ? t('opt_type_to_confirm', confirmWord) : '';
      input.value = '';
      const sync = () => {
        const ok = input.value.trim().toLowerCase() === String(confirmWord || '').toLowerCase();
        for (const btn of typed) btn.disabled = !ok;
      };
      input.oninput = sync;
      sync();
      dlg.addEventListener('cancel', onEsc);
      dlg.showModal();
      // 預設停在第一顆（取消或知道了），不小心按 Enter 不會刪東西。要打字確認的就停在輸入框。
      if (confirmWord) input.focus();
      else box.firstChild.focus();
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
    await applyAutoBackup({ password }, () => {
      toast(t('opt_ab_pw_saved'));
      // 設定分頁的加密卡片上有「先設自動備份密碼」，設好要拿掉
      renderLock();
    });
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

  // 複製密碼後自動清除剪貼簿。剪貼簿的權限是選用的，選了秒數才跟瀏覽器要。
  // 要權限必須在使用者操作的當下叫，Firefox 中間先 await 別的東西就會被拒絕，所以 permissions.request 擺第一個。
  $('clipClear').addEventListener('change', (e) => {
    const seconds = Number(e.target.value);
    const save = async (value) => {
      const res = await send({ type: 'settings.set', patch: { clipboardClearSeconds: value } });
      if (!res.ok) {
        toast(t('opt_setting_failed', res.error));
        return;
      }
      settings = res.data;
      $('clipClear').value = String(settings.clipboardClearSeconds || 0);
    };
    if (!seconds) {
      save(0);
      return;
    }
    // 跟 background/clipboard.js 的 clipboardPermissions() 一樣
    const permissions = PK.platform.can('offscreenClipboard') ? ['clipboardRead', 'clipboardWrite', 'offscreen'] : ['clipboardRead', 'clipboardWrite'];
    chrome.permissions.request({ permissions }).then(
      (granted) => {
        if (granted) return save(seconds);
        toast(t('opt_clip_denied'));
        return save(0);
      },
      (err) => {
        $('clipClear').value = String(settings.clipboardClearSeconds || 0);
        toast(t('opt_setting_failed', err.message));
      }
    );
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

  $('search').addEventListener('input', renderList);

  // 依照使用的瀏覽器顯示對應的擴充功能頁面網址
  (function browserHint() {
    const { name, extensionsUrl } = PK.platform.browserInfo();
    $('browserHint').textContent = t('opt_browser_hint', name, extensionsUrl);
  })();

  // 說明分頁的一張卡片。extra 放在說明下面，例如快捷鍵的按鍵、到別的分頁的連結
  function helpTile(icon, title, body, ...extra) {
    const tile = el('div', 'tile');
    const head = el('div', 'tile-head');
    head.appendChild(iconBox(icon));
    head.appendChild(el('span', null, title));
    tile.appendChild(head);
    tile.appendChild(el('div', 'tile-body', body));
    for (const node of extra) tile.appendChild(node);
    return tile;
  }

  function tileLink(text, onClick) {
    const foot = el('div', 'tile-foot');
    foot.appendChild(linkButton(text + ' →', onClick));
    return foot;
  }

  // 快捷鍵照瀏覽器實際設定的顯示，使用者改過也對得上
  async function shortcutKeys() {
    const box = el('div', 'keys');
    let shortcut = '';
    try {
      const commands = await chrome.commands.getAll();
      const fill = commands.find((c) => c.name === 'fill-login');
      shortcut = (fill && fill.shortcut) || '';
    } catch (err) {
      console.warn('讀不到快捷鍵', err); // i18n-ignore：給開發者看的
    }
    if (!shortcut) box.appendChild(el('span', 'muted', t('opt_help_no_shortcut')));
    for (const key of shortcut.split('+').filter(Boolean)) box.appendChild(el('kbd', null, key));
    return box;
  }

  async function renderHelp() {
    const cards = $('helpCards');
    cards.textContent = '';
    const keys = await shortcutKeys();
    const changeKeys = PK.platform.can('openExtensionsPage')
      ? [tileLink(t('opt_help_link_shortcut'), () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }))]
      : [];
    cards.appendChild(helpTile(ICON.save, t('opt_help_card_1'), t('opt_help_1')));
    cards.appendChild(helpTile(ICON.fill, t('opt_help_card_2'), t('opt_help_2')));
    cards.appendChild(helpTile(ICON.keyboard, t('opt_help_card_3'), t('opt_help_3'), keys, ...changeKeys));
    cards.appendChild(helpTile(ICON.lock, t('opt_help_card_4'), t('opt_help_4')));
    cards.appendChild(helpTile(ICON.key, t('opt_help_card_5'), t('opt_help_5')));
    cards.appendChild(
      helpTile(ICON.click, t('opt_help_card_6'), t('opt_help_6'), tileLink(t('opt_help_link_rules'), () => {
        showTab('settings');
        openBlock('clickBlock');
      }))
    );
    cards.appendChild(helpTile(ICON.history, t('opt_help_card_7'), t('opt_help_7')));
    cards.appendChild(
      helpTile(ICON.shield, t('opt_help_card_8'), t('opt_help_8'), tileLink(t('opt_help_link_lock'), () => {
        showTab('settings');
        openBlock('lockBlock');
      }))
    );
    cards.appendChild(helpTile(ICON.backup, t('opt_help_card_9'), t('opt_help_9'), tileLink(t('opt_help_link_backup'), () => showTab('backup'))));

    const faq = [
      [t('opt_faq_q1'), [t('opt_faq_a1_1'), t('opt_faq_a1_2'), t('opt_faq_a1_3'), t('opt_faq_a1_4')]],
      [t('opt_faq_q2'), [t('opt_faq_a2_1'), t('opt_faq_a2_2'), t('opt_faq_a2_3')]],
      [t('opt_faq_q3'), [t('opt_faq_a3_1'), t('opt_faq_a3_2'), t('opt_faq_a3_3')]],
      [t('opt_faq_q4'), [t('opt_faq_a4_1'), t('opt_faq_a4_2'), t('opt_faq_a4_3')]],
      [t('opt_faq_q5'), [t('opt_faq_a5_1'), t('opt_faq_a5_2'), t('opt_faq_a5_3')]],
    ];
    const list = $('faqList');
    list.textContent = '';
    for (const [question, answers] of faq) {
      const item = el('details', 'faq-item');
      item.appendChild(el('summary', null, question));
      const ul = el('ul');
      for (const a of answers) ul.appendChild(el('li', null, a));
      item.appendChild(ul);
      list.appendChild(item);
    }
  }

  renderHelp();

  // ---- 分頁：網址後面的 #backup 之類會直接開到那一頁，小視窗的備份提醒就是這樣連過來的 ----

  const TABS = ['passwords', 'backup', 'settings', 'trash', 'help', 'versions', 'about'];

  function showTab(name) {
    if (!TABS.includes(name)) name = 'passwords';
    for (const tab of TABS) $('tab-' + tab).hidden = tab !== name;
    for (const b of document.querySelectorAll('.tab[data-tab]')) {
      b.classList.toggle('active', b.dataset.tab === name);
      if (b.dataset.tab === name) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    }
    if (location.hash !== '#' + name) history.replaceState(null, '', '#' + name);
  }

  for (const b of document.querySelectorAll('.tab[data-tab]')) b.addEventListener('click', () => showTab(b.dataset.tab));
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

  const RECENT_VERSIONS = 3;
  let showAllVersions = false;

  function currentVersion() {
    return (chrome.runtime.getManifest && chrome.runtime.getManifest().version) || '';
  }

  function renderVersions() {
    const current = currentVersion();
    $('versionNow').textContent = current ? t('opt_version_now', current) : '';
    $('headerVersion').textContent = current ? 'v' + current : '';
    renderVersionList();
  }

  function renderVersionList() {
    const current = currentVersion();
    const list = $('versionList');
    list.textContent = '';
    for (const v of showAllVersions ? CHANGELOG : CHANGELOG.slice(0, RECENT_VERSIONS)) {
      const isCurrent = v.version === current;
      const box = el('div', isCurrent ? 'ver current' : 'ver');
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
    const older = CHANGELOG.length - RECENT_VERSIONS;
    $('versionMore').hidden = older <= 0;
    $('versionMore').textContent = showAllVersions ? t('opt_versions_less') : tn('opt_versions_more', older);
  }

  $('versionMore').addEventListener('click', () => {
    showAllVersions = !showAllVersions;
    renderVersionList();
  });

  renderVersions();

  // ---- 檢查新版：背景程式到 GitHub 問，這裡只負責顯示和按鈕 ----


  // 標題旁邊寫的版本種類，channel 見 background/update.js 的 releaseChannel()
  function channelName(channel) {
    if (channel === 'store') return t('opt_update_channel_store');
    if (channel === 'github') return t('opt_update_channel_github');
    if (channel === 'firefox') return t('opt_update_channel_firefox');
    return t('opt_update_channel_dev');
  }

  function renderUpdate(info) {
    updateInfo = info;
    const state = $('updateState');
    const latest = info.latest;
    // 商店版由商店更新，不連 GitHub，檢查新版的東西都不顯示
    const store = info.channel === 'store';
    const firefox = info.channel === 'firefox';
    const available = !store && info.available;
    const failed = !store && !available && !!info.error;
    let kind = '';
    if (store) state.textContent = t('opt_update_store');
    else if (available) {
      kind = 'available';
      state.textContent = t('opt_update_available', latest.version, latest.publishedAt ? new Date(latest.publishedAt).toLocaleDateString(formatLang()) : '—');
    } else if (failed) {
      kind = 'failed';
      state.textContent = t('opt_update_failed', info.error);
    } else if (!info.checkedAt) {
      kind = 'never';
      state.textContent = t('opt_update_never');
    } else if (!latest) state.textContent = t('opt_update_no_release');
    else {
      kind = 'ok';
      state.textContent = t('opt_update_latest');
    }
    state.className = kind;
    // 狀態卡片：有新版是淡綠底，檢查失敗是淡紅底
    $('updateBox').className = 'update-box' + (available ? ' available' : failed ? ' failed' : '');
    $('updateCheckedAt').textContent = !store && info.checkedAt ? t('opt_update_checked_at', fmtDate(info.checkedAt)) : '';
    // 標題旁邊的字區塊收起來也看得到。有新版時換成綠色標籤
    const summary = $('updateSummary');
    summary.classList.toggle('available', available);
    summary.textContent = available ? t('opt_update_summary_available', latest.version) : t('opt_update_summary', channelName(info.channel), info.current);
    if (store) $('versionNow').textContent = t('opt_version_now_store', info.current);
    $('updateCheckNow').hidden = store;
    // 商店版不用自己重新載入，說明擴充功能管理頁在哪的那一行也收掉
    $('browserHint').hidden = store;
    $('updateGet').hidden = !available;
    $('updateSteps').hidden = !available || firefox;
    $('updateStepsFirefox').hidden = !available || !firefox;
    $('updateDownload').hidden = !(available && latest.zipUrl);
    $('updateExtensions').hidden = !available || !PK.platform.can('openExtensionsPage');
    $('updatePage').hidden = !(available && latest.pageUrl);
    // 只有正式版會每天自動檢查，其他版本不顯示勾選框。設定本身留著，換成正式版時照舊
    $('updateAutoWrap').hidden = !info.release;
    $('updateAuto').checked = info.auto && info.release;
    $('updateAuto').disabled = !info.release;
    $('updateDev').hidden = info.channel !== 'dev';
    $('updateFirefox').hidden = !firefox;
    $('headerUpdate').hidden = !available;
    if (available) $('headerUpdate').title = t('opt_header_update_title', latest.version);
    $('updateCurrent').textContent = 'v' + info.current;
    $('updateChannel').textContent = channelName(info.channel);
    renderAbout();
  }

  async function loadUpdate() {
    const res = await send({ type: 'update.status' });
    if (res.ok) renderUpdate(res.data);
  }

  $('updateCheckNow').addEventListener('click', async () => {
    const btn = $('updateCheckNow');
    btn.disabled = true;
    btn.textContent = t('opt_update_checking');
    const res = await send({ type: 'update.check' });
    btn.disabled = false;
    btn.textContent = t('opt_update_check_now');
    if (res.ok) renderUpdate(res.data);
    else toast(t('opt_update_failed', res.error));
  });

  $('updateAuto').addEventListener('change', async (e) => {
    const res = await send({ type: 'update.setAuto', enabled: e.target.checked });
    if (res.ok) renderUpdate(res.data);
    else {
      e.target.checked = !e.target.checked;
      toast(t('opt_setting_failed', res.error));
    }
  });

  $('updateDownload').addEventListener('click', async () => {
    const res = await send({ type: 'update.download' });
    toast(res.ok ? t('opt_update_download_started') : t('opt_update_download_failed', res.error));
  });

  // chrome:// 的頁面網頁連不過去，擴充功能可以用 tabs.create 開。Edge 會自己轉到 edge://extensions。
  $('updateExtensions').addEventListener('click', () => chrome.tabs.create({ url: 'chrome://extensions/?id=' + chrome.runtime.id }));
  $('updatePage').addEventListener('click', () => updateInfo && updateInfo.latest && chrome.tabs.create({ url: updateInfo.latest.pageUrl }));
  loadUpdate();

  // ---- 關於：版本、資料在哪、連結、權限、授權 ----

  // 要跟 background/update.js 的 UPDATE_REPO 一樣，tools/check.js 會比對
  const REPO_URL = 'https://github.com/Mukula1221/PasswordKeeperExtension';

  // 使用說明照介面語言挑：繁中、台語看 README，日文看日文版，其他看英文版
  function readmeUrl() {
    const locale = PK.i18n.uiLocale();
    if (locale === 'zh_TW' || locale === 'nan_TW') return REPO_URL + '#readme';
    return REPO_URL + '/blob/main/docs/README.' + (locale === 'ja' ? 'ja' : 'en') + '.md';
  }

  function outLink(a, url) {
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener';
    return a;
  }

  $('aboutSource').href = REPO_URL;
  $('aboutIssues').href = REPO_URL + '/issues';

  // 「你的資料」的一張卡片。kind 是 ok 或 warn，action 是 { text, url } 或 { text, onClick }
  function factTile({ icon, kind, label, value, lines, action }) {
    const tile = el('div', kind === 'warn' ? 'tile fact warn' : 'tile fact');
    tile.appendChild(iconBox(icon, kind ? 'tile-icon ' + kind : 'tile-icon'));
    tile.appendChild(el('div', 'fact-label', label));
    tile.appendChild(el('div', 'fact-value', value));
    for (const line of lines) tile.appendChild(el('div', 'fact-desc', line));
    if (action) {
      const foot = el('div', 'tile-foot');
      if (action.url) foot.appendChild(outLink(el('a', null, action.text + ' →'), action.url));
      else foot.appendChild(linkButton(action.text + ' →', action.onClick));
      tile.appendChild(foot);
    }
    return tile;
  }

  function renderAboutFacts() {
    const box = $('aboutFacts');
    box.textContent = '';
    box.appendChild(
      factTile({
        icon: ICON.computer,
        label: t('opt_about_where_label'),
        value: t('opt_about_where_value'),
        lines: [t('opt_about_where_counts', entries.length, trash.length), t('opt_about_where_desc')],
      })
    );

    const mode = lockSt ? lockSt.mode : '';
    const name = pkWebAuthn.label();
    const lockLine = {
      hello: () => t('opt_about_lock_hello', name),
      password: () => t('opt_about_lock_password'),
      screen: () => t('opt_about_lock_screen'),
      off: () => t('opt_about_lock_off'),
    }[mode];
    box.appendChild(
      factTile({
        icon: isEncryptedLock(mode) ? ICON.shieldOk : ICON.shield,
        kind: isEncryptedLock(mode) ? 'ok' : mode ? 'warn' : '',
        label: t('opt_lock_mode_title'),
        value: mode ? lockModeName(mode, name) : '…',
        lines: lockLine ? [lockLine()] : [],
        action: {
          text: t('opt_about_lock_action'),
          onClick: () => {
            showTab('settings');
            openBlock('lockBlock');
          },
        },
      })
    );

    // GitHub 檢查新版：商店版不連，正式版看「每天自動檢查」有沒有開，其他版本按了才連
    const info = updateInfo;
    const store = !!info && info.channel === 'store';
    let github = t('opt_about_net_github_manual');
    if (store) github = t('opt_about_net_github_store');
    else if (info && info.release && info.auto) github = t('opt_about_net_github_auto');
    box.appendChild(
      factTile({
        icon: ICON.globe,
        label: t('opt_about_net_label'),
        value: store ? t('opt_about_net_hibp_only') : t('opt_about_net_both'),
        lines: [github, t('opt_about_net_hibp')],
        action: { text: t('opt_about_privacy'), url: REPO_URL + '/blob/main/PRIVACY.md' },
      })
    );
  }

  function renderAboutLinks() {
    const box = $('aboutLinks');
    if (box.childElementCount) return;
    const links = [
      [ICON.code, t('opt_about_link_source'), REPO_URL.replace('https://', ''), REPO_URL],
      [ICON.chat, t('opt_about_issue'), t('opt_about_link_issues_desc'), REPO_URL + '/issues'],
      [ICON.download, t('opt_about_link_releases'), t('opt_about_link_releases_desc'), REPO_URL + '/releases'],
      [ICON.shield, t('opt_about_link_privacy'), t('opt_about_link_privacy_desc'), REPO_URL + '/blob/main/PRIVACY.md'],
      [ICON.warning, t('opt_about_link_security'), t('opt_about_link_security_desc'), REPO_URL + '/blob/main/SECURITY.md'],
      [ICON.doc, t('opt_about_link_readme'), t('opt_about_link_readme_desc'), readmeUrl()],
    ];
    for (const [icon, title, desc, url] of links) {
      const a = outLink(el('a', 'link-card'), url);
      a.appendChild(iconBox(icon));
      const texts = el('span', 'texts');
      texts.appendChild(el('span', 'title', title));
      texts.appendChild(el('span', 'desc', desc));
      a.appendChild(texts);
      a.appendChild(svgIcon(ICON.external, 'ext'));
      box.appendChild(a);
    }
  }

  // 權限：manifest 裡有的才列，選用的權限問瀏覽器現在有沒有給
  const PERMISSIONS = [
    { codes: ['http://*/*', 'https://*/*'], host: true, name: () => t('opt_perm_hosts'), why: () => t('opt_perm_hosts_why') },
    { codes: ['storage'], name: () => t('opt_perm_storage'), why: () => t('opt_perm_storage_why') },
    { codes: ['activeTab'], name: () => t('opt_perm_active_tab'), why: () => t('opt_perm_active_tab_why') },
    { codes: ['downloads'], name: () => t('opt_perm_downloads'), why: () => t('opt_perm_downloads_why') },
    { codes: ['alarms'], name: () => t('opt_perm_alarms'), why: () => t('opt_perm_alarms_why') },
    { codes: ['idle'], name: () => t('opt_perm_idle'), why: () => t('opt_perm_idle_why') },
    { codes: ['webRequest', 'webRequestAuthProvider'], name: () => t('opt_perm_web_request'), why: () => t('opt_perm_web_request_why') },
    { codes: ['clipboardRead', 'clipboardWrite'], name: () => t('opt_perm_clipboard'), why: () => t('opt_perm_clipboard_why') },
    { codes: ['offscreen'], name: () => t('opt_perm_offscreen'), why: () => t('opt_perm_offscreen_why') },
  ];

  async function permissionState(perm, manifest) {
    const required = manifest.permissions || [];
    const optional = manifest.optional_permissions || [];
    if (perm.host) return (manifest.host_permissions || []).length ? 'always' : null;
    const codes = perm.codes.filter((c) => required.includes(c) || optional.includes(c));
    if (!codes.length) return null;
    if (codes.every((c) => required.includes(c))) return 'always';
    try {
      return (await chrome.permissions.contains({ permissions: codes })) ? 'granted' : 'unused';
    } catch {
      // 瀏覽器不認得這個權限（例如 Firefox 的 offscreen），就是沒用到
      return 'unused';
    }
  }

  async function renderAboutPerms() {
    const manifest = chrome.runtime.getManifest();
    const states = await Promise.all(PERMISSIONS.map((perm) => permissionState(perm, manifest)));
    const box = $('aboutPerms');
    box.textContent = '';
    const STATE = {
      always: ['tag', () => t('opt_perm_always')],
      granted: ['tag ok', () => t('opt_perm_granted')],
      unused: ['tag plain', () => t('opt_perm_unused')],
    };
    PERMISSIONS.forEach((perm, i) => {
      const state = states[i];
      if (!state) return;
      const row = el('div', 'perm-row');
      const name = el('span');
      name.appendChild(el('span', 'name', perm.name()));
      name.appendChild(el('code', null, perm.codes.join(', ')));
      row.appendChild(name);
      row.appendChild(el('span', 'why', perm.why()));
      row.appendChild(el('span', STATE[state][0], STATE[state][1]()));
      box.appendChild(row);
    });
  }

  function renderAboutCredits() {
    const box = $('aboutCredits');
    if (box.childElementCount) return;
    const credits = [
      [t('opt_about_mit'), REPO_URL + '/blob/main/LICENSE', 'Copyright (c) 2026 PasswordKeeperExtension contributors'],
      ['EFF Large Wordlist', 'https://www.eff.org/dice', t('opt_about_credit_eff')],
      ['Pwned Passwords', 'https://haveibeenpwned.com/Passwords', t('opt_about_credit_hibp')],
    ];
    for (const [name, url, desc] of credits) {
      const line = el('div', 'credit');
      line.appendChild(outLink(el('a', null, name), url));
      line.appendChild(el('span', 'muted', desc));
      box.appendChild(line);
    }
  }

  function renderAbout() {
    const badges = $('aboutBadges');
    badges.textContent = '';
    const version = currentVersion();
    if (version) badges.appendChild(el('span', null, 'v' + version));
    if (updateInfo) badges.appendChild(el('span', null, channelName(updateInfo.channel)));
    if (updateInfo && updateInfo.channel !== 'store' && updateInfo.available) badges.appendChild(el('span', null, t('opt_update_summary_available', updateInfo.latest.version)));
    badges.appendChild(el('span', null, t('opt_about_mit')));
    renderAboutFacts();
    renderAboutLinks();
    renderAboutCredits();
  }

  renderAboutPerms();
  // 在設定分頁打開剪貼簿清除，或在瀏覽器的擴充功能頁收回權限，不用重新整理就會更新
  chrome.permissions.onAdded.addListener(renderAboutPerms);
  chrome.permissions.onRemoved.addListener(renderAboutPerms);

  // ---- 左側欄最下面的語言、色系選單 ----

  // 每個選單的關閉函式，打開一個選單前先關掉別的
  const menuClosers = [];

  function closeMenus() {
    for (const close of menuClosers) close(false);
  }

  // 按鈕按了打開選單。上下鍵、Home、End 移動，Enter 或空白鍵選，Esc 關掉並回到按鈕，點選單外面也會關。
  // refresh 在打開前叫，選單上打勾的項目才會是最新的。
  function setupMenu(button, menu, refresh, onPick) {
    const items = () => [...menu.querySelectorAll('[role="menuitemradio"]')];
    // 選單是 position: fixed，放在按鈕右邊；左側欄變成最上面一排時，放在按鈕下面
    function place() {
      const r = button.getBoundingClientRect();
      const gap = 8;
      if (matchMedia('(max-width: 640px)').matches) {
        menu.style.left = Math.max(gap, Math.min(r.left, innerWidth - menu.offsetWidth - gap)) + 'px';
        menu.style.top = r.bottom + 6 + 'px';
      } else {
        menu.style.left = r.right + gap + 'px';
        menu.style.top = Math.max(gap, Math.min(r.top, innerHeight - menu.offsetHeight - gap)) + 'px';
      }
    }
    function close(focusButton) {
      if (menu.hidden) return;
      menu.hidden = true;
      button.setAttribute('aria-expanded', 'false');
      if (focusButton) button.focus();
    }
    function open() {
      closeMenus();
      refresh();
      menu.hidden = false;
      button.setAttribute('aria-expanded', 'true');
      place();
      (items().find((x) => x.getAttribute('aria-checked') === 'true') || items()[0]).focus();
    }
    button.addEventListener('click', () => (menu.hidden ? open() : close(true)));
    menu.addEventListener('keydown', (e) => {
      const list = items();
      const i = list.indexOf(document.activeElement);
      const go = (n) => {
        e.preventDefault();
        list[(n + list.length) % list.length].focus();
      };
      if (e.key === 'ArrowDown') go(i + 1);
      else if (e.key === 'ArrowUp') go(i - 1);
      else if (e.key === 'Home') go(0);
      else if (e.key === 'End') go(list.length - 1);
      else if (e.key === 'Escape') {
        e.preventDefault();
        close(true);
      } else if (e.key === 'Tab') close(false);
    });
    for (const item of items()) {
      item.addEventListener('click', () => {
        close(true);
        onPick(item);
      });
    }
    menuClosers.push(close);
  }

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.rail-menu')) closeMenus();
  });
  window.addEventListener('resize', closeMenus);

  function markChecked(menu, attr, value) {
    for (const item of menu.querySelectorAll('[role="menuitemradio"]')) item.setAttribute('aria-checked', String(item.getAttribute(attr) === value));
  }

  // 介面語言。auto 是跟著瀏覽器，旁邊寫出瀏覽器挑的是哪一種
  let languageNow = 'auto';

  async function renderLanguagePicker() {
    const res = await send({ type: 'language.get' });
    if (!res.ok) {
      toast(t('opt_lang_failed', res.error));
      return;
    }
    const names = {
      zh_TW: t('lang_name_zh_TW'),
      nan_TW: t('lang_name_nan_TW'),
      en: t('lang_name_en'),
      ja: t('lang_name_ja'),
      ko: t('lang_name_ko'),
      de: t('lang_name_de'),
      ru: t('lang_name_ru'),
      th: t('lang_name_th'),
    };
    $('langAuto').textContent = t('opt_lang_auto', names[res.data.browserLocale] || names.en);
    languageNow = res.data.language;
    markChecked($('langMenu'), 'data-lang', languageNow);
  }

  // 選了就存起來，這一頁重新整理成新的語言。小視窗、解鎖視窗下次打開就是新語言，開著的網頁會收到變更自己換
  setupMenu(
    $('langButton'),
    $('langMenu'),
    () => markChecked($('langMenu'), 'data-lang', languageNow),
    async (item) => {
      const language = item.dataset.lang;
      if (language === languageNow) return;
      const res = await send({ type: 'language.set', language });
      if (!res.ok) {
        toast(t('opt_lang_failed', res.error));
        await renderLanguagePicker();
        return;
      }
      rememberLocale(language === 'auto' ? null : language);
      location.reload();
    }
  );

  renderLanguagePicker();

  // 色系。選了先換這一頁，再請背景程式存起來；開著的小視窗、網頁上的提示收到 storage 的變更自己換
  const renderThemePicker = () => markChecked($('themeMenu'), 'data-theme-choice', PK.theme.currentChoice());

  setupMenu($('themeButton'), $('themeMenu'), renderThemePicker, async (item) => {
    const choice = item.dataset.themeChoice;
    const before = PK.theme.currentChoice();
    if (choice === before) return;
    PK.theme.useTheme(choice);
    renderThemePicker();
    const res = await send({ type: 'theme.set', theme: choice });
    if (!res.ok) {
      PK.theme.useTheme(before);
      renderThemePicker();
      toast(t('opt_theme_failed', res.error));
    }
  });

  renderThemePicker();

  load();

  // e2e 會叫這幾個
  PK.options = {
    askChoice,
    askPassword,
    changeLockMode,
    fmtDate,
    openDialog,
    openRuleDialog,
    renderBackup,
    renderClickRules,
    renderLock,
    showTab,
    // 右邊顯示這一筆，窄的視窗會整頁換成詳細資料
    showEntry(id) {
      currentId = id;
      showDetail = true;
      renderList();
    },
    // 目前列出的帳號，e2e 拿第一筆開編輯對話框
    get entries() {
      return entries;
    },
  };
})();
