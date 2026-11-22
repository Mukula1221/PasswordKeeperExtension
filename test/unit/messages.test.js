// 背景程式收訊息時檢查是誰送的：網頁裡的 content.js 只能叫它用得到的訊息，網站也一律用它所在的網址算。
// 網頁的執行程序被攻破時，攻擊者可以冒充 content.js 送任何訊息，這裡模擬的就是那種情況。
// 執行：node --test test/unit/
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { loadBackground, OPTIONS, POPUP, page, ROOT } = require('./load-background');

const EVIL = page('https://evil.example/login');

function contentMessageTypes() {
  const text = fs.readFileSync(path.join(ROOT, 'src', 'content', 'content.js'), 'utf8');
  return [...new Set([...text.matchAll(/\btype:\s*'([\w.]+)'/g)].map((m) => m[1]))].sort();
}

async function ok(bg, msg, sender) {
  const res = await bg.send(msg, sender);
  assert.equal(res.ok, true, msg.type + ' 應該成功，結果：' + JSON.stringify(res));
  return res.data;
}

async function rejected(bg, msg, sender, key) {
  const res = await bg.send(msg, sender);
  assert.equal(res.ok, false, JSON.stringify(msg) + ' 應該被拒絕，結果：' + JSON.stringify(res));
  if (key) assert.equal(res.error, bg.text(key));
  return res;
}

async function saveFromOptions(bg, entry) {
  return (await ok(bg, { type: 'entries.save', entry }, OPTIONS)).entry;
}

test('每種訊息都有規則，規則也都有對應的訊息', () => {
  const bg = loadBackground();
  // 展開成這邊的陣列：vm 裡的陣列原型不同，deepEqual 會判成不相等
  const handlers = [...bg.run('Object.keys(handlers)')].sort();
  const rules = bg.run('MESSAGE_RULES');
  assert.deepEqual(Object.keys(rules).sort(), handlers);
  for (const [type, rule] of Object.entries(rules)) {
    assert.ok(['any', 'extension'].includes(rule.from), type + ' 的 from 要是 any 或 extension');
    assert.ok(rule.whenLocked === undefined || rule.whenLocked === true, type + ' 的 whenLocked 只能是 true 或不寫');
  }
});

test('只有 content.js 用得到的訊息才開放給網頁', () => {
  const bg = loadBackground();
  const rules = bg.run('MESSAGE_RULES');
  const any = Object.keys(rules).filter((type) => rules[type].from === 'any').sort();
  assert.deepEqual(any, contentMessageTypes());
});

test('網頁送來只限擴充功能頁面的訊息，一律拒絕', async () => {
  const bg = loadBackground();
  const rules = bg.run('MESSAGE_RULES');
  for (const type of Object.keys(rules).filter((t) => rules[t].from === 'extension')) {
    await rejected(bg, { type }, EVIL, 'bg_extension_page_only');
  }
  // 沒有 url 的 sender 也不算擴充功能頁面
  await rejected(bg, { type: 'entries.all' }, {}, 'bg_extension_page_only');
});

test('不認得的訊息和 Object 內建的名字都拒絕', async () => {
  const bg = loadBackground();
  for (const type of ['nope', 'toString', 'constructor', '__proto__', 'hasOwnProperty', 'valueOf']) {
    await rejected(bg, { type }, OPTIONS);
  }
  await rejected(bg, null, OPTIONS);
  await rejected(bg, { type: 42 }, OPTIONS);
});

test('網頁只拿得到自己網站的帳號，訊息裡帶的 host 不算數', async () => {
  const bg = loadBackground();
  await saveFromOptions(bg, { host: 'bank.example', username: 'alice', password: 'bank-pw' });
  await saveFromOptions(bg, { host: 'evil.example', username: 'mallory', password: 'evil-pw' });

  const fromPage = await ok(bg, { type: 'entries.forHost', host: 'bank.example' }, EVIL);
  assert.deepEqual(fromPage.entries.map((e) => e.username), ['mallory']);

  // 小視窗要看目前分頁的網站，用訊息裡帶的
  const fromPopup = await ok(bg, { type: 'entries.forHost', host: 'bank.example' }, POPUP);
  assert.deepEqual(fromPopup.entries.map((e) => e.username), ['alice']);
});

