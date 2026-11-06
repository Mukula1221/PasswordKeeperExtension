// tools/ 底下的腳本共用：讀版本號、版本紀錄、要打包的檔案，產生 CHANGELOG.md 和 GitHub Release 的說明。
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const FILES = require('../files');

const ROOT = path.join(__dirname, '..', '..');
// 每一版改了什麼，管理頁「版本」分頁用的瀏覽器腳本，CHANGELOG.md 也從它產生
const CHANGELOG_JS = 'src/options/changelog.js';

function readManifest() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
}

// changelog.js 是給管理頁用的瀏覽器腳本，在 vm 裡跑一次把 CHANGELOG 拿出來
function readChangelog() {
  const code = fs.readFileSync(path.join(ROOT, CHANGELOG_JS), 'utf8');
  const sandbox = {};
  vm.runInNewContext(code + '\nglobalThis.__changelog = CHANGELOG;', sandbox, { filename: CHANGELOG_JS });
  return sandbox.__changelog;
}

// 作業系統和雲端硬碟自己產生的檔案，資料夾展開時跳過，不要打包進去
const JUNK = new Set(['desktop.ini', 'thumbs.db', '.ds_store']);

// tools/files.js 列的資料夾展開成檔案，路徑一律用 / 分隔
function packageFiles() {
  const walk = (rel) => {
    const full = path.join(ROOT, rel);
    if (!fs.statSync(full).isDirectory()) return [rel];
    return fs
      .readdirSync(full)
      .filter((name) => !JUNK.has(name.toLowerCase()))
      .sort()
      .flatMap((name) => walk(rel + '/' + name));
  };
  return FILES.flatMap(walk);
}

const zipName = (version) => 'password-keeper-' + version + '.zip';

// changelog.js 每一版的 items、notes 是 { zh_TW: [...], en: [...], ja: [...] }，notes 可以省略
const linesOf = (byLocale, locale) => (byLocale && byLocale[locale]) || [];

function renderChangelogMd(changelog) {
  const lines = [
    '# 版本紀錄',
    '',
    '這份檔案是 `node tools/changelog.js` 從 `' + CHANGELOG_JS + '` 產生的，要改請改 `' + CHANGELOG_JS + '`。',
    '',
    '版本號照[語意化版本](https://semver.org/lang/zh-TW/)：只修問題加第三碼，加功能加第二碼，舊資料或舊設定不能直接沿用時加第一碼。',
    '',
  ];
  for (const v of changelog) {
    lines.push('## ' + v.version + ' - ' + v.date, '');
    for (const item of linesOf(v.items, 'zh_TW')) lines.push('- ' + item);
    const notes = linesOf(v.notes, 'zh_TW');
    if (notes.length) {
      lines.push('', '### 要注意', '');
      for (const note of notes) lines.push('- ' + note);
    }
    lines.push('');
  }
  return lines.join('\n');
}

// GitHub Release 的說明三種語言都放。各語言的標題和安裝說明：
const RELEASE_TEXT = {
  zh_TW: {
    items: '這一版改了什麼',
    notes: '要注意',
    install: '安裝或更新',
    steps: (zip) => ['下載下面的 `' + zip + '`，解壓縮後在擴充功能管理頁按「載入解壓縮」選那個資料夾。', '已經裝過正式版的話，照一樣的步驟載入新版，存的密碼和設定會留著。'],
    readme: ['README.md', '#下載安裝', '完整步驟：'],
  },
  en: {
    items: "What's new",
    notes: 'Notes',
    install: 'Install or update',
    steps: (zip) => ['Download `' + zip + '` below, extract it, then click "Load unpacked" on the extensions page and pick that folder.', 'If you already use a release version, load the new one the same way. Your saved passwords and settings stay.'],
    readme: ['docs/README.en.md', '#install', 'Full steps: '],
  },
  ja: {
    items: '変更内容',
    notes: '注意',
    install: 'インストールと更新',
    steps: (zip) => ['下の `' + zip + '` をダウンロードして展開し、拡張機能ページの「パッケージ化されていない拡張機能を読み込む」でそのフォルダーを選びます。', 'リリース版をすでに使っている場合も同じ手順で読み込みます。保存したパスワードと設定はそのまま残ります。'],
    readme: ['docs/README.ja.md', '#インストール', '詳しい手順：'],
  },
};

// repoUrl 在 GitHub Actions 裡才知道，本機跑的時候連結指向專案裡的 README
function renderReleaseNotes(entry, repoUrl) {
  const lines = [];
  for (const [locale, text] of Object.entries(RELEASE_TEXT)) {
    lines.push('## ' + text.items, '');
    for (const item of linesOf(entry.items, locale)) lines.push('- ' + item);
    const notes = linesOf(entry.notes, locale);
    if (notes.length) {
      lines.push('', '### ' + text.notes, '');
      for (const note of notes) lines.push('- ' + note);
    }
    const [file, anchor, label] = text.readme;
    // HEAD 會指到預設分支，不用管分支叫 main 還是 master
    const link = repoUrl ? repoUrl + '/blob/HEAD/' + file + anchor : file;
    lines.push('', '### ' + text.install, '', ...text.steps(zipName(entry.version)), '', label + '[' + file + '](' + link + ')', '', '---', '');
  }
  // 每種語言後面都接一條分隔線，最後一條不用
  return lines.join('\n').replace(/\n+---\n*$/, '\n');
}

module.exports = { ROOT, CHANGELOG_JS, readManifest, readChangelog, packageFiles, zipName, renderChangelogMd, renderReleaseNotes };
