// 1.21.0 的產生器、產生紀錄、外洩密碼檢查。
// 執行：node --test test/unit/
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('crypto');
const { loadBackground, OPTIONS, POPUP, page } = require('./load-background');

const SITE = page('https://shop.example.com/signup');

async function ok(bg, msg, sender) {
  const res = await bg.send(msg, sender);
  assert.equal(res.ok, true, msg.type + ' 應該成功，結果：' + JSON.stringify(res));
  return res.data;
}

const WORDS = { mode: 'words', words: 6, separator: '-', capitalize: true, addNumber: true };

// 單字裡有分隔符號或數字的話，產生出來的密碼看起來會多一個字，也分不出哪個數字是另外加的
test('單字表：每個字都只有小寫英文字母', () => {
  const bg = loadBackground();
  const odd = Array.from(bg.run('PK.wordlist')).filter((w) => !/^[a-z]+$/.test(w));
  assert.deepEqual(odd, []);
});

test('好記的密碼：照單字數、分隔符號產生，每個字都在單字表裡，只加一個數字', async () => {
  const bg = loadBackground();
  const list = new Set(bg.run('PK.wordlist'));
  assert.equal(list.size, 7772);
  for (let i = 0; i < 50; i++) {
    const { password } = await ok(bg, { type: 'password.generate', options: WORDS }, POPUP);
    const parts = password.split('-');
    assert.equal(parts.length, 6, password);
    assert.equal((password.match(/\d/g) || []).length, 1, '只能有一個數字：' + password);
    for (const p of parts) {
      const word = p.replace(/\d$/, '');
      assert.match(word, /^[A-Z]/, '字首要大寫：' + password);
      assert.ok(list.has(word.toLowerCase()), '不在單字表裡：' + word);
    }
  }
  const plain = await ok(bg, { type: 'password.generate', options: { ...WORDS, words: 4, separator: ' ', capitalize: false, addNumber: false } }, POPUP);
  const parts = plain.password.split(' ');
  assert.equal(parts.length, 4, plain.password);
  assert.ok(parts.every((p) => list.has(p)), plain.password);
});

test('好記的密碼：單字數超出範圍會修正，不認得的分隔符號和模式退回預設', async () => {
  const bg = loadBackground();
  const fix = (o) => bg.run('normalizeGeneratorOptions(' + JSON.stringify(o) + ')');
  assert.equal(fix({ mode: 'words', words: 1 }).words, 3);
  assert.equal(fix({ mode: 'words', words: 99 }).words, 20);
  assert.equal(fix({ mode: 'words', separator: '<script>' }).separator, '-');
  assert.equal(fix({ mode: 'evil' }).mode, 'chars');
  // 舊版存的設定沒有這幾個欄位，照預設值補上
  const old = fix({ minLength: 16, maxLength: 20, upper: true, lower: true, digits: true, symbols: false });
  assert.equal(old.mode, 'chars');
  assert.equal(old.words, 6);
});

test('產生紀錄：網頁上的「產生強密碼」會記，網站用網頁的網址算；網頁讀不到、也刪不了紀錄', async () => {
  const bg = loadBackground();
  await bg.settle();
  const { password } = await ok(bg, { type: 'password.generate' }, SITE);
  const list = await ok(bg, { type: 'generated.list' }, OPTIONS);
  assert.equal(list.length, 1);
  assert.equal(list[0].password, password);
  assert.equal(list[0].host, 'shop.example.com');
  for (const type of ['generated.list', 'generated.delete', 'generated.note']) {
    const res = await bg.send({ type, password: 'x' }, SITE);
    assert.equal(res.ok, false, type + ' 網頁不應該叫得到');
  }
  assert.equal((await ok(bg, { type: 'generated.list' }, OPTIONS)).length, 1);
});

