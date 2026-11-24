// 把 Firefox 版裝進真的 Firefox，跑幾個主要流程。看不到視窗，跑完會關掉 Firefox。不用裝套件。
//   node test/e2e/firefox.js                    用找得到的 Firefox
//   node test/e2e/firefox.js <firefox.exe 路徑>
// Edge、Chrome 的完整流程在 run.js。這裡只測 Firefox 跟它們不一樣、或最容易壞的地方。
// 結束代碼：0 全過、1 有案例沒過、2 跑不起來。
const fs = require('fs');
const http = require('http');
const path = require('path');
const { findBrowser, startServer, sleep, WORK } = require('./lib');
const { launchFirefox, openTab } = require('./bidi');
const PACKAGE_FILES = require('../../tools/files');
const { targetManifest, build } = require('../../tools/build');

const ROOT = path.join(__dirname, '..', '..');
// 跟 run.js、package.js 錯開，同時跑也不會搶
const PORT = 8775;
const AUTH_PORT = 8776;
const BIDI_PORT = 9335;
const ORIGIN = 'http://127.0.0.1:' + PORT;
const T = ORIGIN + '/test/';
const SHOTS = path.join(WORK, 'shots');
const DOWNLOADS = path.join(WORK, 'ff-downloads');
// 固定擴充功能的網址，管理頁才知道要開哪裡。Firefox 平常是安裝時隨機產生。
const UUID = '7c0a3f52-5d8e-4b6a-9f21-3e4d5c6b7a80';
const EXT = 'moz-extension://' + UUID + '/';

const MASTER = 'firefox-master-123';
const BACKUP_PASSWORD = 'firefox-backup-123';

const GH_RELEASES = 'https://github.com/Mukula1221/PasswordKeeperExtension/releases/';

// 假的 GitHub /releases/latest，?v= 是版本號。附檔跟 release.yml 放上去的一樣。
const ROUTES = {
  '/fake-gh/latest': (url) => {
    const v = url.searchParams.get('v');
    const asset = (name) => ({ name, browser_download_url: GH_RELEASES + 'download/v' + v + '/' + name });
    return JSON.stringify({
      tag_name: 'v' + v,
      html_url: GH_RELEASES + 'tag/v' + v,
      published_at: '2026-11-23T04:00:00Z',
      assets: ['.zip', '.zip.sha256', '-firefox.zip', '-firefox.zip.sha256'].map((ext) => asset('password-keeper-' + v + ext)),
    });
  },
};

fs.mkdirSync(SHOTS, { recursive: true });

// 一般視窗的案例，和另外開一個整個都是私密瀏覽的 Firefox 跑的案例
const cases = [];
const privateCases = [];
const test = (name, fn) => cases.push({ name, fn });
const privateTest = (name, fn) => privateCases.push({ name: '私密視窗：' + name, fn });

function check(cond, label) {
  if (!cond) throw new Error('沒過：' + label);
}

async function until(fn, ms = 8000, step = 200) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
      if (last) return last;
    } catch {
      // 頁面正在跳轉時 eval 會失敗，再試一次
    }
    await sleep(step);
  }
  return last;
}

// 照 Firefox 版的 manifest 放一份解開的擴充功能，跟打包的 zip 內容一樣
function copyFirefoxExtension() {
  const dest = path.join(WORK, 'ext-firefox');
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  for (const name of PACKAGE_FILES) fs.cpSync(path.join(ROOT, name), path.join(dest, name), { recursive: true });
  fs.writeFileSync(path.join(dest, 'manifest.json'), JSON.stringify(targetManifest('firefox'), null, 2) + '\n');
  return dest;
}

// 要求瀏覽器自己跳帳密視窗（HTTP Basic）的網站。帳密對了才回 ok，記下收到的帳號。
function startAuthServer() {
  const seen = [];
  const server = http.createServer((req, res) => {
    const auth = req.headers.authorization || '';
    const [user, pass] = auth.startsWith('Basic ') ? Buffer.from(auth.slice(6), 'base64').toString().split(':') : [];
    seen.push(user || '');
    if (user === 'test-user@example.test' && pass === 'right') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end('<p id="ok">ok</p>');
    }
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="pk-e2e"' });
    res.end('need auth');
  });
  return new Promise((resolve) => server.listen(AUTH_PORT, '127.0.0.1', () => resolve({ server, seen })));
}

