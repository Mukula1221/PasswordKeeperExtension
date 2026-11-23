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

  function normalizeGeneratorOptions(raw) {
    const o = { ...PK.settings.DEFAULT_SETTINGS.generator, ...(raw || {}) };
    const clamp = (v, fallback) => {
      const n = parseInt(v, 10);
      return Math.min(Math.max(Number.isFinite(n) ? n : fallback, 4), 128);
    };
    o.minLength = clamp(o.minLength, 16);
    o.maxLength = Math.max(clamp(o.maxLength, 20), o.minLength);
    for (const k of ['upper', 'lower', 'digits', 'symbols']) o[k] = !!o[k];
    o.symbolSet = Array.from(new Set(String(o.symbolSet || '').replace(/\s/g, ''))).join('');
    return o;
  }

  // 長度在 minLength 到 maxLength 之間隨機；每一種勾選的字元至少出現一次。
  function generatePassword(options) {
    const o = normalizeGeneratorOptions(options);
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

  PK.generator = { generatePassword, normalizeGeneratorOptions };
})();
