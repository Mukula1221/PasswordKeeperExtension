'use strict';
// 收各畫面送來的訊息：檢查是誰送的、鎖住時能不能做，再交給對應的處理函式。
(() => {
  const PK = (globalThis.PK ??= {});
  const { browserLocale, chosenLocale, i18nLocales, t } = PK.i18n;
  const { baseDomain, insecureFill, originFromUrl, rulePathMatches } = PK.domain;

  // 每種訊息誰可以叫、鎖住時能不能叫。沒列在這裡的訊息一律拒絕，新增訊息時要加一行，test/unit 會檢查。
  // from：'any' 是網頁裡的 content.js 也能叫，'extension' 只收小視窗、管理頁、解鎖視窗。
  // 網頁的執行程序被攻破時，攻擊者可以冒充 content.js 送任何訊息，所以 content.js 用不到的一律設 'extension'。
  // whenLocked：true 是鎖住時也能叫，沒寫就要先解鎖。
  const MESSAGE_RULES = {
    'i18n.current': { from: 'any', whenLocked: true },
    // 這幾個鎖住時回傳空的結果和 locked，content.js 看到才知道要提示已鎖定
    'entries.forHost': { from: 'any', whenLocked: true },
    'clickRules.forHost': { from: 'any', whenLocked: true },
    'clickRules.claim': { from: 'any', whenLocked: true },
    'clickRules.pause': { from: 'any', whenLocked: true },
    'clickRules.pickDone': { from: 'any', whenLocked: true },
    'password.generate': { from: 'any', whenLocked: true },
    // 只記雜湊值、排清除的時間，拿不到任何資料。網頁上的「產生強密碼」複製後也要叫
    'clipboard.copied': { from: 'any', whenLocked: true },
    // 鎖住時 pending.get 不回暫存的帳密，解鎖後下一頁再問
    'pending.set': { from: 'any', whenLocked: true },
    'pending.get': { from: 'any', whenLocked: true },
    'pending.clear': { from: 'any', whenLocked: true },
    'entries.save': { from: 'any' },
    'entries.touch': { from: 'any' },
    'neverSave.add': { from: 'any' },
    'clickRules.save': { from: 'any' },

    ping: { from: 'extension', whenLocked: true },
    'lock.status': { from: 'extension', whenLocked: true },
    // webauthn.unlock 自己會核對系統驗證結果，lock.unlockPassword 會核對自訂密碼，鎖住時也要能叫
    'lock.unlockPassword': { from: 'extension', whenLocked: true },
    'webauthn.status': { from: 'extension', whenLocked: true },
    'webauthn.challenge': { from: 'extension', whenLocked: true },
    'webauthn.unlock': { from: 'extension', whenLocked: true },
    // 解不開時清掉重來，鎖住時也要能叫
    'lock.reset': { from: 'extension', whenLocked: true },
    'lock.now': { from: 'extension', whenLocked: true },
    'backup.status': { from: 'extension', whenLocked: true },
    'autoBackup.get': { from: 'extension', whenLocked: true },
    'settings.get': { from: 'extension', whenLocked: true },
    'language.get': { from: 'extension', whenLocked: true },
    'language.set': { from: 'extension', whenLocked: true },
    'theme.set': { from: 'extension', whenLocked: true },
    'update.status': { from: 'extension', whenLocked: true },
    'update.check': { from: 'extension', whenLocked: true },
    'update.download': { from: 'extension', whenLocked: true },
    'lock.settings': { from: 'extension' },
    'lock.setMode': { from: 'extension' },
    'entries.all': { from: 'extension' },
    'entries.delete': { from: 'extension' },
    'entries.deleteAll': { from: 'extension' },
    'entries.import': { from: 'extension' },
    'trash.list': { from: 'extension' },
    'trash.restore': { from: 'extension' },
    'trash.purge': { from: 'extension' },
    'trash.purgeAll': { from: 'extension' },
    'trash.restoreMany': { from: 'extension' },
    'trash.purgeMany': { from: 'extension' },
    'trash.setDays': { from: 'extension' },
    'backup.export': { from: 'extension' },
    'backup.import': { from: 'extension' },
    'backup.download': { from: 'extension' },
    'backupLog.fileStatus': { from: 'extension' },
    'backupLog.delete': { from: 'extension' },
    'autoBackup.set': { from: 'extension' },
    'autoBackup.runNow': { from: 'extension' },
    'settings.set': { from: 'extension' },
    'neverSave.remove': { from: 'extension' },
    'autoSubmit.set': { from: 'extension' },
    'autoFill.setSite': { from: 'extension' },
    'autoFill.setSites': { from: 'extension' },
    'clickRules.add': { from: 'extension' },
    'clickRules.update': { from: 'extension' },
    'clickRules.delete': { from: 'extension' },
    'clickRules.reorder': { from: 'extension' },
    'clickRules.timing': { from: 'extension' },
    'update.setAuto': { from: 'extension' },
    // 產生紀錄只有小視窗和管理頁讀得到。網頁上的「產生強密碼」由 password.generate 自己記，不經過這裡
    'generated.note': { from: 'extension' },
    'generated.list': { from: 'extension' },
    'generated.delete': { from: 'extension' },
    // 外洩密碼檢查會連到外部網站，只收管理頁的要求
    'breach.check': { from: 'extension' },
  };


  const handlers = {
    async ping() {
      return 'pong';
    },

    async 'entries.forHost'({ host, url }, sender) {
      const settings = await PK.settings.getSettings();
      host = PK.callers.callerHost(host, sender);
      // 網頁的網址：content.js 用瀏覽器填的 sender.url，網頁改不了。小視窗用它帶來的分頁網址。
      const pageUrl = PK.callers.fromExtensionPage(sender) ? String(url || '') : String((sender && sender.url) || '');
      // autoFill 是這個網站實際要不要自動填，content.js 看這個。小視窗另外要知道總開關和這個網站自己的開關。
      const siteAutoFill = !settings.noAutoFillHosts.includes(host);
      const flags = {
        autoFill: settings.autoFill && siteAutoFill,
        autoFillMaster: settings.autoFill,
        siteAutoFill,
        autoSubmit: settings.autoSubmitHosts.includes(host),
      };
      if (await PK.lock.isLocked()) return { entries: [], autoFillEntry: null, ...flags, locked: true };
      const pending = sender.tab ? await PK.pending.getPending(sender.tab.id) : null;
      // insecure：網頁沒加密、帳號卻是在 https 存的。這種帳號不自動填，從清單或小視窗填要先問。
      const entries = PK.entries.rankEntries(await PK.vault.loadEntries(), host).map((e) => (insecureFill(pageUrl, e.origin) ? { ...e, insecure: true } : e));
      // 兩段式登入的第二頁只有密碼欄。第一頁打的帳號有存過就填那一組，沒存過就不能拿別組帳號的密碼來填。
      let autoFillEntry = entries[0] || null;
      if (pending && pending.username && !pending.password) {
        autoFillEntry = entries.find((e) => e.username === pending.username) || null;
      }
      if (autoFillEntry && autoFillEntry.insecure) autoFillEntry = null;
      return { entries, autoFillEntry, ...flags, locked: false };
    },

    // 只開關這一個網站的自動填入。關掉時一起取消這個網站的自動按登入，不然之後打開自動填入，自動按登入會跟著悄悄恢復。
    async 'autoFill.setSite'({ host, enabled }) {
      host = String(host || '').toLowerCase();
      if (!host) throw new Error(t('bg_site_required'));
      const settings = await PK.settings.getSettings();
      const off = settings.noAutoFillHosts.filter((h) => h !== host);
      if (!enabled) off.push(host);
      const patch = { noAutoFillHosts: off };
      if (!enabled) patch.autoSubmitHosts = settings.autoSubmitHosts.filter((h) => h !== host);
      return PK.settings.setSettings(patch);
    },

    // 管理頁「各網站」表按套用時，一次存好幾個網站。sites：[{ host, autoFill, autoSubmit }]。
    // 跟單一網站的規則一樣：自動填入關掉的網站，自動按登入一律取消。
    async 'autoFill.setSites'({ sites }) {
      const settings = await PK.settings.getSettings();
      const off = new Set(settings.noAutoFillHosts);
      const submit = new Set(settings.autoSubmitHosts);
      for (const s of sites || []) {
        const host = String(s.host || '').toLowerCase();
        if (!host) continue;
        if (s.autoFill) off.delete(host);
        else off.add(host);
        if (s.autoFill && s.autoSubmit) submit.add(host);
        else submit.delete(host);
      }
      return PK.settings.setSettings({ noAutoFillHosts: [...off], autoSubmitHosts: [...submit] });
    },

    async 'autoSubmit.set'({ host, enabled }) {
      host = String(host || '').toLowerCase();
      const settings = await PK.settings.getSettings();
      // 自動按登入接在自動填入後面，這個網站的自動填入關著就沒有東西可以按
      if (enabled && settings.noAutoFillHosts.includes(host)) throw new Error(t('bg_autofill_off_for_site'));
      const hosts = settings.autoSubmitHosts.filter((h) => h !== host);
      if (host && enabled) hosts.push(host);
      return PK.settings.setSettings({ autoSubmitHosts: hosts });
    },

    // content.js 拿這個網站啟用中的規則。小視窗多帶 url，要知道這一頁有幾條。
    async 'clickRules.forHost'({ host, url }, sender) {
      if (await PK.lock.isLocked()) return { rules: [], pageCount: 0, locked: true };
      host = PK.callers.callerHost(host, sender);
      const rules = (await PK.settings.getSettings()).clickRules.filter((r) => r.enabled && r.host === host);
      return { rules, pageCount: url ? rules.filter((r) => rulePathMatches(r.path, url)).length : 0, locked: false };
    },

    // 同一頁重選同一顆按鈕算改設定，不會多一條
    async 'clickRules.save'({ rule }, sender) {
      const raw = rule || {};
      const data = PK.clickRules.normalizeClickRule({ ...raw, host: PK.callers.callerHost(raw.host, sender) });
      await PK.clickRules.updateClickRules(({ clickRules }) => {
        const rules = clickRules.slice();
        const i = rules.findIndex((r) => PK.clickRules.sameClickRule(r, data));
        if (i >= 0) rules[i] = { ...rules[i], ...data, enabled: true };
        else rules.push({ id: crypto.randomUUID(), enabled: true, createdAt: Date.now(), ...data });
        return { clickRules: rules };
      });
      // 管理頁可能開在別的分頁，通知它重畫。host 讓它把新規則那個網站展開。
      chrome.runtime.sendMessage({ type: 'clickRulesChanged', host: data.host }).catch(() => {
        // 沒有頁面開著就會失敗，不用理
      });
      return true;
    },

    // 管理頁手動新增。跟在網頁上重選按鈕不一樣，相同的規則要報錯，手動填的內容不該悄悄蓋掉舊設定。
    async 'clickRules.add'({ rule }) {
      const raw = rule || {};
      const data = PK.clickRules.normalizeClickRule({ ...raw, text: PK.clickRules.cleanRuleText(raw.text) });
      if (!PK.clickRules.CLICK_RULE_HOST.test(data.host)) throw new Error(t('bg_site_invalid'));
      if (raw.intervalSec !== undefined) PK.clickRules.requireClickSeconds(raw.intervalSec, 1, t('bg_label_interval'));
      return PK.clickRules.updateClickRules(({ clickRules }) => {
        if (clickRules.some((r) => PK.clickRules.sameClickRule(r, data))) throw new Error(t('bg_duplicate_click_rule'));
        return { clickRules: [...clickRules, { id: crypto.randomUUID(), enabled: true, createdAt: Date.now(), ...data }] };
      });
    },

    async 'clickRules.update'({ id, patch }) {
      return PK.clickRules.updateClickRules(({ clickRules }) => ({
        clickRules: clickRules.map((r) => {
          if (r.id !== id) return r;
          const next = PK.clickRules.patchClickRule(r, patch);
          if (clickRules.some((other) => other.id !== id && PK.clickRules.sameClickRule(other, next))) throw new Error(t('bg_duplicate_click_rule'));
          return next;
        }),
      }));
    },

    async 'clickRules.delete'({ id }) {
      return PK.clickRules.updateClickRules(({ clickRules }) => ({ clickRules: clickRules.filter((r) => r.id !== id) }));
    },

    // ids 是這個網站所有規則排好的順序。別的網站的規則留在原位。
    async 'clickRules.reorder'({ host, ids }) {
      return PK.clickRules.updateClickRules(({ clickRules }) => {
        const own = clickRules.filter((r) => r.host === host);
        const queue = (ids || []).map((id) => own.find((r) => r.id === id));
        // 管理頁開著時，規則可能在別的分頁新增或刪掉了。對不上就不動，不然規則會不見。
        if (queue.length !== own.length || new Set(queue).size !== own.length || queue.includes(undefined)) {
          throw new Error(t('bg_rules_changed'));
        }
        return { clickRules: clickRules.map((r) => (r.host === host ? queue.shift() : r)) };
      });
    },

    // 間隔預設值和登出後暫停，沒帶到的不動
    async 'clickRules.timing'({ clickIntervalSec, logoutPauseSec }) {
      const patch = {};
      if (clickIntervalSec !== undefined) patch.clickIntervalSec = PK.clickRules.requireClickSeconds(clickIntervalSec, 1, t('bg_label_interval'));
      if (logoutPauseSec !== undefined) patch.logoutPauseSec = PK.clickRules.requireClickSeconds(logoutPauseSec, 0, t('bg_label_pause'));
      return PK.clickRules.updateClickRules(() => patch);
    },

    // content.js 每次要自動點之前先問這個。通過就記一筆，所以問一次就算點一次。
    // peek 只看現在能不能點，不記。ruleId 是哪條規則，用它自己的間隔；沒帶（自動填完按登入）或沒填就用共用的預設值。
    async 'clickRules.claim'({ key, host, ruleId, peek }, sender) {
      if (!sender.tab) return { allowed: false, reason: 'no-tab' };
      host = PK.callers.callerHost(host, sender);
      if (await PK.lock.isLocked()) return { allowed: false, reason: 'locked' };
      const settings = await PK.settings.getSettings();
      const rule = ruleId && settings.clickRules.find((r) => r.id === ruleId);
      const intervalMs = ((rule && rule.intervalSec) || settings.clickIntervalSec) * 1000;
      const pauseMs = settings.logoutPauseSec * 1000;
      const logoutKey = 'logout:' + baseDomain(host);
      return PK.clickRules.updateClickGuard((map) => {
        const guard = PK.clickRules.tabClickGuard(map, sender.tab.id);
        const now = Date.now();
        if (guard[logoutKey] && now - guard[logoutKey] < pauseMs) return { allowed: false, reason: 'logout' };
        if (guard[key] && now - guard[key] < intervalMs) return { allowed: false, reason: 'cooldown' };
        if (!peek) guard[key] = now;
        return { allowed: true };
      });
    },

    // 使用者按了登出。用主網域記，因為單一驗證的網址常常跟系統不同，但主網域相同。
    async 'clickRules.pause'({ host }, sender) {
      if (!sender.tab) return false;
      host = PK.callers.callerHost(host, sender);
      await PK.clickRules.updateClickGuard((map) => {
        PK.clickRules.tabClickGuard(map, sender.tab.id)['logout:' + baseDomain(host)] = Date.now();
      });
      return true;
    },

    // 選取模式是每個 frame 各跑各的，其中一個選好或按 Esc，其他 frame 也要收掉
    async 'clickRules.pickDone'(_, sender) {
      if (!sender.tab) return false;
      chrome.tabs.sendMessage(sender.tab.id, { type: 'pickStop' }).catch(() => {
        // 分頁可能已經跳頁或關掉，不用理
      });
      return true;
    },

    async 'lock.status'() {
      return PK.lock.lockStatus();
    },

    // 改閒置分鐘數或「重開就鎖」不用再驗，反正已經是解鎖狀態才改得到
    async 'lock.settings'({ idleMinutes, onStartup }) {
      const settings = await PK.settings.getSettings();
      const next = { ...settings.lock };
      if (idleMinutes != null) next.idleMinutes = Math.min(Math.max(parseInt(idleMinutes, 10) || 10, 1), 720);
      if (onStartup != null) next.onStartup = !!onStartup;
      await PK.settings.setSettings({ lock: next });
      PK.lock.applyIdleInterval();
      return PK.lock.lockStatus();
    },

    async 'lock.setMode'(data, sender) {
      PK.callers.requireExtensionPage(sender);
      return PK.lock.setLockMode(data);
    },

    // 自訂密碼加密時打自訂密碼解鎖，管理頁驗證身分也用這個。鎖住時也要能叫。
    async 'lock.unlockPassword'({ password }, sender) {
      PK.callers.requireExtensionPage(sender);
      await PK.lock.unlockWithPassword(password);
      await PK.lock.setLocked(false);
      return PK.lock.lockStatus();
    },

    // 忘了自訂密碼或系統驗證壞了，清掉資料重來。鎖住時也要能叫，沒加密的不用清。
    async 'lock.reset'(_, sender) {
      PK.callers.requireExtensionPage(sender);
      if (!PK.lock.isEncryptedMode((await PK.settings.getSettings()).lock.mode)) throw new Error(t('bg_lock_reset_not_needed'));
      await PK.vault.resetVault();
      PK.badge.refreshActiveBadges();
      return PK.lock.lockStatus();
    },

    async 'lock.now'() {
      const settings = await PK.settings.getSettings();
      if (!settings.lock.enabled) throw new Error(t('bg_lock_not_enabled'));
      await PK.lock.setLocked(true);
      return PK.lock.lockStatus();
    },

    async 'webauthn.status'() {
      return PK.webauthn.webAuthnStatus();
    },

    async 'webauthn.challenge'() {
      return { challenge: await PK.webauthn.issueWebAuthnChallenge(), rpId: chrome.runtime.id };
    },

    async 'webauthn.unlock'(assertion) {
      await PK.webauthn.verifyAssertion(assertion);
      await PK.lock.unlockWithHello(assertion.prf);
      await PK.lock.setLocked(false);
      return PK.lock.lockStatus();
    },

    async 'entries.all'() {
      const entries = await PK.vault.loadEntries();
      entries.sort((a, b) => a.host.localeCompare(b.host) || a.username.localeCompare(b.username));
      return entries;
    },

    // 網頁上的「要儲存嗎？」只能存 contentSaveSites 列的網站，origin 也用那裡記的，不收網頁給的
    async 'entries.save'({ entry, id }, sender) {
      let raw = entry || {};
      const sites = PK.callers.fromExtensionPage(sender) ? null : await PK.callers.contentSaveSites(sender);
      const host = sites ? PK.entries.normalizeInput(raw).host : null;
      if (sites) {
        const site = sites.find((s) => s.host === host);
        if (!site) throw PK.callers.siteNotAllowed();
        raw = { ...raw, origin: site.origin };
      }
      const result = await PK.vault.modifyEntries((entries) => {
        // 用 id 更新時，那一筆原本也要是同一個網站的，不然網頁可以拿 id 改掉別的網站的帳號
        if (sites && id && entries.some((e) => e.id === id && e.host !== host)) throw PK.callers.siteNotAllowed();
        return PK.entries.upsert(entries, raw, id);
      });
      PK.badge.refreshActiveBadges();
      return result;
    },

    // 刪掉的先進回收桶，放滿保留天數（預設 30 天）之前都可以復原
    async 'entries.delete'({ id }) {
      const removed = await PK.vault.modifyVault((vault) => {
        const i = vault.entries.findIndex((e) => e.id === id);
        if (i < 0) return false;
        const [entry] = vault.entries.splice(i, 1);
        vault.trash.unshift({ ...entry, deletedAt: Date.now() });
        return true;
      });
      PK.badge.refreshActiveBadges();
      return removed;
    },

    async 'entries.deleteAll'() {
      await PK.vault.modifyVault((vault) => {
        const now = Date.now();
        vault.trash.unshift(...vault.entries.map((e) => ({ ...e, deletedAt: now })));
        vault.entries.length = 0;
      });
      PK.badge.refreshActiveBadges();
      return true;
    },

    async 'trash.list'() {
      // 走 modifyVault 是為了順便把過期的清掉
      return PK.vault.modifyVault((vault) => vault.trash.slice().sort((a, b) => (b.deletedAt || 0) - (a.deletedAt || 0)));
    },

    async 'trash.restore'({ id }) {
      const entry = await PK.vault.modifyVault((vault) => {
        const i = vault.trash.findIndex((x) => x.id === id);
        if (i < 0) throw new Error(t('bg_trash_not_found'));
        const item = vault.trash[i];
        if (vault.entries.some((e) => e.host === item.host && e.username === item.username)) {
          throw new Error(t('bg_restore_duplicate'));
        }
        vault.trash.splice(i, 1);
        const { deletedAt, ...restored } = item;
        vault.entries.push(restored);
        return restored;
      });
      PK.badge.refreshActiveBadges();
      return entry;
    },

    async 'trash.purge'({ id }) {
      return PK.vault.modifyVault((vault) => {
        const i = vault.trash.findIndex((t) => t.id === id);
        if (i < 0) return false;
        vault.trash.splice(i, 1);
        return true;
      });
    },

    async 'trash.purgeAll'() {
      await PK.vault.modifyVault((vault) => {
        vault.trash.length = 0;
      });
      return true;
    },

    // 批次復原：同網站已經有同一個帳號的那幾筆跳過，其他照常復原，回傳跳過哪幾筆。
    // 一筆一筆檢查，所以勾到兩筆同網站同帳號的（刪掉、新增、又刪掉）時，只會復原第一筆。
    async 'trash.restoreMany'({ ids }) {
      const result = await PK.vault.modifyVault((vault) => {
        const out = { restored: 0, skipped: [] };
        for (const id of ids || []) {
          const i = vault.trash.findIndex((t) => t.id === id);
          if (i < 0) continue;
          const t = vault.trash[i];
          if (vault.entries.some((e) => e.host === t.host && e.username === t.username)) {
            out.skipped.push({ host: t.host, username: t.username });
            continue;
          }
          vault.trash.splice(i, 1);
          const { deletedAt, ...restored } = t;
          vault.entries.push(restored);
          out.restored++;
        }
        return out;
      });
      PK.badge.refreshActiveBadges();
      return result;
    },

    async 'trash.purgeMany'({ ids }) {
      const wanted = new Set(ids || []);
      return PK.vault.modifyVault((vault) => {
        const before = vault.trash.length;
        vault.trash = vault.trash.filter((t) => !wanted.has(t.id));
        return before - vault.trash.length;
      });
    },

    // 改保留天數。改短的話，已經放超過新天數的會在這次寫入時一起清掉，回傳清掉幾筆。
    // 管理頁會先列出會被清掉的讓使用者確認，這裡不再問。
    async 'trash.setDays'({ days }) {
      const n = parseInt(days, 10);
      if (!(n >= 1 && n <= 365)) throw new Error(t('bg_trash_days_range'));
      const cutoff = Date.now() - n * PK.vault.DAY_MS;
      const expired = (await PK.vault.loadVault()).trash.filter((x) => (x.deletedAt || 0) <= cutoff).length;
      await PK.settings.setSettings({ trashDays: n });
      await PK.vault.modifyVault(() => {});
      return { days: n, purged: expired };
    },

    async 'entries.touch'({ id }) {
      await PK.vault.touchEntry(id);
      return true;
    },

    // rows: [{ url, username, password, note }]，管理頁從 CSV 讀出來的。
    // Firefox 匯出的檔案有時間，會多帶 createdAt、lastUsedAt、passwordChangedAt（毫秒）。
    async 'entries.import'({ rows }) {
      const stats = await PK.entries.importEntries(rows);
      PK.badge.refreshActiveBadges();
      return stats;
    },

    // options 有給就用給的（popup 會順便存起來），沒給就用設定裡存的。
    // content.js 只能用存好的設定，不然網頁可以把設定偷改成很短的密碼。
    async 'password.generate'({ options, save }, sender) {
      const own = PK.callers.fromExtensionPage(sender);
      const result = PK.generator.generatePassword((own && options) || (await PK.settings.getSettings()).generator);
      if (own && save && options) await PK.settings.setSettings({ generator: result.options });
      // 網頁上的「產生強密碼」一叫就會填進欄位，算用到了，記進產生紀錄。網站用 content.js 所在的網址算。
      // 鎖著時讀寫不了紀錄，這次就不記
      if (!own && !(await PK.lock.isLocked())) await PK.generator.noteGenerated(result.password, PK.callers.callerHost('', sender));
      return result;
    },

    // 小視窗按了「複製」或「填入頁面」，把那組記進產生紀錄
    async 'generated.note'({ password, host }) {
      await PK.generator.noteGenerated(String(password || ''), String(host || ''));
      return true;
    },

    async 'breach.check'() {
      return PK.breach.checkBreaches();
    },

    async 'generated.list'() {
      return PK.generator.listGenerated();
    },

    // id 沒給就全部清掉
    async 'generated.delete'({ id }) {
      return PK.generator.deleteGenerated(id ? String(id) : '');
    },

    async 'backup.export'({ password, ids }) {
      return PK.backup.exportBackup(password, ids);
    },

    async 'backup.import'({ password, content }) {
      return PK.backup.importBackup(password, content);
    },

    async 'backup.status'() {
      return PK.backup.backupStatus();
    },

    // content 是檔案內容，kind 是 manual / csv / selected，管理頁組好內容後叫這個存檔
    async 'backup.download'({ content, filename, mime, kind, count }) {
      return PK.backupFiles.downloadBackup({ content, filename, mime: mime || 'application/json', kind, count });
    },

    // 單筆刪紀錄前，管理頁先問這個，看要問「要不要一起刪檔案」還是提醒使用者自己去刪
    async 'backupLog.fileStatus'({ id }) {
      const item = (await PK.backupFiles.getBackupLog()).find((x) => x.id === id);
      if (!item) throw new Error(t('bg_log_not_found'));
      const status = await PK.backupFiles.backupFileStatus(item);
      return { status, reason: PK.backupFiles.fileReason(status) };
    },

    async 'backupLog.delete'({ ids, deleteFiles }) {
      return PK.backupFiles.deleteBackupLog(ids, !!deleteFiles);
    },

    async 'autoBackup.get'() {
      return PK.autoBackup.autoBackupInfo();
    },

    async 'autoBackup.set'(data) {
      return PK.autoBackup.setAutoBackup(data);
    },

    async 'autoBackup.runNow'() {
      return PK.autoBackup.runAutoBackup(true);
    },

    async 'settings.get'() {
      return PK.settings.getSettings();
    },

    // 管理頁右上角的語言選單。auto 是跟著瀏覽器，browserLocale 是瀏覽器挑的那一種。
    async 'language.get'() {
      return { language: (await chosenLocale()) || 'auto', browserLocale: browserLocale() };
    },

    // 鎖住時也能換：語言只是怎麼顯示，看不懂驗證畫面的人也要能換回看得懂的語言
    async 'language.set'({ language }) {
      if (language === 'auto') await chrome.storage.local.remove('uiLanguage');
      else if (i18nLocales().includes(language)) await chrome.storage.local.set({ uiLanguage: language });
      else throw new Error(t('bg_language_invalid'));
      // storage 的變更通知會晚一點才到，這裡先換好，管理頁重新整理後的第一個訊息就會是新語言
      await PK.locale.reloadLocale();
      return { language };
    },

    // 管理頁左側欄的色系選單。system 是跟著系統，存的時候拿掉 uiTheme。
    // 鎖住時也能換，理由跟語言一樣。值要跟 theme.js 的 THEMES 一樣。
    async 'theme.set'({ theme }) {
      if (theme === 'system') await chrome.storage.local.remove('uiTheme');
      else if (['white', 'dark', 'teal'].includes(theme)) await chrome.storage.local.set({ uiTheme: theme });
      else throw new Error(t('bg_theme_invalid'));
      return { theme };
    },

    // 網頁裡的 content.js 拿指定語言的翻譯。沒指定時 messages 是 null，照瀏覽器的語言。
    // 直接讀 storage，不用背景程式自己記的：content.js 收到語言變更通知時，背景程式可能還沒收到
    async 'i18n.current'() {
      const locale = await chosenLocale();
      return { locale, messages: locale && locale !== browserLocale() ? await PK.locale.localeMessages(locale) : null };
    },

    async 'clipboard.copied'({ text }) {
      return PK.clipboard.noteCopied(text);
    },

    async 'settings.set'({ patch }) {
      return PK.settings.setSettings(patch || {});
    },

    // 小視窗和管理頁問有沒有新版。版本號不是秘密，鎖住時也能問。
    async 'update.status'() {
      return PK.update.updateStatus();
    },

    // 管理頁的「立即檢查」。開發版也能按，只是不會自動檢查。
    async 'update.check'() {
      await PK.update.checkUpdate();
      return PK.update.updateStatus();
    },

    // 打開自動檢查時馬上看一次，不用等到明天
    async 'update.setAuto'({ enabled }) {
      await PK.settings.setSettings({ updateCheck: !!enabled });
      if (enabled) await PK.update.updateTick();
      return PK.update.updateStatus();
    },

    // 下載的網址用背景程式自己存的，畫面傳來的網址不收
    async 'update.download'() {
      const { latest } = await PK.update.updateStatus();
      if (!latest || !latest.zipUrl) throw new Error(t('bg_update_no_download'));
      return chrome.downloads.download({ url: latest.zipUrl });
    },

    async 'neverSave.add'({ host }, sender) {
      host = String(host || '').toLowerCase();
      if (!PK.callers.fromExtensionPage(sender) && !(await PK.callers.contentSaveSites(sender)).some((s) => s.host === host)) throw PK.callers.siteNotAllowed();
      const settings = await PK.settings.getSettings();
      if (host && !settings.neverSave.includes(host)) settings.neverSave.push(host);
      return PK.settings.setSettings({ neverSave: settings.neverSave });
    },

    async 'neverSave.remove'({ host }) {
      const settings = await PK.settings.getSettings();
      return PK.settings.setSettings({ neverSave: settings.neverSave.filter((h) => h !== host) });
    },

    // 之後存檔只認這裡記下的網站，所以 host、origin 用 content.js 所在的網址算
    async 'pending.set'(data, sender) {
      if (!sender.tab) return null;
      return PK.pending.setPending(sender.tab.id, {
        host: PK.callers.callerHost(data.host, sender),
        origin: PK.callers.fromExtensionPage(sender) ? data.origin : originFromUrl(sender.url),
        username: data.username,
        password: data.password,
        submitUrl: data.submitUrl,
      });
    },

    async 'pending.get'(_, sender) {
      if (!sender.tab) return { pending: null, mode: null };
      return PK.pending.pendingDecision(sender.tab.id);
    },

    async 'pending.clear'(_, sender) {
      if (sender.tab) await PK.pending.clearPending(sender.tab.id);
      return true;
    },

  };

  async function dispatch(msg, sender) {
    await PK.locale.localeReady();
    const rule = MESSAGE_RULES[msg.type];
    if (rule.from !== 'any' && !PK.callers.fromExtensionPage(sender)) throw new Error(t('bg_extension_page_only'));
    if (PK.callers.fromBlockedPrivateTab(sender)) throw new Error(t('bg_private_window_blocked'));
    if (!rule.whenLocked && (await PK.lock.isLocked())) throw PK.lock.lockedError();
    return handlers[msg.type](msg, sender);
  }

  // 用 hasOwn：type 是 'toString'、'constructor' 這類名字時，handlers[type] 會拿到 Object 內建的函式
  function knownMessage(msg) {
    return !!msg && typeof msg.type === 'string' && Object.hasOwn(handlers, msg.type) && Object.hasOwn(MESSAGE_RULES, msg.type);
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!knownMessage(msg)) {
      sendResponse({ ok: false, error: t('bg_unknown_message', msg && msg.type) });
      return false;
    }
    dispatch(msg, sender).then(
      (data) => sendResponse({ ok: true, data }),
      (err) => {
        // 已鎖定、欄位填錯這類拒絕是寫給使用者看的訊息（一般 Error），會回給畫面顯示，不算程式出錯。
        // 印成 console.error 會讓 chrome://extensions 冒出紅色「錯誤」按鈕，所以只印 TypeError 這類真的意外。
        if (!(err && (err.locked || err.constructor === Error))) {
          console.error('[密碼小管家] 處理訊息失敗', msg.type, err); // i18n-ignore：給開發者看的
        }
        sendResponse({ ok: false, error: err && err.message ? err.message : String(err), locked: !!(err && err.locked) });
      }
    );
    // 回傳 true 告訴瀏覽器 sendResponse 會晚一點才叫，不然通道會先被關掉。
    return true;
  });

  PK.messages = { MESSAGE_RULES, dispatch, handlers };
})();