let fx;
let options;

// 從管理頁送訊息給背景程式，跟管理頁自己送的一樣
const send = (msg) => options.eval(`new Promise((resolve) => chrome.runtime.sendMessage(${JSON.stringify(msg)}, resolve))`);
const t = (key, ...subs) => options.eval(`PK.i18n.t(${JSON.stringify(key)}, ...${JSON.stringify(subs)})`);

test('裝得起來：背景程式收得到訊息，認得出是 Firefox、暫時載入的 Firefox 版', async () => {
  const st = await send({ type: 'lock.status' });
  check(st && st.ok, '背景程式要回 lock.status：' + JSON.stringify(st));
  check((await options.eval('PK.platform.engine()')) === 'firefox', '要認得出是 Firefox');
  check((await options.eval('PK.platform.extensionOrigin()')) === EXT.slice(0, -1), '擴充功能網址要是 moz-extension://');
  const up = await send({ type: 'update.status' });
  check(up.ok && up.data.channel === 'firefox', '暫時載入的要算 Firefox 版：' + JSON.stringify(up));
  const title = await options.eval(`document.querySelector('h1').textContent`);
  check(title === (await t('ext_name')), '管理頁要套上介面文字：' + title);
});

test('網站權限：安裝時就給了所有網站', async () => {
  const granted = await options.eval(`chrome.permissions.contains({ origins: ['http://127.0.0.1/*'] })`);
  check(granted === true, '安裝後要有測試網站的權限，不然網頁上什麼都不會跳');
});

test('工具鎖定：不顯示系統驗證加密，閒置時間旁邊有說明', async () => {
  await options.goto(EXT + 'src/options/options.html#settings', 1500);
  const view = await options.eval(`({
    hello: document.getElementById('lockCardHello').hidden,
    password: document.querySelector('input[name="lockMode"][value="password"]').disabled,
    info: document.getElementById('lockInfo').textContent,
    tip: !document.getElementById('lockIdleTip').hidden,
  })`);
  check(view.hello && !view.password, '系統驗證加密的卡片要隱藏，自訂密碼加密可以選：' + JSON.stringify(view));
  check(view.info === (await t('opt_lock_info_no_hello')), '要說明只能選自訂密碼加密：' + view.info);
  check(view.tip, '閒置時間旁邊要有鎖螢幕的說明');
  // 工具鎖定的區塊預設收合，展開才截得到三張卡片
  await options.eval(`(() => {
    const box = document.getElementById('lockMinutes').closest('details');
    box.open = true;
    box.scrollIntoView({ block: 'start' });
    return true;
  })()`);
  await sleep(300);
  await options.screenshot(path.join(SHOTS, 'ff-options-lock.png'));
  const res = await send({ type: 'lock.setMode', mode: 'hello', setup: {} });
  check(!res.ok && res.error === (await t('wa_unsupported')), '背景程式也要擋系統驗證加密：' + JSON.stringify(res));
});

test('網頁：存的帳號會自動填入', async () => {
  const saved = await send({ type: 'entries.save', entry: { host: '127.0.0.1', origin: ORIGIN, username: 'test-user@example.test', password: 'right' } });
  check(saved.ok, '存帳號：' + JSON.stringify(saved));
  const page = await openTab(fx.bidi, T + 'harness.html', 1500);
  try {
    const filled = await until(() => page.eval(`document.getElementById('p').value === 'right' && document.getElementById('u').value`), 6000);
    check(filled === 'test-user@example.test', '帳號密碼要自動填好：' + filled);
  } finally {
    await page.close();
  }
});

