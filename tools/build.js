// 打包正式版：dist/password-keeper-<版本>.zip，旁邊附一個 .sha256 讓下載的人核對檔案沒被改過。
// 解壓縮出來的資料夾可以直接在擴充功能頁「載入解壓縮」。
// 用法：node tools/build.js
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createZip } = require('./lib/zip');
const { ROOT, readManifest, readChangelog, packageFiles, zipName } = require('./lib/project');

// 正式版的 manifest 多放這把公鑰，擴充功能 ID 就固定是 fgmjnolhbeohanamhnomcpmolhdapdkg，不會跟著解壓縮的資料夾變。
// 換資料夾裝新版時，存的密碼和工具鎖定才會留著。改掉這把公鑰，已經裝過正式版的人會變成另一個擴充功能、看不到原本的資料。
// 原始碼資料夾的 manifest.json 不放：開發版的 ID 跟資料夾位置綁在一起，加了會讓正在用的開發版找不到原本的資料。
const RELEASE_KEY =
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA9E73zypDI0YIYaih0bwDD3v8t8WudaIebBclD8HGT1+B9/naW7UUUdH/ZPoheUsa0qwq3wcMEtrKhmCCkkWVE/27o4sQLQSdcZSHS9E6uYQFKnXC4cOtzmlUNJuUPScyCjhTEtsCDqxRYfVqUsb+/mHkreIxe09/jtdpM8yDrczI+R94Z6AS2shTDhqtCRjLAPgOuvlPw/80QqKVJP2DvVu2t7iiEecADz21EoVlFnvNJm/S5Ip3RywMqruPNdSwjBgAfetRs4k0C3SVxq1hqtx6qLkC3/XtXV9619JugvcwPepiaJcljnvbjb1mbF9JXISZwIuMAoR8G3Xr8ic1BQIDAQAB';

function build() {
  const manifest = readManifest();
  const entry = readChangelog().find((v) => v.version === manifest.version);
  if (!entry) throw new Error('changelog.js 沒有 ' + manifest.version + ' 這一版，先補版本說明再打包');
  const entries = packageFiles().map((name) => ({
    name,
    data:
      name === 'manifest.json'
        ? Buffer.from(JSON.stringify({ ...manifest, key: RELEASE_KEY }, null, 2) + '\n')
        : fs.readFileSync(path.join(ROOT, name)),
  }));
  // 檔案時間用這一版的發布日，同一版每次打包出來都一樣
  const zip = createZip(entries, new Date(entry.date + 'T12:00:00'));
  const dist = path.join(ROOT, 'dist');
  fs.mkdirSync(dist, { recursive: true });
  const name = zipName(manifest.version);
  const file = path.join(dist, name);
  fs.writeFileSync(file, zip);
  const sha256 = crypto.createHash('sha256').update(zip).digest('hex');
  fs.writeFileSync(file + '.sha256', sha256 + '  ' + name + '\n');
  return { file, sha256, count: entries.length, bytes: zip.length };
}

if (require.main === module) {
  const r = build();
  console.log('已打包 ' + path.relative(ROOT, r.file) + '（' + r.count + ' 個檔案，' + r.bytes + ' bytes）');
  console.log('SHA-256 ' + r.sha256);
}

module.exports = { build, RELEASE_KEY };
