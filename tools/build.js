// 打包正式版，旁邊附一個 .sha256 讓下載的人核對檔案沒被改過。
// 用法：
//   node tools/build.js                  GitHub 版：dist/password-keeper-<版本>.zip，Edge、Chrome「載入解壓縮」用
//   node tools/build.js chromium-store   Chromium 商店版：dist/store/password-keeper-<版本>-chromium-store.zip
//   node tools/build.js firefox          Firefox 版：dist/store/password-keeper-<版本>-firefox.zip
//   node tools/build.js all              三種都打包
// 各版本打包的檔案一樣，只有 manifest.json 不同，程式裡不同的地方集中在 src/shared/platform.js。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createZip } = require('./lib/zip');
const { ROOT, readManifest, readChangelog, packageFiles, zipName, firefoxZipName, chromiumStoreZipName } = require('./lib/project');

// 正式版的 manifest 多放這把公鑰，擴充功能 ID 就固定是 fgmjnolhbeohanamhnomcpmolhdapdkg，不會跟著解壓縮的資料夾變。
// 換資料夾裝新版時，存的密碼和工具鎖定才會留著。改掉這把公鑰，已經裝過正式版的人會變成另一個擴充功能、看不到原本的資料。
// 原始碼資料夾的 manifest.json 不放：開發版的 ID 跟資料夾位置綁在一起，加了會讓正在用的開發版找不到原本的資料。
const RELEASE_KEY =
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA9E73zypDI0YIYaih0bwDD3v8t8WudaIebBclD8HGT1+B9/naW7UUUdH/ZPoheUsa0qwq3wcMEtrKhmCCkkWVE/27o4sQLQSdcZSHS9E6uYQFKnXC4cOtzmlUNJuUPScyCjhTEtsCDqxRYfVqUsb+/mHkreIxe09/jtdpM8yDrczI+R94Z6AS2shTDhqtCRjLAPgOuvlPw/80QqKVJP2DvVu2t7iiEecADz21EoVlFnvNJm/S5Ip3RywMqruPNdSwjBgAfetRs4k0C3SVxq1hqtx6qLkC3/XtXV9619JugvcwPepiaJcljnvbjb1mbF9JXISZwIuMAoR8G3Xr8ic1BQIDAQAB';

// Edge、Chrome 的背景程式是 service worker，由 src/background/background.js 用 importScripts 依序載入各檔。
// Firefox 不支援 service worker 寫法，要在 manifest 的 background.scripts 一個個列出來，順序跟 importScripts 一樣。
function backgroundScripts() {
  const entry = 'src/background/background.js';
  const text = fs.readFileSync(path.join(ROOT, entry), 'utf8');
  const files = [...text.matchAll(/^importScripts\('([^']+)'\);$/gm)].map((m) => path.posix.join(path.posix.dirname(entry), m[1]));
  if (!files.length) throw new Error(entry + ' 找不到 importScripts');
  return files;
}

// 把 overlay 蓋到 base 上：物件一層層合併，值是 null 的欄位刪掉，其他值直接換掉
function overlay(base, patch) {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k];
    else if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object') out[k] = overlay(out[k], v);
    else out[k] = v;
  }
  return out;
}

// GitHub 版放 dist/，上傳商店的放 dist/store/。發版時三種都附在 Releases，見 .github/workflows/release.yml。
const TARGETS = {
  // GitHub Releases 的 zip，Edge、Chrome 載入解壓縮。
  github: {
    dir: 'dist',
    zip: zipName,
    manifest: (m) => ({ ...m, key: RELEASE_KEY }),
  },
  // Chrome Web Store、Edge Add-ons、Opera 共用。不放 key：商店會給自己的 ID，Chrome Web Store 新建項目時也不收 key。
  'chromium-store': {
    dir: 'dist/store',
    zip: chromiumStoreZipName,
    manifest: (m) => ({ ...m }),
  },
  // 上傳到 Firefox 的商店 AMO，同一個檔也附在 GitHub Releases 給人暫時載入。
  // Firefox 不支援 service worker 寫法，背景程式改列在 background.scripts。
  firefox: {
    dir: 'dist/store',
    zip: firefoxZipName,
    manifest: (m) => {
      const patch = JSON.parse(fs.readFileSync(path.join(ROOT, 'platforms', 'firefox', 'manifest.json'), 'utf8'));
      return overlay(m, { ...patch, background: { service_worker: null, scripts: backgroundScripts() } });
    },
  },
};

function targetManifest(target, manifest = readManifest()) {
  if (!TARGETS[target]) throw new Error('不認得的瀏覽器：' + target + '，可以用 ' + Object.keys(TARGETS).join('、'));
  return TARGETS[target].manifest(manifest);
}

function build(target = 'github') {
  const manifest = readManifest();
  const entry = readChangelog().find((v) => v.version === manifest.version);
  if (!entry) throw new Error('changelog.js 沒有 ' + manifest.version + ' 這一版，先補版本說明再打包');
  const finalManifest = targetManifest(target, manifest);
  const t = TARGETS[target];
  const entries = packageFiles().map((name) => ({
    name,
    data: name === 'manifest.json' ? Buffer.from(JSON.stringify(finalManifest, null, 2) + '\n') : fs.readFileSync(path.join(ROOT, name)),
  }));
  // 檔案時間用這一版的發布日，同一版每次打包出來都一樣
  const zip = createZip(entries, new Date(entry.date + 'T12:00:00'));
  const dist = path.join(ROOT, t.dir);
  fs.mkdirSync(dist, { recursive: true });
  const name = t.zip(manifest.version);
  const file = path.join(dist, name);
  fs.writeFileSync(file, zip);
  const sha256 = crypto.createHash('sha256').update(zip).digest('hex');
  fs.writeFileSync(file + '.sha256', sha256 + '  ' + name + '\n');
  return { file, sha256, count: entries.length, bytes: zip.length };
}

if (require.main === module) {
  const arg = process.argv[2] || 'github';
  for (const target of arg === 'all' ? Object.keys(TARGETS) : [arg]) {
    const r = build(target);
    console.log('已打包 ' + path.relative(ROOT, r.file) + '（' + r.count + ' 個檔案，' + r.bytes + ' bytes）');
    console.log('SHA-256 ' + r.sha256);
  }
}

module.exports = { build, targetManifest, backgroundScripts, RELEASE_KEY, TARGETS };