test('網頁：登入後背景程式收到要問要不要儲存的帳密', async () => {
  const page = await openTab(fx.bidi, T + 'harness.html', 1500);
  try {
    await page.eval(`(() => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      for (const [id, v] of [['u', 'typed-user'], ['p', 'typed-pass']]) {
        const el = document.getElementById(id);
        set.call(el, v);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
      document.querySelector('button[type=submit]').click();
      return true;
    })()`);
    const pending = await until(
      () => options.eval(`chrome.storage.session.get(null).then((all) => Object.entries(all).filter(([k, v]) => k.startsWith('pending:') && v.username === 'typed-user').length)`),
      6000
    );
    check(pending === 1, '背景程式要暫存剛送出的帳密');
    await sleep(800);
    await page.screenshot(path.join(SHOTS, 'ff-save-prompt.png'));
  } finally {
    await page.close();
  }
});

test('瀏覽器的帳密視窗：有存帳號的網站直接回答', async () => {
  const auth = await startAuthServer();
  const page = await openTab(fx.bidi, null);
  try {
    // 帳密視窗會讓 navigate 一直等不到載入完成，所以不等，之後看頁面內容
    fx.bidi.send('browsingContext.navigate', { context: page.context, url: 'http://127.0.0.1:' + AUTH_PORT + '/auth', wait: 'none' }).catch(() => {});
    const ok = await until(() => page.eval(`document.getElementById('ok') ? document.getElementById('ok').textContent : ''`), 8000);
    check(ok === 'ok', '要用存的帳密通過驗證，收到的帳號：' + JSON.stringify(auth.seen));
  } finally {
    await page.close();
    auth.server.close();
  }
});

test('自動備份：用 blob 網址存到下載資料夾底下的子資料夾', async () => {
  const set = await send({ type: 'autoBackup.set', password: BACKUP_PASSWORD, folder: 'pk-firefox-e2e' });
  check(set.ok, '設定自動備份：' + JSON.stringify(set));
  const run = await send({ type: 'autoBackup.runNow' });
  check(run.ok, '立即備份要成功：' + JSON.stringify(run));
  const files = await options.eval(`chrome.downloads.search({ filenameRegex: 'pk-firefox-e2e' }).then((list) => list.map((d) => ({ state: d.state, exists: d.exists, filename: d.filename })))`);
  check(files.length === 1 && files[0].state === 'complete' && files[0].exists, '下載要完成：' + JSON.stringify(files));
  check(/[\\/]pk-firefox-e2e[\\/][^\\/]+\.pkbak$/.test(files[0].filename), '要存在子資料夾裡、副檔名 .pkbak：' + files[0].filename);
});

test('工具鎖定：自訂密碼加密，鎖上之後打自訂密碼解開', async () => {
  const set = await send({ type: 'lock.setMode', mode: 'password', setup: { password: MASTER } });
  check(set.ok && set.data.mode === 'password', '換成自訂密碼加密：' + JSON.stringify(set));
  const locked = await send({ type: 'lock.now' });
  check(locked.ok && locked.data.locked, '要鎖上：' + JSON.stringify(locked));
  const blocked = await send({ type: 'entries.all' });
  check(!blocked.ok, '鎖住時不能讀帳號');
  const wrong = await send({ type: 'lock.unlockPassword', password: 'wrong-password-1' });
  check(!wrong.ok && wrong.error === (await t('bg_master_password_wrong')), '打錯要說自訂密碼不對：' + JSON.stringify(wrong));
  const right = await send({ type: 'lock.unlockPassword', password: MASTER });
  check(right.ok && !right.data.locked, '打對要解開：' + JSON.stringify(right));
  const all = await send({ type: 'entries.all' });
  check(all.ok && all.data.some((e) => e.username === 'test-user@example.test' && e.password === 'right'), '解開後要讀得到加密前存的帳號');
});

test('小視窗：打得開，畫面有套上介面文字', async () => {
  const popup = await openTab(fx.bidi, EXT + 'src/popup/popup.html', 1200);
  try {
    const manage = await popup.eval(`document.getElementById('manage').textContent`);
    check(manage === (await t('pop_manage')), '小視窗要套上介面文字：' + manage);
    await popup.screenshot(path.join(SHOTS, 'ff-popup.png'));
  } finally {
    await popup.close();
  }
});