test('網頁不能存別的網站的帳號，origin 也不收網頁給的', async () => {
  const bg = loadBackground();
  await rejected(bg, { type: 'entries.save', entry: { host: 'bank.example', username: 'x', password: 'y' } }, EVIL, 'bg_site_not_allowed');

  const saved = await ok(
    bg,
    { type: 'entries.save', entry: { host: 'evil.example', origin: 'javascript:alert(1)', username: 'm', password: 'p' } },
    EVIL
  );
  assert.equal(saved.entry.origin, 'https://evil.example');

  const all = await ok(bg, { type: 'entries.all' }, OPTIONS);
  assert.deepEqual(all.map((e) => e.host), ['evil.example']);
});

test('登入後跳到別的網域，還是能存剛登入的那個網站', async () => {
  const bg = loadBackground();
  const login = page('https://login.example/signin', 7);
  const app = page('https://app.other/home', 7);

  // pending.set 帶的 host 是假的，背景程式要用 content.js 所在的網址記
  await ok(
    bg,
    { type: 'pending.set', host: 'bank.example', origin: 'https://bank.example', username: 'u', password: 'p', submitUrl: 'https://login.example/signin' },
    login
  );
  const decision = await ok(bg, { type: 'pending.get' }, app);
  assert.equal(decision.pending.host, 'login.example');
  assert.equal(decision.pending.origin, 'https://login.example');

  // 同一個分頁跳到 app.other 後，跳出來的「要儲存嗎？」存的是 login.example
  const saved = await ok(bg, { type: 'entries.save', entry: { host: 'login.example', origin: 'https://evil.example', username: 'u', password: 'p' } }, app);
  assert.equal(saved.entry.origin, 'https://login.example');
  await rejected(bg, { type: 'entries.save', entry: { host: 'bank.example', username: 'u', password: 'p' } }, app, 'bg_site_not_allowed');

  // 別的分頁沒有暫存，不能存 login.example
  await rejected(bg, { type: 'entries.save', entry: { host: 'login.example', username: 'v', password: 'q' } }, page('https://app.other/home', 8), 'bg_site_not_allowed');
});

test('登入框在 iframe 裡時，最外層的頁面可以存 iframe 那個網站', async () => {
  const bg = loadBackground();
  await ok(bg, { type: 'pending.set', host: 'sso.example', username: 'u', password: 'p' }, page('https://sso.example/frame', 7, 3));
  await ok(bg, { type: 'entries.save', entry: { host: 'sso.example', username: 'u', password: 'p' } }, page('https://portal.example/', 7, 0));
  await ok(bg, { type: 'neverSave.add', host: 'sso.example' }, page('https://portal.example/', 7, 0));
});

test('網頁不能拿 id 改掉別的網站的帳號', async () => {
  const bg = loadBackground();
  const bank = await saveFromOptions(bg, { host: 'bank.example', username: 'alice', password: 'bank-pw' });
  await rejected(bg, { type: 'entries.save', id: bank.id, entry: { host: 'evil.example', username: 'alice', password: 'stolen' } }, EVIL, 'bg_site_not_allowed');
  const all = await ok(bg, { type: 'entries.all' }, OPTIONS);
  assert.equal(all.length, 1);
  assert.equal(all[0].host, 'bank.example');
  assert.equal(all[0].password, 'bank-pw');
});

test('網頁只能把自己的網站設成永遠不問', async () => {
  const bg = loadBackground();
  await rejected(bg, { type: 'neverSave.add', host: 'bank.example' }, EVIL, 'bg_site_not_allowed');
  await ok(bg, { type: 'neverSave.add', host: 'evil.example' }, EVIL);
  const settings = await ok(bg, { type: 'settings.get' }, OPTIONS);
  assert.deepEqual(settings.neverSave, ['evil.example']);
});