test('產生紀錄：小視窗改選項重產不記，按了複製才記；同一組不重複記；最多 20 組；可以刪一組或全部清掉', async () => {
  const bg = loadBackground();
  await bg.settle();
  await ok(bg, { type: 'password.generate', options: WORDS, save: true }, POPUP);
  assert.equal((await ok(bg, { type: 'generated.list' }, POPUP)).length, 0, '小視窗產生時不記');
  await ok(bg, { type: 'generated.note', password: 'copied-1', host: 'a.example.com' }, POPUP);
  await ok(bg, { type: 'generated.note', password: 'copied-1', host: 'a.example.com' }, POPUP);
  assert.equal((await ok(bg, { type: 'generated.list' }, POPUP)).length, 1, '同一組按複製又按填入只記一次');
  for (let i = 2; i <= 25; i++) await ok(bg, { type: 'generated.note', password: 'copied-' + i }, POPUP);
  let list = await ok(bg, { type: 'generated.list' }, POPUP);
  assert.equal(list.length, 20);
  assert.equal(list[0].password, 'copied-25', '新的排前面');
  list = await ok(bg, { type: 'generated.delete', id: list[0].id }, POPUP);
  assert.equal(list.length, 19);
  assert.equal(list[0].password, 'copied-24');
  list = await ok(bg, { type: 'generated.delete' }, POPUP);
  assert.equal(list.length, 0);
});

test('產生紀錄：不會放進加密備份檔', async () => {
  const bg = loadBackground();
  await bg.settle();
  await ok(bg, { type: 'entries.save', entry: { url: 'https://a.example.com', username: 'u', password: 'saved-pass' } }, OPTIONS);
  await ok(bg, { type: 'generated.note', password: 'generated-only-pass' }, POPUP);
  const { content } = await ok(bg, { type: 'backup.export', password: 'backup-pass-123' }, OPTIONS);
  bg.run('(globalThis.__file = ' + content + ')');
  const text = await bg.run("decryptBackup('backup-pass-123', globalThis.__file)");
  assert.ok(text.includes('saved-pass'), '帳號要在備份裡');
  assert.ok(!text.includes('generated-only-pass'), '產生紀錄不能在備份裡');
});

test('外洩檢查：只送雜湊值前 5 碼，在這裡比對，補位的假資料不算', async () => {
  const bg = loadBackground();
  await bg.settle();
  await ok(bg, { type: 'entries.save', entry: { url: 'https://a.example.com', username: 'u1', password: 'P@ssw0rd' } }, OPTIONS);
  await ok(bg, { type: 'entries.save', entry: { url: 'https://b.example.com', username: 'u2', password: 'not-breached-pass' } }, OPTIONS);
  const sha = (s) => createHash('sha1').update(s).digest('hex').toUpperCase();
  const hit = sha('P@ssw0rd');
  const miss = sha('not-breached-pass');
  const asked = [];
  bg.run(`(globalThis.fetch = async (url, init) => {
    globalThis.__asked.push({ url, padding: init.headers['Add-Padding'], credentials: init.credentials });
    const prefix = url.slice(-5);
    const body = prefix === ${JSON.stringify(hit.slice(0, 5))}
      ? ${JSON.stringify(hit.slice(5))} + ':42\\r\\n' + ${JSON.stringify(miss.slice(5))} + ':0\\r\\nFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF:3'
      : ${JSON.stringify(miss.slice(5))} + ':0';
    return { ok: true, status: 200, text: async () => body };
  }, globalThis.__asked = [], true)`);
  const result = await ok(bg, { type: 'breach.check' }, OPTIONS);
  Object.assign(asked, bg.run('globalThis.__asked'));
  assert.equal(result.checked, 2);
  assert.equal(result.found.length, 1);
  assert.equal(result.found[0].count, 42);
  const urls = asked.map((a) => a.url).sort();
  assert.deepEqual(urls, ['https://api.pwnedpasswords.com/range/' + hit.slice(0, 5), 'https://api.pwnedpasswords.com/range/' + miss.slice(0, 5)].sort());
  for (const a of asked) {
    assert.equal(a.padding, 'true', '要加 Add-Padding');
    assert.equal(a.credentials, 'omit', '不帶 cookie');
    assert.ok(!a.url.includes('P@ssw0rd') && !a.url.includes(hit.slice(5)), '不能送出密碼或完整雜湊值');
  }
});

test('外洩檢查：網頁叫不到；連不上時回錯誤訊息', async () => {
  const bg = loadBackground();
  await bg.settle();
  await ok(bg, { type: 'entries.save', entry: { url: 'https://a.example.com', username: 'u', password: 'x-pass' } }, OPTIONS);
  const fromPage = await bg.send({ type: 'breach.check' }, page('https://a.example.com/'));
  assert.equal(fromPage.ok, false);
  bg.run("(globalThis.fetch = async () => ({ ok: false, status: 503, text: async () => '' }), true)");
  const res = await bg.send({ type: 'breach.check' }, OPTIONS);
  assert.equal(res.ok, false);
  assert.equal(res.error, bg.text('bg_breach_failed', 'HTTP 503'));
});