// Firefox 的背景程式是一般頁面，管理頁拿得到，可以把 GitHub 換成 ROUTES 的假 GitHub
const useUpdateApi = (url) => options.eval(`chrome.runtime.getBackgroundPage().then((bg) => (bg.PK.update.useUpdateApi(${JSON.stringify(url)}), true))`);

test('版本分頁：寫明是暫時載入的 Firefox 版，有新版時下載 Firefox 版的 zip', async () => {
  let page = null;
  try {
    await useUpdateApi(ORIGIN + '/fake-gh/latest?v=99.0.0');
    const res = await send({ type: 'update.check' });
    check(res.ok && res.data.available && !res.data.release, '要看出有新版，自動檢查不能打開：' + JSON.stringify(res));
    check(res.data.latest.zipUrl === GH_RELEASES + 'download/v99.0.0/password-keeper-99.0.0-firefox.zip', '要下載 Firefox 版的 zip：' + res.data.latest.zipUrl);
    page = await openTab(fx.bidi, EXT + 'src/options/options.html#versions', 1500);
    const view = await page.eval(`(() => {
      const shown = (id) => document.getElementById(id).checkVisibility();
      return {
        firefox: shown('updateFirefox'),
        dev: shown('updateDev'),
        stepsFirefox: shown('updateStepsFirefox'),
        steps: shown('updateSteps'),
        download: shown('updateDownload'),
        extensions: shown('updateExtensions'),
        autoDisabled: document.getElementById('updateAuto').disabled,
        autoShown: shown('updateAutoWrap'),
      };
    })()`);
    check(view.firefox && !view.dev, '要說是暫時載入的 Firefox 版，不是開發版：' + JSON.stringify(view));
    check(view.stepsFirefox && !view.steps && view.download, '要寫 Firefox 的載入步驟，給下載按鈕：' + JSON.stringify(view));
    check(!view.extensions && view.autoDisabled && !view.autoShown, 'Firefox 開不了擴充功能管理頁，不顯示那顆按鈕，也不顯示自動檢查的勾選框：' + JSON.stringify(view));
    await page.screenshot(path.join(SHOTS, 'ff-update-available.png'));
  } finally {
    await useUpdateApi(null);
    await options.eval(`chrome.storage.local.remove('updateInfo').then(() => true)`);
    if (page) await page.close();
  }
});

// 照「版本」分頁寫的步驟：拿打包出來的 Firefox 版 zip 本身，再暫時載入一次。
// 會重新啟動擴充功能，所以排在一般視窗的最後一個。
test('載入新版：Firefox 版的 zip 再暫時載入一次，存的帳號和工具鎖定都還在', async () => {
  const { file } = build('firefox');
  await fx.bidi.send('webExtension.install', { extensionData: { type: 'archivePath', path: file } });
  await sleep(1500);
  options = await openTab(fx.bidi, EXT + 'src/options/options.html', 1500);
  const st = await send({ type: 'lock.status' });
  check(st.ok && st.data.mode === 'password', '工具鎖定要還是自訂密碼加密：' + JSON.stringify(st && st.data));
  if (st.data.locked) {
    const unlocked = await send({ type: 'lock.unlockPassword', password: MASTER });
    check(unlocked.ok && !unlocked.data.locked, '打原本的自訂密碼要解得開：' + JSON.stringify(unlocked));
  }
  const all = await send({ type: 'entries.all' });
  check(all.ok && all.data.some((e) => e.username === 'test-user@example.test'), '存的帳號要還在');
});

// ---- 私密視窗：Firefox 版整個停用，AMO 規定不能儲存私密瀏覽的資料。另外開一個整個都是私密瀏覽的 Firefox ----