test('網頁產生密碼時不能改掉產生密碼的設定', async () => {
  const bg = loadBackground();
  const weak = { minLength: 4, maxLength: 4, upper: false, lower: true, digits: false, symbols: false };
  const fromPage = await ok(bg, { type: 'password.generate', options: weak, save: true }, EVIL);
  assert.ok(fromPage.password.length >= 16, '網頁給的選項不該生效：' + fromPage.password);
  assert.equal((await ok(bg, { type: 'settings.get' }, OPTIONS)).generator.minLength, 16);

  // 小視窗改選項照常能存
  await ok(bg, { type: 'password.generate', options: weak, save: true }, POPUP);
  assert.equal((await ok(bg, { type: 'settings.get' }, OPTIONS)).generator.minLength, 4);
});

test('網頁選的自動點選規則，一律存在網頁自己的網站底下', async () => {
  const bg = loadBackground();
  const rule = { host: 'bank.example', path: '/login', selector: '#go', text: 'Go', when: 'onLoad' };
  await ok(bg, { type: 'clickRules.save', rule }, page('https://site.example/login'));
  const settings = await ok(bg, { type: 'settings.get' }, OPTIONS);
  assert.deepEqual(settings.clickRules.map((r) => r.host), ['site.example']);

  const forBank = await ok(bg, { type: 'clickRules.forHost', host: 'site.example' }, page('https://bank.example/login'));
  assert.equal(forBank.rules.length, 0);
});

test('鎖住時擋的訊息跟原本一樣', async () => {
  const bg = loadBackground();
  await bg.settle();
  await bg.chrome.storage.local.set({ settings: { lock: { enabled: true, mode: 'screen' } } });
  await bg.chrome.storage.session.set({ locked: true });

  const res = await rejected(bg, { type: 'entries.all' }, OPTIONS);
  assert.equal(res.locked, true);
  await ok(bg, { type: 'lock.status' }, OPTIONS);
  const forHost = await ok(bg, { type: 'entries.forHost' }, EVIL);
  assert.equal(forHost.locked, true);
  assert.equal((await rejected(bg, { type: 'entries.save', entry: { host: 'evil.example', password: 'p' } }, EVIL)).locked, true);
});

test('主網域、網址轉網站', () => {
  const bg = loadBackground();
  const baseDomain = bg.run('baseDomain');
  assert.equal(baseDomain('jira.example.com'), 'example.com');
  assert.equal(baseDomain('a.b.example.com.tw'), 'example.com.tw');
  assert.equal(baseDomain('192.168.1.10'), '192.168.1.10');
  assert.equal(baseDomain('localhost'), 'localhost');
  assert.equal(baseDomain('[::1]'), '[::1]');

  const hostFromUrl = bg.run('hostFromUrl');
  assert.equal(hostFromUrl('HTTPS://Bank.Example:8443/x?y=1'), 'bank.example');
  assert.equal(hostFromUrl('javascript:alert(1)'), '');
  assert.equal(hostFromUrl('not a url'), '');
  assert.equal(hostFromUrl(undefined), '');
});

test('擴充功能頁面的網址用 getURL 算', () => {
  const bg = loadBackground();
  assert.equal(bg.run('extensionOrigin()'), 'chrome-extension://unittestextensionid');
  assert.equal(bg.run('fromExtensionPage')(OPTIONS), true);
  assert.equal(bg.run('fromExtensionPage')({ url: 'chrome-extension://otherextension/src/options/options.html' }), false);
  assert.equal(bg.run('fromExtensionPage')({ url: 'chrome-extension://unittestextensionid.evil.example/' }), false);
  assert.equal(bg.run('fromExtensionPage')(EVIL), false);
});
