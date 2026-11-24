'use strict';
// 外洩密碼檢查：查存著的密碼有沒有出現在 Have I Been Pwned（HIBP）收錄的外洩名單。
// 不送密碼：每組密碼算 SHA-1，只把前 5 碼送給 HIBP，拿回所有前 5 碼一樣的雜湊值後段，在這裡比對（k-anonymity）。
// 管理頁按「檢查有沒有外洩」才會連，平常不連。結果不存，關掉管理頁就沒了。
(() => {
  const PK = (globalThis.PK ??= {});
  const { t } = PK.i18n;

  const BREACH_API = 'https://api.pwnedpasswords.com/range/';
  const TIMEOUT_MS = 15000;
  // 同時問幾段。帳號多的時候一段一段問太慢，一次問太多又像在洗 HIBP 的流量
  const PARALLEL = 6;

  let breachApi = BREACH_API;

  // e2e 換成本機假的 HIBP，傳空的換回正式網址
  function useBreachApi(url) {
    breachApi = url || BREACH_API;
  }

  async function sha1Hex(text) {
    const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0'))
      .join('')
      .toUpperCase();
  }

  // 回傳這一段所有雜湊值後段和出現次數
  async function fetchRange(prefix) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      // Add-Padding：HIBP 會補假資料，每次回應的長度差不多，旁人從流量大小猜不出問的是哪一段。
      // 不帶 cookie，跟檢查新版一樣。
      const res = await fetch(breachApi + prefix, { headers: { 'Add-Padding': 'true' }, credentials: 'omit', cache: 'no-store', signal: ctrl.signal });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const counts = new Map();
      for (const line of (await res.text()).split('\n')) {
        const [suffix, count] = line.trim().split(':');
        const n = parseInt(count, 10);
        // 補位的假資料次數是 0
        if (suffix && n > 0) counts.set(suffix.toUpperCase(), n);
      }
      return counts;
    } finally {
      clearTimeout(timer);
    }
  }

  // Firefox 規定送出跟帳密有關的資料要先經過使用者同意，管理頁按檢查時會跳 Firefox 的同意視窗。
  // 這裡再擋一次，沒同意就不連。
  async function consentGiven() {
    if (!PK.platform.can('dataCollectionConsent')) return true;
    const granted = await chrome.permissions.getAll();
    return Array.isArray(granted.data_collection) && granted.data_collection.includes('authenticationInfo');
  }

  // 回傳 { checked: 檢查了幾筆, found: [{ id, count }] }，found 只列出現在外洩名單裡的帳號
  async function checkBreaches() {
    if (!(await consentGiven())) throw new Error(t('bg_breach_no_consent'));
    const entries = (await PK.vault.loadEntries()).filter((e) => e.password);
    const byPrefix = new Map();
    for (const e of entries) {
      const hash = await sha1Hex(e.password);
      const prefix = hash.slice(0, 5);
      if (!byPrefix.has(prefix)) byPrefix.set(prefix, []);
      byPrefix.get(prefix).push({ id: e.id, suffix: hash.slice(5) });
    }
    const found = [];
    const queue = [...byPrefix.entries()];
    const worker = async () => {
      while (queue.length) {
        const [prefix, list] = queue.shift();
        let counts;
        try {
          counts = await fetchRange(prefix);
        } catch (err) {
          throw new Error(t('bg_breach_failed', err.name === 'AbortError' ? t('bg_breach_timeout') : err.message));
        }
        for (const { id, suffix } of list) if (counts.has(suffix)) found.push({ id, count: counts.get(suffix) });
      }
    };
    await Promise.all(Array.from({ length: Math.min(PARALLEL, queue.length) }, worker));
    return { checked: entries.length, found };
  }

  PK.breach = { checkBreaches, useBreachApi };
})();
