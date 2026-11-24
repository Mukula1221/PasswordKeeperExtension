// 背景程式的檔案怎麼組織：每個檔包在自己的閉包裡，只把別的檔要用的放進全域的 PK。
// 執行：node --test test/unit/
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadBackground } = require('./load-background');

test('背景程式載入後，全域只多了 PK', async () => {
  const bg = loadBackground();
  await bg.settle();
  // 假 chrome API 和 Node 給的那些是測試自己放的，不算
  const provided = ['chrome', 'console', 'crypto', 'URL', 'TextEncoder', 'TextDecoder', 'atob', 'btoa', 'structuredClone', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask', 'AbortController', 'location', 'fetch', 'self', 'importScripts'];
  const added = [...bg.run('Object.keys(globalThis)')].filter((k) => !provided.includes(k));
  assert.deepEqual(added, ['PK']);
});

test('PK 底下各檔匯出的名稱不重複', () => {
  const bg = loadBackground();
  const owners = {};
  for (const [ns, exported] of Object.entries(bg.pk())) {
    for (const name of Object.keys(exported)) (owners[name] = owners[name] || []).push(ns);
  }
  const dup = Object.entries(owners).filter(([, list]) => list.length > 1);
  assert.deepEqual(dup, [], '同一個名稱出現在好幾個檔：' + JSON.stringify(dup));
});
