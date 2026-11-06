// 推上 GitHub 前的檢查，CI 每次都會跑：node tools/check.js
// 發布流程另外加 --tag v1.2.3，確認標籤跟 manifest.json 的版本一樣。
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const FILES = require('./files');
const { ROOT, CHANGELOG_JS, readManifest, readChangelog, packageFiles, renderChangelogMd } = require('./lib/project');
const { LOCALES, checkMessages, usedKeys, untranslatedInJs, checkHtml } = require('./lib/i18n-check');

const problems = [];
const SEMVER = /^\d+\.\d+\.\d+$/;

function compareVersions(a, b) {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

// Windows 的 git 可能把換行換成 CRLF，比對前先統一
const readText = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

function checkVersions(manifest) {
  if (!SEMVER.test(manifest.version)) problems.push('manifest.json 的版本號要是 X.Y.Z：' + manifest.version);
  const changelog = readChangelog();
  const top = changelog[0] && changelog[0].version;
  if (top !== manifest.version) problems.push('changelog.js 最上面一版是 ' + top + '，manifest.json 是 ' + manifest.version + '，要一樣');
  changelog.forEach((v, i) => {
    if (!SEMVER.test(v.version)) problems.push('changelog.js 的版本號要是 X.Y.Z：' + v.version);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v.date) || isNaN(new Date(v.date))) problems.push(v.version + ' 的日期要是 YYYY-MM-DD：' + v.date);
    checkLocalizedLines(v, 'items');
    if (v.notes !== undefined) checkLocalizedLines(v, 'notes');
    if (i > 0 && compareVersions(changelog[i - 1].version, v.version) <= 0) {
      problems.push('changelog.js 要新的版本在前面：' + changelog[i - 1].version + ' 排在 ' + v.version + ' 前面');
    }
  });
  const tag = process.argv.indexOf('--tag');
  if (tag >= 0 && process.argv[tag + 1] !== 'v' + manifest.version) {
    problems.push('標籤 ' + process.argv[tag + 1] + ' 跟 manifest.json 的版本對不上，標籤要是 v' + manifest.version);
  }
  if (!fs.existsSync(path.join(ROOT, 'CHANGELOG.md')) || readText('CHANGELOG.md') !== renderChangelogMd(changelog)) {
    problems.push('CHANGELOG.md 沒跟上 changelog.js，執行 node tools/changelog.js');
  }
}

// 每一版的說明要三種語言都寫，條數一樣、順序對應
function checkLocalizedLines(v, field) {
  const byLocale = v[field];
  if (!byLocale || typeof byLocale !== 'object' || Array.isArray(byLocale)) {
    problems.push(v.version + ' 的 ' + field + ' 要分語言寫：{ zh_TW: [...], en: [...], ja: [...] }');
    return;
  }
  const counts = LOCALES.map((loc) => (Array.isArray(byLocale[loc]) ? byLocale[loc].length : -1));
  if (counts.includes(-1)) problems.push(v.version + ' 的 ' + field + ' 少了 ' + LOCALES.filter((loc, i) => counts[i] < 0).join('、'));
  else if (new Set(counts).size > 1) problems.push(v.version + ' 的 ' + field + ' 三種語言的條數不一樣：' + counts.join(' / '));
  else if (!counts[0]) problems.push(v.version + ' 的 ' + field + ' 是空的');
  for (const loc of LOCALES) {
    for (const line of byLocale[loc] || []) if (typeof line !== 'string' || !line.trim()) problems.push(v.version + ' 的 ' + field + '.' + loc + ' 有空的一條');
  }
}

function readMessages() {
  const messages = {};
  for (const loc of LOCALES) {
    const rel = '_locales/' + loc + '/messages.json';
    if (!fs.existsSync(path.join(ROOT, rel))) {
      problems.push(rel + ' 不存在');
      continue;
    }
    try {
      messages[loc] = Object.fromEntries(Object.entries(JSON.parse(readText(rel))).map(([k, v]) => [k, v && v.message]));
    } catch (err) {
      problems.push(rel + ' 不是正確的 JSON：' + err.message);
    }
  }
  return messages;
}

