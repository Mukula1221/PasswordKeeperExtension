// 印出某一版的 GitHub Release 說明，發布流程（.github/workflows/release.yml）會用。
// 用法：node tools/release-notes.js [版本號]，沒給就用 manifest.json 的版本。
const { readManifest, readChangelog, renderReleaseNotes } = require('./lib/project');

const version = (process.argv[2] || readManifest().version).replace(/^v/, '');
const entry = readChangelog().find((v) => v.version === version);
if (!entry) {
  console.error('changelog.js 找不到 ' + version + ' 這一版');
  process.exit(1);
}
// GitHub Actions 會給這兩個環境變數，說明裡的連結才能指到 GitHub 上的 README
const repoUrl = process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY ? process.env.GITHUB_SERVER_URL + '/' + process.env.GITHUB_REPOSITORY : '';
process.stdout.write(renderReleaseNotes(entry, repoUrl));