// 前提：擴充功能有在私密視窗跑，不然下面的案例什麼都沒測到也會過
privateTest('擴充功能有在私密視窗跑，管理頁照常能用', async () => {
  check((await options.eval('chrome.extension.isAllowedIncognitoAccess()')) === true, '要允許擴充功能在私密視窗執行');
  check((await options.eval('PK.platform.inPrivateContext()')) === true, '管理頁要在私密瀏覽裡');
  const saved = await send({ type: 'entries.save', entry: { host: '127.0.0.1', origin: ORIGIN, username: 'test-user@example.test', password: 'right' } });
  check(saved.ok, '管理頁要能存帳號：' + JSON.stringify(saved));
});

privateTest('小視窗只顯示不能用的提示', async () => {
  const popup = await openTab(fx.bidi, EXT + 'src/popup/popup.html', 1200);
  try {
    const view = await popup.eval(`({
      text: document.getElementById('privateScreen').checkVisibility() ? document.getElementById('privateScreen').textContent.trim() : '',
      main: document.getElementById('main').checkVisibility(),
      search: document.getElementById('search').checkVisibility(),
    })`);
    check(view.text.startsWith(await t('pop_private_blocked')) && !view.main && !view.search, '只顯示提示：' + JSON.stringify(view));
    await popup.screenshot(path.join(SHOTS, 'ff-private-popup.png'));
  } finally {
    await popup.close();
  }
});

privateTest('網頁上不自動填入，登入後也不暫存帳密', async () => {
  const page = await openTab(fx.bidi, T + 'harness.html', 2500);
  try {
    const filled = await page.eval(`document.getElementById('u').value + document.getElementById('p').value`);
    check(filled === '', '不能自動填入：' + filled);
    await page.eval(`(() => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      for (const [id, v] of [['u', 'typed-user'], ['p', 'typed-pass']]) {
        const el = document.getElementById(id);
        set.call(el, v);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
      document.querySelector('button[type=submit]').click();
      return true;
    })()`);
    await sleep(2000);
    const pending = await options.eval(`chrome.storage.session.get(null).then((all) => Object.keys(all).filter((k) => k.startsWith('pending:')).length)`);
    check(pending === 0, '不能暫存私密視窗裡打的帳密');
  } finally {
    await page.close();
  }
});

privateTest('瀏覽器的帳密視窗不回答', async () => {
  const auth = await startAuthServer();
  const page = await openTab(fx.bidi, null);
  try {
    fx.bidi.send('browsingContext.navigate', { context: page.context, url: 'http://127.0.0.1:' + AUTH_PORT + '/auth', wait: 'none' }).catch(() => {});
    await sleep(3000);
    check(auth.seen.length > 0, '網站要收到請求');
    check(!auth.seen.includes('test-user@example.test'), '不能用存的帳密回答：' + JSON.stringify(auth.seen));
  } finally {
    await page.close();
    auth.server.close();
  }
});

// 剪貼簿的權限是選用的，要使用者在 Firefox 的對話框按允許。這組先在設定檔記好已經允許，跟使用者按過允許一樣。
// Firefox 的背景程式自己讀寫剪貼簿，跟 Edge、Chrome 用 offscreen document 的做法不一樣，所以這裡另外測。
const clipboardCases = [];
const clipboardTest = (name, fn) => clipboardCases.push({ name: '剪貼簿：' + name, fn });

clipboardTest('時間到清掉小管家複製的密碼，使用者後來複製的不動', async () => {
  check((await options.eval(`chrome.permissions.contains({ permissions: ['clipboardRead', 'clipboardWrite'] })`)) === true, '要先有剪貼簿權限');
  const set = await send({ type: 'settings.set', patch: { clipboardClearSeconds: 30 } });
  check(set.ok, '設定 30 秒：' + JSON.stringify(set));
  const write = (text) => options.eval(`navigator.clipboard.writeText(${JSON.stringify(text)}).then(() => true)`);
  const read = () => options.eval(`navigator.clipboard.readText()`);

  await write('ff-copied-secret-1');
  const noted = await send({ type: 'clipboard.copied', text: 'ff-copied-secret-1' });
  check(noted.ok && noted.data === true, '應該排好清除的時間：' + JSON.stringify(noted));
  await sleep(32000);
  check((await read()) === '', '30 秒後應該清掉，實際 ' + JSON.stringify(await read()));

  await write('ff-copied-secret-2');
  await send({ type: 'clipboard.copied', text: 'ff-copied-secret-2' });
  await write('something the user copied later');
  await sleep(32000);
  check((await read()) === 'something the user copied later', '使用者後來複製的不應該清，實際 ' + JSON.stringify(await read()));
});

