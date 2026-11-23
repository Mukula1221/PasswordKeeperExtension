'use strict';
// 自動點選規則的整理和存檔，以及每個分頁的防連點紀錄。
(() => {
  const PK = (globalThis.PK ??= {});
  const { t } = PK.i18n;


  function normalizeRulePath(raw) {
    let path = String(raw == null ? '' : raw).trim();
    if (!path) throw new Error(t('bg_rule_path_required'));
    // 使用者可能直接貼整個網址
    if (/^https?:\/\//i.test(path)) {
      try {
        const u = new URL(path);
        path = u.pathname + u.search + u.hash;
      } catch {
        throw new Error(t('bg_rule_url_invalid'));
      }
    }
    return path.startsWith('/') || path.startsWith('*') ? path : '/' + path;
  }

  function requireClickSeconds(raw, min, label) {
    const sec = PK.settings.clickSeconds(raw, min);
    if (sec === null) throw new Error(t('bg_seconds_range', label, min, PK.settings.CLICK_SEC_MAX));
    return sec;
  }

  // 跟網頁上讀到的按鈕文字整理成一樣，比對時才對得上
  function cleanRuleText(raw) {
    return String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim().slice(0, 80);
  }

  function normalizeClickRule(raw) {
    const host = String(raw.host || '').trim().toLowerCase();
    const selector = String(raw.selector || '').trim();
    if (!host) throw new Error(t('bg_site_required'));
    if (!selector) throw new Error(t('bg_rule_no_button'));
    const rule = {
      host,
      path: normalizeRulePath(raw.path),
      selector,
      text: String(raw.text || '').slice(0, 80),
      when: raw.when === 'afterFill' ? 'afterFill' : 'onLoad',
    };
    // 這兩個是選填。在網頁上重選同一顆按鈕時沒帶到，存檔才不會蓋掉使用者調過的值。
    const intervalSec = PK.settings.clickSeconds(raw.intervalSec, 1);
    if (intervalSec !== null) rule.intervalSec = intervalSec;
    if (raw.onMissing === 'stop') rule.onMissing = 'stop';
    return rule;
  }

  function sameClickRule(a, b) {
    return a.host === b.host && a.path === b.path && a.selector === b.selector;
  }

  // content.js 是拿 location.hostname 完全比對，寫成別的樣子（像 *.example.com）的規則永遠不會點。
  // options.js 的 splitRuleUrl 有一份一樣的，管理頁要先拆好才看得到結果。
  const CLICK_RULE_HOST = /^(\[[\da-f:.]+\]|[a-z\d_-]+(\.[a-z\d_-]+)*)$/;

  // 管理頁改一條規則，沒帶到的欄位不動
  function patchClickRule(rule, patch) {
    const next = { ...rule };
    if (patch.enabled != null) next.enabled = !!patch.enabled;
    if (patch.when != null) next.when = patch.when === 'afterFill' ? 'afterFill' : 'onLoad';
    if (patch.path != null) next.path = normalizeRulePath(patch.path);
    if (patch.selector != null) {
      next.selector = String(patch.selector).trim();
      if (!next.selector) throw new Error(t('bg_selector_required'));
      // 文字留著的話，新按鈕對不上舊文字就點不到，還可能用舊文字點回舊按鈕
      if (next.selector !== rule.selector) next.text = '';
    }
    if (patch.text != null) next.text = cleanRuleText(patch.text);
    // null 是清掉，回到共用的間隔預設值
    if (patch.intervalSec === null) delete next.intervalSec;
    else if (patch.intervalSec !== undefined) next.intervalSec = requireClickSeconds(patch.intervalSec, 1, t('bg_label_interval'));
    if (patch.onMissing === 'stop') next.onMissing = 'stop';
    else if (patch.onMissing != null) delete next.onMissing;
    return next;
  }

  // 管理頁改完欄位馬上按別的按鈕時，兩個訊息會同時進來。不排隊的話，後存的會蓋掉先存的。
  let clickRulesQueue = Promise.resolve();

  function updateClickRules(change) {
    const run = clickRulesQueue.then(async () => PK.settings.setSettings(change(await PK.settings.getSettings())));
    clickRulesQueue = run.catch(() => {
      // 失敗的那次已經往外拋給呼叫者了，這裡只是不要讓佇列卡住。
    });
    return run;
  }

  // 備份檔裡的規則：同網站、同網址、同按鈕的略過，其他新增。回傳新增幾條。
  async function importClickRules(rows) {
    const rules = (await PK.settings.getSettings()).clickRules.slice();
    let added = 0;
    for (const row of rows) {
      let data;
      try {
        data = normalizeClickRule(row);
      } catch (err) {
        // 壞掉的規則略過就好，不要讓整份備份匯不進來
        console.warn('[密碼小管家] 略過備份檔裡壞掉的自動點選規則', err); // i18n-ignore：給開發者看的
        continue;
      }
      if (rules.some((r) => sameClickRule(r, data))) continue;
      rules.push({ id: crypto.randomUUID(), enabled: row.enabled !== false, createdAt: row.createdAt || Date.now(), ...data });
      added++;
    }
    if (added) await PK.settings.setSettings({ clickRules: rules });
    return added;
  }

  // 防連點：同一個分頁裡，同一條規則隔夠久才能再點，也不自動點剛按過登出的網站。
  // 不擋的話，密碼錯被退回登入頁會一直重試，帳號可能被鎖；按登出也會馬上被登回去。
  // 記錄放 storage.session，因為頁面重新載入後 content.js 的變數就沒了。樣子：{ 分頁 id: { 代號: 時間 } }。

  // 同一個分頁的好幾個 frame 可能同時來問，排隊一次一個，不然會一起通過
  let clickGuardQueue = Promise.resolve();

  function updateClickGuard(mutator) {
    const run = clickGuardQueue.then(async () => {
      const { clickGuard } = await chrome.storage.session.get('clickGuard');
      const map = clickGuard || {};
      const result = mutator(map);
      await chrome.storage.session.set({ clickGuard: map });
      return result;
    });
    clickGuardQueue = run.catch(() => {
      // 失敗的那次已經往外拋給呼叫者了，這裡只是不要讓佇列卡住。
    });
    return run;
  }

  // 取出這個分頁的紀錄。存的是點的時間，有沒有過期等要用時照當下的設定算，這樣改短間隔馬上有效。
  // 超過最長間隔的一定用不到了，順便清掉。
  function tabClickGuard(map, tabId) {
    const now = Date.now();
    const guard = map[tabId] || {};
    for (const [key, at] of Object.entries(guard)) {
      if (now - at >= PK.settings.CLICK_SEC_MAX * 1000) delete guard[key];
    }
    map[tabId] = guard;
    return guard;
  }

  function clearClickGuard(tabId) {
    return updateClickGuard((map) => {
      delete map[tabId];
    });
  }

  PK.clickRules = { CLICK_RULE_HOST, cleanRuleText, clearClickGuard, importClickRules, normalizeClickRule, normalizeRulePath, patchClickRule, requireClickSeconds, sameClickRule, tabClickGuard, updateClickGuard, updateClickRules };
})();
