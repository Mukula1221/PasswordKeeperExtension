// 驗證正式版打包檔：zip 解壓縮後能直接載入，擴充功能 ID 固定，解壓縮到別的資料夾裝新版，存的帳號還在。
//   node test/e2e/package.js          測 Edge
//   node test/e2e/package.js chrome   測 Chrome
// 結束代碼：0 全過、1 沒過、2 跑不起來。
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { findBrowser, launch, findServiceWorker, attachWorker, sleep, WORK } = require('./lib');
const { build } = require('../../tools/build');

const RELEASE_ID = 'fgmjnolhbeohanamhnomcpmolhdapdkg';

// 用 Windows 內建的解壓縮，確認一般使用者「解壓縮全部」解得開
function unzip(zipFile, dest) {
  fs.rmSync(dest, { recursive: true, force: true });
  execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', 'Expand-Archive -LiteralPath $env:PK_ZIP -DestinationPath $env:PK_DEST -Force'], {
    env: { ...process.env, PK_ZIP: zipFile, PK_DEST: dest },
    stdio: 'pipe',
  });
}

async function workerOf(b) {
  const sw = await findServiceWorker(b.cdp);
  if (!sw) throw new Error('擴充功能沒裝起來');
  const w = await attachWorker(b.cdp, sw);
  for (let i = 0; i < 50; i++) {
    try {
      if (await w.eval("typeof handlers === 'object'")) return { w, id: sw.url.split('/')[2] };
    } catch {
      // 背景程式剛啟動，還沒載完
    }
    await sleep(200);
  }
  throw new Error('背景程式沒有載完');
}

function check(cond, label) {
  if (!cond) throw new Error('沒過：' + label);
}

(async () => {
  const { file } = build();
  const first = path.join(WORK, 'pkg-first');
  const next = path.join(WORK, 'pkg-next');
  unzip(file, first);
  unzip(file, next);
  check(fs.existsSync(path.join(first, 'manifest.json')), 'manifest.json 要在 zip 最外層，解壓縮的資料夾才能直接載入');
  // 第二個資料夾假裝是下一版
  const manifest = JSON.parse(fs.readFileSync(path.join(next, 'manifest.json'), 'utf8'));
  const nextVersion = manifest.version + '.1';
  fs.writeFileSync(path.join(next, 'manifest.json'), JSON.stringify({ ...manifest, version: nextVersion }, null, 2));

  const b = await launch(findBrowser(process.argv[2] || 'edge'), first);
  let failed = false;
  try {
    let { w, id } = await workerOf(b);
    check(id === RELEASE_ID, '擴充功能 ID 要固定是 ' + RELEASE_ID + '，實際 ' + id);
    console.log('PASS 解壓縮後可以直接載入，ID ' + id);
    await w.eval(`handlers['entries.save']({ entry: { host: 'example.test', origin: 'https://example.test', username: 'package-test', password: 'not-a-real-one' } }).then(() => true)`);

    const { id: loadedId } = await b.cdp.send('Extensions.loadUnpacked', { path: next });
    check(loadedId === RELEASE_ID, '從別的資料夾載入新版，ID 要一樣，實際 ' + loadedId);
    await sleep(1500);
    ({ w, id } = await workerOf(b));
    const version = await w.eval('chrome.runtime.getManifest().version');
    check(version === nextVersion, '要換成新版 ' + nextVersion + '，實際 ' + version);
    const users = await w.eval(`handlers['entries.all']().then((list) => list.map((e) => e.username))`);
    check(users.includes('package-test'), '換資料夾裝新版，存的帳號要還在：' + JSON.stringify(users));
    console.log('PASS 解壓縮到別的資料夾裝新版，ID 不變、存的帳號還在');
  } catch (err) {
    failed = true;
    console.log('FAIL', err.message);
  } finally {
    await b.close();
  }
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error('跑不起來：', err);
  process.exit(2);
});
