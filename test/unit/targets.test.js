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
  // 外洩密碼檢查送出雜湊值的前 5 碼，使用者按檢查時才請 Firefox 跳同意視窗，所以是選用的
  assert.deepEqual(gecko.data_collection_permissions, { required: ['none'], optional: ['authenticationInfo'] });
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
const GECKO_ID = targetManifest('firefox').browser_specific_settings.gecko.id;
const GH_RELEASES = 'https://github.com/Mukula1221/PasswordKeeperExtension/releases/';

// 假的 GitHub /releases/latest，附檔跟 release.yml 放上去的一樣。Firefox 版的排前面，確定是照檔名找，不是拿第一個 zip。
function fakeRelease(version) {
  const asset = (name) => ({ name, browser_download_url: GH_RELEASES + 'download/v' + version + '/' + name });
  return {
    tag_name: 'v' + version,
    html_url: GH_RELEASES + 'tag/v' + version,
    published_at: '2026-11-23T04:00:00Z',
    assets: [
      asset('password-keeper-' + version + '-firefox.zip'),
      asset('password-keeper-' + version + '-firefox.zip.sha256'),
      asset('password-keeper-' + version + '.zip'),
      asset('password-keeper-' + version + '.zip.sha256'),
    ],
  };
}

// 把背景程式的 fetch 換成回 fakeRelease，回傳問過的網址。
// 假的背景程式沒有 AbortSignal，平常叫 fetch 之前就會出錯，這裡才補上。
function answerWithRelease(bg, version) {
  const asked = [];
  const bgGlobal = bg.run('globalThis');
  bgGlobal.AbortSignal = AbortSignal;
  bgGlobal.fetch = async (url) => {
    asked.push(url);
    return { status: 200, ok: true, json: async () => fakeRelease(version) };
  };
  return asked;
}

test('Firefox 版的 ID：背景程式認的跟 platforms/firefox/manifest.json 一樣', () => {
  assert.equal(loadBackground().run('FIREFOX_ID'), GECKO_ID);
});

test('Firefox 暫時載入的：Firefox 版，按立即檢查才問，下載 Firefox 版的 zip', async () => {
  const ff = loadBackground(FIREFOX);
  ff.chrome.runtime.id = GECKO_ID;
  const st = await ff.send({ type: 'update.status' }, ff.OPTIONS);
  assert.equal(st.data.channel, 'firefox');
  assert.equal(st.data.release, false);
  const asked = answerWithRelease(ff, '99.0.0');
  await ff.send({ type: 'update.setAuto', enabled: true }, ff.OPTIONS);
  assert.equal(asked.length, 0, '自動檢查打開也不會問');
  const res = await ff.send({ type: 'update.check' }, ff.OPTIONS);
  assert.equal(asked.length, 1);
  assert.equal(res.data.available, true);
  assert.equal(res.data.latest.zipUrl, GH_RELEASES + 'download/v99.0.0/password-keeper-99.0.0-firefox.zip');
});

test('GitHub 版：Release 上也有 Firefox 版的 zip 時，只下載自己的', async () => {
  const bg = loadBackground();
  bg.chrome.runtime.id = bg.run('RELEASE_ID');
  answerWithRelease(bg, '99.0.0');
  const res = await bg.send({ type: 'update.check' }, OPTIONS);
  assert.equal(res.data.latest.zipUrl, GH_RELEASES + 'download/v99.0.0/password-keeper-99.0.0.zip');
});

test('能力表：Edge、Chrome 都可以，Firefox 都不行，寫錯名稱直接報錯', () => {
  const bg = loadBackground();
  const ff = loadBackground(FIREFOX);
  assert.equal(bg.run('engine()'), 'chromium');
  assert.equal(ff.run('engine()'), 'firefox');
  for (const name of ['extensionWebAuthn', 'screenLockEvents', 'privateWindows', 'openExtensionsPage']) {
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
