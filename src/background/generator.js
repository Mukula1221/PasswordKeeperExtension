'use strict';
// 產生強密碼。
(() => {
  const PK = (globalThis.PK ??= {});
  const { t } = PK.i18n;


  const CHAR_SETS = {
    lower: 'abcdefghijklmnopqrstuvwxyz',
    upper: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
    digits: '0123456789',
  };

  // 0 到 maxExclusive-1 的亂數。抽到超過範圍就重抽，避免直接取餘數讓某些數字機率偏高。
  function randomInt(maxExclusive) {
    const limit = Math.floor(0x100000000 / maxExclusive) * maxExclusive;
    const buf = new Uint32Array(1);
    let x;
    do {
      crypto.getRandomValues(buf);
      x = buf[0];
    } while (x >= limit);
    return x % maxExclusive;
  }

  // 好記的密碼：單字數和可以用的分隔符號
  const WORDS_MIN = 3;
  const WORDS_MAX = 20;
  const SEPARATORS = ['-', '.', '_', ' '];

  function normalizeGeneratorOptions(raw) {
    const o = { ...PK.settings.DEFAULT_SETTINGS.generator, ...(raw || {}) };
    const clamp = (v, fallback, min = 4, max = 128) => {
      const n = parseInt(v, 10);
      return Math.min(Math.max(Number.isFinite(n) ? n : fallback, min), max);
    };
    o.mode = o.mode === 'words' ? 'words' : 'chars';
    o.minLength = clamp(o.minLength, 16);
    o.maxLength = Math.max(clamp(o.maxLength, 20), o.minLength);
    for (const k of ['upper', 'lower', 'digits', 'symbols', 'capitalize', 'addNumber']) o[k] = !!o[k];
    o.symbolSet = Array.from(new Set(String(o.symbolSet || '').replace(/\s/g, ''))).join('');
    o.words = clamp(o.words, 6, WORDS_MIN, WORDS_MAX);
    if (!SEPARATORS.includes(o.separator)) o.separator = '-';
    return o;
  }

  // 好記的密碼：從 EFF 單字表抽 words 個字，用分隔符號串起來。
  // 每個字被抽到的機率一樣，7776 個字裡抽一個約 12.9 bit，預設 6 個字約 77 bit。
  function generatePassphrase(o) {
    const list = PK.wordlist;
    const words = [];
    for (let i = 0; i < o.words; i++) {
      const w = list[randomInt(list.length)];
      words.push(o.capitalize ? w[0].toUpperCase() + w.slice(1) : w);
    }
    // 很多網站規定要有數字，接在隨機一個字的後面
    if (o.addNumber) words[randomInt(words.length)] += String(randomInt(10));
    return words.join(o.separator);
  }

  // 隨機字元：長度在 minLength 到 maxLength 之間隨機；每一種勾選的字元至少出現一次。
  function generatePassword(options) {
    const o = normalizeGeneratorOptions(options);
    if (o.mode === 'words') return { password: generatePassphrase(o), options: o };
    const pools = [];
    if (o.lower) pools.push(CHAR_SETS.lower);
    if (o.upper) pools.push(CHAR_SETS.upper);
    if (o.digits) pools.push(CHAR_SETS.digits);
    if (o.symbols) {
      if (!o.symbolSet) throw new Error(t('bg_gen_symbols_empty'));
      pools.push(o.symbolSet);
    }
    if (!pools.length) throw new Error(t('bg_gen_no_charset'));
    const length = o.minLength + randomInt(o.maxLength - o.minLength + 1);
    if (length < pools.length) throw new Error(t('bg_gen_too_short'));
    const all = pools.join('');
    const chars = pools.map((pool) => pool[randomInt(pool.length)]);
    while (chars.length < length) chars.push(all[randomInt(all.length)]);
    // 洗牌，不然開頭永遠是「每類一個」的固定順序
    for (let i = chars.length - 1; i > 0; i--) {
      const j = randomInt(i + 1);
      [chars[i], chars[j]] = [chars[j], chars[i]];
    }
    return { password: chars.join(''), options: o };
  }

  // ---- 產生紀錄：真的用到的密碼留一份，網站沒存成功時找得回來 ----
  // 放在 vault 的 meta.generated，跟帳號一起加密。備份檔只帶帳號，不帶這份紀錄。
  // 只記「用到」的：網頁上的「產生強密碼」、小視窗按「複製」或「填入頁面」。小視窗每改一次選項就重產一次，那些不記。

  const GENERATED_MAX = 20;

  async function noteGenerated(password, host) {
    if (!password) return;
    await PK.vault.modifyVault((vault) => {
      const list = Array.isArray(vault.meta.generated) ? vault.meta.generated : [];
      // 同一組按了複製又按填入，只記一次
      if (list[0] && list[0].password === password) return;
      list.unshift({ id: crypto.randomUUID(), password: String(password), host: String(host || ''), at: Date.now() });
      vault.meta.generated = list.slice(0, GENERATED_MAX);
    });
  }

  async function listGenerated() {
    const { meta } = await PK.vault.loadVault();
    return Array.isArray(meta.generated) ? meta.generated : [];
  }

  // id 沒給就全部清掉
  async function deleteGenerated(id) {
    await PK.vault.modifyVault((vault) => {
      const list = Array.isArray(vault.meta.generated) ? vault.meta.generated : [];
      vault.meta.generated = id ? list.filter((g) => g.id !== id) : [];
    });
    return listGenerated();
  }

  PK.generator = { deleteGenerated, generatePassword, listGenerated, normalizeGeneratorOptions, noteGenerated };
})();
