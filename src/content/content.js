'use strict';
// 注入到每個網頁的腳本。做這幾件事：
// 1. 找出登入欄位（帳號、密碼）
// 2. 使用者按登入時把帳密交給背景程式暫存，跳頁後再問要不要儲存
// 3. 頁面一載入就把存過的帳密填進去
// 4. 點帳號或密碼欄時跳出帳號清單讓使用者選（可以用鍵盤操作）
// 5. 設新密碼的表單裡提供「產生強密碼」
// 6. 讓使用者選一顆按鈕，之後開到那一頁就自動點（自動點選）
// 所有畫面都畫在 shadow DOM 裡，網頁本身的 CSS 和 JS 碰不到（見 ui.js）。找欄位在 fields.js，自動點選找按鈕在 click-target.js。
(() => {
  const PK = (globalThis.PK ??= {});
  // 同一個環境載入第二次時不要重複掛事件
  if (PK.contentLoaded) return;
  PK.contentLoaded = true;
  const { browserLocale, chosenLocale, t, uiLocale, useLocale } = PK.i18n;
  const { baseDomain, rulePathMatches } = PK.domain;
  const { el, refreshShadowStyle, toast, ui } = PK.contentUi;
  const { attrText, canFill, detectGroups, isTextInput, isUsable, isVisible, setValue, usableInputs } = PK.contentFields;
  const { CLICKABLE, clickableOf, elementText, findClickTarget, fireClick, selectorFor } = PK.clickTarget;

  const HOST = location.hostname.toLowerCase();
  const ORIGIN = location.origin;
  if (!HOST || !/^https?:$/.test(location.protocol)) return;

  const TAG = '[密碼小管家]'; // i18n-ignore：console 訊息的前綴，給開發者看的
  const IS_TOP = window.top === window;

  // 擴充功能重新載入或更新後，舊頁面裡的這支腳本再叫 chrome.i18n 會丟例外，但網頁上的卡片、清單和計時器還在跑，所以文字先取好放著。
  // 管理頁換了語言時，loadChosenLanguage() 會用新的語言重取一次。
  // 要放網頁文字或錯誤訊息的，先把 $1 原樣留著，顯示時再用 formatText() 換成實際的值。
  function buildText() {
    return {
      errExtReloaded: t('cs_err_ext_reloaded'),
      errNoResponse: t('cs_err_no_response'),
      extName: t('ext_name'),
      save: t('cs_save'),
      cancel: t('cs_cancel'),

      bannerSaveTitle: t('cs_banner_save_title'),
      bannerUpdateTitle: t('cs_banner_update_title'),
      bannerUsername: t('cs_banner_username'),
      bannerPassword: t('cs_banner_password'),
      bannerShow: t('cs_banner_show'),
      bannerHide: t('cs_banner_hide'),
      bannerNever: t('cs_banner_never'),
      bannerNo: t('cs_banner_no'),
      bannerUpdate: t('cs_banner_update'),
      bannerNeverDone: t('cs_banner_never_done', '$1'),
      saveFailed: t('cs_save_failed', '$1'),
      passwordUpdated: t('cs_password_updated'),
      passwordSaved: t('cs_password_saved'),

      generateFailed: t('cs_generate_failed', '$1'),
      generateNoField: t('cs_generate_no_field'),
      generateFilledCopied: t('cs_generate_filled_copied'),
      generateFilled: t('cs_generate_filled'),

      dropdownLocked: t('cs_dropdown_locked'),
      dropdownChooseAccount: t('cs_dropdown_choose_account', t('ext_name')),
      dropdownGenerate: t('cs_dropdown_generate'),
      dropdownGenerateHint: t('cs_dropdown_generate_hint'),
      dropdownNoUsername: t('cs_dropdown_no_username'),

      clickCooldown: t('cs_click_cooldown'),
      clickAfterLogout: t('cs_click_after_logout'),
      clickMissedStop: t('cs_click_missed_stop', '$1'),
      clickButtonFallback: t('cs_click_button_fallback'),
      clickDone: t('cs_click_done', '$1'),
      clickNotFound: t('cs_click_not_found'),
      clickEmptyField: t('cs_click_empty_field'),

      pickHint: t('cs_pick_hint'),
      pickUntrustedFrame: t('cs_pick_untrusted_frame'),
      pickCardFailed: t('cs_pick_card_failed', '$1'),
      pickTitle: t('cs_pick_title'),
      pickButton: t('cs_pick_button'),
      pickNoText: t('cs_pick_no_text'),
      pickWhen: t('cs_pick_when'),
      pickNoteNoAccount: t('cs_pick_note_no_account'),
      pickNoteAutofillOff: t('cs_pick_note_autofill_off'),
      pickAfterFill: t('cs_pick_after_fill'),
      pickOnLoad: t('cs_pick_on_load'),
      pickSaved: t('cs_pick_saved'),

      fillNoFields: t('cs_fill_no_fields'),
      fillFailed: t('cs_fill_failed'),
    };
  }

  let TEXT = buildText();

  // 用函式當替換值，網頁文字裡有 $& 這種寫法時才不會被當成特殊符號
  function formatText(template, value) {
    return template.replace(/\$1/g, () => value);
  }

  // ---- 跟背景程式溝通 ----

  function send(msg) {
    return new Promise((resolve) => {
      // 擴充功能重新載入後，舊頁面裡的這支腳本就變孤兒，chrome.runtime.id 會是 undefined，叫了會丟例外。
      let alive = false;
      try {
        alive = !!(chrome.runtime && chrome.runtime.id);
      } catch {
        alive = false;
      }
      if (!alive) return resolve({ ok: false, error: TEXT.errExtReloaded });
      try {
        chrome.runtime.sendMessage(msg, (res) => {
          if (chrome.runtime.lastError) return resolve({ ok: false, error: chrome.runtime.lastError.message });
          resolve(res || { ok: false, error: TEXT.errNoResponse });
        });
      } catch (err) {
        resolve({ ok: false, error: String(err) });
      }
    });
  }

  // ---- 管理頁指定的介面語言 ----

  // 指定了跟瀏覽器不一樣的語言時，跟背景程式拿那個語言的翻譯，再重取文字、換字型。
  // 已經畫在網頁上的卡片不會重畫，下一次出現的就是新語言。
  async function loadChosenLanguage() {
    const locale = await chosenLocale();
    if (!locale || locale === browserLocale()) {
      useLocale(null);
    } else {
      const res = await send({ type: 'i18n.current' });
      if (!res.ok) throw new Error(res.error);
      useLocale(res.data.locale, res.data.messages);
    }
    TEXT = buildText();
    refreshShadowStyle();
  }

  // 拿不到就先照瀏覽器的語言，畫面還是看得懂
  const followChosenLanguage = () =>
    loadChosenLanguage().catch((err) => console.warn(TAG, '讀不到指定的語言，先照瀏覽器的語言', err)); // i18n-ignore：給開發者看的

  followChosenLanguage();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.uiLanguage) followChosenLanguage();
  });

  // 內嵌在別人網站裡的 iframe 不自動填，避免惡意網頁偷偷把登入頁框進來騙密碼。
  // 同一個網站自己的 iframe 可以填。
  function frameIsTrusted() {
    if (IS_TOP) return true;
    const ancestors = location.ancestorOrigins;
    if (!ancestors || ancestors.length === 0) return false;
    const mine = baseDomain(HOST);
    for (let i = 0; i < ancestors.length; i++) {
      let h;
      try {
        h = new URL(ancestors[i]).hostname.toLowerCase();
      } catch {
        return false;
      }
      if (baseDomain(h) !== mine) return false;
    }
    return true;
  }
  const TRUSTED = frameIsTrusted();

  // ---- 填值 ----

  function fillGroup(group, entry, force) {
    let did = false;
    if (group.user && entry.username && canFill(group.user, force)) {
      setValue(group.user, entry.username);
      did = true;
    }
    if (group.pass && entry.password && canFill(group.pass, force)) {
      setValue(group.pass, entry.password);
      did = true;
    }
    if (did && entry.id) send({ type: 'entries.touch', id: entry.id });
    return did;
  }

  // ---- 讀取這個網站的帳號（短暫快取，避免每次 focus 都去問背景程式）----

  let cache = null;
  async function getEntries(fresh) {
    if (!fresh && cache && Date.now() - cache.at < 5000) return cache;
    const res = await send({ type: 'entries.forHost', host: HOST });
    if (!res.ok) {
      console.warn(TAG, res.error);
      return { entries: [], autoFillEntry: null, autoFill: false, autoSubmit: false, locked: false };
    }
    // res.data：entries、autoFillEntry、autoFill、autoSubmit、locked
    cache = { at: Date.now(), ...res.data };
    return cache;
  }

  // ---- 「要儲存嗎？」卡片 ----

  let bannerEl = null;
  let bannerTimer = null;

  function closeBanner() {
    if (bannerEl) bannerEl.remove();
    bannerEl = null;
    clearTimeout(bannerTimer);
    clearPickBox();
  }

  function showSaveBanner({ pending, mode, existingId, existingUsername }) {
    const root = ui();
    closeBanner();
    const box = el('div', 'banner');
    const h2 = el('h2');
    h2.appendChild(el('span', 'logo'));
    h2.appendChild(el('span', null, mode === 'update' ? TEXT.bannerUpdateTitle : TEXT.bannerSaveTitle));
    box.appendChild(h2);
    box.appendChild(el('div', 'site', pending.host));

    box.appendChild(el('label', null, TEXT.bannerUsername));
    const userInput = el('input');
    userInput.type = 'text';
    // 改密碼表單沒有帳號欄時，pending.username 是空的，就顯示背景程式對到的那個帳號
    userInput.value = pending.username || existingUsername || '';
    box.appendChild(userInput);

    box.appendChild(el('label', null, TEXT.bannerPassword));
    const wrap = el('div', 'pwwrap');
    const pwInput = el('input');
    pwInput.type = 'password';
    pwInput.value = pending.password || '';
    const eye = el('button', null, TEXT.bannerShow);
    eye.type = 'button';
    eye.addEventListener('click', () => {
      const show = pwInput.type === 'password';
      pwInput.type = show ? 'text' : 'password';
      eye.textContent = show ? TEXT.bannerHide : TEXT.bannerShow;
    });
    wrap.appendChild(pwInput);
    wrap.appendChild(eye);
    box.appendChild(wrap);

    const row = el('div', 'row');
    const never = el('button', 'link', TEXT.bannerNever);
    const no = el('button', null, TEXT.bannerNo);
    const yes = el('button', 'primary', mode === 'update' ? TEXT.bannerUpdate : TEXT.save);
    row.appendChild(never);
    row.appendChild(no);
    row.appendChild(yes);
    box.appendChild(row);

    never.addEventListener('click', async () => {
      await send({ type: 'neverSave.add', host: pending.host });
      await send({ type: 'pending.clear' });
      closeBanner();
      toast(formatText(TEXT.bannerNeverDone, pending.host));
    });
    no.addEventListener('click', async () => {
      await send({ type: 'pending.clear' });
      closeBanner();
    });
    yes.addEventListener('click', async () => {
      const username = userInput.value.trim();
      // 使用者在卡片上把帳號改掉了，那就是另一個帳號，要新增而不是蓋掉舊的
      const id = mode === 'update' && username === (existingUsername || '') ? existingId : undefined;
      yes.disabled = true;
      const res = await send({
        type: 'entries.save',
        id,
        entry: { host: pending.host, origin: pending.origin, username, password: pwInput.value },
      });
      if (!res.ok) {
        yes.disabled = false;
        toast(formatText(TEXT.saveFailed, res.error));
        return;
      }
      await send({ type: 'pending.clear' });
      cache = null;
      closeBanner();
      toast(res.data.action === 'updated' ? TEXT.passwordUpdated : TEXT.passwordSaved);
    });

    root.appendChild(box);
    bannerEl = box;
    // 跟背景程式的 PENDING_TTL_MS 一樣長，卡片消失時暫存的帳密也剛好過期
    bannerTimer = setTimeout(closeBanner, 2 * 60 * 1000);
  }

  async function askToSave() {
    const res = await send({ type: 'pending.get' });
    if (!res.ok || !res.data || !res.data.pending) return;
    const p = res.data.pending;
    // 送出後又回到同一頁、登入表單還在，多半是密碼打錯被退回來，先不問。暫存的帳密留著，改對之後跳到別頁才問。
    // 副作用：登入成功後仍停在同一頁、登入框也還留著的網站會變成不問，那種網站要用小視窗手動新增。
    const samePage = p.submitUrl && p.submitUrl === location.origin + location.pathname;
    if (samePage && detectGroups().some((g) => g.kind === 'login')) return;
    showSaveBanner(res.data);
  }

  // ---- 帳號清單（點欄位時跳出）----

  let dropdown = null;

  function closeDropdown() {
    if (dropdown) {
      dropdown.el.remove();
      dropdown = null;
    }
  }

  // 有兩個以上密碼欄、或網站標了 autocomplete="new-password" 的，就是在設新密碼，清單裡要給「產生強密碼」
  function isNewPasswordGroup(g) {
    return g.kind === 'signup' || g.passList.some((p) => p.getAttribute('autocomplete') === 'new-password');
  }

  // 把產生的密碼填進「新密碼」和「確認密碼」欄。改密碼表單的「目前密碼」欄不能動。
  function fillGenerated(group, password) {
    let targets = group.passList.filter((p) => p.getAttribute('autocomplete') === 'new-password');
    // 沒標 autocomplete 的話：三欄以上是「目前、新、確認」，取最後兩欄；兩欄以下全填
    if (!targets.length) targets = group.passList.length >= 3 ? group.passList.slice(-2) : group.passList;
    if (!targets.length) return false;
    for (const p of targets) setValue(p, password);
    return true;
  }

  async function generateInto(group) {
    const res = await send({ type: 'password.generate' });
    if (!res.ok) {
      toast(formatText(TEXT.generateFailed, res.error));
      return;
    }
    if (!fillGenerated(group, res.data.password)) {
      toast(TEXT.generateNoField);
      return;
    }
    // 順便複製一份，表單填不進去時還可以貼
    let copied = false;
    try {
      await navigator.clipboard.writeText(res.data.password);
      copied = true;
    } catch {
      copied = false;
    }
    toast(copied ? TEXT.generateFilledCopied : TEXT.generateFilled);
  }

  function setHighlight(index) {
    if (!dropdown || !dropdown.items.length) return;
    const n = dropdown.items.length;
    dropdown.index = ((index % n) + n) % n;
    dropdown.items.forEach((it, i) => it.classList.toggle('active', i === dropdown.index));
  }

  function activateHighlighted() {
    if (!dropdown || dropdown.index < 0) return false;
    dropdown.items[dropdown.index].click();
    return true;
  }

  function placeDropdown(dd, anchor) {
    const root = ui();
    const r = anchor.getBoundingClientRect();
    dd.style.left = Math.max(0, r.left) + 'px';
    dd.style.top = r.bottom + 2 + 'px';
    dd.style.minWidth = Math.max(220, r.width) + 'px';
    root.appendChild(dd);
    // 下面放不下就往上開
    const h = dd.offsetHeight;
    if (r.bottom + 2 + h > window.innerHeight && r.top - h - 2 > 0) dd.style.top = r.top - h - 2 + 'px';
  }

  function showLockedHint(anchor) {
    closeDropdown();
    const dd = el('div', 'dropdown');
    dd.appendChild(el('div', 'head', TEXT.extName));
    dd.appendChild(el('div', 'item locked', TEXT.dropdownLocked));
    placeDropdown(dd, anchor);
    dropdown = { el: dd, anchor, items: [], index: -1 };
  }

  function showDropdown(anchor, group, entries) {
    closeDropdown();
    const newPassword = isNewPasswordGroup(group);
    const dd = el('div', 'dropdown');
    dd.appendChild(el('div', 'head', newPassword ? TEXT.extName : TEXT.dropdownChooseAccount));
    const items = [];
    const addItem = (item, onPick) => {
      // mousedown 先擋掉，欄位才不會失去焦點
      item.addEventListener('mousedown', (e) => e.preventDefault());
      item.addEventListener('mouseenter', () => setHighlight(items.indexOf(item)));
      item.addEventListener('click', () => {
        closeDropdown();
        onPick();
      });
      items.push(item);
      dd.appendChild(item);
    };
    if (newPassword) {
      const gen = el('div', 'item gen');
      gen.appendChild(el('div', 'u', TEXT.dropdownGenerate));
      gen.appendChild(el('div', 'h', TEXT.dropdownGenerateHint));
      addItem(gen, () => generateInto(group));
    } else {
      for (const entry of entries.slice(0, 8)) {
        const item = el('div', 'item');
        item.appendChild(el('div', 'u', entry.username || TEXT.dropdownNoUsername));
        addItem(item, () => fillGroup(group, entry, true));
      }
    }
    if (!items.length) return;
    placeDropdown(dd, anchor);
    dropdown = { el: dd, anchor, items, index: -1 };
  }

  async function onFieldFocus(field, group) {
    const newPassword = isNewPasswordGroup(group);
    const { entries, locked } = await getEntries();
    if (document.activeElement !== field) return;
    if (locked) {
      showLockedHint(field);
      return;
    }
    if (!newPassword && !entries.length) return;
    showDropdown(field, group, entries);
  }

  document.addEventListener(
    'mousedown',
    (e) => {
      if (!dropdown) return;
      if (e.target === PK.contentUi.host() || e.target === dropdown.anchor) return;
      closeDropdown();
    },
    true
  );
  window.addEventListener('scroll', closeDropdown, { capture: true, passive: true });
  window.addEventListener('resize', closeDropdown);

  // ---- 攔截登入動作 ----

  let groups = [];
  let lastSent = { key: '', at: 0 };
  let watchTimer = null;

  function groupContaining(node) {
    if (!(node instanceof Node)) return null;
    return groups.find((g) => g.container === node || g.container.contains(node)) || null;
  }

  function readPassword(g) {
    if (g.passList.length >= 2) {
      // 註冊或改密碼表單：最後兩欄一樣就是新密碼，不然取第一欄
      const values = g.passList.map((p) => p.value);
      const [a, b] = values.slice(-2);
      return a && a === b ? a : values[0];
    }
    return g.pass ? g.pass.value : '';
  }

  function capture(g) {
    if (!g) return;
    const username = g.user ? g.user.value.trim() : '';
    const password = readPassword(g);
    if (!password && !(g.kind === 'useronly' && username)) return;
    const key = username + '\u0000' + password;
    if (lastSent.key === key && Date.now() - lastSent.at < 1500) return;
    lastSent = { key, at: Date.now() };
    send({
      type: 'pending.set',
      host: HOST,
      origin: ORIGIN,
      username,
      password: password || null,
      submitUrl: location.origin + location.pathname,
    }).then((res) => {
      if (!res.ok) {
        console.warn(TAG, res.error);
        return;
      }
      if (password) watchForLoginResult(g);
    });
  }

  // 登入可能會跳頁，也可能是 SPA 原地換畫面。跳頁的話新頁面載入時會去問背景程式；
  // 沒跳頁就在這裡盯著：網址變了或密碼欄消失，就當作登入成功，跳儲存提示。
  function watchForLoginResult(g) {
    const startUrl = location.href;
    const startedAt = Date.now();
    clearInterval(watchTimer);
    watchTimer = setInterval(() => {
      const gone = !g.pass || !isUsable(g.pass);
      const moved = location.href !== startUrl;
      if (gone || moved) {
        clearInterval(watchTimer);
        if (IS_TOP) askToSave();
        else window.top.postMessage({ __pk: 'captured' }, '*');
        return;
      }
      if (Date.now() - startedAt > 10000) clearInterval(watchTimer);
    }, 500);
  }

  document.addEventListener(
    'submit',
    (e) => {
      capture(groupContaining(e.target) || groups.find((g) => readPassword(g)));
    },
    true
  );

  document.addEventListener(
    'click',
    (e) => {
      const target = e.target instanceof Element ? e.target : null;
      if (!target) return;
      const btn = target.closest('button, input[type=submit], input[type=button], input[type=image], [role=button], a');
      if (!btn) return;
      // 等網頁自己的 click handler 跑完再讀值，有些網站會在 click 時才把值組好
      setTimeout(() => capture(groupContaining(btn) || groups.find((g) => readPassword(g))), 0);
    },
    true
  );

  function groupForField(node) {
    return groups.find((x) => x.user === node || x.pass === node || x.passList.includes(node)) || null;
  }

  // 清單打開時：上下鍵選、Enter 填、Esc 關。沒打開時在欄位按下鍵會打開。
  // 用 capture 搶在網頁前面處理，不然 Enter 會先把表單送出去。
  document.addEventListener(
    'keydown',
    (e) => {
      if (dropdown) {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          setHighlight(dropdown.index + (e.key === 'ArrowDown' ? 1 : -1));
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        if (e.key === 'Enter' && dropdown.index >= 0) {
          activateHighlighted();
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        if (e.key === 'Escape') {
          closeDropdown();
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        if (e.key === 'Tab') closeDropdown();
      } else if (e.key === 'ArrowDown') {
        const g = groupForField(e.target);
        if (g) {
          onFieldFocus(e.target, g);
          e.preventDefault();
          return;
        }
      }
      if (e.key === 'Enter') {
        const g = groupForField(e.target);
        if (g) capture(g);
      }
    },
    true
  );

  // 同網站 iframe 裡登入後，由最上層頁面來顯示儲存提示（iframe 太小會被裁掉）
  if (IS_TOP) {
    window.addEventListener('message', (e) => {
      if (e.data && e.data.__pk === 'captured') setTimeout(askToSave, 800);
    });
  }

  // ---- 掃描頁面、掛事件、自動填入 ----

  const handled = new WeakSet();

  function attachHandlers(field, group) {
    handled.add(field);
    field.addEventListener('focus', () => onFieldFocus(field, group));
    field.addEventListener('click', () => {
      if (!dropdown) onFieldFocus(field, group);
    });
    field.addEventListener('blur', () => setTimeout(() => {
      if (dropdown && dropdown.anchor === field && PK.contentUi.root() && !PK.contentUi.root().activeElement) closeDropdown();
    }, 150));
  }

  async function scan() {
    // SPA 換頁不會重新載入這支腳本，要自己發現網址變了
    if (currentRoute() !== lastRoute) {
      lastRoute = currentRoute();
      clickRulesPromise = null;
      anyAutoClick = false;
      clickStopOrder = Infinity;
      armPageClicks().catch((err) => console.warn(TAG, err));
    }
    groups = detectGroups();
    const fresh = [];
    for (const g of groups) {
      // 確認密碼欄也要掛，點它才會跳「產生強密碼」
      const newFields = [g.user, ...g.passList].filter((f) => f && !handled.has(f));
      if (!newFields.length) continue;
      for (const f of newFields) attachHandlers(f, g);
      fresh.push(g);
    }
    if (fresh.length) await autofill(fresh);
  }

  let autoSubmitted = false;

  async function autofill(targets) {
    const { autoFillEntry, autoFill, autoSubmit, locked } = await getEntries();
    if (locked || !autoFillEntry || !autoFill || !TRUSTED) return;
    const pageRules = (await getClickRules()).filter((r) => rulePathMatches(r.path, location.href));
    for (const g of targets) {
      if (g.kind === 'signup') continue;
      // 只有帳號欄的頁面，要網站明確標了 autocomplete="username" 才自動填，不然電子報的 email 欄也會被填
      if (g.kind === 'useronly' && !g.strong) continue;
      fillGroup(g, autoFillEntry, false);
      const keyField = g.pass || g.user;
      const wanted = g.pass ? autoFillEntry.password : autoFillEntry.username;
      if (!keyField || keyField.value !== wanted) continue;
      // 使用者選過這一頁要點哪顆按鈕，就點那顆，不用猜。「頁面一打開就點」的規則自己會點，這裡也不能再按一次。
      if (pageRules.length) {
        for (const rule of pageRules) if (rule.when === 'afterFill') armClick(rule, g.kind, g);
        continue;
      }
      // 設定裡勾了「這個網站自動填完就按登入」才按。一頁只按一次、只在最上層頁面、頁面上只有一個登入表單、而且值真的填進去了。
      if (autoSubmit && IS_TOP && !autoSubmitted && groups.length === 1) {
        autoSubmitted = true;
        setTimeout(async () => {
          // 頁面重新載入後 autoSubmitted 會歸零，密碼錯被退回來又會再按一次，所以要問背景程式
          if (await claimClick('autoSubmit:' + HOST + ':' + g.kind)) submitGroup(g);
        }, 400);
      }
    }
  }

  // 幫使用者按登入：先找表單的送出按鈕，沒有就找文字像「登入」的按鈕，再沒有就直接送出表單
  function submitGroup(g) {
    const buttons = Array.from(
      g.container.querySelectorAll('button, input[type=submit], input[type=button], input[type=image], [role=button]')
    ).filter(isUsable);
    let btn = buttons.find(
      (b) => b.matches('button[type=submit], input[type=submit], input[type=image]') || (b.tagName === 'BUTTON' && !b.getAttribute('type'))
    );
    if (!btn) {
      btn = buttons.find((b) =>
        /登入|登錄|login|log in|sign ?in|submit|進入|確定|下一步|next|continue|ログイン|サインイン|送信|次へ/i.test(
          (b.value || '') + ' ' + (b.textContent || '') + ' ' + (b.getAttribute('aria-label') || '')
        )
      );
    }
    if (btn) {
      btn.click();
      return true;
    }
    const form = (g.pass || g.user) && (g.pass || g.user).form;
    if (form) {
      if (typeof form.requestSubmit === 'function') form.requestSubmit();
      else form.submit();
      return true;
    }
    return false;
  }

  // ---- 自動點選：開頁面時等按鈕出現就點 ----

  const CLICK_WAIT_MS = 15000;
  const CLICK_TICK_MS = 300;

  let clickRulesPromise = null;
  // 這一頁等著點的規則，鍵是「規則 id:階段」。兩段式登入兩頁可能共用同一顆按鈕，所以階段要算進去。
  const armedClicks = new Map();
  let clickTimer = null;
  let clickBusy = false;
  let anyAutoClick = false;
  // 選「停止」的規則放棄之後，排在它後面的這一頁都不再點。換頁才重算。
  let clickStopOrder = Infinity;
  let lastRoute = currentRoute();

  // hash 開頭是 #/ 或 #! 的才是 SPA 的路由（/#/login），一般的 #段落 不算換頁
  function currentRoute() {
    const route = /^#[/!]/.test(location.hash) ? location.hash.split('?')[0] : '';
    return location.pathname + route;
  }

  function getClickRules() {
    if (!clickRulesPromise) {
      clickRulesPromise = send({ type: 'clickRules.forHost', host: HOST }).then((res) => {
        // order 是使用者排的順序，等著點的規則照這個一條一條來
        if (res.ok) return res.data.rules.map((rule, order) => ({ ...rule, order }));
        console.warn(TAG, res.error);
        return [];
      });
    }
    return clickRulesPromise;
  }

  async function armPageClicks() {
    if (!TRUSTED) return;
    for (const rule of await getClickRules()) {
      if (rule.when === 'onLoad' && rulePathMatches(rule.path, location.href)) armClick(rule, 'load', null);
    }
  }

  function armClick(rule, stage, group) {
    if (rule.order > clickStopOrder) return;
    const key = rule.id + ':' + stage;
    const armed = armedClicks.get(key);
    // 網站重畫表單時會再填一次，換成新的欄位就好，等待時間不重算
    if (armed) {
      armed.group = group;
      return;
    }
    armedClicks.set(key, { key, rule, group, armedAt: Date.now(), deadline: 0 });
    if (!clickTimer) clickTimer = setInterval(() => clickTick().catch((err) => console.warn(TAG, err)), CLICK_TICK_MS);
  }

  // 問背景程式這次可不可以點。背景程式的紀錄放在 storage.session，頁面重新載入也還在。
  // ruleId 讓背景程式用那條規則自己的間隔，沒帶就用共用的預設值。
  async function claimClick(key, ruleId) {
    const res = await send({ type: 'clickRules.claim', key, host: HOST, ruleId });
    if (!res.ok) {
      console.warn(TAG, res.error);
      return false;
    }
    if (res.data.allowed) return true;
    if (res.data.reason === 'cooldown') toast(TEXT.clickCooldown);
    else if (res.data.reason === 'logout') toast(TEXT.clickAfterLogout);
    return false;
  }

  // 剛點過的規則，按鈕多半已經不在了（點了頁面就換了），不用等滿 15 秒擋著後面的。
  // 只問一次，不跳提示：按鈕本來就不在畫面上，使用者不需要知道這條沒點。
  async function clickedJustNow(item) {
    if (item.askedGuard) return false;
    item.askedGuard = true;
    const res = await send({ type: 'clickRules.claim', key: item.key, host: HOST, ruleId: item.rule.id, peek: true });
    if (!res.ok) {
      console.warn(TAG, res.error);
      return false;
    }
    return !res.data.allowed;
  }

  // 這條等不到按鈕或不能點，放棄。選「停止」的話，排在後面的也一起收掉。
  function giveUpClick(item) {
    armedClicks.delete(item.key);
    if (item.rule.onMissing !== 'stop') return;
    clickStopOrder = Math.min(clickStopOrder, item.rule.order);
    const behind = [...armedClicks.values()].filter((other) => other.rule.order > item.rule.order);
    for (const other of behind) armedClicks.delete(other.key);
    if (behind.length) toast(formatText(TEXT.clickMissedStop, (item.rule.text || TEXT.clickButtonFallback).slice(0, 20)));
  }

  // 按鈕剛出現時，網頁的程式可能還沒綁好，太早點等於白點，防連點又會擋掉下一次，所以等頁面載完。
  // 有些頁面的圖片或廣告一直載不完，最多等 3 秒。
  function clickSettled(item, now) {
    const waited = now - item.armedAt;
    if (item.group) return waited >= 400;
    return waited >= 500 && (document.readyState === 'complete' || waited >= 3000);
  }

  function groupStillFilled(g) {
    const field = g.pass || g.user;
    return !!field && isUsable(field) && !!field.value;
  }

  // 表單裡還有空欄位（多半是驗證碼），帳密填好也送不過，點了只會多錯一次
  function hasEmptyField(g) {
    return usableInputs(g.container).some(
      (x) => (isTextInput(x) || x.type === 'password') && isUsable(x) && !x.value && !/search|query|keyword/i.test(attrText(x))
    );
  }

  function clickRuleTarget(rule, target) {
    anyAutoClick = true;
    // 「我同意」這種勾選框已經勾了就不要再點，再點會變成取消勾選
    const box = target instanceof HTMLLabelElement ? target.control : target;
    if (box instanceof HTMLInputElement && /^(checkbox|radio)$/.test(box.type) && box.checked) return;
    fireClick(target);
    toast(formatText(TEXT.clickDone, (rule.text || TEXT.clickButtonFallback).slice(0, 20)));
  }

  // 照使用者排的順序，只處理排最前面的那條。它點完或放棄了才輪到下一條，還在等就整排一起等。
  // 點了就結束這一輪，下一條等下一輪，中間留時間給網頁反應。
  async function runNextClick(now) {
    const queue = [...armedClicks.values()].sort((a, b) => a.rule.order - b.rule.order);
    for (const item of queue) {
      // 被前面那條的「停止」收掉了
      if (!armedClicks.has(item.key)) continue;
      if (!rulePathMatches(item.rule.path, location.href)) {
        armedClicks.delete(item.key);
        continue;
      }
      // 輪到這條才開始算，不然前面那條等滿 15 秒，這條也跟著過期
      if (!item.deadline) item.deadline = now + CLICK_WAIT_MS;
      if (now > item.deadline) {
        // 帳密填好了卻等不到按鈕，多半是網站改版，要讓使用者知道。「頁面一打開就點」不提示，已經登入的話按鈕本來就不在。
        if (item.group && !anyAutoClick) toast(TEXT.clickNotFound);
        giveUpClick(item);
        continue;
      }
      if (!clickSettled(item, now)) return;
      if (item.group) {
        if (!groupStillFilled(item.group)) return;
        if (hasEmptyField(item.group)) {
          toast(TEXT.clickEmptyField);
          giveUpClick(item);
          continue;
        }
      }
      const target = findClickTarget(item.rule, item.group);
      if (!target) {
        if (!(await clickedJustNow(item))) return;
        armedClicks.delete(item.key);
        continue;
      }
      armedClicks.delete(item.key);
      if (await claimClick(item.key, item.rule.id)) clickRuleTarget(item.rule, target);
      return;
    }
  }

  async function clickTick() {
    // 正在選按鈕或確認卡片還開著時先不要點，不然頁面會突然跳走
    if (clickBusy || picker || pickBoxTarget) return;
    const now = Date.now();
    // 瀏覽器預先載入的頁面使用者還沒看到，等真的打開才開始算
    if (document.prerendering) {
      for (const item of armedClicks.values()) {
        item.armedAt = now;
        item.deadline = 0;
      }
      return;
    }
    clickBusy = true;
    try {
      await runNextClick(now);
    } finally {
      clickBusy = false;
    }
    if (!armedClicks.size) {
      clearInterval(clickTimer);
      clickTimer = null;
    }
  }

  // ---- 自動點選：按了登出就暫停 ----
  // 不然剛登出回到登入頁，又會馬上被自動點回去。只看真人的點擊，網頁自己發的不算。

  const LOGOUT_HINT = /登出|註銷|注销|退出|log[\s_-]?(out|off)|sign[\s_-]?(out|off)|ログアウト|サインアウト/i;

  function looksLikeLogout(target) {
    const node = clickableOf(target);
    const text = elementText(node);
    if (text.length <= 30 && LOGOUT_HINT.test(text)) return true;
    return [target, node].some((x) =>
      ['aria-label', 'title', 'id', 'class', 'href', 'name'].some((attr) => LOGOUT_HINT.test(x.getAttribute(attr) || ''))
    );
  }

  document.addEventListener(
    'click',
    (e) => {
      if (e.isTrusted && e.target instanceof Element && looksLikeLogout(e.target)) send({ type: 'clickRules.pause', host: HOST });
    },
    true
  );

  // ---- 自動點選：選要點的按鈕 ----
  // 每個 frame 各自進選取模式，因為最上層碰不到 iframe 裡面的元素。選好或按 Esc 時由背景程式通知其他 frame 收掉。

  const PICK_SWALLOW = ['pointerdown', 'mousedown', 'mouseup', 'click', 'dblclick', 'auxclick'];
  let picker = null;
  let pickBox = null;
  let pickBoxTarget = null;

  function drawPickBox(target) {
    pickBoxTarget = target;
    if (!pickBox) {
      pickBox = el('div', 'pick-box');
      ui().appendChild(pickBox);
    }
    const r = target.getBoundingClientRect();
    pickBox.style.left = r.left - 2 + 'px';
    pickBox.style.top = r.top - 2 + 'px';
    pickBox.style.width = r.width + 4 + 'px';
    pickBox.style.height = r.height + 4 + 'px';
  }

  function clearPickBox() {
    if (pickBox) pickBox.remove();
    pickBox = null;
    pickBoxTarget = null;
  }

  function redrawPickBox() {
    if (pickBoxTarget) drawPickBox(pickBoxTarget);
  }
  window.addEventListener('scroll', redrawPickBox, { capture: true, passive: true });
  window.addEventListener('resize', redrawPickBox);

  // 還不能按的按鈕有些設成 pointer-events: none（Nexus 就是），座標只找得到包著它的那層，要自己比位置
  function pointerlessButtonAt(node, x, y) {
    return Array.from(node.querySelectorAll(CLICKABLE)).find((c) => {
      const r = c.getBoundingClientRect();
      return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom && isVisible(c) && getComputedStyle(c).pointerEvents === 'none';
    });
  }

  // 用座標找而不是看 e.target：滑鼠在 disabled 的按鈕上時，瀏覽器不一定把事件發給它
  function pickTargetAt(e) {
    const node = document.elementFromPoint(e.clientX, e.clientY);
    if (!node || node === PK.contentUi.host() || node === document.documentElement) return null;
    const pointerless = node.closest(CLICKABLE) ? null : pointerlessButtonAt(node, e.clientX, e.clientY);
    if (pointerless) return pointerless;
    return node === document.body ? null : clickableOf(node);
  }

  function startPicker() {
    if (picker) return;
    closeDropdown();
    closeBanner();
    const hint = IS_TOP ? el('div', 'pick-hint', TEXT.pickHint) : null;
    if (hint) ui().appendChild(hint);
    // 只理真人的操作，不然網頁可以自己發 click 替使用者選按鈕
    const swallow = (e) => {
      if (!e.isTrusted) return;
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    const onMove = (e) => {
      if (!e.isTrusted) return;
      const target = pickTargetAt(e);
      if (target) drawPickBox(target);
      else clearPickBox();
    };
    const onUp = (e) => {
      if (!e.isTrusted) return;
      swallow(e);
      if (e.button !== 0) return;
      const target = pickTargetAt(e);
      if (target) finishPicker(target);
    };
    const onKey = (e) => {
      if (!e.isTrusted || e.key !== 'Escape') return;
      swallow(e);
      stopPicker();
      send({ type: 'clickRules.pickDone' });
    };
    for (const type of PICK_SWALLOW) window.addEventListener(type, swallow, true);
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', onUp, true);
    window.addEventListener('keydown', onKey, true);
    picker = { hint, swallow, onMove, onUp, onKey };
  }

  function stopPicker() {
    if (!picker) return;
    const { hint, swallow, onMove, onUp, onKey } = picker;
    picker = null;
    if (hint) hint.remove();
    clearPickBox();
    window.removeEventListener('pointermove', onMove, true);
    window.removeEventListener('pointerup', onUp, true);
    window.removeEventListener('keydown', onKey, true);
    // 放開滑鼠後瀏覽器還會補發一個 click，晚一點才拿掉攔截，不然網頁會收到這一下
    setTimeout(() => {
      for (const type of PICK_SWALLOW) window.removeEventListener(type, swallow, true);
    }, 300);
  }

  function finishPicker(target) {
    stopPicker();
    send({ type: 'clickRules.pickDone' });
    // 別人網站框進來的頁面不自動點，跟不自動填是同一個原因
    if (!TRUSTED) {
      toast(TEXT.pickUntrustedFrame);
      return;
    }
    showPickCard(target).catch((err) => {
      console.warn(TAG, err);
      toast(formatText(TEXT.pickCardFailed, err.message));
    });
  }

  async function showPickCard(target) {
    const selector = selectorFor(target);
    const text = elementText(target);
    const path = currentRoute();
    let when = detectGroups().some((g) => g.kind !== 'signup') ? 'afterFill' : 'onLoad';
    const { entries, autoFill } = await getEntries(true);

    const box = el('div', 'banner');
    const h2 = el('h2');
    h2.appendChild(el('span', 'logo'));
    h2.appendChild(el('span', null, TEXT.pickTitle));
    box.appendChild(h2);
    box.appendChild(el('div', 'site', HOST + path));
    box.appendChild(el('label', null, TEXT.pickButton));
    box.appendChild(el('div', 'picked', text || TEXT.pickNoText));
    box.appendChild(el('label', null, TEXT.pickWhen));

    const note = el('div', 'note');
    const showNote = () => {
      if (when !== 'afterFill') note.textContent = '';
      else if (!entries.length) note.textContent = TEXT.pickNoteNoAccount;
      else if (!autoFill) note.textContent = TEXT.pickNoteAutofillOff;
      else note.textContent = '';
    };
    for (const [value, label] of [
      ['afterFill', TEXT.pickAfterFill],
      ['onLoad', TEXT.pickOnLoad],
    ]) {
      const wrap = el('label', 'radio');
      const radio = el('input');
      radio.type = 'radio';
      radio.name = 'pk-when';
      radio.checked = when === value;
      radio.addEventListener('change', () => {
        when = value;
        showNote();
      });
      wrap.appendChild(radio);
      wrap.appendChild(el('span', null, label));
      box.appendChild(wrap);
    }
    box.appendChild(note);
    showNote();

    const row = el('div', 'row');
    const cancel = el('button', null, TEXT.cancel);
    const save = el('button', 'primary', TEXT.save);
    row.appendChild(cancel);
    row.appendChild(save);
    box.appendChild(row);
    cancel.addEventListener('click', closeBanner);
    save.addEventListener('click', async () => {
      save.disabled = true;
      const res = await send({ type: 'clickRules.save', rule: { host: HOST, path, selector, text, when } });
      if (!res.ok) {
        save.disabled = false;
        toast(formatText(TEXT.saveFailed, res.error));
        return;
      }
      closeBanner();
      toast(TEXT.pickSaved);
    });

    closeBanner();
    drawPickBox(target);
    ui().appendChild(box);
    bannerEl = box;
    bannerTimer = setTimeout(closeBanner, 2 * 60 * 1000);
  }

  let scanTimer = null;
  function scheduleScan() {
    if (scanTimer) return;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      scan().catch((err) => console.warn(TAG, err));
    }, 400);
  }

  new MutationObserver(scheduleScan).observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['type', 'style', 'class', 'hidden', 'disabled', 'readonly'],
  });

  // popup 的「填入」、快捷鍵、popup 的「產生密碼 → 填入頁面」都送這個訊息
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    // 解鎖後背景程式會廣播，這時才把帳密填進去
    if (msg && msg.type === 'unlocked') {
      cache = null;
      clickRulesPromise = null;
      closeDropdown();
      groups = detectGroups();
      autofill(groups).catch((err) => console.warn(TAG, err));
      armPageClicks().catch((err) => console.warn(TAG, err));
      sendResponse({ ok: true });
      return false;
    }
    // popup 的「選要自動點的按鈕」
    if (msg && msg.type === 'pickStart') {
      startPicker();
      sendResponse({ ok: true });
      return false;
    }
    if (msg && msg.type === 'pickStop') {
      stopPicker();
      sendResponse({ ok: true });
      return false;
    }
    if (!msg || msg.type !== 'fill') return false;
    const targets = detectGroups();
    if (!targets.length) {
      // 其他 frame 可能有登入欄位，晚一點再回，讓有欄位的那個 frame 先回
      setTimeout(() => sendResponse({ ok: false, error: TEXT.fillNoFields }), 300);
      return true;
    }
    let did = false;
    if (msg.generatedPassword) {
      // 優先填設新密碼的表單，沒有就填第一個有密碼欄的
      const withPass = targets.filter((g) => g.passList.length);
      const group = withPass.find(isNewPasswordGroup) || withPass[0];
      did = group ? fillGenerated(group, msg.generatedPassword) : false;
    } else if (msg.entry) {
      did = fillGroup(targets[0], msg.entry, true);
    }
    sendResponse({ ok: did, error: did ? null : TEXT.fillFailed });
    return false;
  });

  scan().catch((err) => console.warn(TAG, err));
  armPageClicks().catch((err) => console.warn(TAG, err));
  if (IS_TOP) askToSave();
})();
