// 用 src/options/changelog.js 重新產生 CHANGELOG.md。版本說明只改 src/options/changelog.js，改完執行：node tools/changelog.js
const fs = require('fs');
const path = require('path');
const { ROOT, readChangelog, renderChangelogMd } = require('./lib/project');

fs.writeFileSync(path.join(ROOT, 'CHANGELOG.md'), renderChangelogMd(readChangelog()));
console.log('已更新 CHANGELOG.md');