// 三種語言的 key 要一樣、程式用到的 key 都要有、沒用到的不要留、不能還有沒翻到的中文
function checkI18n(manifest) {
  if (!manifest.default_locale) problems.push('manifest.json 要有 default_locale');
  const messages = readMessages();
  if (LOCALES.some((loc) => !messages[loc])) return;
  problems.push(...checkMessages(messages));
  // i18n.js 直接用 chrome.i18n.getMessage 拿這兩個，不經過 t()
  const used = new Set(['locale_code', 'lang_tag']);
  for (const file of packageFiles()) {
    if (file.startsWith('_locales/') || !/\.(js|html|json)$/.test(file)) continue;
    const text = readText(file);
    for (const key of usedKeys(text)) used.add(key);
    if (file.endsWith('.html')) problems.push(...checkHtml(file, text, messages.zh_TW));
    else if (file.endsWith('.js') && file !== CHANGELOG_JS) problems.push(...untranslatedInJs(file, text));
  }
  for (const key of used) if (messages.zh_TW[key] === undefined) problems.push(key + ' 有用到，但 _locales 裡沒有');
  for (const key of Object.keys(messages.zh_TW)) if (!used.has(key)) problems.push('_locales 裡的 ' + key + ' 沒有用到');
}

// manifest.json、HTML 和程式裡用到的檔案，都要列在 tools/files.js，不然打包出來的 zip 會缺檔
function referencedFiles(manifest) {
  const refs = new Set();
  const add = (p) => p && refs.add(p.replace(/^\//, '').split(/[#?]/)[0]);
  add(manifest.background && manifest.background.service_worker);
  for (const cs of manifest.content_scripts || []) [...(cs.js || []), ...(cs.css || [])].forEach(add);
  if (manifest.action) {
    add(manifest.action.default_popup);
    Object.values(manifest.action.default_icon || {}).forEach(add);
  }
  if (manifest.options_ui) add(manifest.options_ui.page);
  Object.values(manifest.icons || {}).forEach(add);
  for (const file of packageFiles()) {
    if (file.endsWith('.html')) {
      for (const m of readText(file).matchAll(/\b(?:src|href)="([^"]+)"/g)) {
        if (!/^(?:[a-z][a-z0-9+.-]*:|#)/i.test(m[1])) add(path.posix.join(path.posix.dirname(file), m[1]));
      }
    }
    if (file.endsWith('.js')) {
      // 只認整個參數就是一個固定字串的；'_locales/' + 語言 這種拼出來的路徑不算。
      // importScripts 的相對路徑從那個 js 檔所在的資料夾算，getURL 一律從擴充功能最外層算
      for (const m of readText(file).matchAll(/\b(importScripts|getURL)\(\s*'([^']+)'\s*\)/g)) {
        add(m[1] === 'importScripts' && !m[2].startsWith('/') ? path.posix.join(path.posix.dirname(file), m[2]) : m[2]);
      }
    }
  }
  return refs;
}

function checkPackage(manifest) {
  for (const rel of FILES) if (!fs.existsSync(path.join(ROOT, rel))) problems.push('tools/files.js 列了 ' + rel + '，但檔案不存在');
  if (problems.length) return;
  const packaged = new Set(packageFiles());
  for (const ref of referencedFiles(manifest)) {
    if (!packaged.has(ref)) problems.push(ref + ' 有用到，但沒列在 tools/files.js，打包會漏掉');
  }
}

function jsFilesUnder(rel) {
  const full = path.join(ROOT, rel);
  if (!fs.existsSync(full)) return [];
  if (!fs.statSync(full).isDirectory()) return rel.endsWith('.js') ? [rel] : [];
  return fs.readdirSync(full).flatMap((name) => jsFilesUnder(rel + '/' + name));
}

function checkSyntax() {
  const files = [...packageFiles().filter((f) => f.endsWith('.js')), ...jsFilesUnder('tools'), ...jsFilesUnder('test')];
  for (const file of files) {
    try {
      execFileSync(process.execPath, ['--check', path.join(ROOT, file)], { stdio: 'pipe' });
    } catch (err) {
      problems.push(file + ' 語法錯誤：' + String(err.stderr).trim().split('\n').slice(0, 4).join(' / '));
    }
  }
  return files.length;
}

const manifest = readManifest();
checkVersions(manifest);
checkPackage(manifest);
checkI18n(manifest);
const checked = checkSyntax();
if (problems.length) {
  console.error('檢查沒過：');
  for (const p of problems) console.error('- ' + p);
  process.exit(1);
}
console.log('檢查通過：版本 ' + manifest.version + '，打包 ' + packageFiles().length + ' 個檔案，' + checked + ' 個程式檔語法正確');
