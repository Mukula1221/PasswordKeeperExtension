// 各版本的差別：打包出來的 manifest（tools/build.js），和程式怎麼分出自己是哪一種版本、哪個瀏覽器。
// 執行：node --test test/unit/
const test = require('node:test');
const assert = require('node:assert/strict');
const { targetManifest, backgroundScripts, RELEASE_KEY } = require('../../tools/build');
const { readManifest } = require('../../tools/lib/project');
const { loadBackground, OPTIONS } = require('./load-background');

test('GitHub 版：加固定公鑰，其他跟原始碼一樣', () => {
  const source = readManifest();
  const m = targetManifest('github', source);
  assert.equal(m.key, RELEASE_KEY);
  assert.deepEqual({ ...m, key: undefined }, { ...source, key: undefined });
});

test('Chromium 商店版：不放 key，跟原始碼一樣', () => {
  const source = readManifest();
  const m = targetManifest('chromium-store', source);
  assert.equal('key' in m, false);
  assert.deepEqual(m, source);
});

test('Firefox 版：背景程式改列 scripts，加 AMO 規定的欄位', () => {
  const source = readManifest();
  const m = targetManifest('firefox', source);
  assert.equal('key' in m, false);
  assert.equal('minimum_chrome_version' in m, false);
  assert.equal('service_worker' in m.background, false);
  assert.deepEqual(m.background.scripts, backgroundScripts());
  // 順序要跟 background.js 的 importScripts 一樣，platform.js、i18n.js 要最先載入
  assert.deepEqual(m.background.scripts.slice(0, 2), ['src/shared/platform.js', 'src/shared/i18n.js']);
  const gecko = m.browser_specific_settings.gecko;
  assert.match(gecko.id, /^\{[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}$/);
  assert.deepEqual(gecko.data_collection_permissions, { required: ['none'] });
  assert.equal(gecko.strict_min_version, '140.0');
  assert.deepEqual(m.permissions, source.permissions);
  assert.deepEqual(m.host_permissions, source.host_permissions);
});

async function updateStatus(bg) {
  const res = await bg.send({ type: 'update.status' }, OPTIONS);
  assert.equal(res.ok, true, JSON.stringify(res));
  return res.data;
}

test('載入解壓縮、ID 不是正式版的：開發版', async () => {
  const bg = loadBackground();
  const st = await updateStatus(bg);
  assert.equal(st.channel, 'dev');
  assert.equal(st.release, false);
});

test('載入解壓縮、ID 是正式版的：GitHub 版', async () => {
  const bg = loadBackground();
  bg.chrome.runtime.id = bg.run('RELEASE_ID');
  const st = await updateStatus(bg);
  assert.equal(st.channel, 'github');
  assert.equal(st.release, true);
});

test('從商店裝的：商店版，不連 GitHub', async () => {
  const bg = loadBackground();
  bg.chrome.management.getSelf = async () => ({ installType: 'normal' });
  // 就算 ID 剛好跟 GitHub 版一樣，從商店裝的也算商店版
  bg.chrome.runtime.id = bg.run('RELEASE_ID');
  const st = await updateStatus(bg);
  assert.equal(st.channel, 'store');
  assert.equal(st.release, false);
  const check = await bg.send({ type: 'update.check' }, OPTIONS);
  assert.equal(check.ok, false);
  assert.equal(check.error, bg.text('bg_update_store'));
  // 自動檢查打開也不會問：測試的 fetch 一叫就失敗，有叫到的話 updateInfo 會記下錯誤
  await bg.send({ type: 'update.setAuto', enabled: true }, OPTIONS);
  assert.equal(bg.chrome.storage.local.data.updateInfo, undefined);
});

const FIREFOX = { origin: 'moz-extension://3b6f7c1e-0000-4000-8000-000000000001' };

test('能力表：Edge、Chrome 都可以，Firefox 三項都不行，寫錯名稱直接報錯', () => {
  const bg = loadBackground();
  const ff = loadBackground(FIREFOX);
  assert.equal(bg.run('engine()'), 'chromium');
  assert.equal(ff.run('engine()'), 'firefox');
  for (const name of ['extensionWebAuthn', 'screenLockEvents', 'privateWindows']) {
    assert.equal(bg.run(`can('${name}')`), true, name);
    assert.equal(ff.run(`can('${name}')`), false, name);
  }
  assert.throws(() => bg.run(`can('extensionWebAuthm')`), /沒有這個能力/);
});

test('Firefox 不能設定系統驗證加密', async () => {
  const ff = loadBackground(FIREFOX);
  // 管理頁不顯示，網頁或改過的管理頁硬送過來也要擋
  const res = await ff.send({ type: 'lock.setMode', mode: 'hello', setup: {} }, ff.OPTIONS);
  assert.equal(res.ok, false);
  assert.equal(res.error, ff.text('wa_unsupported'));
});

// 私密分頁裡的 content.js，跟一般分頁只差 tab.incognito
function privateTab(url) {
  return { url, frameId: 0, tab: { id: 7, url, incognito: true } };
}

test('Firefox 私密分頁：content.js 送來的訊息一律拒絕，管理頁照常', async () => {
  const ff = loadBackground(FIREFOX);
  const login = 'https://login.example/';
  for (const msg of [
    { type: 'entries.forHost', host: 'login.example' },
    { type: 'pending.set', data: { username: 'u', password: 'p' } },
    { type: 'entries.save', entry: { host: 'login.example', username: 'u', password: 'p' } },
  ]) {
    const res = await ff.send(msg, privateTab(login));
    assert.equal(res.ok, false, msg.type);
    assert.equal(res.error, ff.text('bg_private_window_blocked'), msg.type);
  }
  const pendingKeys = Object.keys(ff.chrome.storage.session.data).filter((k) => k.startsWith('pending:'));
  assert.deepEqual(pendingKeys, [], '私密分頁的帳密不能暫存');
  // 管理頁開在私密視窗也一樣能用，管的是已經存好的帳號
  const privateOptions = { ...ff.OPTIONS, tab: { ...ff.OPTIONS.tab, incognito: true } };
  const status = await ff.send({ type: 'lock.status' }, privateOptions);
  assert.equal(status.ok, true);
});

test('Edge、Chrome 的私密分頁照常', async () => {
  const bg = loadBackground();
  const res = await bg.send({ type: 'entries.forHost', host: 'login.example' }, privateTab('https://login.example/'));
  assert.equal(res.ok, true, JSON.stringify(res));
});

test('Firefox 私密分頁：瀏覽器的帳密視窗不回答', async () => {
  const ff = loadBackground(FIREFOX);
  await ff.send({ type: 'entries.save', entry: { host: 'intranet.example', origin: 'https://intranet.example', username: 'u', password: 'p' } }, ff.OPTIONS);
  const [onAuth] = ff.chrome.webRequest.onAuthRequired.listeners;
  const answer = (details) => new Promise((resolve) => onAuth(details, resolve));
  const base = { requestId: 'r1', challenger: { host: 'intranet.example', port: 443 }, isProxy: false };
  assert.deepEqual(JSON.parse(JSON.stringify(await answer({ ...base, incognito: true }))), {});
  const normal = await answer({ ...base, requestId: 'r2', incognito: false });
  assert.equal(normal.authCredentials.username, 'u');
});