// 開一個 Firefox 裝好擴充功能，跑完一組案例就關掉。回傳沒過的數量。
async function runSuite(firefoxPath, extDir, { prefs: extraPrefs = {}, files = {} }, list) {
  const geckoId = targetManifest('firefox').browser_specific_settings.gecko.id;
  let failed = 0;
  fx = await launchFirefox(firefoxPath, {
    port: BIDI_PORT,
    files,
    prefs: {
      'extensions.webextensions.uuids': JSON.stringify({ [geckoId]: UUID }),
      'browser.download.dir': DOWNLOADS,
      'browser.download.folderList': 2,
      'browser.download.useDownloadDir': true,
      'browser.shell.checkDefaultBrowser': false,
      'browser.aboutwelcome.enabled': false,
      'datareporting.policy.dataSubmissionEnabled': false,
      'toolkit.telemetry.reportingpolicy.firstRun': false,
      ...extraPrefs,
    },
  });
  try {
    const { extension } = await fx.bidi.send('webExtension.install', { extensionData: { type: 'path', path: extDir } });
    console.log('Firefox，擴充功能 ' + extension);
    await sleep(1500);
    options = await openTab(fx.bidi, EXT + 'src/options/options.html', 1500);
    for (const c of list) {
      const start = Date.now();
      try {
        await c.fn();
        console.log('PASS ' + c.name + ' (' + (Date.now() - start) + 'ms)');
      } catch (err) {
        failed++;
        console.log('FAIL ' + c.name + '：' + err.message);
      }
    }
  } finally {
    await fx.close();
  }
  return failed;
}

(async () => {
  let firefoxPath;
  try {
    firefoxPath = findBrowser(process.argv[2] || 'firefox');
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }
  const { server } = await startServer(PORT, ROUTES);
  fs.rmSync(DOWNLOADS, { recursive: true, force: true });
  fs.mkdirSync(DOWNLOADS, { recursive: true });
  const extDir = copyFirefoxExtension();
  const total = cases.length + privateCases.length + clipboardCases.length;
  let failed = 0;
  try {
    failed += await runSuite(firefoxPath, extDir, {}, cases);
    // 整個 Firefox 都用私密瀏覽，開的分頁全是私密分頁。
    // 擴充功能預設不准在私密視窗執行，跟使用者在附加元件管理員打開「在隱私視窗中執行」一樣，先在設定檔記好允許。
    const geckoId = targetManifest('firefox').browser_specific_settings.gecko.id;
    failed += await runSuite(
      firefoxPath,
      extDir,
      {
        prefs: { 'browser.privatebrowsing.autostart': true },
        files: { 'extension-preferences.json': JSON.stringify({ [geckoId]: { permissions: ['internal:privateBrowsingAllowed'], origins: [] } }) },
      },
      privateCases
    );
    failed += await runSuite(
      firefoxPath,
      extDir,
      { files: { 'extension-preferences.json': JSON.stringify({ [geckoId]: { permissions: ['clipboardRead', 'clipboardWrite'], origins: [] } }) } },
      clipboardCases
    );
  } catch (err) {
    console.error('跑不起來：' + err.message);
    failed = -1;
  } finally {
    server.close();
  }
  if (failed < 0) process.exit(2);
  console.log('結果：' + (total - failed) + ' 過、' + failed + ' 沒過，共 ' + total);
  console.log('截圖在 ' + SHOTS);
  process.exit(failed ? 1 : 0);
})();
