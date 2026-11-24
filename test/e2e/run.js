// 把擴充功能裝進真的瀏覽器跑完整流程，看不到視窗，跑完會關掉瀏覽器。不用裝套件。
//   node test/e2e/run.js                測 Edge
//   node test/e2e/run.js chrome         測 Chrome，也可以給瀏覽器執行檔的完整路徑
//   node test/e2e/run.js edge 登出      只跑名稱含「登出」的案例
// 結束代碼：0 全過、1 有案例沒過、2 跑不起來。
const path = require('path');
const fs = require('fs');
const { generateKeyPairSync, randomBytes } = require('crypto');
const { findBrowser, copyExtension, startServer, launch, findServiceWorker, openPage, attachFrame, attachWorker, sleep, WORK } = require('./lib');

const PORT = 8770;
const ORIGIN = 'http://127.0.0.1:' + PORT;
const T = ORIGIN + '/test/';
const SHOTS = path.join(WORK, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });

let b, w, hits, extId, browserPath, extDir;
const results = [];
const cases = [];
const test = (name, fn) => cases.push({ name, fn });

function check(cond, label) {
  if (!cond) throw new Error('沒過：' + label);
}

async function until(fn, ms = 8000, step = 150) {
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

async function safeUrl(page) {
  for (let i = 0; i < 20; i++) {
    try {
      return await page.url();
    } catch {
      await sleep(150);
    }
  }
  return '';
}

async function safeEval(page, expr) {
  for (let i = 0; i < 20; i++) {
    try {
      return await page.eval(expr);
    } catch {
      await sleep(150);
    }
  }
  return undefined;
}

const reset = () =>
  w.eval(`(async () => {
    await chrome.storage.local.remove(['vault', 'settings', 'webauthn', 'uiLanguage', 'updateInfo', 'autoBackupKey', 'vaultKeyLock', 'autoBackupReady']);
    await chrome.storage.session.clear();
    // 加密的案例會刪掉 keyB64，背景程式記著的舊金鑰也要丟掉
    forgetCachedKey();
    return true;
  })()`);

// 背景程式會看 sender 是誰：直接叫 handlers 準備資料時，假裝是管理頁送來的。
// 假裝是網頁裡的 content.js 時，sender 要帶那一頁的 url，跟真的瀏覽器一樣。
const fromOptions = `{ url: extensionOrigin() + '/src/options/options.html' }`;

const seedEntry = (password = 'right', host = '127.0.0.1') =>
  w.eval(`handlers['entries.save']({ entry: { host: ${JSON.stringify(host)}, origin: ${JSON.stringify('http://' + host + ':' + PORT)}, username: 'test-user@example.test', password: ${JSON.stringify(password)} } }, ${fromOptions}).then(() => true)`);

const seedRules = (rules) =>
  w.eval(`(async () => {
    const list = ${JSON.stringify(rules)}.map((r, i) => ({ id: 'rule-' + i, host: '127.0.0.1', enabled: true, createdAt: 1, ...r }));
    await setSettings({ clickRules: list });
    return list.length;
  })()`);

const getRules = () => w.eval('getSettings().then((s) => s.clickRules)');

async function open(url, waitMs) {
  const page = await openPage(b.cdp);
  await b.cdp.send('Target.activateTarget', { targetId: page.targetId });
  await page.send('Page.bringToFront');
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 800, deviceScaleFactor: 1, mobile: false });
  if (url) await page.goto(url, waitMs);
  return page;
}

async function closePage(page) {
  await b.cdp.send('Target.closeTarget', { targetId: page.targetId }).catch(() => {});
}

// 跟小視窗按鈕送的是同一個訊息，只是改從背景程式送
const startPick = (url) =>
  w.eval(`(async () => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((t) => t.url === ${JSON.stringify(url)});
    if (!tab) return 'no tab: ' + tabs.map((t) => t.url).join(' | ');
    const res = await chrome.tabs.sendMessage(tab.id, { type: 'pickStart' });
    return res && res.ok ? 'ok' : JSON.stringify(res);
  })()`);

const hitCount = (needle) => hits.filter((h) => h.includes(needle)).length;

// ---- 自動填完按登入 ----

test('自動按登入：密碼錯只送一次', async () => {
  await seedEntry('wrong');
  await w.eval(`handlers['autoSubmit.set']({ host: '127.0.0.1', enabled: true })`);
  hits.length = 0;
  const page = await open(T + 'fail-login.html');
  await sleep(6000);
  const n = hitCount('fail-login.html?error=1');
  check(n === 1, '退回錯誤頁的次數應該是 1，實際 ' + n);
  check(/error=1/.test(await safeUrl(page)), '應該停在錯誤頁');
  await closePage(page);
});

test('自動按登入：密碼對照常登入', async () => {
  await seedEntry('right');
  await w.eval(`handlers['autoSubmit.set']({ host: '127.0.0.1', enabled: true })`);
  const page = await open(T + 'fail-login.html');
  const url = await until(async () => {
    const u = await page.url();
    return u.includes('done.html') && u;
  });
  check(url, '應該跳到 done.html');
  await closePage(page);
});

test('自動按登入：猜不到表單外的 div 按鈕，不會送出', async () => {
  await seedEntry('right');
  await w.eval(`handlers['autoSubmit.set']({ host: '127.0.0.1', enabled: true })`);
  const page = await open(T + 'click-login.html');
  await sleep(2500);
  check((await safeEval(page, 'sessionStorage.tries')) === '0', '不應該送出');
  check((await safeEval(page, `document.getElementById('p').value`)) === 'right', '帳密應該有填');
  await closePage(page);
});

// ---- 自動填完才點 ----

async function afterFillCase(query, selector = '.go', text = '登 入') {
  await seedEntry('right');
  await seedRules([{ path: '/test/click-login.html', selector, text, when: 'afterFill' }]);
  const page = await open(T + 'click-login.html' + query);
  const url = await until(async () => {
    const u = await page.url();
    return u.includes('done.html') && u;
  }, 9000);
  const errs = page.console.filter((c) => /error|exception|refused|violat/i.test(c));
  check(url, '應該跳到 done.html。頁面在 ' + (await safeUrl(page)) + '，console：' + JSON.stringify(errs));
  await closePage(page);
}

test('自動填完才點：div 按鈕，聽 click', () => afterFillCase(''));
test('自動填完才點：div 按鈕，只聽 mousedown', () => afterFillCase('?mousedown'));
test('自動填完才點：javascript: 連結（舊系統 __doPostBack）', () => afterFillCase('?js'));
test('自動填完才點：disabled 的按鈕，填完才能按', () => afterFillCase('?disabled'));
test('自動填完才點：按鈕 2 秒後才出現', () => afterFillCase('?late'));

test('自動填完才點：有驗證碼欄就不點', async () => {
  await seedEntry('right');
  await seedRules([{ path: '/test/click-login.html', selector: '.go', text: '登 入', when: 'afterFill' }]);
  const page = await open(T + 'click-login.html?captcha');
  const toast = await until(async () => /空欄位/.test(await page.toastText()) && (await page.toastText()), 4000);
  check(toast, '應該跳「表單還有空欄位」的提示');
  check((await safeEval(page, 'sessionStorage.tries')) === '0', '不應該送出');
  await closePage(page);
});

test('自動填完才點：密碼錯只送一次，不會一直重試', async () => {
  await seedEntry('wrong');
  await seedRules([{ path: '/test/click-login.html', selector: '.go', text: '登 入', when: 'afterFill' }]);
  const page = await open(T + 'click-login.html');
  const toast = await until(async () => /剛剛自動點過/.test(await page.toastText()) && (await page.toastText()), 6000);
  check(toast, '第二次載入應該跳「剛剛自動點過」');
  await sleep(2000);
  check((await safeEval(page, 'sessionStorage.tries')) === '1', '送出次數應該是 1，實際 ' + (await safeEval(page, 'sessionStorage.tries')));
  await closePage(page);
});

test('自動填完才點：沒存帳號不會點', async () => {
  await seedRules([{ path: '/test/click-login.html', selector: '.go', text: '登 入', when: 'afterFill' }]);
  const page = await open(T + 'click-login.html');
  await sleep(2500);
  check((await safeEval(page, 'sessionStorage.tries')) === '0', '不應該送出');
  await closePage(page);
});

test('自動填完才點：自動填入關著不會點', async () => {
  await seedEntry('right');
  await seedRules([{ path: '/test/click-login.html', selector: '.go', text: '登 入', when: 'afterFill' }]);
  await w.eval(`handlers['autoFill.setSite']({ host: '127.0.0.1', enabled: false })`);
  const page = await open(T + 'click-login.html');
  await sleep(2500);
  check((await safeEval(page, 'sessionStorage.tries')) === '0', '不應該送出');
  await closePage(page);
});

test('同一頁兩條規則：先勾我同意，再按登入', async () => {
  await seedEntry('right');
  await seedRules([
    { path: '/test/click-login.html', selector: 'label.agree', text: '我同意使用條款', when: 'afterFill' },
    { path: '/test/click-login.html', selector: '.go', text: '登 入', when: 'afterFill' },
  ]);
  const page = await open(T + 'click-login.html?agree');
  const url = await until(async () => {
    const u = await page.url();
    return u.includes('done.html') && u;
  }, 9000);
  check(url, '應該跳到 done.html，頁面文字：' + (await safeEval(page, `document.getElementById('log').textContent`)));
  await closePage(page);
});

test('兩段式登入：第一頁按下一步，第二頁按登入', async () => {
  await seedEntry('right');
  await seedRules([
    { path: '/test/step1.html', selector: 'button', text: '下一步', when: 'afterFill' },
    { path: '/test/step2.html', selector: 'button', text: '登入', when: 'afterFill' },
  ]);
  const page = await open(T + 'step1.html');
  const url = await until(async () => {
    const u = await page.url();
    return u.includes('done.html') && u;
  }, 10000);
  check(url, '應該跳到 done.html，頁面在 ' + (await safeUrl(page)));
  await closePage(page);
});

test('自動填完才點：一般表單的 submit 按鈕', async () => {
  await seedEntry('right');
  await seedRules([{ path: '/test/fail-login.html', selector: 'button[type=submit]', text: '登入', when: 'afterFill' }]);
  const page = await open(T + 'fail-login.html');
  const url = await until(async () => {
    const u = await page.url();
    return u.includes('done.html') && u;
  });
  check(url, '應該跳到 done.html');
  await closePage(page);
});

test('同一頁有規則時，自動按登入不會再按一次', async () => {
  await seedEntry('wrong');
  await w.eval("handlers['autoSubmit.set']({ host: '127.0.0.1', enabled: true })");
  await seedRules([{ path: '/test/fail-login.html', selector: 'h1', when: 'onLoad' }]);
  hits.length = 0;
  const page = await open(T + 'fail-login.html');
  await sleep(3000);
  check(hitCount('error=1') === 0, '不應該按登入：' + JSON.stringify(hits));
  await closePage(page);
});

// ---- 頁面一打開就點 ----

test('頁面一打開就點：不用存帳號就會點，已登入畫面不會再點', async () => {
  await seedRules([{ path: '/test/click-sso.html', selector: '#ssoBtn', text: '使用單一登入', when: 'onLoad' }]);
  const page = await open(T + 'click-sso.html');
  const url = await until(async () => {
    const u = await page.url();
    return u.includes('?home') && u;
  });
  check(url, '應該跳到 ?home');
  await sleep(2000);
  check((await safeEval(page, 'sessionStorage.ssoClicks')) === '1', '按鈕應該只被點一次');
  await closePage(page);
});

test('頁面一打開就點：單一驗證失敗退回入口不會一直點', async () => {
  await seedRules([{ path: '/test/click-sso.html', selector: '#ssoBtn', text: '使用單一登入', when: 'onLoad' }]);
  const page = await open(T + 'click-sso.html?fail');
  const toast = await until(async () => /剛剛自動點過/.test(await page.toastText()) && (await page.toastText()), 6000);
  check(toast, '第二次載入應該跳「剛剛自動點過」');
  await sleep(1500);
  check((await safeEval(page, 'sessionStorage.ssoClicks')) === '1', '按鈕應該只被點一次，實際 ' + (await safeEval(page, 'sessionStorage.ssoClicks')));
  await closePage(page);
});

test('頁面一打開就點：規則關掉就不點', async () => {
  await seedRules([{ path: '/test/click-sso.html', selector: '#ssoBtn', text: '使用單一登入', when: 'onLoad', enabled: false }]);
  const page = await open(T + 'click-sso.html');
  await sleep(2500);
  check((await safeEval(page, 'sessionStorage.ssoClicks')) === '0', '不應該點');
  await closePage(page);
});

test('安全：按鈕文字對不上就不點', async () => {
  await seedRules([{ path: '/test/click-sso.html', selector: '#ssoBtn', text: '別的文字', when: 'onLoad' }]);
  const page = await open(T + 'click-sso.html');
  await sleep(2500);
  check((await safeEval(page, 'sessionStorage.ssoClicks')) === '0', '不應該點');
  await closePage(page);
});

test('安全：位置找不到時，用文字找到剛好一個就點', async () => {
  await seedRules([{ path: '/test/click-sso.html', selector: '#notExist', text: '使用單一登入', when: 'onLoad' }]);
  const page = await open(T + 'click-sso.html');
  const url = await until(async () => {
    const u = await page.url();
    return u.includes('?home') && u;
  });
  check(url, '應該用文字找到按鈕');
  await closePage(page);
});

test('安全：網址對不上就不點，改 * 就點', async () => {
  await seedRules([{ path: '/test/other.html', selector: '#ssoBtn', text: '使用單一登入', when: 'onLoad' }]);
  let page = await open(T + 'click-sso.html');
  await sleep(2500);
  check((await safeEval(page, 'sessionStorage.ssoClicks')) === '0', '網址不同不應該點');
  await closePage(page);
  await seedRules([{ path: '/test/*', selector: '#ssoBtn', text: '使用單一登入', when: 'onLoad' }]);
  page = await open(T + 'click-sso.html');
  const url = await until(async () => {
    const u = await page.url();
    return u.includes('?home') && u;
  });
  check(url, '/test/* 應該比對得到');
  await closePage(page);
});

test('網址比對規則（查詢字串、hash 路由、大小寫）', async () => {
  const cases = [
    ['/login', 'https://a.com/login?returnUrl=/x', true],
    ['/login', 'https://a.com/login/sub', false],
    ['/login*', 'https://a.com/login/sub', true],
    ['*', 'https://a.com/anything?x=1#y', true],
    ['/LOGIN.aspx', 'https://a.com/login.aspx', true],
    ['/index.php?page=login', 'https://a.com/index.php?page=login', true],
    ['/index.php?page=login', 'https://a.com/index.php?page=home', false],
    ['/#/login', 'https://a.com/#/login', true],
    ['/#/login', 'https://a.com/#/login?x=1', true],
    ['/#/login', 'https://a.com/#/home', false],
    ['/', 'https://a.com/', true],
    ['/', 'https://a.com/home', false],
    ['/a.b', 'https://a.com/aXb', false],
  ];
  const got = await w.eval(`${JSON.stringify(cases)}.map(([p, u, want]) => [p, u, want, rulePathMatches(p, u)])`);
  for (const [p, u, want, actual] of got) check(want === actual, p + ' 對 ' + u + ' 應該 ' + want);
  const norm = await w.eval(`['https://a.com/login?x=1#y', 'login', '/ok', '*'].map(normalizeRulePath)`);
  check(JSON.stringify(norm) === JSON.stringify(['/login?x=1#y', '/login', '/ok', '*']), '網址整理：' + JSON.stringify(norm));
  const empty = await w.eval(`(() => { try { normalizeRulePath('  '); return 'no error'; } catch (e) { return e.message; } })()`);
  check(/不能空白/.test(empty), '空白網址要報錯');
});

// ---- 登出 ----

test('按「登出」文字連結：回到入口不自動點；開新分頁照常點', async () => {
  await seedRules([{ path: '/test/click-sso.html', selector: '#ssoBtn', text: '使用單一登入', when: 'onLoad' }]);
  let page = await open(T + 'click-sso.html');
  await until(async () => (await page.url()).includes('?home'));
  await sleep(300);
  await page.click('#logout');
  const toast = await until(async () => /剛登出/.test(await page.toastText()) && (await page.toastText()), 6000);
  check(toast, '應該跳「剛登出」');
  await sleep(1500);
  check(!(await safeUrl(page)).includes('?home'), '應該留在入口');
  check((await safeEval(page, 'sessionStorage.ssoClicks')) === '1', '按鈕只應該被點一次');
  await closePage(page);
  page = await open(T + 'click-sso.html');
  const url = await until(async () => {
    const u = await page.url();
    return u.includes('?home') && u;
  });
  check(url, '新分頁應該照常自動點');
  await closePage(page);
});

test('按只有圖示的登出鍵（class 看得出來）：不會被登回去', async () => {
  await seedRules([{ path: '/test/click-sso.html', selector: '#ssoBtn', text: '使用單一登入', when: 'onLoad' }]);
  const page = await open(T + 'click-sso.html?home');
  await sleep(800);
  await page.click('#btnIcon');
  const toast = await until(async () => /剛登出/.test(await page.toastText()) && (await page.toastText()), 6000);
  check(toast, '應該跳「剛登出」');
  check((await safeEval(page, 'sessionStorage.ssoClicks')) === '0', '不應該點');
  await closePage(page);
});

test('按完全看不出來的登出鍵：被登回去一次，再按一次就停', async () => {
  await seedRules([{ path: '/test/click-sso.html', selector: '#ssoBtn', text: '使用單一登入', when: 'onLoad' }]);
  const page = await open(T + 'click-sso.html?home');
  await sleep(800);
  await page.click('#btnPlain');
  const url = await until(async () => {
    const u = await page.url();
    return u.includes('?home') && (await page.eval('sessionStorage.ssoClicks')) === '1' && u;
  });
  check(url, '第一次登出會被自動點回去');
  await sleep(300);
  await page.click('#btnPlain');
  const toast = await until(async () => /剛剛自動點過/.test(await page.toastText()) && (await page.toastText()), 6000);
  check(toast, '第二次應該跳「剛剛自動點過」');
  await sleep(1000);
  check((await safeEval(page, 'sessionStorage.ssoClicks')) === '1', '按鈕只應該被點一次');
  await closePage(page);
});

test('網頁自己發的假點擊不算登出', async () => {
  await seedRules([{ path: '/test/click-sso.html', selector: '#ssoBtn', text: '使用單一登入', when: 'onLoad' }]);
  const page = await open(T + 'click-sso.html?home');
  await sleep(800);
  await page.eval(`document.getElementById('logout').click()`);
  const url = await until(async () => {
    const u = await page.url();
    return u.includes('?home') && (await page.eval('sessionStorage.ssoClicks')) === '1' && u;
  });
  check(url, '假點擊不該暫停自動點');
  await closePage(page);
});

test('登出只暫停同一個主網域', async () => {
  const r = await w.eval(`(async () => {
    // 同一個分頁先後開到不同網站，每個網站的 content.js 各自送訊息
    const from = (host, tabId = 9001) => ({ tab: { id: tabId }, url: 'https://' + host + '/' });
    await handlers['clickRules.pause']({ host: 'jira.example.com.tw' }, from('jira.example.com.tw'));
    return {
      sameBase: await handlers['clickRules.claim']({ key: 'a', host: 'sso.example.com.tw' }, from('sso.example.com.tw')),
      otherBase: await handlers['clickRules.claim']({ key: 'b', host: 'other.example.com' }, from('other.example.com')),
      otherTab: await handlers['clickRules.claim']({ key: 'c', host: 'sso.example.com.tw' }, from('sso.example.com.tw', 9002)),
      again: await handlers['clickRules.claim']({ key: 'b', host: 'other.example.com' }, from('other.example.com')),
    };
  })()`);
  check(r.sameBase.reason === 'logout', '同主網域要擋');
  check(r.otherBase.allowed === true, '不同主網域不擋');
  check(r.otherTab.allowed === true, '別的分頁不擋');
  check(r.again.reason === 'cooldown', '同一條第二次要擋');
});

test('5 分鐘過了可以再點，分頁關掉紀錄會清掉', async () => {
  const r = await w.eval(`(async () => {
    const sender = { tab: { id: 9003 } };
    const first = await handlers['clickRules.claim']({ key: 'k', host: 'a.com' }, sender);
    const blocked = await handlers['clickRules.claim']({ key: 'k', host: 'a.com' }, sender);
    await updateClickGuard((map) => { map[9003].k = Date.now() - DEFAULT_SETTINGS.clickIntervalSec * 1000 - 1; });
    const later = await handlers['clickRules.claim']({ key: 'k', host: 'a.com' }, sender);
    await clearClickGuard(9003);
    const { clickGuard } = await chrome.storage.session.get('clickGuard');
    return { first, blocked, later, gone: !(9003 in clickGuard) };
  })()`);
  check(r.first.allowed && r.blocked.reason === 'cooldown' && r.later.allowed && r.gone, JSON.stringify(r));
});

// ---- 選按鈕 ----

test('選按鈕：滑鼠移過去加框，點了不會真的按到，存好下次自動點', async () => {
  await seedEntry('right');
  const url = T + 'click-login.html';
  const page = await open(url, 1200);
  // 帳密是自動填的，還沒規則所以不會送出
  check((await safeEval(page, 'sessionStorage.tries')) === '0', '還不應該送出');
  check((await startPick(url)) === 'ok', 'pickStart');
  await sleep(200);
  const texts0 = await page.shadowTexts();
  check(texts0.some((t) => /點要自動點的按鈕/.test(t)), '應該有提示，實際 ' + JSON.stringify(texts0));
  const c = await page.centerOf('.go span');
  await page.moveTo(c.x, c.y);
  await sleep(200);
  await page.screenshot(path.join(SHOTS, 'pick-hover.png'));
  await page.clickAt(c.x, c.y);
  await sleep(500);
  check((await safeEval(page, 'sessionStorage.tries')) === '0', '選取時不應該真的按到');
  check((await safeUrl(page)).endsWith('click-login.html'), '不應該跳頁');
  const texts = await page.shadowTexts();
  check(texts.some((t) => /要自動點這個嗎/.test(t)), '應該跳確認卡片，實際 ' + JSON.stringify(texts));
  check(!texts.some((t) => /點要自動點的按鈕/.test(t)), '提示應該收掉');
  await page.screenshot(path.join(SHOTS, 'pick-card.png'));
  await page.clickShadow('儲存');
  await until(async () => (await getRules()).length === 1);
  const rules = await getRules();
  check(rules.length === 1, '應該存一條規則');
  const rule = rules[0];
  check(rule.when === 'afterFill', '有密碼欄預設自動填完才點，實際 ' + rule.when);
  check(rule.path === '/test/click-login.html', 'path ' + rule.path);
  check(rule.host === '127.0.0.1', 'host ' + rule.host);
  check(rule.text === '登 入', 'text ' + rule.text);
  check(rule.selector === 'div.go', 'selector 應該往外找到按鈕本體，實際 ' + rule.selector);
  await sleep(300);
  check((await safeEval(page, 'sessionStorage.tries')) === '0', '存好時還不應該送出');
  await page.goto(url);
  const done = await until(async () => {
    const u = await page.url();
    return u.includes('done.html') && u;
  });
  check(done, '重新載入後應該自動點');
  await closePage(page);
});

test('選按鈕：確認卡片可以改時機，沒存帳號會提醒', async () => {
  const url = T + 'click-login.html';
  const page = await open(url, 800);
  check((await startPick(url)) === 'ok', 'pickStart');
  await sleep(200);
  await page.click('.go');
  await sleep(500);
  let texts = await page.shadowTexts();
  check(texts.some((t) => /還沒存帳號/.test(t)), '沒存帳號要提醒：' + JSON.stringify(texts));
  await page.clickShadow('頁面一打開就點', 'SPAN');
  await sleep(200);
  texts = await page.shadowTexts();
  check(!texts.some((t) => t === '這個網站還沒存帳號，存了才會點'), '改成頁面一打開就點，提醒要收掉');
  await page.screenshot(path.join(SHOTS, 'pick-card-onload.png'));
  await page.clickShadow('儲存');
  await until(async () => (await getRules()).length === 1);
  check((await getRules())[0].when === 'onLoad', '時機要存成 onLoad');
  await closePage(page);
});

test('選按鈕：同一顆選兩次不會多一條', async () => {
  const url = T + 'click-sso.html';
  const page = await open(url, 800);
  for (let i = 0; i < 2; i++) {
    check((await startPick(url)) === 'ok', 'pickStart');
    await sleep(200);
    await page.click('#ssoBtn');
    await sleep(400);
    await page.clickShadow('儲存');
    await sleep(400);
  }
  const rules = await getRules();
  check(rules.length === 1, '應該只有一條，實際 ' + rules.length);
  check(rules[0].when === 'onLoad', '沒有密碼欄預設頁面一打開就點');
  check(rules[0].selector === '#ssoBtn', 'selector ' + rules[0].selector);
  await closePage(page);
});

test('選按鈕：選 disabled 的按鈕也選得到', async () => {
  const url = T + 'click-login.html?disabled';
  const page = await open(url, 800);
  check(await safeEval(page, `document.querySelector('.go').disabled`), '按鈕應該是 disabled');
  check((await startPick(url)) === 'ok', 'pickStart');
  await sleep(200);
  await page.click('.go');
  await sleep(500);
  const texts = await page.shadowTexts();
  check(texts.some((t) => /要自動點這個嗎/.test(t)), '應該跳確認卡片，實際 ' + JSON.stringify(texts));
  await page.clickShadow('取消');
  await sleep(200);
  check((await getRules()).length === 0, '取消不應該存');
  await closePage(page);
});

test('選按鈕：Esc 取消後頁面恢復正常', async () => {
  const url = T + 'click-sso.html';
  const page = await open(url, 800);
  check((await startPick(url)) === 'ok', 'pickStart');
  await sleep(200);
  await page.press('Escape', 'Escape', 27);
  await sleep(500);
  const texts = await page.shadowTexts();
  check(!texts.some((t) => /點要自動點的按鈕/.test(t)), '提示應該收掉，實際 ' + JSON.stringify(texts));
  await page.click('#ssoBtn');
  const done = await until(async () => {
    const u = await page.url();
    return u.includes('?home') && u;
  }, 3000);
  check(done, '取消後按鈕應該正常能按');
  check((await getRules()).length === 0, '不應該存');
  await closePage(page);
});

test('選按鈕：網頁自己發的假事件選不到', async () => {
  const url = T + 'click-sso.html';
  const page = await open(url, 800);
  check((await startPick(url)) === 'ok', 'pickStart');
  await sleep(200);
  await page.eval(`(() => {
    const b = document.getElementById('log');
    const r = b.getBoundingClientRect();
    const init = { bubbles: true, clientX: r.left + 2, clientY: r.top + 2 };
    b.dispatchEvent(new PointerEvent('pointerup', init));
    b.dispatchEvent(new MouseEvent('click', init));
  })()`);
  await sleep(400);
  const texts = await page.shadowTexts();
  check(!texts.some((t) => /要自動點這個嗎/.test(t)), '不應該跳確認卡片');
  check(texts.some((t) => /點要自動點的按鈕/.test(t)), '應該還在選取模式');
  await page.press('Escape', 'Escape', 27);
  await closePage(page);
});

test('選按鈕：選到密碼欄，打的內容不會存進規則', async () => {
  const url = T + 'click-login.html';
  const page = await open(url, 800);
  await page.click('#p');
  await page.eval(`document.getElementById('p').value = 'typed-secret'`);
  check((await startPick(url)) === 'ok', 'pickStart');
  await sleep(200);
  await page.click('#p');
  await sleep(500);
  const before = JSON.stringify(await page.shadowTexts());
  check(!before.includes('typed-secret'), '卡片不應該顯示密碼');
  await page.clickShadow('儲存');
  await until(async () => (await getRules()).length === 1);
  const raw = JSON.stringify(await getRules());
  check(!raw.includes('typed-secret'), '規則不應該存到密碼：' + raw);
  await closePage(page);
});

test('選按鈕：沒有 id 的重複元素用第幾個定位；網站改版位置變了就改用文字找', async () => {
  const url = ORIGIN + '/dup';
  const page = await open(url, 800);
  check((await startPick(url)) === 'ok', 'pickStart');
  await sleep(200);
  const pos = await page.eval(`(() => {
    const it = Array.from(document.querySelectorAll('.item')).find((x) => x.textContent.trim() === 'B');
    const r = it.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  await page.clickAt(pos.x, pos.y);
  await sleep(500);
  await page.clickShadow('儲存');
  await until(async () => (await getRules()).length === 1);
  const rule = (await getRules())[0];
  check(/nth-of-type\(2\)/.test(rule.selector), 'selector 應該用第幾個：' + rule.selector);
  check(rule.text === 'B', 'text ' + rule.text);
  await w.eval(`handlers['clickRules.update']({ id: ${JSON.stringify(rule.id)}, patch: { when: 'onLoad', path: '*' } })`);
  await page.goto(url);
  const hit = await until(() => page.eval('window.__clicked'), 4000);
  check(hit === 'B', '應該點到 B，實際 ' + hit);
  await closePage(page);
  const page2 = await open(url + '?shift');
  const hit2 = await until(() => page2.eval('window.__clicked'), 4000);
  check(hit2 === 'B', '多了一個元素之後還是要點到 B，實際 ' + hit2);
  await closePage(page2);
});

// ---- 右上角和登入框有同名的按鈕（Nexus）----

const MODAL_PATH = '/test/click-modal.html';
const MODAL = ORIGIN + MODAL_PATH;
const HEADER_BTN = 'a.x-btn-nx-header-medium';
const DIALOG_BTN = '.x-window a.x-btn-nx-primary-small';
// 舊版選按鈕時，滑鼠停在按鈕上才有的 x-btn-over 被記進去了，重新載入後對不上
const STALE_MODAL_RULE = {
  path: MODAL_PATH,
  selector: 'a.x-btn.x-unselectable.x-box-item.x-toolbar-item.x-btn-nx-primary-small.x-btn-over',
  text: 'Sign in',
  when: 'afterFill',
};

const modalCounts = (page) => page.eval('window.__counts');
const signedIn = (page, ms = 6000) =>
  until(async () => {
    const counts = await modalCounts(page);
    return counts.signin > 0 && counts;
  }, ms);

test('Nexus 登入框：滑鼠移上去才有的 class 不會記進規則，重新載入後照常點', async () => {
  await seedEntry('right');
  const page = await open(MODAL, 800);
  await page.click(HEADER_BTN);
  const ready = await until(() => page.eval(`document.querySelector(${JSON.stringify(DIALOG_BTN)})?.getAttribute('aria-disabled') === 'false'`), 5000);
  check(ready, '帳密自動填好後按鈕要能按');
  check((await startPick(MODAL)) === 'ok', 'pickStart');
  await sleep(200);
  const c = await page.centerOf(DIALOG_BTN);
  await page.moveTo(c.x, c.y);
  await sleep(200);
  const hovering = await page.eval(`document.querySelector(${JSON.stringify(DIALOG_BTN)}).className`);
  check(/x-btn-over/.test(hovering), '滑鼠移上去要有 x-btn-over，不然測不到：' + hovering);
  await page.clickAt(c.x, c.y);
  await sleep(500);
  await page.clickShadow('儲存');
  await until(async () => (await getRules()).length === 1);
  const rule = (await getRules())[0];
  check(rule.text === 'Sign in', 'text ' + rule.text);
  check(rule.when === 'afterFill', 'when ' + rule.when);
  check(!/over|pressed|focus|disabled/.test(rule.selector), 'selector 不應該有狀態 class：' + rule.selector);
  check((await modalCounts(page)).signin === 0, '選的時候不應該真的按到');

  await page.moveTo(5, 5);
  await page.send('Page.reload');
  await sleep(800);
  await page.click(HEADER_BTN);
  const counts = await signedIn(page);
  check(counts, '重新載入後應該自動點登入框的 Sign in，實際 ' + JSON.stringify(await modalCounts(page)));
  check(counts.signin === 1 && counts.header === 1, '右上角那顆不應該被自動點：' + JSON.stringify(counts));
  await closePage(page);
});

test('Nexus 登入框：按鈕還不能按時也選得到，不會選到外面那層', async () => {
  const page = await open(MODAL, 800);
  await page.click(HEADER_BTN);
  await until(() => page.eval(`!!document.querySelector(${JSON.stringify(DIALOG_BTN)})`), 3000);
  const state = await page.eval(`(() => {
    const a = document.querySelector(${JSON.stringify(DIALOG_BTN)});
    return { aria: a.getAttribute('aria-disabled'), pe: getComputedStyle(a).pointerEvents };
  })()`);
  check(state.aria === 'true' && state.pe === 'none', '按鈕應該還不能按：' + JSON.stringify(state));
  check((await startPick(MODAL)) === 'ok', 'pickStart');
  await sleep(200);
  await page.click(DIALOG_BTN);
  await sleep(500);
  await page.clickShadow('儲存');
  await until(async () => (await getRules()).length === 1);
  const rule = (await getRules())[0];
  check(rule.text === 'Sign in', '應該選到按鈕，不是外面那層：' + rule.text);
  check(!/over|pressed|focus|disabled/.test(rule.selector), 'selector 不應該有狀態 class：' + rule.selector);

  await seedEntry('right');
  await page.send('Page.reload');
  await sleep(800);
  await page.click(HEADER_BTN);
  const counts = await signedIn(page);
  check(counts && counts.signin === 1 && counts.header === 1, '存了帳號後應該照常點：' + JSON.stringify(await modalCounts(page)));
  await closePage(page);
});

test('Nexus 登入框：舊規則對不上位置時，點登入框那顆，不點右上角那顆', async () => {
  await seedEntry('right');
  await seedRules([STALE_MODAL_RULE]);
  const page = await open(MODAL, 800);
  await page.click(HEADER_BTN);
  const counts = await signedIn(page);
  check(counts && counts.signin === 1 && counts.header === 1, '實際 ' + JSON.stringify(await modalCounts(page)));
  await closePage(page);
});

for (const [name, query] of [
  ['有 aria-disabled', '?slow'],
  ['只有 class 和 pointer-events', '?slow&noaria'],
]) {
  test('Nexus 登入框：按鈕還不能按時等它，不會改點右上角那顆（' + name + '）', async () => {
    await seedEntry('right');
    await seedRules([STALE_MODAL_RULE]);
    const page = await open(MODAL + query, 800);
    await page.click(HEADER_BTN);
    await sleep(1200);
    const waiting = await modalCounts(page);
    check(waiting.signin === 0 && waiting.header === 1, '還不能按時不應該點任何一顆：' + JSON.stringify(waiting));
    const counts = await signedIn(page);
    check(counts && counts.signin === 1 && counts.header === 1, '可以按之後應該點登入框那顆：' + JSON.stringify(await modalCounts(page)));
    await closePage(page);
  });
}

test('Nexus 登入框：兩條規則接力，自動打開登入框再自動按登入', async () => {
  await seedEntry('right');
  await seedRules([
    { path: MODAL_PATH, selector: 'a.x-btn.x-unselectable.x-box-item.x-toolbar-item.x-btn-nx-header-medium', text: 'Sign in', when: 'onLoad' },
    { path: MODAL_PATH, selector: 'a.x-btn.x-unselectable.x-box-item.x-toolbar-item.x-btn-nx-primary-small', text: 'Sign in', when: 'afterFill' },
  ]);
  const page = await open(MODAL);
  const counts = await signedIn(page);
  check(counts && counts.signin === 1 && counts.header === 1, '實際 ' + JSON.stringify(await safeEval(page, 'window.__counts')));
  await closePage(page);
});

test('同名按鈕都沒被遮住時，點離帳密欄最近的那顆', async () => {
  await seedEntry('right');
  await seedRules([STALE_MODAL_RULE]);
  const page = await open(MODAL + '?nomask', 800);
  await page.click(HEADER_BTN);
  const counts = await signedIn(page);
  check(counts && counts.signin === 1 && counts.header === 1, '實際 ' + JSON.stringify(await modalCounts(page)));
  await closePage(page);
});

test('頁面一打開就點：同名按鈕只點沒被遮住、可以按的那顆', async () => {
  await seedRules([{ ...STALE_MODAL_RULE, when: 'onLoad' }]);
  const page = await open(MODAL + '?open', 1500);
  const waiting = await modalCounts(page);
  check(waiting.header === 0 && waiting.signin === 0, '右上角被遮住、登入框那顆還不能按，都不應該點：' + JSON.stringify(waiting));
  await page.eval(`(() => {
    for (const input of document.querySelectorAll('.x-form-body input')) {
      input.value = 'x';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
  })()`);
  const counts = await signedIn(page);
  check(counts && counts.signin === 1 && counts.header === 0, '實際 ' + JSON.stringify(await modalCounts(page)));
  await closePage(page);
});

test('安全：同名按鈕分不出來就不點', async () => {
  await seedRules([{ path: '/twins', selector: '#notExist', text: '送出', when: 'onLoad' }]);
  const page = await open(ORIGIN + '/twins', 2500);
  check((await page.eval('window.__clicks')) === 0, '兩顆都沒被遮住，不應該猜');
  await closePage(page);
});

// ---- SPA ----

test('SPA：換到 #/login 才點', async () => {
  await seedRules([{ path: '/spa#/login', selector: '#ssoBtn', text: 'SSO', when: 'onLoad' }]);
  const page = await open(ORIGIN + '/spa#/home', 1200);
  check(!(await page.eval('window.__clicked')), '在 #/home 不應該點');
  await page.eval(`location.hash = '#/login'`);
  const hit = await until(() => page.eval('window.__clicked'), 5000);
  check(hit, '換到 #/login 應該點');
  await closePage(page);
});

// ---- iframe ----

test('iframe：同網站的會點，跨網站的不會點', async () => {
  await seedRules([{ path: '/test/click-sso.html', selector: '#ssoBtn', text: '使用單一登入', when: 'onLoad' }]);
  hits.length = 0;
  let page = await open(ORIGIN + '/wrap?src=' + encodeURIComponent('/test/click-sso.html'));
  const ok = await until(() => hitCount('click-sso.html?home') > 0, 5000);
  check(ok, '同網站 iframe 應該點');
  await closePage(page);

  await seedRules([{ host: 'localhost', path: '/test/click-sso.html', selector: '#ssoBtn', text: '使用單一登入', when: 'onLoad' }]);
  hits.length = 0;
  page = await open(ORIGIN + '/wrap?src=' + encodeURIComponent('http://localhost:' + PORT + '/test/click-sso.html'));
  await sleep(3000);
  check(hits.filter((h) => h.startsWith('/test/click-sso.html')).length === 1, 'iframe 應該有載入：' + JSON.stringify(hits));
  check(hitCount('click-sso.html?home') === 0, '跨網站 iframe 不應該點');
  await closePage(page);
});

test('iframe：在同網站 iframe 裡選按鈕，最上層的提示會收掉', async () => {
  const url = ORIGIN + '/wrap?src=' + encodeURIComponent('/test/click-sso.html');
  const page = await open(url, 1000);
  check((await startPick(url)) === 'ok', 'pickStart');
  await sleep(300);
  const pos = await page.eval(`(() => {
    const f = document.getElementById('f');
    const fr = f.getBoundingClientRect();
    const r = f.contentDocument.getElementById('ssoBtn').getBoundingClientRect();
    return { x: fr.left + f.clientLeft + r.left + r.width / 2, y: fr.top + f.clientTop + r.top + r.height / 2 };
  })()`);
  await page.clickAt(pos.x, pos.y);
  await sleep(600);
  const texts = await page.shadowTexts();
  check(!texts.some((t) => /點要自動點的按鈕/.test(t)), '最上層提示應該收掉，實際 ' + JSON.stringify(texts));
  check(texts.some((t) => /要自動點這個嗎/.test(t)), '確認卡片應該出現在 iframe 裡，實際 ' + JSON.stringify(texts));
  check((await page.eval(`document.getElementById('f').contentWindow.sessionStorage.ssoClicks`)) === '0', '不應該真的按到');
  await closePage(page);
});

test('iframe：跨網站 iframe 裡選不到，也不會真的按到', async () => {
  hits.length = 0;
  const url = ORIGIN + '/wrap?src=' + encodeURIComponent('http://localhost:' + PORT + '/test/click-sso.html');
  const page = await open(url, 1000);
  check((await startPick(url)) === 'ok', 'pickStart');
  await sleep(300);
  const frame = await attachFrame(b.cdp, 'localhost');
  const inner = await frame.centerOf('#ssoBtn');
  const f = await page.eval(`(() => { const e = document.getElementById('f'); const r = e.getBoundingClientRect(); return { x: r.left + e.clientLeft, y: r.top + e.clientTop }; })()`);
  await page.clickAt(f.x + inner.x, f.y + inner.y);
  await sleep(800);
  await page.screenshot(path.join(SHOTS, 'cross-frame.png'));
  const rules = await getRules();
  check(rules.length === 0, '不應該存規則');
  check(hitCount('click-sso.html?home') === 0, '不應該真的按到');
  const texts = await frame.shadowTexts();
  check(texts.some((t) => /別的網站框進來/.test(t)), '應該跳提示，實際 ' + JSON.stringify(texts));
  const top = await page.shadowTexts();
  check(!top.some((t) => /點要自動點的按鈕/.test(t)), '最上層提示應該收掉，實際 ' + JSON.stringify(top));
  await closePage(page);
});

// ---- 鎖定 ----

test('工具鎖定：鎖著不點，解鎖後才點', async () => {
  await seedRules([{ path: '/test/click-sso.html', selector: '#ssoBtn', text: '使用單一登入', when: 'onLoad' }]);
  await w.eval(`(async () => {
    await chrome.storage.local.set({ webauthn: { id: 'x', alg: -7, publicKey: 'x', transports: [], createdAt: 1 } });
    const s = await getSettings();
    await setSettings({ lock: { ...s.lock, enabled: true } });
    await setLocked(true);
  })()`);
  const page = await open(T + 'click-sso.html');
  await sleep(3000);
  check((await safeEval(page, 'sessionStorage.ssoClicks')) === '0', '鎖著不應該點');
  await w.eval('setLocked(false)');
  const url = await until(async () => {
    const u = await page.url();
    return u.includes('?home') && u;
  }, 5000);
  check(url, '解鎖後應該點');
  await closePage(page);
});

test('工具鎖定：鎖著不能改規則', async () => {
  await seedRules([{ path: '/x', selector: '#a', text: 'A', when: 'onLoad' }]);
  await w.eval(`(async () => {
    await chrome.storage.local.set({ webauthn: { id: 'x', alg: -7, publicKey: 'x', transports: [], createdAt: 1 } });
    const s = await getSettings();
    await setSettings({ lock: { ...s.lock, enabled: true } });
    await setLocked(true);
  })()`);
  const r = await w.eval(`(async () => {
    const out = {};
    for (const type of ['clickRules.save', 'clickRules.add', 'clickRules.update', 'clickRules.delete', 'clickRules.reorder', 'clickRules.timing']) {
      try {
        await dispatch({ type, id: 'rule-0', patch: { enabled: false }, rule: { host: 'a.com', path: '/', selector: '#x' } }, ${fromOptions});
        out[type] = 'allowed';
      } catch (e) {
        out[type] = e.locked ? 'locked' : e.message;
      }
    }
    return out;
  })()`);
  for (const [k, v] of Object.entries(r)) check(v === 'locked', k + ' 應該被擋，實際 ' + v);
  await w.eval('setLocked(false)');
});

// ---- 備份 ----

test('備份：完整備份帶規則，挑幾筆不帶，重複匯入不會多', async () => {
  await seedEntry('right');
  await seedRules([{ path: '/x', selector: '#a', text: 'A', when: 'onLoad' }]);
  const r = await w.eval(`(async () => {
    const full = await exportBackup('password-123', null);
    const ids = (await loadEntries()).map((e) => e.id);
    const partial = await exportBackup('password-123', ids);
    await setSettings({ clickRules: [] });
    const statsPartial = await importBackup('password-123', partial.content);
    const afterPartial = (await getSettings()).clickRules.length;
    const statsFull = await importBackup('password-123', full.content);
    const afterFull = (await getSettings()).clickRules;
    const statsAgain = await importBackup('password-123', full.content);
    const afterAgain = (await getSettings()).clickRules.length;
    return { statsPartial, afterPartial, statsFull, afterFull, statsAgain, afterAgain };
  })()`);
  check(r.statsPartial.clickRules === 0 && r.afterPartial === 0, '挑幾筆不應該帶規則 ' + JSON.stringify(r.statsPartial));
  check(r.statsFull.clickRules === 1 && r.afterFull.length === 1 && r.afterFull[0].selector === '#a', '完整備份要帶回規則 ' + JSON.stringify(r.statsFull));
  check(r.statsAgain.clickRules === 0 && r.afterAgain === 1, '重複匯入不應該多 ' + JSON.stringify(r.statsAgain));
});

test('自動備份指紋：沒有規則時跟舊版一樣，有規則時會變', async () => {
  const r = await w.eval(`(async () => {
    const entries = [{ id: 'a', updatedAt: 1 }];
    const text = 'a:1';
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    const old = bytesToB64(new Uint8Array(hash));
    return { old, none: await entriesSignature(entries, []), some: await entriesSignature(entries, [{ id: 'r' }]) };
  })()`);
  check(r.old === r.none, '沒有規則時指紋要跟舊版一樣');
  check(r.some !== r.none, '有規則時指紋要變');
});

test('自動備份：不存備份密碼，檔案只有備份密碼打得開', async () => {
  await seedEntry('right');
  const r = await w.eval(`(async () => {
    const secret = 'auto-backup-pass-123';
    await handlers['autoBackup.set']({ password: secret });
    const stored = JSON.stringify(await chrome.storage.local.get(null)) + JSON.stringify(await loadVault());
    // 不要真的寫檔到下載資料夾
    const realSave = saveFile;
    let saved = null;
    saveFile = async ({ content, filename }) => {
      saved = content;
      return { id: 0, path: 'fake/' + filename };
    };
    let result;
    try {
      result = await runAutoBackup(true);
    } finally {
      saveFile = realSave;
    }
    const file = JSON.parse(saved);
    const body = JSON.parse(await decryptBackup(secret, file));
    let imported = '';
    try {
      await importBackup(secret, saved);
      imported = 'ok';
    } catch (e) {
      imported = e.message;
    }
    let wrong = '';
    try {
      await importBackup('wrong-pass-123', saved);
    } catch (e) {
      wrong = e.message;
    }
    return {
      leaked: stored.includes(secret),
      hasPassword: (await autoBackupInfo()).hasPassword,
      ran: result.ran,
      version: file.version,
      topLevel: 'iv' in file || 'data' in file || 'kdf' in file,
      passwords: body.entries.map((e) => e.password),
      imported,
      wrong,
      expectWrong: t('bg_wrong_password_or_damaged'),
    };
  })()`);
  check(!r.leaked, '設了備份密碼後，storage.local 和 vault 裡都不能有這組密碼');
  check(r.hasPassword, '管理頁要顯示已設定');
  check(r.ran && r.version === 2, '自動備份要存成 version 2：' + JSON.stringify(r));
  check(!r.topLevel, 'version 2 的密文不能放最外層，舊版才不會說密碼錯誤');
  check(r.passwords.length === 1 && r.passwords[0] === 'right', '用備份密碼要解得開帳密：' + JSON.stringify(r.passwords));
  check(r.imported === 'ok', '匯入要成功：' + r.imported);
  check(r.wrong === r.expectWrong, '密碼錯要說密碼錯誤：' + r.wrong);
});

test('自動備份：1.14 以前存在 vault 裡的備份密碼，升級時換成金鑰再刪掉', async () => {
  await seedEntry('right');
  const r = await w.eval(`(async () => {
    const old = 'old-auto-pass-123';
    await modifyVault((v) => {
      v.meta.autoBackupPassword = old;
    });
    await migrateAutoBackupPassword();
    const key = await getAutoBackupKey();
    const vault = await loadVault();
    const { content } = await exportAutoBackup(key, vault.entries, await getSettings());
    const body = JSON.parse(await decryptBackup(old, JSON.parse(content)));

    // 已經有新金鑰、vault 裡卻還留著舊密碼（上次轉到一半）：不能拿舊密碼蓋掉新金鑰
    await modifyVault((v) => {
      v.meta.autoBackupPassword = 'leftover-pass-123';
    });
    await migrateAutoBackupPassword();
    const keyAfter = await getAutoBackupKey();
    return {
      left: 'autoBackupPassword' in (await loadVault()).meta,
      hasPassword: (await autoBackupInfo()).hasPassword,
      count: body.entries.length,
      kept: keyAfter.publicKey === key.publicKey,
    };
  })()`);
  check(!r.left, '轉換後 vault 裡不能再有舊密碼');
  check(r.hasPassword, '轉換後管理頁要顯示已設定');
  check(r.count === 1, '轉換後的備份檔要用原本的密碼打得開');
  check(r.kept, '已經有金鑰時不能被舊密碼蓋掉');
});

test('備份：太新的備份檔說要更新，缺欄位的說不是備份檔', async () => {
  const r = await w.eval(`(async () => {
    const msg = async (file) => {
      try {
        await importBackup('whatever-123', JSON.stringify(file));
        return 'ok';
      } catch (e) {
        return e.message;
      }
    };
    return {
      tooNew: await msg({ format: 'pk-backup', version: 3 }),
      broken: await msg({ format: 'pk-backup', version: 2, payload: {} }),
      expectNew: t('bg_backup_too_new'),
      expectBroken: t('bg_not_backup_file'),
    };
  })()`);
  check(r.tooNew === r.expectNew, '太新的檔案要叫使用者更新：' + r.tooNew);
  check(r.broken === r.expectBroken, '缺欄位的要說不是備份檔：' + r.broken);
});

// ---- 小視窗和管理頁 ----

test('小視窗：按「選要自動點的按鈕」真的會進選取模式，有規則顯示條數', async () => {
  await seedRules([{ path: '/test/click-sso.html', selector: '#nope', text: '找不到的按鈕', when: 'onLoad' }]);
  const target = await open(T + 'click-sso.html', 800);
  // 小視窗開在分頁裡的話，「目前分頁」會變成它自己，所以把這個查詢導到測試頁
  const stub = `{
    const q = chrome.tabs.query.bind(chrome.tabs);
    chrome.tabs.query = async (info) => (info && info.active && info.currentWindow ? q({ url: '*://127.0.0.1/*' }) : q(info));
    window.close = () => { window.__closed = true; };
  }`;
  const popup = await openPage(b.cdp, 'about:blank', stub);
  await popup.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 620, deviceScaleFactor: 1, mobile: false });
  await popup.goto('chrome-extension://' + extId + '/src/popup/popup.html', 1200);
  await b.cdp.send('Target.activateTarget', { targetId: popup.targetId });
  await popup.send('Page.bringToFront');
  await sleep(300);
  check((await popup.eval(`document.getElementById('site').textContent`)) === '127.0.0.1', '小視窗要認到測試頁');
  const count = await popup.eval(`document.getElementById('pickCount').textContent`);
  check(/這一頁有 1 條/.test(count), '條數文字：' + count);
  check(!(await popup.eval(`document.getElementById('pickCount').hidden`)), '條數要顯示');
  await popup.screenshot(path.join(SHOTS, 'popup.png'));
  await popup.click('#pickBtn');
  await sleep(600);
  check(await popup.eval('window.__closed === true'), '按了要關小視窗');
  const texts = await target.shadowTexts();
  check(texts.some((t) => /點要自動點的按鈕/.test(t)), '測試頁應該進選取模式，實際 ' + JSON.stringify(texts));
  await closePage(popup);
  await closePage(target);
});

test('小視窗：瀏覽器自己的頁面按鈕是灰的', async () => {
  const stub = `window.close = () => {};`;
  const popup = await openPage(b.cdp, 'about:blank', stub);
  await popup.goto('chrome-extension://' + extId + '/src/popup/popup.html', 1000);
  check(await popup.eval(`document.getElementById('pickBtn').disabled`), '不能用的頁面要灰掉');
  await closePage(popup);
});

test('管理頁：列規則、改網址、改時機、關掉、刪除，別的分頁新增會更新', async () => {
  await seedEntry('right');
  await seedRules([
    { path: '/test/click-login.html', selector: '.go', text: '登 入', when: 'afterFill' },
    { host: 'nosaved.example.com', path: '/', selector: '#x', text: '', when: 'afterFill' },
  ]);
  const page = await open('chrome-extension://' + extId + '/src/options/options.html#settings', 1200);
  await page.eval(`document.getElementById('ruleSites').scrollIntoView()`);
  await page.eval(`document.querySelectorAll('.rule-site').forEach((s) => { s.open = true; })`);
  await sleep(200);
  await page.screenshot(path.join(SHOTS, 'options.png'));
  const rows = await page.eval(`Array.from(document.querySelectorAll('.rule-card')).map((c) => c.innerText.replace(/\\s+/g, ' '))`);
  check(rows.length === 2, '應該兩條：' + JSON.stringify(rows));
  check(rows[1].includes('還沒存帳號'), '沒存帳號要標出來：' + JSON.stringify(rows));
  check((await page.eval(`document.querySelectorAll('.rule-text')[1].value`)) === '', '沒文字時按鈕文字欄要是空的');
  const textTip = await page.eval(`document.querySelectorAll('.rule-text')[1].closest('.rule-field').querySelector('.tip').dataset.tip`);
  check(textTip.includes('留空就只看選擇器'), '要標出留空是什麼意思：' + textTip);

  // 改網址：貼整個網址只留路徑
  await page.eval(`(() => {
    const i = document.querySelector('.rule-path');
    i.value = 'http://127.0.0.1:8770/test/click-login.html?x=1';
    i.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await sleep(300);
  check((await page.eval(`document.querySelector('.rule-path').value`)) === '/test/click-login.html?x=1', '網址要整理');
  check((await getRules()).find((r) => r.id === 'rule-0').path === '/test/click-login.html?x=1', '要存回去');

  // 網址清空：跳提示、放回原本的
  await page.eval(`(() => {
    const i = document.querySelector('.rule-path');
    i.value = '  ';
    i.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await sleep(300);
  check((await page.eval(`document.querySelector('.rule-path').value`)) === '/test/click-login.html?x=1', '失敗要放回原本的');
  check(/不能空白/.test(await page.eval(`document.getElementById('toast').textContent`)), '要跳提示');

  // 改時機
  await page.eval(`(() => {
    const s = document.querySelector('.rule-when');
    s.value = 'onLoad';
    s.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await sleep(300);
  check((await getRules()).find((r) => r.id === 'rule-0').when === 'onLoad', '時機要存回去');

  // 關掉
  await page.click('.rule-enabled');
  await sleep(300);
  check((await getRules()).find((r) => r.id === 'rule-0').enabled === false, '要關掉');

  // 別的分頁新增
  const other = await open(T + 'click-sso.html', 800);
  check((await startPick(T + 'click-sso.html')) === 'ok', 'pickStart');
  await sleep(200);
  await other.click('#ssoBtn');
  await sleep(400);
  await other.clickShadow('儲存');
  await sleep(500);
  await closePage(other);
  const n = await until(() => page.eval(`document.querySelectorAll('.rule-card').length === 3`), 3000);
  check(n, '管理頁開著要自己更新');

  // 刪除
  await b.cdp.send('Target.activateTarget', { targetId: page.targetId });
  await page.send('Page.bringToFront');
  await sleep(200);
  await page.click('.rule-delete');
  await sleep(500);
  check(page.dialogs.some((d) => /刪除/.test(d)), '刪除要先問');
  check((await getRules()).length === 2, '應該剩兩條');
  await closePage(page);
});

// 表格要能捲、高度有上限、標題留在上面、捲到底看得到最後一列
async function checkTableScrolls(page, id, maxHeight) {
  const r = await page.eval(`(() => {
    const box = document.getElementById(${JSON.stringify(id)});
    box.scrollIntoView();
    const th = box.querySelector('th');
    const before = th.getBoundingClientRect().top;
    box.scrollTop = 200;
    const after = th.getBoundingClientRect().top;
    box.scrollTop = box.scrollHeight;
    const last = box.querySelector('tbody tr:last-child').getBoundingClientRect();
    const result = {
      scrollable: box.scrollHeight > box.clientHeight,
      height: box.clientHeight,
      moved: Math.abs(after - before),
      lastVisible: last.bottom <= box.getBoundingClientRect().bottom + 1,
    };
    box.scrollTop = 200;
    return result;
  })()`);
  check(r.scrollable, id + ' 應該可以捲：' + JSON.stringify(r));
  check(r.height <= maxHeight, id + ' 高度應該有上限 ' + maxHeight + '：' + JSON.stringify(r));
  check(r.moved < 1, id + ' 標題應該留在上面：' + JSON.stringify(r));
  check(r.lastVisible, id + ' 捲到底要看得到最後一列：' + JSON.stringify(r));
  await checkScrollbarBelowHead(page, id);
}

// 從畫面看不出捲軸軌道的位置，所以用按的：標題旁邊按了不會捲，標題正下方按了才會往上捲一頁
async function checkScrollbarBelowHead(page, id) {
  const startAt = 400;
  const scrollTop = () => page.eval(`document.getElementById(${JSON.stringify(id)}).scrollTop`);
  const at = await page.eval(`(() => {
    const box = document.getElementById(${JSON.stringify(id)});
    box.scrollTop = ${startAt};
    const gutter = box.offsetWidth - box.clientWidth - box.clientLeft * 2;
    const th = box.querySelector('th').getBoundingClientRect();
    return {
      x: box.getBoundingClientRect().left + box.clientLeft + box.clientWidth + gutter / 2,
      gutter,
      besideHead: th.top + th.height / 2,
      belowHead: th.bottom + 3,
      top: box.scrollTop,
    };
  })()`);
  check(at.gutter > 0, id + ' 應該有直向捲軸：' + JSON.stringify(at));
  check(at.top === startAt, id + ' 應該捲得到 ' + startAt + '：' + JSON.stringify(at));
  await page.clickAt(at.x, at.besideHead);
  await sleep(400);
  const beside = await scrollTop();
  check(beside === startAt, id + ' 捲軸不應該延伸到標題旁邊，按了之後從 ' + startAt + ' 變成 ' + beside);
  await page.clickAt(at.x, at.belowHead);
  await sleep(400);
  const below = await scrollTop();
  check(below < startAt, id + ' 標題正下方應該是捲軸，按了之後還是 ' + below);
  await page.eval(`document.getElementById(${JSON.stringify(id)}).scrollTop = 200`);
}

// 先捲到一半再按固定在外面的那顆按鈕。按了會整張重畫，捲動位置要留著，不然畫面會跳回頂端。
async function checkClickKeepsScroll(page, boxId, buttonSelector) {
  await page.eval(`(() => {
    const box = document.getElementById(${JSON.stringify(boxId)});
    box.scrollIntoView({ block: 'nearest' });
    box.scrollTop = 400;
  })()`);
  await sleep(100);
  check((await page.eval(`document.getElementById(${JSON.stringify(boxId)}).scrollTop`)) === 400, boxId + ' 應該捲得到 400');
  await page.click(buttonSelector);
  await sleep(300);
  const top = await page.eval(`document.getElementById(${JSON.stringify(boxId)}).scrollTop`);
  check(top === 400, boxId + ' 按了 ' + buttonSelector + ' 之後捲動位置要留著，實際 ' + top);
}

test('管理頁：密碼表、備份紀錄、回收桶列太多時也會自己捲', async () => {
  const hosts = Array.from({ length: 80 }, (_, i) => 'site' + String(i).padStart(2, '0') + '.example.test');
  await w.eval(`(async () => {
    const hosts = ${JSON.stringify(hosts)};
    for (const host of hosts) {
      await handlers['entries.save']({ entry: { host, origin: 'https://' + host, username: 'test-user', password: 'not-a-real-one' } }, ${fromOptions});
    }
    const entries = await loadEntries();
    for (const e of entries.slice(0, 40)) await handlers['entries.delete']({ id: e.id });
    for (let i = 0; i < 40; i++) await appendBackupLog({ kind: 'manual', path: 'C:\\\\backup\\\\file' + i + '.pkbak', count: 1 });
    return true;
  })()`);
  const page = await open('chrome-extension://' + extId + '/src/options/options.html#passwords', 1500);
  const viewport = await page.eval('innerHeight');

  await checkTableScrolls(page, 'passwordTableWrap', Math.ceil(viewport * 0.7));
  await sleep(100);
  await page.screenshot(path.join(SHOTS, 'options-passwords-scroll.png'));
  await checkClickKeepsScroll(page, 'passwordTableWrap', '#checkAll');
  check(/40 筆/.test(await page.eval(`document.getElementById('exportSelected').textContent`)), '全選要算整張表');

  await page.eval(`location.hash = '#backup'; document.getElementById('logDetails').open = true;`);
  await sleep(300);
  await checkTableScrolls(page, 'logTableWrap', 360);
  await sleep(100);
  await page.screenshot(path.join(SHOTS, 'options-log-scroll.png'));
  await checkClickKeepsScroll(page, 'logTableWrap', '#logCheckAll');
  check(/40 筆/.test(await page.eval(`document.getElementById('logDelete').textContent`)), '備份紀錄全選要算整張表');

  await page.eval(`location.hash = '#trash'`);
  await sleep(300);
  const trash = await page.eval(`(() => {
    const box = document.getElementById('trashList');
    const rows = box.querySelectorAll('.entry');
    const heights = Array.from(rows).map((x) => x.getBoundingClientRect().height);
    return {
      scrollable: box.scrollHeight > box.clientHeight,
      height: box.clientHeight,
      rows: rows.length,
      minRow: Math.min(...heights),
      maxHeight: Math.ceil(innerHeight * 0.6),
    };
  })()`);
  check(trash.rows === 40, '回收桶應該有 40 筆：' + JSON.stringify(trash));
  check(trash.scrollable, '回收桶應該可以捲：' + JSON.stringify(trash));
  check(trash.height <= trash.maxHeight, '回收桶高度應該有上限：' + JSON.stringify(trash));
  check(trash.minRow >= 30, '回收桶的列不應該被壓扁：' + JSON.stringify(trash));
  await page.screenshot(path.join(SHOTS, 'options-trash-scroll.png'));
  await checkClickKeepsScroll(page, 'trashList', '#trashCheckAll');
  check(/40 筆/.test(await page.eval(`document.getElementById('trashRestoreSel').textContent`)), '回收桶全選要算整個清單');
  await closePage(page);
});

test('管理頁：列太多時表格自己捲，標題留在上面，勾選後不會跳回頂端', async () => {
  const hosts = Array.from({ length: 30 }, (_, i) => 'site' + String(i).padStart(2, '0') + '.example.test');
  await w.eval(`(async () => {
    for (const host of ${JSON.stringify(hosts)}) {
      await handlers['entries.save']({ entry: { host, origin: 'https://' + host, username: 'test-user', password: 'not-a-real-one' } }, ${fromOptions});
    }
    return true;
  })()`);
  await seedRules(hosts.map((host, i) => ({ host, path: '/', selector: '#b' + i, text: '按鈕' + i, when: 'onLoad' })));
  const page = await open('chrome-extension://' + extId + '/src/options/options.html#settings', 1500);

  await checkTableScrolls(page, 'siteTableWrap', 360);
  await page.eval(`document.getElementById('siteTableWrap').scrollIntoView()`);
  await sleep(200);
  await page.screenshot(path.join(SHOTS, 'options-scroll.png'));

  // 自動點選沒有固定的標題，高度有上限、捲到底看得到最後一個網站就好
  const ruleScroll = await page.eval(`(() => {
    const box = document.getElementById('ruleSites');
    box.scrollIntoView();
    box.scrollTop = box.scrollHeight;
    const last = box.querySelector('.rule-site:last-child').getBoundingClientRect();
    const result = {
      scrollable: box.scrollHeight > box.clientHeight,
      height: box.clientHeight,
      lastVisible: last.bottom <= box.getBoundingClientRect().bottom + 1,
    };
    box.scrollTop = 0;
    return result;
  })()`);
  check(ruleScroll.scrollable, 'ruleSites 應該可以捲：' + JSON.stringify(ruleScroll));
  check(ruleScroll.height <= Math.ceil(800 * 0.7), 'ruleSites 高度應該有上限：' + JSON.stringify(ruleScroll));
  check(ruleScroll.lastVisible, 'ruleSites 捲到底要看得到最後一個網站：' + JSON.stringify(ruleScroll));

  // 視窗變窄時標題的字會折行，捲軸的起點要跟著往下
  await page.eval(`showTab('passwords')`);
  const headHeight = () => page.eval(`document.querySelector('#passwordTableWrap th').getBoundingClientRect().height`);
  const wideHead = await headHeight();
  await page.send('Emulation.setDeviceMetricsOverride', { width: 500, height: 800, deviceScaleFactor: 1, mobile: false });
  await sleep(300);
  const narrowHead = await headHeight();
  check(narrowHead > wideHead, '視窗變窄時標題應該變高，不然測不到：' + wideHead + ' → ' + narrowHead);
  await page.eval(`document.getElementById('passwordTableWrap').scrollIntoView()`);
  await checkScrollbarBelowHead(page, 'passwordTableWrap');
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 800, deviceScaleFactor: 1, mobile: false });
  await page.eval(`showTab('settings')`);
  await sleep(300);
  await page.eval(`document.getElementById('siteTableWrap').scrollIntoView()`);

  // 勾選會整張表重畫，捲動位置要留著，不然勾下面的網站時畫面會跳回頂端
  const rowBox = await page.eval(`(() => {
    const box = document.getElementById('siteTableWrap');
    box.scrollTop = 400;
    const boxRect = box.getBoundingClientRect();
    const th = box.querySelector('th').getBoundingClientRect();
    const input = Array.from(box.querySelectorAll('tbody input[type=checkbox]')).find((x) => {
      const r = x.getBoundingClientRect();
      return r.top > th.bottom + 2 && r.bottom < boxRect.bottom - 2;
    });
    const r = input.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  await page.clickAt(rowBox.x, rowBox.y);
  await sleep(300);
  check((await page.eval(`document.getElementById('siteTableWrap').scrollTop`)) === 400, '勾選後捲動位置要留著');
  check(/1 個網站還沒套用/.test(await page.eval(`document.getElementById('siteDirty').textContent`)), '要真的勾到');

  // 捲到下面時標題的「清除所有」還按得到，而且整張表都算
  const clear = await page.centerOf('#siteTable button[data-col="fill"][data-val="0"]');
  await page.clickAt(clear.x, clear.y);
  await sleep(300);
  check(/30 個網站還沒套用/.test(await page.eval(`document.getElementById('siteDirty').textContent`)), '清除所有要算整張表');

  // 自動點選也是：改完不會跳回頂端
  await page.eval(`document.getElementById('ruleSites').scrollIntoView()`);
  const ruleBox = await page.eval(`(() => {
    const box = document.getElementById('ruleSites');
    box.querySelectorAll('.rule-site').forEach((s) => { s.open = true; });
    box.scrollTop = 400;
    const boxRect = box.getBoundingClientRect();
    const input = Array.from(box.querySelectorAll('.rule-enabled')).find((x) => {
      const r = x.getBoundingClientRect();
      return r.top > boxRect.top + 2 && r.bottom < boxRect.bottom - 2;
    });
    const r = input.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  await page.clickAt(ruleBox.x, ruleBox.y);
  await sleep(300);
  check((await page.eval(`document.getElementById('ruleSites').scrollTop`)) === 400, '自動點選改完捲動位置要留著');
  check((await getRules()).filter((r) => !r.enabled).length === 1, '要真的關掉一條');

  // 刪到沒有資料時，外框也要收掉，不留空框
  await w.eval(`setSettings({ clickRules: [] })`);
  await page.send('Page.reload');
  await sleep(1200);
  check(await page.eval(`document.getElementById('ruleSites').hidden`), '沒有規則時外框要收掉');
  await closePage(page);
});

test('管理頁：列不多時不會出現捲軸', async () => {
  await seedEntry('right');
  await seedRules([{ path: '/x', selector: '#a', text: 'A', when: 'onLoad' }]);
  await w.eval(`appendBackupLog({ kind: 'manual', path: 'C:\\\\backup\\\\file.pkbak', count: 1 })`);
  const page = await open('chrome-extension://' + extId + '/src/options/options.html#settings', 1200);
  // 自動點選沒有表格的標題，只看有沒有捲軸。只有一個網站時要自己展開，高度才算數。
  const ruleSites = await page.eval(`(() => {
    const b = document.getElementById('ruleSites');
    b.scrollIntoView();
    return { sh: b.scrollHeight, ch: b.clientHeight, sw: b.scrollWidth, cw: b.clientWidth, open: b.querySelector('.rule-site').open };
  })()`);
  check(ruleSites.open, '只有一個網站時要展開：' + JSON.stringify(ruleSites));
  check(ruleSites.ch > 0, 'ruleSites 要看得到才算數：' + JSON.stringify(ruleSites));
  check(ruleSites.sh <= ruleSites.ch, 'ruleSites 不應該有直向捲軸：' + JSON.stringify(ruleSites));
  check(ruleSites.sw <= ruleSites.cw, 'ruleSites 不應該有橫向捲軸：' + JSON.stringify(ruleSites));
  for (const [tab, id] of [
    ['settings', 'siteTableWrap'],
    ['passwords', 'passwordTableWrap'],
    ['backup', 'logTableWrap'],
  ]) {
    const r = await page.eval(`(() => {
      location.hash = ${JSON.stringify('#' + tab)};
      showTab(${JSON.stringify(tab)});
      document.getElementById('logDetails').open = true;
      const b = document.getElementById(${JSON.stringify(id)});
      b.scrollIntoView();
      const th = b.querySelector('th:last-child').getBoundingClientRect();
      const hit = document.elementFromPoint(th.right - 5, th.top + th.height / 2);
      return { sh: b.scrollHeight, ch: b.clientHeight, sw: b.scrollWidth, cw: b.clientWidth, hit: hit && hit.tagName };
    })()`);
    check(r.ch > 0, id + ' 要看得到才算數：' + JSON.stringify(r));
    check(r.sh <= r.ch, id + ' 不應該有直向捲軸：' + JSON.stringify(r));
    check(r.sw <= r.cw, id + ' 不應該有橫向捲軸：' + JSON.stringify(r));
    check(r.hit === 'TH', id + ' 沒有捲軸時，標題右邊不應該被蓋住：' + JSON.stringify(r));
  }
  await closePage(page);
});

// ---- 自動點選的順序 ----

const ORDER = ORIGIN + '/order';
const orderRule = (name, extra) => ({ path: '/order', selector: '#' + name, text: name, when: 'onLoad', ...extra });
const orderClicks = (page) => safeEval(page, 'window.__clicks()');
const waitClicks = (page, n, ms = 6000) =>
  until(async () => {
    const clicks = await orderClicks(page);
    return clicks.length >= n && clicks;
  }, ms);
const sameList = (a, b) => JSON.stringify(a) === JSON.stringify(b);

test('順序：照排好的順序一條一條點，調了順序就照新的', async () => {
  await seedRules([orderRule('a', { onMissing: 'stop' }), orderRule('b'), orderRule('c')]);
  let page = await open(ORDER);
  let clicks = await waitClicks(page, 3);
  check(sameList(clicks, ['a', 'b', 'c']), '實際 ' + JSON.stringify(clicks));
  await closePage(page);
  await w.eval(`handlers['clickRules.reorder']({ host: '127.0.0.1', ids: ['rule-2', 'rule-0', 'rule-1'] })`);
  // 新分頁沒有間隔的紀錄，不會被擋
  page = await open(ORDER);
  clicks = await waitClicks(page, 3);
  check(sameList(clicks, ['c', 'a', 'b']), '調順序後實際 ' + JSON.stringify(clicks));
  await closePage(page);
});

test('順序：前一條的按鈕晚出現，後面的會等它', async () => {
  await seedRules([orderRule('a'), orderRule('b')]);
  const page = await open(ORDER + '?late=a&ms=2500');
  await sleep(1800);
  const early = await orderClicks(page);
  check(early.length === 0, '第 1 條還沒點，第 2 條不能先點：' + JSON.stringify(early));
  const clicks = await waitClicks(page, 2);
  check(sameList(clicks, ['a', 'b']), '實際 ' + JSON.stringify(clicks));
  await closePage(page);
});

test('順序：選停止的規則剛點過、按鈕不在了，不用等 15 秒，後面的照樣點', async () => {
  await seedRules([orderRule('a', { onMissing: 'stop' }), orderRule('b')]);
  const page = await open(ORDER + '?reload=a');
  const clicks = await waitClicks(page, 2, 6000);
  check(sameList(clicks, ['a', 'b']), '實際 ' + JSON.stringify(clicks));
  await closePage(page);
});

test('順序：頁面沒有登入表單時，自動填完才點的規則不會擋後面的', async () => {
  await seedRules([{ path: '/order', selector: '#go', text: 'go', when: 'afterFill', onMissing: 'stop' }, orderRule('b')]);
  const page = await open(ORDER);
  const clicks = await waitClicks(page, 1, 4000);
  check(sameList(clicks, ['b']), '實際 ' + JSON.stringify(clicks));
  await closePage(page);
});

test('等不到按鈕：選跳過，等滿 15 秒換下一條', async () => {
  await seedRules([orderRule('a'), orderRule('b')]);
  const page = await open(ORDER + '?hide=a');
  await sleep(12000);
  const early = await orderClicks(page);
  check(early.length === 0, '15 秒內要等第 1 條：' + JSON.stringify(early));
  const clicks = await waitClicks(page, 1, 6000);
  check(sameList(clicks, ['b']), '實際 ' + JSON.stringify(clicks));
  await closePage(page);
});

test('等不到按鈕：選停止，後面都不點，之後才填好的表單也不點', async () => {
  await seedEntry('right');
  await seedRules([
    orderRule('a', { onMissing: 'stop' }),
    orderRule('b'),
    { path: '/order', selector: '#go', text: 'go', when: 'afterFill' },
  ]);
  const page = await open(ORDER + '?hide=a&form=16500');
  const toast = await until(async () => /沒點到，後面的不點了/.test(await page.toastText()) && (await page.toastText()), 18000);
  check(toast, '要跳提示');
  // 表單 16.5 秒才出現，那時候已經停了
  await sleep(4000);
  check((await safeEval(page, `document.getElementById('p').value`)) === 'right', '表單還是要自動填');
  const clicks = await orderClicks(page);
  check(clicks.length === 0, '後面都不應該點：' + JSON.stringify(clicks));
  await closePage(page);
});

// ---- 間隔、登出後暫停 ----

test('間隔：規則自己的秒數到了可以再點', async () => {
  await seedRules([{ path: '/test/click-sso.html', selector: '#ssoBtn', text: '使用單一登入', when: 'onLoad', intervalSec: 3 }]);
  const page = await open(T + 'click-sso.html?fail');
  const toast = await until(async () => /剛剛自動點過/.test(await page.toastText()) && (await page.toastText()), 6000);
  check(toast, '3 秒內重新載入應該跳「剛剛自動點過」');
  check((await safeEval(page, 'sessionStorage.ssoClicks')) === '1', '3 秒內只點一次');
  await sleep(3200);
  await page.send('Page.reload');
  const again = await until(async () => (await page.eval('sessionStorage.ssoClicks')) === '2', 6000);
  check(again, '3 秒後應該可以再點，實際 ' + (await safeEval(page, 'sessionStorage.ssoClicks')));
  await closePage(page);
});

test('間隔：改短馬上生效，正在算的紀錄也照新的秒數', async () => {
  await seedRules([{ path: '/test/click-sso.html', selector: '#ssoBtn', text: '使用單一登入', when: 'onLoad' }]);
  const page = await open(T + 'click-sso.html?fail');
  const toast = await until(async () => /剛剛自動點過/.test(await page.toastText()) && (await page.toastText()), 6000);
  check(toast, '預設 300 秒內重新載入應該被擋');
  await w.eval(`handlers['clickRules.timing']({ clickIntervalSec: 1 })`);
  await sleep(1200);
  await page.send('Page.reload');
  const again = await until(async () => (await page.eval('sessionStorage.ssoClicks')) === '2', 6000);
  check(again, '改成 1 秒後應該可以再點，實際 ' + (await safeEval(page, 'sessionStorage.ssoClicks')));
  await closePage(page);
});

test('間隔：自動填完按登入用間隔預設值', async () => {
  await seedEntry('wrong');
  await w.eval(`handlers['autoSubmit.set']({ host: '127.0.0.1', enabled: true })`);
  await w.eval(`handlers['clickRules.timing']({ clickIntervalSec: 3 })`);
  hits.length = 0;
  const page = await open(T + 'fail-login.html');
  await until(() => hitCount('fail-login.html?error=1') === 1, 5000);
  await sleep(800);
  check(hitCount('fail-login.html?error=1') === 1, '3 秒內只送一次，實際 ' + hitCount('fail-login.html?error=1'));
  await sleep(2600);
  // 重新載入本身也算一次，再送一次才會到 3
  await page.send('Page.reload');
  const again = await until(() => hitCount('fail-login.html?error=1') >= 3, 5000);
  check(again, '3 秒後應該可以再送，實際 ' + hitCount('fail-login.html?error=1'));
  await closePage(page);
});

test('間隔：規則的秒數優先，沒填用預設值；登出暫停另外算，填 0 不暫停；只看不算點', async () => {
  await seedRules([
    { path: '/x', selector: '#a', text: 'A', when: 'onLoad', intervalSec: 100 },
    { path: '/x', selector: '#b', text: 'B', when: 'onLoad' },
  ]);
  const r = await w.eval(`(async () => {
    const sender = { tab: { id: 9100 }, url: 'https://a.com/' };
    const claim = (key, ruleId, peek) => handlers['clickRules.claim']({ key, host: 'a.com', ruleId, peek }, sender);
    const ago = (key, sec) => updateClickGuard((map) => { map[9100][key] = Date.now() - sec * 1000; });
    await handlers['clickRules.timing']({ clickIntervalSec: 10, logoutPauseSec: 20 });
    const out = {};
    out.peek1 = await claim('own', 'rule-0', true);
    out.peek2 = await claim('own', 'rule-0', true);
    out.first = await claim('own', 'rule-0');
    out.peekBlocked = await claim('own', 'rule-0', true);
    await ago('own', 50);
    out.ownBlocked = await claim('own', 'rule-0');
    await ago('own', 101);
    out.ownAllowed = await claim('own', 'rule-0');
    await claim('shared', 'rule-1');
    await ago('shared', 5);
    out.sharedBlocked = await claim('shared', 'rule-1');
    await ago('shared', 11);
    out.sharedAllowed = await claim('shared', 'rule-1');
    await claim('submit');
    await ago('submit', 5);
    out.submitBlocked = await claim('submit');
    await ago('submit', 11);
    out.submitAllowed = await claim('submit');
    await handlers['clickRules.pause']({ host: 'a.com' }, sender);
    out.paused = await claim('x');
    await ago('logout:' + baseDomain('a.com'), 21);
    out.resumed = await claim('x');
    await handlers['clickRules.timing']({ logoutPauseSec: 0 });
    await handlers['clickRules.pause']({ host: 'a.com' }, sender);
    out.noPause = await claim('y');
    await clearClickGuard(9100);

    out.bad = [];
    for (const patch of [{ clickIntervalSec: 0 }, { clickIntervalSec: 1.5 }, { clickIntervalSec: 86401 }, { clickIntervalSec: null }, { logoutPauseSec: -1 }, { logoutPauseSec: 86401 }]) {
      try {
        await handlers['clickRules.timing'](patch);
        out.bad.push('allowed ' + JSON.stringify(patch));
      } catch (e) {
        if (!/整數/.test(e.message)) out.bad.push(e.message);
      }
    }
    for (const intervalSec of [0, 1.5, 86401, 'abc']) {
      try {
        await handlers['clickRules.update']({ id: 'rule-1', patch: { intervalSec } });
        out.bad.push('allowed rule ' + intervalSec);
      } catch (e) {
        if (!/整數/.test(e.message)) out.bad.push(e.message);
      }
    }
    await setSettings({ clickIntervalSec: 'abc', logoutPauseSec: -1 });
    const broken = await getSettings();
    out.broken = [broken.clickIntervalSec, broken.logoutPauseSec];
    return out;
  })()`);
  check(r.peek1.allowed && r.peek2.allowed && r.first.allowed, '只看不算點：' + JSON.stringify(r));
  check(r.peekBlocked.reason === 'cooldown', '點過之後只看也要看得出來：' + JSON.stringify(r.peekBlocked));
  check(r.ownBlocked.reason === 'cooldown' && r.ownAllowed.allowed, '規則自己的秒數優先：' + JSON.stringify(r));
  check(r.sharedBlocked.reason === 'cooldown' && r.sharedAllowed.allowed, '沒填秒數用預設值：' + JSON.stringify(r));
  check(r.submitBlocked.reason === 'cooldown' && r.submitAllowed.allowed, '自動按登入用預設值：' + JSON.stringify(r));
  check(r.paused.reason === 'logout' && r.resumed.allowed, '登出暫停另外算：' + JSON.stringify(r));
  check(r.noPause.allowed, '填 0 不暫停：' + JSON.stringify(r.noPause));
  check(r.bad.length === 0, '不合理的秒數要擋：' + JSON.stringify(r.bad));
  check(sameList(r.broken, [300, 300]), '存的秒數壞掉要當預設值：' + JSON.stringify(r.broken));
});

test('規則：重選同一顆不會蓋掉間隔和等不到按鈕時，備份也會帶到', async () => {
  await seedEntry('right');
  await seedRules([orderRule('a', { intervalSec: 42, onMissing: 'stop' })]);
  const r = await w.eval(`(async () => {
    await handlers['clickRules.save']({ rule: { host: '127.0.0.1', path: '/order', selector: '#a', text: 'a', when: 'onLoad' } }, { tab: { id: 9200 }, url: 'http://127.0.0.1/order' });
    const repicked = (await getSettings()).clickRules;
    const full = await exportBackup('password-123', null);
    await setSettings({ clickRules: [] });
    await importBackup('password-123', full.content);
    const restored = (await getSettings()).clickRules;
    return { repicked, restored };
  })()`);
  check(r.repicked.length === 1 && r.repicked[0].intervalSec === 42 && r.repicked[0].onMissing === 'stop', '重選要留著：' + JSON.stringify(r.repicked));
  check(r.restored.length === 1 && r.restored[0].intervalSec === 42 && r.restored[0].onMissing === 'stop', '備份要帶到：' + JSON.stringify(r.restored));
});

// ---- 管理頁的自動點選區塊 ----

const openRuleOptions = async () => {
  const page = await open('chrome-extension://' + extId + '/src/options/options.html#settings', 1200);
  await page.eval(`document.getElementById('ruleSites').scrollIntoView()`);
  return page;
};
const ruleSites = (page) =>
  page.eval(`Array.from(document.querySelectorAll('.rule-site')).map((s) => ({
    title: s.querySelector('summary').innerText.replace(/\\s+/g, ' '),
    open: s.open,
    visible: Array.from(s.querySelectorAll('.rule-card')).filter((c) => c.checkVisibility()).length,
  }))`);
const cardSelector = (id) => '.rule-card[data-rule-id="' + id + '"]';

test('管理頁：每個網站可以收合，改東西不會收起來，新增規則會展開', async () => {
  await seedRules([
    { host: 'a.example.test', path: '/', selector: '#a1', text: 'A1', when: 'onLoad' },
    { host: 'b.example.test', path: '/', selector: '#b1', text: 'B1', when: 'onLoad', enabled: false },
    { host: 'a.example.test', path: '/', selector: '#a2', text: 'A2', when: 'onLoad' },
  ]);
  const page = await openRuleOptions();
  let sites = await ruleSites(page);
  check(sites.length === 2, '同網站要放在一起：' + JSON.stringify(sites));
  check(sites.every((s) => !s.open && s.visible === 0), '好幾個網站時預設收合：' + JSON.stringify(sites));
  check(/a\.example\.test.*2 條/.test(sites[0].title), '要標幾條：' + sites[0].title);
  check(/b\.example\.test.*1 條，1 條關閉/.test(sites[1].title), '要標關閉幾條：' + sites[1].title);
  await page.screenshot(path.join(SHOTS, 'rule-sites-collapsed.png'));

  // 真的點網站那一列
  await page.click('.rule-site summary');
  await sleep(200);
  sites = await ruleSites(page);
  check(sites[0].open && sites[0].visible === 2, '點了要展開：' + JSON.stringify(sites));
  check(!sites[1].open, '別的網站不動：' + JSON.stringify(sites));
  await page.screenshot(path.join(SHOTS, 'rule-sites-open.png'));

  // 調順序會整塊重畫，展開的要留著
  await page.click(cardSelector('rule-0') + ' .rule-down');
  await sleep(400);
  sites = await ruleSites(page);
  check(sites[0].open && !sites[1].open, '重畫後開合要留著：' + JSON.stringify(sites));

  // 關掉一條，網站那一列的數字跟著變
  await page.click(cardSelector('rule-0') + ' .rule-enabled');
  await sleep(300);
  sites = await ruleSites(page);
  check(/2 條，1 條關閉/.test(sites[0].title), '關閉的數字要更新：' + sites[0].title);
  check(await page.eval(`document.querySelector(${JSON.stringify(cardSelector('rule-0'))}).classList.contains('off')`), '關掉的規則要變淡');

  // 再點一次收起來
  await page.click('.rule-site summary');
  await sleep(200);
  sites = await ruleSites(page);
  check(!sites[0].open && sites[0].visible === 0, '再點要收合：' + JSON.stringify(sites));

  // 在別的分頁新增，那個網站要展開
  await w.eval(`handlers['clickRules.save']({ rule: { host: 'b.example.test', path: '/new', selector: '#n', text: 'N', when: 'onLoad' } }, { tab: { id: 9300 }, url: 'https://b.example.test/new' })`);
  const opened = await until(async () => {
    const list = await ruleSites(page);
    return list[1].open && list[1].visible === 2;
  }, 3000);
  check(opened, '新增規則的網站要展開：' + JSON.stringify(await ruleSites(page)));
  await closePage(page);
});

test('管理頁：▲▼ 調整順序，只動同一個網站，對不上就不動', async () => {
  await seedRules([
    { host: 'a.example.test', path: '/', selector: '#a1', text: 'A1', when: 'onLoad' },
    { host: 'b.example.test', path: '/', selector: '#b1', text: 'B1', when: 'onLoad' },
    { host: 'a.example.test', path: '/', selector: '#a2', text: 'A2', when: 'onLoad' },
    { host: 'a.example.test', path: '/', selector: '#a3', text: 'A3', when: 'onLoad' },
  ]);
  const page = await openRuleOptions();
  await page.click('.rule-site summary');
  await sleep(200);
  const ids = async () => (await getRules()).map((r) => r.id);
  const shown = () =>
    page.eval(`Array.from(document.querySelectorAll('.rule-site')[0].querySelectorAll('.rule-card')).map((c) => ({
      no: c.querySelector('.rule-no').textContent,
      id: c.dataset.ruleId,
      up: c.querySelector('.rule-up').disabled,
      down: c.querySelector('.rule-down').disabled,
    }))`);
  let cards = await shown();
  check(sameList(cards.map((c) => c.no), ['第 1 條', '第 2 條', '第 3 條']), '要標第幾條：' + JSON.stringify(cards));
  check(cards[0].up && !cards[0].down && !cards[2].up && cards[2].down, '頭尾的按鈕要灰掉：' + JSON.stringify(cards));

  await page.click(cardSelector('rule-0') + ' .rule-down');
  await sleep(400);
  check(sameList(await ids(), ['rule-2', 'rule-1', 'rule-0', 'rule-3']), '別的網站要留在原位：' + JSON.stringify(await ids()));
  cards = await shown();
  check(sameList(cards.map((c) => c.id), ['rule-2', 'rule-0', 'rule-3']), '畫面要跟著變：' + JSON.stringify(cards));
  check(sameList(cards.map((c) => c.no), ['第 1 條', '第 2 條', '第 3 條']), '序號要重排：' + JSON.stringify(cards));
  const focused = await page.eval(`(() => {
    const a = document.activeElement;
    return { cls: a.className, id: a.closest('.rule-card') && a.closest('.rule-card').dataset.ruleId };
  })()`);
  check(focused.id === 'rule-0' && /rule-down/.test(focused.cls), '焦點要留在移動的那條：' + JSON.stringify(focused));

  await page.click(cardSelector('rule-3') + ' .rule-up');
  await sleep(400);
  check(sameList(await ids(), ['rule-2', 'rule-1', 'rule-3', 'rule-0']), '往前移：' + JSON.stringify(await ids()));

  const stale = await w.eval(`(async () => {
    const before = (await getSettings()).clickRules.map((r) => r.id);
    const out = [];
    for (const list of [['rule-0'], ['rule-0', 'rule-0', 'rule-2'], ['rule-0', 'rule-2', 'nope']]) {
      try {
        await handlers['clickRules.reorder']({ host: 'a.example.test', ids: list });
        out.push('allowed ' + list);
      } catch (e) {
        if (!/有變動/.test(e.message)) out.push(e.message);
      }
    }
    const after = (await getSettings()).clickRules.map((r) => r.id);
    return { out, same: JSON.stringify(before) === JSON.stringify(after) };
  })()`);
  check(stale.out.length === 0 && stale.same, '對不上的順序不能存：' + JSON.stringify(stale));

  // 改完欄位馬上調順序，兩個都要存到
  await page.eval(`(() => {
    const t = document.querySelector(${JSON.stringify(cardSelector('rule-2') + ' .rule-text')});
    t.value = '新的文字';
    t.dispatchEvent(new Event('change', { bubbles: true }));
    document.querySelector(${JSON.stringify(cardSelector('rule-2') + ' .rule-down')}).click();
  })()`);
  await sleep(500);
  const rules = await getRules();
  check(rules.find((r) => r.id === 'rule-2').text === '新的文字', '欄位要存到：' + JSON.stringify(rules));
  check(sameList(rules.map((r) => r.id), ['rule-3', 'rule-1', 'rule-2', 'rule-0']), '順序要存到：' + JSON.stringify(rules.map((r) => r.id)));
  await closePage(page);
});

test('管理頁：選擇器可以改，改了清空按鈕文字；寫錯不存、內容留著', async () => {
  await seedRules([orderRule('a'), orderRule('c')]);
  const page = await openRuleOptions();
  const first = cardSelector('rule-0');
  const firstRule = async () => (await getRules()).find((r) => r.id === 'rule-0');
  const field = () => page.eval(`document.querySelector(${JSON.stringify(first + ' .rule-selector')}).value`);
  const error = () => page.eval(`document.querySelector(${JSON.stringify(first + ' .error')}).textContent`);
  const setSelector = (value) =>
    page.eval(`(() => {
      const t = document.querySelector(${JSON.stringify(first + ' .rule-selector')});
      t.value = ${JSON.stringify(value)};
      t.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
  check((await field()) === '#a', '要顯示選擇器，實際 ' + (await field()));

  // 真的打字，按 Enter 算改完
  await page.click(first + ' .rule-selector');
  await page.eval(`document.querySelector(${JSON.stringify(first + ' .rule-selector')}).select()`);
  await page.send('Input.insertText', { text: '#b' });
  await page.press('Enter', 'Enter', 13);
  await sleep(400);
  let rule = await firstRule();
  check(rule.selector === '#b', '要存回去：' + JSON.stringify(rule));
  check(rule.text === '', '改選擇器要清空按鈕文字：' + JSON.stringify(rule));
  check((await field()) === '#b', 'Enter 不應該多一個換行：' + JSON.stringify(await field()));
  check((await page.eval(`document.querySelector(${JSON.stringify(first + ' .rule-text')}).value`)) === '', '按鈕文字欄要跟著清空');
  check(/已清空按鈕文字/.test(await page.eval(`document.getElementById('toast').textContent`)), '要跳提示');

  // 開頁面真的點到新的那顆，舊的沒被點
  const target = await open(ORDER);
  const clicks = await waitClicks(target, 2);
  check(sameList(clicks, ['b', 'c']), '要點新的按鈕，實際 ' + JSON.stringify(clicks));
  await closePage(target);
  await b.cdp.send('Target.activateTarget', { targetId: page.targetId });
  await page.send('Page.bringToFront');

  // 寫法有錯
  await setSelector('div[');
  await sleep(300);
  check(/寫法有問題/.test(await error()), '要標錯：' + (await error()));
  check((await field()) === 'div[', '打的內容要留著：' + (await field()));
  check((await firstRule()).selector === '#b', '不能存：' + JSON.stringify(await firstRule()));
  await page.screenshot(path.join(SHOTS, 'rule-selector-error.png'));

  // 整塊重畫後，打的內容和錯誤還在
  await page.eval(`renderClickRules()`);
  check((await field()) === 'div[', '重畫後打的內容要留著：' + (await field()));
  check(/寫法有問題/.test(await error()), '重畫後錯誤要留著：' + (await error()));

  // 清空
  await setSelector('   ');
  await sleep(300);
  check(/不能空白/.test(await error()), '空白要標錯：' + (await error()));
  check((await firstRule()).selector === '#b', '空白不能存');

  // 跟別條一樣
  await setSelector('#c');
  await sleep(300);
  check(/相同選擇器/.test(await error()), '重複要標錯：' + (await error()));
  check((await firstRule()).selector === '#b', '重複不能存');

  // 改對了，錯誤清掉。文字已經是空的，不用再跳清空的提示
  await page.eval(`document.getElementById('toast').textContent = ''`);
  await setSelector('  #a  ');
  await sleep(300);
  check((await error()) === '', '改對要清掉錯誤：' + (await error()));
  check((await firstRule()).selector === '#a', '要存：' + JSON.stringify(await firstRule()));
  check((await field()) === '#a', '前後空白要去掉：' + JSON.stringify(await field()));
  check((await page.eval(`document.getElementById('toast').textContent`)) === '', '文字本來就空的不用跳提示');

  // 手動填回按鈕文字，空白整理成跟網頁讀到的一樣
  await page.eval(`(() => {
    const t = document.querySelector(${JSON.stringify(first + ' .rule-text')});
    t.value = '  登   入 ';
    t.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await sleep(300);
  rule = await firstRule();
  check(rule.text === '登 入', '文字要整理：' + JSON.stringify(rule));
  check((await page.eval(`document.querySelector(${JSON.stringify(first + ' .rule-text')}).value`)) === '登 入', '畫面也要整理');
  await closePage(page);
});

test('管理頁：選擇器很長時整段折行，不撐破版面', async () => {
  const unit = 'div.main-container > div:nth-of-type(2) > form:nth-of-type(2) > div.actions-wrapper > a.x-btn.x-unselectable.x-btn-nx-primary-small';
  const noSpace = 'a' + '.x-very-long-class-name-without-any-space'.repeat(12);
  await seedRules([
    { path: '/x', selector: unit, text: 'A', when: 'onLoad' },
    { path: '/y', selector: Array(8).fill(unit).join(' > '), text: 'B', when: 'onLoad' },
    { path: '/z', selector: noSpace, text: 'C', when: 'onLoad' },
  ]);
  const page = await openRuleOptions();
  const measure = () =>
    page.eval(`(() => {
      const box = document.getElementById('ruleSites');
      return {
        box: { sw: box.scrollWidth, cw: box.clientWidth },
        doc: { sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth },
        areas: Array.from(document.querySelectorAll('.rule-selector')).map((t) => ({ h: t.clientHeight, sh: t.scrollHeight, sw: t.scrollWidth, cw: t.clientWidth })),
      };
    })()`);
  for (const width of [1100, 600]) {
    await page.send('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: false });
    await sleep(300);
    const m = await measure();
    check(m.box.sw <= m.box.cw, width + ' 區塊不應該橫向捲：' + JSON.stringify(m.box));
    check(m.doc.sw <= m.doc.cw, width + ' 整頁不應該橫向捲：' + JSON.stringify(m.doc));
    for (const a of m.areas) check(a.sw <= a.cw, width + ' 選擇器要折行，不能橫向捲：' + JSON.stringify(a));
    check(m.areas.every((a) => a.h <= 100), width + ' 最多 5 行高：' + JSON.stringify(m.areas));
    check(m.areas[1].sh > m.areas[1].h, width + ' 超過 5 行要在框內捲：' + JSON.stringify(m.areas[1]));
    if (width === 1100) {
      check(m.areas[0].sh <= m.areas[0].h, '放得下的要整段看得到：' + JSON.stringify(m.areas[0]));
      check(m.areas[0].h > 30, '兩行的要比一行高：' + JSON.stringify(m.areas[0]));
      await page.screenshot(path.join(SHOTS, 'rule-long-selector.png'));
    }
  }
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 800, deviceScaleFactor: 1, mobile: false });
  await closePage(page);
});

test('管理頁：間隔、等不到按鈕時可以改，時間設定改了提示跟著變', async () => {
  await seedRules([orderRule('a'), orderRule('b')]);
  const page = await openRuleOptions();
  const first = cardSelector('rule-0');
  const firstRule = async () => (await getRules()).find((r) => r.id === 'rule-0');
  const setValue = (selector, value) =>
    page.eval(`(() => {
      const t = document.querySelector(${JSON.stringify(selector)});
      t.value = ${JSON.stringify(value)};
      t.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
  const read = (selector, prop = 'value') => page.eval(`document.querySelector(${JSON.stringify(selector)}).${prop}`);
  const toastText = () => page.eval(`document.getElementById('toast').textContent`);

  check((await read('#clickInterval')) === '300', '間隔預設值一開始是 300');
  check((await read('#logoutPause')) === '300', '登出後暫停一開始是 300');
  check((await read(first + ' .rule-interval')) === '', '沒填間隔要是空的');
  check((await read(first + ' .rule-interval', 'placeholder')) === '預設 300', '要提示預設值');

  await setValue(first + ' .rule-interval', '30');
  await sleep(300);
  check((await firstRule()).intervalSec === 30, '要存回去：' + JSON.stringify(await firstRule()));

  await setValue(first + ' .rule-interval', '0');
  await sleep(300);
  check((await firstRule()).intervalSec === 30, '0 不能存');
  check((await read(first + ' .rule-interval')) === '30', '失敗要放回原本的');
  check(/整數/.test(await toastText()), '要跳提示：' + (await toastText()));

  await setValue(first + ' .rule-interval', '');
  await sleep(300);
  check(!('intervalSec' in (await firstRule())), '清空要回到預設值：' + JSON.stringify(await firstRule()));

  await setValue(first + ' .rule-missing', 'stop');
  await sleep(300);
  check((await firstRule()).onMissing === 'stop', '要存回去：' + JSON.stringify(await firstRule()));
  await setValue(first + ' .rule-missing', 'skip');
  await sleep(300);
  check(!('onMissing' in (await firstRule())), '跳過是預設值，不用存：' + JSON.stringify(await firstRule()));
  check(!(await read(first + ' .rule-missing', 'disabled')), '不是最後一條要可以選');
  check(await read(cardSelector('rule-1') + ' .rule-missing', 'disabled'), '最後一條後面沒有別條，要灰掉');

  await setValue('#clickInterval', '60');
  await sleep(300);
  check((await w.eval('getSettings().then((s) => s.clickIntervalSec)')) === 60, '間隔預設值要存');
  check((await read(first + ' .rule-interval', 'placeholder')) === '預設 60', '提示要跟著變');
  await setValue('#clickInterval', '0');
  await sleep(300);
  check((await read('#clickInterval')) === '60', '間隔預設值不能是 0，要放回原本的');
  await setValue('#clickInterval', '');
  await sleep(300);
  check((await read('#clickInterval')) === '60', '間隔預設值不能空白，要放回原本的');

  await setValue('#logoutPause', '0');
  await sleep(300);
  check((await w.eval('getSettings().then((s) => s.logoutPauseSec)')) === 0, '登出後暫停可以是 0');
  check((await read('#logoutPause')) === '0', '畫面要顯示 0');
  await setValue('#logoutPause', '-1');
  await sleep(300);
  check((await read('#logoutPause')) === '0', '不能是負的，要放回原本的');

  // 開著畫面改了間隔預設值，不該動到已經填了秒數的規則
  await setValue(first + ' .rule-interval', '45');
  await sleep(300);
  await setValue('#clickInterval', '90');
  await sleep(300);
  check((await firstRule()).intervalSec === 45, '填了秒數的規則不跟著變：' + JSON.stringify(await firstRule()));
  check((await read(first + ' .rule-interval')) === '45', '畫面也不跟著變');
  await page.screenshot(path.join(SHOTS, 'rule-timing.png'));
  await closePage(page);
});

test('登出後暫停：按了登出，填的秒數到了就恢復自動點', async () => {
  await seedRules([{ path: '/test/click-sso.html', selector: '#ssoBtn', text: '使用單一登入', when: 'onLoad' }]);
  await w.eval(`handlers['clickRules.timing']({ logoutPauseSec: 3, clickIntervalSec: 1 })`);
  const page = await open(T + 'click-sso.html?home');
  await page.click('#logout');
  const toast = await until(async () => /剛登出/.test(await page.toastText()) && (await page.toastText()), 6000);
  check(toast, '暫停中要跳「剛登出」');
  check((await safeEval(page, 'sessionStorage.ssoClicks')) === '0', '暫停中不能點');
  await sleep(3200);
  await page.send('Page.reload');
  const url = await until(async () => {
    const u = await page.url();
    return u.includes('?home') && u;
  }, 6000);
  check(url, '3 秒後應該恢復自動點，頁面在 ' + (await safeUrl(page)));
  await closePage(page);
});

// ---- 手動新增自動點選 ----

const ruleDialogOpen = (page) => page.eval(`document.getElementById('ruleDialog').open`);
const setBox = (page, id, value) =>
  page.eval(`(() => {
    const t = document.getElementById(${JSON.stringify(id)});
    t.value = ${JSON.stringify(value)};
    t.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
const readBox = (page, id) => page.eval(`document.getElementById(${JSON.stringify(id)}).value`);
const ruleDialogErrors = (page) => page.eval(`Array.from(document.querySelectorAll('#ruleDialog .error')).map((e) => e.textContent).filter(Boolean)`);
const clickRuleAdd = async (page) => {
  await page.eval(`document.getElementById('ruleAdd').scrollIntoView({ block: 'center' })`);
  await page.click('#ruleAdd');
  await sleep(200);
};

test('手動新增：貼整個網址會拆開，存了之後開到那一頁真的會點', async () => {
  const page = await openRuleOptions();
  check(await page.eval(`document.getElementById('ruleEmpty').checkVisibility()`), '沒有規則要顯示引導文字');
  check((await page.eval(`document.getElementById('ruleEmpty').textContent`)).includes('＋ 新增'), '引導文字要提到「＋ 新增」');
  await clickRuleAdd(page);
  check(await ruleDialogOpen(page), '按了要開對話框');
  check((await page.eval('document.activeElement.id')) === 'newRuleHost', '游標要在網站欄');
  await setBox(page, 'newRuleHost', ORDER + '?x=1#section');
  check((await readBox(page, 'newRuleHost')) === '127.0.0.1', '網站要拆出來');
  check((await readBox(page, 'newRulePath')) === '/order', '網址不留查詢字串');
  await setBox(page, 'newRuleSelector', '#b');
  await setBox(page, 'newRuleText', '  b  ');
  await setBox(page, 'newRuleWhen', 'onLoad');
  await setBox(page, 'newRuleInterval', '30');
  await page.screenshot(path.join(SHOTS, 'rule-dialog.png'));
  await page.click('#ruleDialogSave');
  await sleep(400);
  check(!(await ruleDialogOpen(page)), '存好要關對話框');
  check((await page.eval(`document.getElementById('toast').textContent`)) === '已新增', '要告訴使用者已新增');
  const rules = await getRules();
  check(rules.length === 1, '應該一條：' + JSON.stringify(rules));
  const r = rules[0];
  check(r.id && r.enabled === true && r.host === '127.0.0.1' && r.path === '/order' && r.selector === '#b' && r.text === 'b' && r.when === 'onLoad' && r.intervalSec === 30, '存的內容：' + JSON.stringify(r));
  const sites = await ruleSites(page);
  check(sites.length === 1 && sites[0].open && sites[0].visible === 1, '新規則的網站要展開：' + JSON.stringify(sites));
  check(await page.eval(`document.querySelector('.rule-card').classList.contains('moved')`), '新規則要標出來');
  check((await page.eval(`document.querySelector('.rule-card .rule-selector').value`)) === '#b', '卡片要顯示新規則');
  await closePage(page);

  const target = await open(ORDER);
  const clicks = await waitClicks(target, 1);
  check(sameList(clicks, ['b']), '開到那一頁要點，實際 ' + JSON.stringify(clicks));
  await closePage(target);
});

test('手動新增：從網站區塊按，網站先填好，新規則排在那個網站最後', async () => {
  await seedRules([
    { host: 'a.example.test', path: '/', selector: '#a1', text: 'A1', when: 'onLoad' },
    { host: 'b.example.test', path: '/', selector: '#b1', text: 'B1', when: 'onLoad' },
    { host: 'a.example.test', path: '/', selector: '#a2', text: 'A2', when: 'onLoad' },
  ]);
  const page = await openRuleOptions();
  await page.click('.rule-site summary');
  await sleep(200);
  await page.eval(`document.querySelector('.rule-site .rule-add').scrollIntoView({ block: 'center' })`);
  await page.click('.rule-site .rule-add');
  await sleep(200);
  check(await ruleDialogOpen(page), '按了要開對話框');
  check((await readBox(page, 'newRuleHost')) === 'a.example.test', '網站要先填好');
  check((await page.eval('document.activeElement.id')) === 'newRulePath', '游標要跳到網址');
  await setBox(page, 'newRulePath', '*');
  await setBox(page, 'newRuleSelector', '#a3');
  await page.click('#ruleDialogSave');
  await sleep(400);
  const rules = await getRules();
  check(sameList(rules.map((r) => r.selector), ['#a1', '#b1', '#a2', '#a3']), '別的網站不動：' + JSON.stringify(rules));
  check(!('intervalSec' in rules[3]), '沒填間隔就用預設值：' + JSON.stringify(rules[3]));
  const sites = await ruleSites(page);
  check(sites[0].open && sites[0].visible === 3 && !sites[1].open, '開合要對：' + JSON.stringify(sites));
  const cards = await page.eval(`Array.from(document.querySelectorAll('.rule-site')[0].querySelectorAll('.rule-card')).map((c) => c.querySelector('.rule-no').textContent + c.querySelector('.rule-selector').value)`);
  check(sameList(cards, ['第 1 條#a1', '第 2 條#a2', '第 3 條#a3']), '要排在最後：' + JSON.stringify(cards));
  check(!(await page.eval(`document.querySelectorAll('.rule-site')[0].querySelectorAll('.rule-missing')[1].disabled`)), '原本的最後一條現在可以選等不到按鈕時');

  // 從上面的按鈕加到收著的網站，那個網站要展開，新規則要捲到看得見的地方
  await clickRuleAdd(page);
  await setBox(page, 'newRuleHost', 'b.example.test');
  await setBox(page, 'newRulePath', '/');
  await setBox(page, 'newRuleSelector', '#b2');
  await page.click('#ruleDialogSave');
  await sleep(400);
  const after = await ruleSites(page);
  check(after[1].open && after[1].visible === 2, '新規則的網站要展開：' + JSON.stringify(after));
  const box = await page.eval(`(() => {
    const r = document.querySelector('.rule-card.moved').getBoundingClientRect();
    const s = document.getElementById('ruleSites').getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, siteTop: s.top, siteBottom: s.bottom, vh: innerHeight };
  })()`);
  // 捲動位置會取整數，下緣可能超出不到 1 像素
  check(box.top >= box.siteTop && box.bottom <= box.siteBottom + 1 && box.top >= 0 && box.bottom <= box.vh + 1, '新規則要看得見：' + JSON.stringify(box));
  await closePage(page);
});

test('手動新增：填錯不會存，打的內容留著，重複的規則不蓋掉舊的', async () => {
  await seedRules([{ host: 'a.example.test', path: '/x', selector: '#same', text: '舊', when: 'onLoad', intervalSec: 7 }]);
  const page = await openRuleOptions();
  await clickRuleAdd(page);
  const save = async () => {
    await page.click('#ruleDialogSave');
    await sleep(300);
  };

  await save();
  let errors = await ruleDialogErrors(page);
  check(sameList(errors, ['網站不能空白', '網址不能空白，整個網站請填 *', '選擇器不能空白']), '空白要標在欄位旁邊：' + JSON.stringify(errors));
  check(await ruleDialogOpen(page), '有錯不能關');
  await page.screenshot(path.join(SHOTS, 'rule-dialog-errors.png'));

  await setBox(page, 'newRulePath', '/x');
  await setBox(page, 'newRuleSelector', '#new');
  for (const bad of ['*.example.test', 'android://x', '/login', 'a b.test']) {
    await setBox(page, 'newRuleHost', bad);
    await save();
    errors = await ruleDialogErrors(page);
    check(sameList(errors, ['網站的格式不對']), bad + ' 實際 ' + JSON.stringify(errors));
    check((await readBox(page, 'newRuleHost')) === bad, bad + ' 打的內容要留著');
  }

  await setBox(page, 'newRuleHost', 'a.example.test');
  await setBox(page, 'newRuleSelector', 'div[');
  await save();
  errors = await ruleDialogErrors(page);
  check(sameList(errors, ['選擇器的寫法有問題']), '選擇器：' + JSON.stringify(errors));
  check((await readBox(page, 'newRuleSelector')) === 'div[', '選擇器打的內容要留著');

  await setBox(page, 'newRuleSelector', '#new');
  for (const bad of ['0', '1.5', '86401']) {
    await setBox(page, 'newRuleInterval', bad);
    await save();
    errors = await ruleDialogErrors(page);
    check(sameList(errors, ['間隔要是 1 到 86400 的整數']), bad + ' 實際 ' + JSON.stringify(errors));
  }
  await setBox(page, 'newRuleInterval', '');

  await setBox(page, 'newRuleSelector', '#same');
  await setBox(page, 'newRuleText', '新');
  await save();
  errors = await ruleDialogErrors(page);
  check(sameList(errors, ['這個網址已經有相同選擇器的規則']), '重複：' + JSON.stringify(errors));
  check(await ruleDialogOpen(page), '重複時對話框要開著');
  let rules = await getRules();
  check(rules.length === 1 && rules[0].text === '舊' && rules[0].intervalSec === 7, '舊規則不能被蓋掉：' + JSON.stringify(rules));

  await page.click('#ruleDialogCancel');
  await sleep(200);
  check(!(await ruleDialogOpen(page)), '按取消要關');
  rules = await getRules();
  check(rules.length === 1, '按取消不能存：' + JSON.stringify(rules));

  await clickRuleAdd(page);
  for (const id of ['newRuleHost', 'newRulePath', 'newRuleSelector', 'newRuleText', 'newRuleInterval']) {
    check((await readBox(page, id)) === '', id + ' 再開要是空的');
  }
  check((await readBox(page, 'newRuleWhen')) === 'afterFill', '什麼時候點要回到第一個選項');
  check((await ruleDialogErrors(page)).length === 0, '再開不能留著舊的錯誤');
  check((await page.eval(`document.getElementById('newRuleInterval').placeholder`)) === '預設 300', '間隔要提示預設值');
  await closePage(page);
});

test('手動新增：網站和網址欄貼什麼都拆得對，沒帳號要標出來', async () => {
  await seedEntry('right', 'saved.example.test');
  const page = await openRuleOptions();
  await page.eval(`openRuleDialog('')`);
  for (const [paste, before, host, pathAfter] of [
    ['example.test', '/keep', 'example.test', '/keep'],
    ['https://example.test', '/keep', 'example.test', '/keep'],
    ['https://example.test/', '/keep', 'example.test', '/'],
    ['HTTP://Example.TEST:8080/Login?x=1#part', '', 'example.test', '/Login'],
    ['https://example.test/#/login?y=1', '', 'example.test', '/#/login'],
    ['https://example.test/app/*', '', 'example.test', '/app/*'],
  ]) {
    await setBox(page, 'newRulePath', before);
    await setBox(page, 'newRuleHost', paste);
    const got = [await readBox(page, 'newRuleHost'), await readBox(page, 'newRulePath')];
    check(sameList(got, [host, pathAfter]), paste + ' 實際 ' + JSON.stringify(got));
  }

  // 貼到網址欄也要拆，網站有填就不動
  await setBox(page, 'newRuleHost', '');
  await setBox(page, 'newRulePath', 'https://paste.example.test/login?next=1');
  check((await readBox(page, 'newRuleHost')) === 'paste.example.test', '網站是空的要幫忙填');
  check((await readBox(page, 'newRulePath')) === '/login', '網址要拆開');
  await setBox(page, 'newRulePath', 'https://other.example.test');
  check((await readBox(page, 'newRuleHost')) === 'paste.example.test', '網站有填就不動');
  check((await readBox(page, 'newRulePath')) === '/', '沒有路徑就是首頁');
  await setBox(page, 'newRulePath', '/manual/*');
  check((await readBox(page, 'newRulePath')) === '/manual/*', '自己打的路徑不動');

  const note = () => page.eval(`document.querySelector('#ruleDialog .rule-note').textContent`);
  await setBox(page, 'newRuleHost', '');
  check((await note()) === '', '網站還沒填不用標');
  await setBox(page, 'newRuleHost', 'nosaved.example.test');
  check((await note()).includes('還沒存帳號'), '沒帳號要標：' + (await note()));
  await setBox(page, 'newRuleWhen', 'onLoad');
  check((await note()) === '', '頁面一打開就點不用帳號');
  await setBox(page, 'newRuleWhen', 'afterFill');
  await setBox(page, 'newRuleHost', 'saved.example.test');
  check((await note()) === '', '有帳號不用標');
  await closePage(page);
});

test('手動新增：背景程式也會擋寫錯的內容', async () => {
  const out = await w.eval(`(async () => {
    const add = async (rule) => {
      try {
        await handlers['clickRules.add']({ rule });
        return 'ok';
      } catch (err) {
        return err.message;
      }
    };
    const base = { host: 'a.example.test', path: '/x', selector: '#a', when: 'onLoad' };
    const out = {
      noHost: await add({ ...base, host: '' }),
      star: await add({ ...base, host: '*.example.test' }),
      withPath: await add({ ...base, host: 'a.example.test/login' }),
      noPath: await add({ ...base, path: '' }),
      noSelector: await add({ ...base, selector: ' ' }),
      badInterval: await add({ ...base, intervalSec: 0 }),
      ok: await add({ ...base, path: 'https://a.example.test/x', text: '  登  入  ', intervalSec: 5 }),
      dup: await add(base),
    };
    out.rules = (await getSettings()).clickRules;
    return out;
  })()`);
  check(out.noHost === '網站不能空白', 'noHost：' + out.noHost);
  check(out.star === '網站的格式不對', 'star：' + out.star);
  check(out.withPath === '網站的格式不對', 'withPath：' + out.withPath);
  check(out.noPath.includes('網址不能空白'), 'noPath：' + out.noPath);
  check(out.noSelector === '沒有選到按鈕', 'noSelector：' + out.noSelector);
  check(out.badInterval.includes('間隔要是'), 'badInterval：' + out.badInterval);
  check(out.ok === 'ok', 'ok：' + out.ok);
  check(out.dup === '這個網址已經有相同選擇器的規則', 'dup：' + out.dup);
  check(out.rules.length === 1 && out.rules[0].path === '/x' && out.rules[0].text === '登 入' && out.rules[0].intervalSec === 5, '存的內容：' + JSON.stringify(out.rules));
});

// ---- 說明的「?」 ----

const tipBox = (page) =>
  page.eval(`(() => {
    const box = document.querySelector('.tip-box');
    if (!box || box.hidden) return null;
    const r = box.getBoundingClientRect();
    return { text: box.textContent, left: r.left, right: r.right, top: r.top, bottom: r.bottom, inDialog: !!box.closest('dialog'), vw: innerWidth, vh: innerHeight };
  })()`);
const INTERVAL_TIP = '#clickInterval ~ .muted .tip';

test('說明：間隔預設值只留一句，細節在「?」，滑鼠移上去馬上顯示', async () => {
  await seedRules([orderRule('a')]);
  const page = await openRuleOptions();
  await page.eval(`document.getElementById('clickInterval').scrollIntoView({ block: 'center' })`);
  const row = await page.eval(`document.getElementById('clickInterval').closest('.form-field').innerText.replace(/\\s+/g, ' ')`);
  check(row.includes('點過之後，隔多久才能再點。'), '畫面要留一句：' + row);
  check(!row.includes('自動填完按登入'), '細節不該留在畫面上：' + row);
  const c = await page.centerOf(INTERVAL_TIP);
  await page.moveTo(c.x, c.y);
  await sleep(50);
  const box = await tipBox(page);
  check(box && box.text.includes('「自動填完按登入」也用這個'), '要馬上顯示：' + JSON.stringify(box));
  check(box.top >= c.y && box.left >= 0 && box.right <= box.vw, '要在「?」下面、視窗裡面：' + JSON.stringify(box));
  await page.screenshot(path.join(SHOTS, 'tip-hover.png'));
  await page.moveTo(5, 5);
  await sleep(100);
  check(!(await tipBox(page)), '滑鼠移開要收掉');

  // 卡片上的欄位也是
  const card = cardSelector('rule-0');
  const labels = await page.eval(`Array.from(document.querySelectorAll(${JSON.stringify(card + ' .rule-field-name')})).map((n) => n.textContent)`);
  check(sameList(labels, ['按鈕文字?', '網址?', '選擇器?', '什麼時候點?', '間隔（秒）?', '等不到按鈕時?']), '欄位標題不留括號：' + JSON.stringify(labels));
  await closePage(page);
});

test('說明：按 Tab 移到「?」也會顯示，Esc 關掉，點「?」不會動到旁邊的欄位', async () => {
  await seedRules([orderRule('a')]);
  const page = await openRuleOptions();
  await page.eval(`document.getElementById('clickInterval').focus()`);
  await page.press('Tab', 'Tab', 9);
  await sleep(100);
  check(await page.eval(`document.activeElement.classList.contains('tip')`), 'Tab 要能移到「?」');
  let box = await tipBox(page);
  check(box && box.text.includes('「自動填完按登入」也用這個'), '移到就要顯示：' + JSON.stringify(box));
  await page.press('Escape', 'Escape', 27);
  await sleep(100);
  check(!(await tipBox(page)), 'Esc 要關掉');
  await page.eval('document.activeElement.blur()');

  // 欄位標題整個包在 label 裡，點「?」不該跳到欄位
  const tip = cardSelector('rule-0') + ' .rule-field .tip';
  await page.eval(`document.querySelector(${JSON.stringify(tip)}).scrollIntoView({ block: 'center' })`);
  await page.click(tip);
  await sleep(100);
  check(await page.eval(`document.activeElement.classList.contains('tip')`), '點「?」焦點要停在「?」：' + (await page.eval('document.activeElement.className')));
  box = await tipBox(page);
  check(box && box.text.includes('按鈕上的字'), '點了要顯示：' + JSON.stringify(box));
  await closePage(page);
});

test('說明：對話框裡的「?」看得到，Esc 先關說明再關對話框', async () => {
  const page = await openRuleOptions();
  await page.eval(`openRuleDialog('')`);
  await sleep(100);
  const c = await page.centerOf('#ruleDialog .rule-field .tip');
  await page.moveTo(c.x, c.y);
  await sleep(50);
  const box = await tipBox(page);
  check(box && box.inDialog && box.text.includes('example.com.tw'), '說明要放進對話框才不會被蓋住：' + JSON.stringify(box));
  await page.screenshot(path.join(SHOTS, 'tip-in-dialog.png'));
  await page.press('Escape', 'Escape', 27);
  await sleep(100);
  check(!(await tipBox(page)), 'Esc 先關說明');
  check(await ruleDialogOpen(page), '對話框還要開著');
  await page.press('Escape', 'Escape', 27);
  await sleep(100);
  check(!(await ruleDialogOpen(page)), '再按一次關對話框');

  // 關掉對話框後，頁面上的「?」要放回頁面
  await page.eval(`document.getElementById('clickInterval').scrollIntoView({ block: 'center' })`);
  const again = await page.centerOf(INTERVAL_TIP);
  await page.moveTo(again.x, again.y);
  await sleep(50);
  const back = await tipBox(page);
  check(back && !back.inDialog, '頁面上的說明不能還在對話框裡：' + JSON.stringify(back));
  await closePage(page);
});

test('說明：每個「?」都有內容，視窗很窄或在最下面時不會超出視窗', async () => {
  await seedEntry('right');
  await seedRules([orderRule('a'), orderRule('b')]);
  const page = await open('chrome-extension://' + extId + '/src/options/options.html#settings', 1200);
  const attrs = await page.eval(`Array.from(document.querySelectorAll('.tip')).filter((t) => !t.dataset.tip || t.tabIndex !== 0 || t.getAttribute('aria-label') !== t.dataset.tip).map((t) => t.outerHTML)`);
  check(attrs.length === 0, '每個「?」都要有內容、能用鍵盤移到：' + JSON.stringify(attrs));

  const walk = async (label) => {
    const count = await page.eval(`window.__tips = Array.from(document.querySelectorAll('.tip')).filter((t) => t.checkVisibility()); window.__tips.length`);
    check(count > 0, label + ' 應該有「?」');
    for (let i = 0; i < count; i++) {
      for (const block of ['center', 'end']) {
        const c = await page.eval(`(() => {
          const t = window.__tips[${i}];
          t.scrollIntoView({ block: ${JSON.stringify(block)} });
          const r = t.getBoundingClientRect();
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        })()`);
        await page.moveTo(c.x, c.y);
        await sleep(40);
        const box = await tipBox(page);
        check(box, label + ' 第 ' + i + ' 個要顯示');
        check(box.left >= 0 && box.right <= box.vw && box.top >= 0 && box.bottom <= box.vh, label + ' 第 ' + i + ' 個超出視窗：' + JSON.stringify(box));
        await page.moveTo(1, 1);
        await sleep(20);
      }
    }
    return count;
  };

  for (const [tab, min] of [['settings', 10], ['backup', 4]]) {
    await page.eval(`showTab(${JSON.stringify(tab)})`);
    await page.eval(`document.querySelectorAll('.rule-site, details.card').forEach((s) => { s.open = true; })`);
    for (const [width, height] of [[1100, 800], [360, 640]]) {
      await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
      await sleep(200);
      const count = await walk(tab + ' ' + width);
      check(count >= min, tab + ' ' + width + ' 應該至少 ' + min + ' 個，實際 ' + count);
    }
  }
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 800, deviceScaleFactor: 1, mobile: false });
  await closePage(page);
});

test('說明：小視窗的「?」看得到，點了不會勾到旁邊的方框', async () => {
  await seedEntry('right');
  const target = await open(T + 'harness.html', 800);
  const stub = `{
    const q = chrome.tabs.query.bind(chrome.tabs);
    chrome.tabs.query = async (info) => (info && info.active && info.currentWindow ? q({ url: '*://127.0.0.1/*' }) : q(info));
    window.close = () => {};
  }`;
  const popup = await openPage(b.cdp, 'about:blank', stub);
  await popup.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 480, deviceScaleFactor: 1, mobile: false });
  await popup.goto('chrome-extension://' + extId + '/src/popup/popup.html', 1200);
  await b.cdp.send('Target.activateTarget', { targetId: popup.targetId });
  await popup.send('Page.bringToFront');
  await sleep(300);
  check(await popup.eval(`document.getElementById('autoSubmitWrap').checkVisibility()`), '有帳號要顯示自動按登入');
  await popup.click('#autoSubmitWrap .tip');
  await sleep(200);
  const box = await tipBox(popup);
  check(box && box.text.includes('只有一個登入表單'), '要顯示說明：' + JSON.stringify(box));
  check(box.left >= 0 && box.right <= box.vw && box.top >= 0 && box.bottom <= box.vh, '不能超出小視窗：' + JSON.stringify(box));
  await popup.screenshot(path.join(SHOTS, 'tip-popup.png'));
  check(!(await popup.eval(`document.getElementById('autoSubmit').checked`)), '點「?」不能勾到方框');
  const hosts = await w.eval('getSettings().then((s) => s.autoSubmitHosts)');
  check(hosts.length === 0, '點「?」不能改設定：' + JSON.stringify(hosts));
  await closePage(popup);
  await closePage(target);
});

test('說明：畫面上不再有明文、鑰匙這類詞，互搬說明預設收合', async () => {
  const page = await open('chrome-extension://' + extId + '/src/options/options.html#backup', 1200);
  check(!(await page.eval(`document.getElementById('browserMove').open`)), '互搬說明要預設收合');
  check(!(await page.eval(`document.querySelector('#browserMove ol').checkVisibility()`)), '收合時步驟不該顯示');
  await page.eval(`document.querySelector('#browserMove summary').scrollIntoView({ block: 'center' })`);
  await page.click('#browserMove summary');
  await sleep(200);
  check(await page.eval(`document.querySelector('#browserMove ol').checkVisibility()`), '點標題要展開');
  await page.screenshot(path.join(SHOTS, 'backup-move-open.png'));
  const texts = await page.eval(`['tab-passwords', 'tab-backup', 'tab-settings', 'tab-trash', 'tab-help', 'lockScreen']
    .map((id) => {
      const root = document.getElementById(id);
      return root.textContent + Array.from(root.querySelectorAll('.tip')).map((t) => t.dataset.tip).join('');
    })
    .join('')`);
  for (const word of ['明文', '鑰匙', '單一登入', '另外告訴他', '立即備份一次']) check(!texts.includes(word), '畫面上不該有「' + word + '」');
  await closePage(page);
});

// ---- 鎖定時的對話框 ----

test('工具鎖定：管理頁開著對話框時被鎖定，對話框要關掉，密碼要清掉', async () => {
  await seedEntry('right');
  const page = await open('chrome-extension://' + extId + '/src/options/options.html', 1200);
  const lockNow = async () => {
    await w.eval(`(async () => {
      await chrome.storage.local.set({ webauthn: { id: 'x', alg: -7, publicKey: 'x', transports: [], createdAt: 1 } });
      const s = await getSettings();
      await setSettings({ lock: { ...s.lock, enabled: true } });
      await setLocked(true);
    })()`);
    check(await until(() => page.eval(`!document.getElementById('lockScreen').hidden`), 3000), '要回到驗證畫面');
    await sleep(200);
  };
  // 測試沒辦法叫 Windows Hello，直接解鎖；管理頁收到廣播會自己回來
  const unlock = async () => {
    await w.eval('setLocked(false)');
    await until(() => page.eval(`!document.getElementById('pageMain').hidden`), 3000);
    await sleep(300);
  };
  const openDialogs = () => page.eval(`Array.from(document.querySelectorAll('dialog[open]')).map((d) => d.id)`);

  // 修改密碼，密碼已經按了顯示
  await page.eval('openDialog(entries[0])');
  await sleep(100);
  await page.click('#fEye');
  check((await page.eval(`document.getElementById('fPass').type`)) === 'text', '密碼要先顯示出來');
  await lockNow();
  let left = await openDialogs();
  check(left.length === 0, '修改密碼的對話框要關掉：' + JSON.stringify(left));
  check((await page.eval(`document.getElementById('fPass').value`)) === '', '密碼欄要清掉');
  await page.screenshot(path.join(SHOTS, 'lock-closes-dialog.png'));
  await unlock();

  // 問備份密碼：等結果的地方要收到取消，打到一半的密碼要清掉。
  // eval 最後回傳 true，不然測試工具會等對話框關掉才回來，卡住。
  await page.eval(`window.__pw = 'waiting'; askPassword({ title: '測試', confirm: true }).then((v) => { window.__pw = v; }); true`);
  await page.eval(`document.getElementById('pw1').value = 'typed-1'; document.getElementById('pw2').value = 'typed-2'`);
  await lockNow();
  left = await openDialogs();
  check(left.length === 0, '問密碼的對話框要關掉：' + JSON.stringify(left));
  check((await page.eval('window.__pw')) === null, '等結果的地方要收到取消：' + (await page.eval('window.__pw')));
  check((await page.eval(`document.getElementById('pw1').value + document.getElementById('pw2').value`)) === '', '打到一半的密碼要清掉');
  await unlock();

  // 選擇的對話框和新增自動點選
  await page.eval(`window.__choice = 'waiting'; askChoice({ title: '測試', buttons: [{ label: '知道了', value: true }] }).then((v) => { window.__choice = v; }); true`);
  await lockNow();
  check((await openDialogs()).length === 0, '選擇的對話框要關掉');
  check((await page.eval('window.__choice')) === null, '選擇的對話框要回傳取消：' + (await page.eval('window.__choice')));
  await unlock();
  await page.eval(`openRuleDialog('')`);
  await lockNow();
  check((await openDialogs()).length === 0, '新增自動點選的對話框要關掉');
  await unlock();

  // 解鎖後對話框照常能用
  await page.eval(`window.__again = 'waiting'; askPassword({ title: '再一次', confirm: false }).then((v) => { window.__again = v; }); true`);
  await page.eval(`document.getElementById('pw1').value = 'again'`);
  await page.click('#pwOk');
  await sleep(200);
  check((await page.eval('window.__again')) === 'again', '解鎖後問密碼要照常：' + (await page.eval('window.__again')));
  check((await openDialogs()).length === 0, '按確定要關掉');
  await page.eval('openDialog(entries[0])');
  await sleep(100);
  check((await page.eval(`document.getElementById('fPass').value`)) === 'right', '解鎖後修改密碼要照常帶出密碼');
  await page.eval(`document.getElementById('dialog').close()`);
  await w.eval('setLocked(false)');
  await closePage(page);
});

// ---- 小視窗版面、解鎖視窗 ----

// 開工具鎖定。鑰匙是假的，只夠讓解鎖視窗走到叫系統驗證那一步，簽章核對一定不會過。
const enableLock = (locked) =>
  w.eval(`(async () => {
    await chrome.storage.local.set({ webauthn: { id: 'AAAA', alg: -7, publicKey: 'AAAA', transports: [], createdAt: 1 } });
    const s = await getSettings();
    await setSettings({ lock: { ...s.lock, enabled: true } });
    await setLocked(${locked ? 'true' : 'false'});
    return true;
  })()`);

// 小視窗開在分頁裡的話，「目前分頁」會變成它自己，所以把這個查詢導到測試頁
const POPUP_STUB = `{
  const q = chrome.tabs.query.bind(chrome.tabs);
  chrome.tabs.query = async (info) => (info && info.active && info.currentWindow ? q({ url: '*://127.0.0.1/*' }) : q(info));
  window.close = () => { window.__closed = true; };
}`;

test('小視窗：搜尋框下面沒有空白，這個網站的設定放在一起，鎖定在右上角', async () => {
  await seedEntry('right');
  await seedRules([{ path: '/test/harness.html', selector: '#nope', text: '找不到的按鈕', when: 'onLoad' }]);
  await enableLock(false);
  const target = await open(T + 'harness.html', 800);
  const popup = await openPage(b.cdp, 'about:blank', POPUP_STUB);
  await popup.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 620, deviceScaleFactor: 1, mobile: false });
  await popup.goto('chrome-extension://' + extId + '/src/popup/popup.html', 1200);
  await b.cdp.send('Target.activateTarget', { targetId: popup.targetId });
  await popup.send('Page.bringToFront');
  await sleep(300);
  const gap = await popup.eval(`document.getElementById('list').getBoundingClientRect().top - document.getElementById('search').getBoundingClientRect().bottom`);
  check(gap <= 12, '搜尋框和帳號之間不該空一大塊：' + gap + 'px');
  const outside = await popup.eval(`['autoFillWrap', 'autoSubmitWrap', 'pickBtn', 'pickCount'].filter((id) => !document.getElementById(id).closest('.site-opts'))`);
  check(outside.length === 0, '要放在「這個網站」底下：' + JSON.stringify(outside));
  check(await popup.eval(`document.getElementById('autoFillWrap').checkVisibility() && document.getElementById('pickCount').checkVisibility()`), '有帳號、有規則時要看得到');
  const labels = await popup.eval(`document.getElementById('autoFillWrap').textContent + document.getElementById('autoSubmitWrap').textContent`);
  check(!labels.includes('這個網站'), '勾選框不用再寫「這個網站」：' + labels);
  check(await popup.eval(`!!document.getElementById('lockNow').closest('.header') && document.getElementById('lockNow').checkVisibility()`), '鎖定要在右上角');
  const footer = await popup.eval(`Array.from(document.querySelectorAll('.footer button')).map((x) => x.id)`);
  check(sameList(footer, ['manage']), '下面只留管理所有密碼：' + JSON.stringify(footer));
  await popup.screenshot(path.join(SHOTS, 'popup-layout.png'));
  await popup.click('#lockNow');
  check(await until(() => popup.eval(`!document.getElementById('lockScreen').hidden`), 3000), '按鎖定要換成鎖住的畫面');
  check(await w.eval('isLocked()'), '背景程式要真的鎖上');
  check(!(await popup.eval(`document.getElementById('lockNow').checkVisibility()`)), '鎖住之後鎖定按鈕要藏起來');
  await w.eval('setLocked(false)');
  await closePage(popup);
  await closePage(target);
});

// 解鎖視窗一打開就會叫系統驗證。測試不能叫真的 Windows Hello，換成假的：一直等到被中斷，每次叫都記下來。
const FAKE_HELLO = `{
  window.close = () => { window.__closed = true; };
  window.__hello = [];
  navigator.credentials.get = (o) => new Promise((resolve, reject) => {
    const call = { signal: !!(o && o.signal), aborted: false };
    window.__hello.push(call);
    if (o && o.signal) o.signal.addEventListener('abort', () => { call.aborted = true; reject(new DOMException('aborted', 'AbortError')); });
  });
}`;

// 第一次像使用者在 Windows Hello 按了取消，之後叫的一直等
const FAKE_HELLO_CANCEL_FIRST =
  FAKE_HELLO +
  `{
  const wait = navigator.credentials.get;
  navigator.credentials.get = (o) => {
    if (window.__hello.length) return wait(o);
    window.__hello.push({ signal: !!(o && o.signal), aborted: false });
    return Promise.reject(new DOMException('cancelled', 'NotAllowedError'));
  };
}`;

async function gotoUnlock(page) {
  await page.send('Emulation.setDeviceMetricsOverride', { width: 460, height: 268, deviceScaleFactor: 1, mobile: false });
  await b.cdp.send('Target.activateTarget', { targetId: page.targetId });
  await page.send('Page.bringToFront');
  await page.goto('chrome-extension://' + extId + '/src/unlock/unlock.html', 600);
}

async function openUnlock(init) {
  const page = await openPage(b.cdp, 'about:blank', init);
  await gotoUnlock(page);
  return page;
}

const unlockState = (page) =>
  page.eval(`(() => {
    const seen = (id) => document.getElementById(id).checkVisibility();
    return {
      waiting: seen('waiting'),
      failed: seen('failed'),
      done: seen('done'),
      hello: seen('hello'),
      retry: seen('retry'),
      text: document.body.innerText.replace(/\\s+/g, ' '),
      calls: (window.__hello || []).map((c) => ({ signal: c.signal, aborted: c.aborted })),
    };
  })()`);

// 用瀏覽器的虛擬驗證器（CDP 的 WebAuthn）代替 Windows Hello：簽章是真的，背景程式照常核對，不會跳出真的驗證視窗。
// 要在頁面叫驗證之前接上。回傳查簽過幾次的函式。
async function useVirtualHello(page) {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const id = randomBytes(16);
  const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  await w.eval(`(async () => {
    await chrome.storage.local.set({ webauthn: { id: ${JSON.stringify(b64url(id))}, alg: -7, publicKey: ${JSON.stringify(b64url(publicKey.export({ type: 'spki', format: 'der' })))}, transports: ['internal'], createdAt: 1 } });
    const s = await getSettings();
    await setSettings({ lock: { ...s.lock, enabled: true } });
    await setLocked(true);
    return true;
  })()`);
  await page.send('WebAuthn.enable', { enableUI: false });
  const { authenticatorId } = await page.send('WebAuthn.addVirtualAuthenticator', {
    options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
  // 擴充功能頁面的鑰匙，虛擬驗證器記的 rpId 是整個 chrome-extension://ID，只給 ID 會找不到鑰匙
  await page.send('WebAuthn.addCredential', {
    authenticatorId,
    credential: {
      credentialId: id.toString('base64'),
      isResidentCredential: false,
      rpId: 'chrome-extension://' + extId,
      privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
      signCount: 0,
    },
  });
  return async () => (await page.send('WebAuthn.getCredentials', { authenticatorId })).credentials[0].signCount;
}

test('解鎖視窗：等驗證時沒有解鎖按鈕，「點這裡重新開啟」會中斷前一次再叫一次', async () => {
  await enableLock(true);
  const page = await openUnlock(FAKE_HELLO);
  let st = await until(async () => {
    const s = await unlockState(page);
    return s.calls.length === 1 ? s : null;
  }, 3000);
  check(st, '一打開就要叫一次系統驗證：' + JSON.stringify(await unlockState(page)));
  check(st.waiting && st.retry && !st.hello && !st.failed, '等驗證時只有「點這裡重新開啟」，不能有解鎖按鈕：' + JSON.stringify(st));
  check(st.text.includes('視窗完成驗證') && st.text.includes('沒有自動跳出來？'), '要寫在哪裡驗證、沒跳出來怎麼辦：' + st.text);
  check(st.calls[0].signal, '叫系統驗證要帶 signal，不然中斷不了');
  await page.screenshot(path.join(SHOTS, 'unlock-waiting.png'));
  await page.click('#retry');
  st = await until(async () => {
    const s = await unlockState(page);
    return s.calls.length === 2 ? s : null;
  }, 3000);
  check(st, '點了要再叫一次：' + JSON.stringify(await unlockState(page)));
  check(st.calls[0].aborted && !st.calls[1].aborted, '要先中斷前一次，新叫的那次還在等：' + JSON.stringify(st.calls));
  check(st.waiting && !st.failed && !st.hello, '自己中斷的那次不能顯示成失敗：' + JSON.stringify(st));
  check(await w.eval('isLocked()'), '還沒驗證不能解鎖');
  await page.click('#close');
  check(await page.eval('window.__closed === true'), '按取消要關視窗');
  await closePage(page);
});

test('解鎖視窗：驗證被取消才出現「再試一次」，按了重新叫', async () => {
  await enableLock(true);
  const page = await openUnlock(FAKE_HELLO_CANCEL_FIRST);
  let st = await until(async () => {
    const s = await unlockState(page);
    return s.failed ? s : null;
  }, 3000);
  check(st, '取消後要顯示失敗：' + JSON.stringify(await unlockState(page)));
  check(st.hello && !st.waiting && !st.retry, '取消後才出現「再試一次」：' + JSON.stringify(st));
  check(st.text.includes('驗證被取消或逾時') && !st.text.includes('再按一次按鈕重試'), '失敗訊息：' + st.text);
  await page.screenshot(path.join(SHOTS, 'unlock-failed.png'));
  await page.click('#hello');
  st = await until(async () => {
    const s = await unlockState(page);
    return s.calls.length === 2 && s.waiting ? s : null;
  }, 3000);
  check(st && !st.hello && !st.failed, '按「再試一次」要重新叫、回到等驗證：' + JSON.stringify(await unlockState(page)));
  await closePage(page);
});

test('解鎖視窗：用虛擬驗證器真的驗一次，解鎖後視窗自己關掉', async () => {
  const page = await openPage(b.cdp, 'about:blank', `window.close = () => { window.__closed = true; };`);
  const signCount = await useVirtualHello(page);
  await gotoUnlock(page);
  check(await until(() => page.eval('window.__closed === true'), 5000), '驗證過要自己關視窗：' + JSON.stringify(await unlockState(page)));
  check(await page.eval(`document.getElementById('done').checkVisibility()`), '關之前要顯示已解鎖');
  await page.screenshot(path.join(SHOTS, 'unlock-done.png'));
  check(!(await w.eval('isLocked()')), '背景程式要解鎖');
  check((await signCount()) === 1, '虛擬驗證器要真的簽過一次');
  await closePage(page);
});

test('管理頁：驗證畫面用虛擬驗證器照常解鎖', async () => {
  const page = await openPage(b.cdp, 'about:blank');
  const signCount = await useVirtualHello(page);
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 800, deviceScaleFactor: 1, mobile: false });
  await b.cdp.send('Target.activateTarget', { targetId: page.targetId });
  await page.send('Page.bringToFront');
  await page.goto('chrome-extension://' + extId + '/src/options/options.html', 1200);
  check(await page.eval(`!document.getElementById('lockScreen').hidden`), '鎖著要先顯示驗證畫面');
  await page.click('#helloUnlock');
  check(
    await until(() => page.eval(`!document.getElementById('pageMain').hidden`), 5000),
    '驗證過要顯示管理頁：' + (await page.eval(`document.getElementById('lockError').textContent`))
  );
  check(!(await w.eval('isLocked()')), '背景程式要解鎖');
  check((await signCount()) === 1, '虛擬驗證器要真的簽過一次');
  await closePage(page);
});

// ---- 保護方式：自訂密碼加密、系統驗證加密 ----

const MASTER = 'master-pass-1234';
// 換保護方式要從擴充功能自己的頁面叫，這裡假裝是管理頁送來的
const asPage = `{ url: extensionOrigin() + '/src/options/options.html' }`;
const setMode = (data) => w.eval(`handlers['lock.setMode'](${JSON.stringify(data)}, ${asPage}).then(() => 'ok', (e) => e.message)`);
const unlockPassword = (password) =>
  w.eval(`handlers['lock.unlockPassword']({ password: ${JSON.stringify(password)} }, ${asPage}).then(() => 'ok', (e) => e.message)`);
const setBackupPassword = () => w.eval(`handlers['autoBackup.set']({ password: 'backup-pass-123' }).then(() => true)`);
// 瀏覽器重開：storage.session 整個清掉，記憶體裡的金鑰和鎖定狀態都沒了
const restartBrowser = () => w.eval(`chrome.storage.session.clear().then(() => true)`);
const msgOf = (key, ...subs) => w.eval(`t(${JSON.stringify(key)}, ${subs.map((s) => JSON.stringify(s)).join(', ')})`);
const passwordsNow = () => w.eval(`(async () => ({ locked: await isLocked(), passwords: (await loadEntries()).map((e) => e.password) }))()`);

test('保護方式：舊設定只有 enabled，升級後變成關閉或只鎖畫面', async () => {
  const r = await w.eval(`({
    on: normalizeLock({ enabled: true, idleMinutes: 5 }),
    off: normalizeLock({ enabled: false }),
    none: normalizeLock(undefined),
    password: normalizeLock({ mode: 'password', enabled: false }),
    screenOff: normalizeLock({ mode: 'screen', enabled: false }),
  })`);
  check(r.on.mode === 'screen' && r.on.enabled && r.on.idleMinutes === 5, '舊的已啟用要變成只鎖畫面：' + JSON.stringify(r.on));
  check(r.off.mode === 'off' && !r.off.enabled && r.none.mode === 'off', '沒啟用要是關閉：' + JSON.stringify([r.off, r.none]));
  check(r.password.mode === 'password' && r.password.enabled, '加密的照 mode：' + JSON.stringify(r.password));
  check(r.screenOff.mode === 'off', '舊程式寫 enabled: false 要變成關閉：' + JSON.stringify(r.screenOff));
});

test('自訂密碼加密：硬碟上沒有能解開帳密的金鑰，瀏覽器重開後要打自訂密碼', async () => {
  await seedEntry('right');
  check((await setMode({ mode: 'password', setup: { password: MASTER } })) === (await msgOf('bg_lock_needs_backup_password')), '沒設自動備份密碼不能選加密');
  await setBackupPassword();
  check((await setMode({ mode: 'password', setup: { password: 'short-pass' } })) === (await msgOf('bg_master_password_too_short', 12)), '自訂密碼太短要擋');
  const fromWeb = await w.eval(`handlers['lock.setMode']({ mode: 'password', setup: { password: '${MASTER}' } }, { url: 'https://example.test/' }).then(() => 'ok', (e) => e.message)`);
  check(fromWeb === (await msgOf('bg_extension_page_only')), '網頁裡的程式不能換保護方式：' + fromWeb);
  const oldKey = await w.eval(`chrome.storage.local.get('keyB64').then((x) => x.keyB64)`);
  check((await setMode({ mode: 'password', setup: { password: MASTER } })) === 'ok', '設自訂密碼要成功');
  const disk = await w.eval(`(async () => {
    const all = await chrome.storage.local.get(null);
    let oldKeyOpens = true;
    try {
      await decrypt(await importKey(b64ToBytes(${JSON.stringify(oldKey)})), all.vault);
    } catch {
      oldKeyOpens = false;
    }
    return { hasKey: 'keyB64' in all, mode: all.vaultKeyLock && all.vaultKeyLock.mode, text: JSON.stringify(all), oldKeyOpens, settingsMode: (await getSettings()).lock.mode };
  })()`);
  check(!disk.hasKey, '設了自訂密碼，硬碟上不能再有 keyB64');
  check(disk.mode === 'password' && disk.settingsMode === 'password', '保護方式要是自訂密碼加密：' + JSON.stringify([disk.mode, disk.settingsMode]));
  check(!disk.text.includes(MASTER), '硬碟上不能有自訂密碼');
  check(!disk.oldKeyOpens, '舊的金鑰要解不開新的 vault');
  check(!(await w.eval('isLocked()')), '剛設好不用再解鎖');

  await restartBrowser();
  const locked = await w.eval(`(async () => {
    let all = '';
    try {
      await dispatch({ type: 'entries.all' }, ${fromOptions});
      all = 'ok';
    } catch (e) {
      all = e.locked ? 'locked' : e.message;
    }
    return { isLocked: await isLocked(), needsKey: (await lockStatus()).needsKey, all };
  })()`);
  check(locked.isLocked && locked.needsKey && locked.all === 'locked', '瀏覽器重開後要鎖著，讀不到帳密：' + JSON.stringify(locked));
  check((await unlockPassword('wrong-pass-12345')) === (await msgOf('bg_master_password_wrong')), '打錯要說自訂密碼不對');
  check(await w.eval('isLocked()'), '打錯不能解鎖');
  check((await unlockPassword(MASTER)) === 'ok', '打對要解鎖');
  const after = await passwordsNow();
  check(!after.locked && after.passwords[0] === 'right', '解鎖後要讀得到帳密：' + JSON.stringify(after));

  // 改回不加密要打自訂密碼
  check((await setMode({ mode: 'off' })) === (await msgOf('bg_master_password_wrong')), '改回不加密沒打自訂密碼要擋');
  check((await setMode({ mode: 'off', proof: { password: MASTER } })) === 'ok', '打了自訂密碼要能改回不加密');
  await restartBrowser();
  const plain = await w.eval(`(async () => {
    const all = await chrome.storage.local.get(null);
    return { hasKey: 'keyB64' in all, hasLock: 'vaultKeyLock' in all, locked: await isLocked(), passwords: (await loadEntries()).map((e) => e.password) };
  })()`);
  check(plain.hasKey && !plain.hasLock && !plain.locked && plain.passwords[0] === 'right', '改回不加密後，重開也直接讀得到：' + JSON.stringify(plain));
});

test('自訂密碼加密：瀏覽器重開還沒解鎖時，自動備份照樣存', async () => {
  await seedEntry('right');
  await setBackupPassword();
  check((await setMode({ mode: 'password', setup: { password: MASTER } })) === 'ok', '設自訂密碼要成功');
  await seedEntry('second', 'b.example.test');
  await restartBrowser();
  const r = await w.eval(`(async () => {
    const realSave = saveFile;
    let saved = null;
    saveFile = async ({ content, filename }) => {
      saved = content;
      return { id: 0, path: 'fake/' + filename };
    };
    let result;
    try {
      result = await runAutoBackup(true);
    } finally {
      saveFile = realSave;
    }
    const body = JSON.parse(await decryptBackup('backup-pass-123', JSON.parse(saved)));
    return { ran: result.ran, locked: await isLocked(), hosts: body.entries.map((e) => e.host).sort() };
  })()`);
  check(r.ran && r.locked, '鎖著也要存得出備份：' + JSON.stringify(r));
  check(sameList(r.hosts, ['127.0.0.1', 'b.example.test']), '備份要帶到鎖之前最後的帳密：' + JSON.stringify(r.hosts));
});

test('系統驗證加密：虛擬驗證器給 PRF 秘密值，瀏覽器重開後按系統驗證就解得開', async () => {
  await seedEntry('right');
  await setBackupPassword();
  const page = await openPage(b.cdp, 'about:blank');
  await page.send('WebAuthn.enable', { enableUI: false });
  await page.send('WebAuthn.addVirtualAuthenticator', {
    options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true, hasPrf: true },
  });
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 800, deviceScaleFactor: 1, mobile: false });
  await page.goto('chrome-extension://' + extId + '/src/options/options.html#settings', 1200);
  // 記下卡片下面每次顯示的「第幾次」說明
  const result = await page.eval(`(() => {
    window.__steps = [];
    const step = document.getElementById('lockStep');
    new MutationObserver(() => {
      if (!step.hidden && window.__steps[window.__steps.length - 1] !== step.textContent) window.__steps.push(step.textContent);
    }).observe(step, { attributes: true, childList: true, characterData: true, subtree: true });
    return renderLock().then(() => changeLockMode('hello')).then((r) => r, (e) => 'error: ' + e.message);
  })()`);
  check(result === 'done', '選系統驗證加密要成功：' + result);
  const label = await page.eval('PK.webauthnClient.label()');
  const steps = await page.eval('window.__steps');
  check(
    JSON.stringify(steps) === JSON.stringify([await msgOf('opt_hello_step_create', label), await msgOf('opt_hello_step_verify', label)]),
    '兩次系統驗證前都要說在做什麼：' + JSON.stringify(steps)
  );
  check(!(await page.eval(`document.getElementById('lockStep').checkVisibility()`)), '設好之後說明要收起來');
  const disk = await w.eval(`chrome.storage.local.get(null).then((all) => ({
    hasKey: 'keyB64' in all,
    mode: all.vaultKeyLock && all.vaultKeyLock.mode,
    sameKey: !!all.webauthn && all.webauthn.id === all.vaultKeyLock.hello.credentialId,
  }))`);
  check(!disk.hasKey && disk.mode === 'hello' && disk.sameKey, '硬碟上只能有用系統驗證加密過的金鑰：' + JSON.stringify(disk));
  // 重新設定失敗（鑰匙資料不對）時，原本的鑰匙和加密過的金鑰都不能動，不然重開後會解不開
  const before = await w.eval(`chrome.storage.local.get(['webauthn', 'vaultKeyLock']).then((x) => JSON.stringify(x))`);
  const bad = await setMode({ mode: 'hello', setup: { credential: { id: 'x', alg: -7, publicKey: 'x', clientDataJSON: 'bad' }, assertion: { prf: 'AAAA' }, prfSalt: 'AAAA' } });
  check(bad !== 'ok', '鑰匙資料不對要擋下來');
  check((await w.eval(`chrome.storage.local.get(['webauthn', 'vaultKeyLock']).then((x) => JSON.stringify(x))`)) === before, '失敗時不能動到原本的鑰匙和金鑰');
  await restartBrowser();
  check(await w.eval('isLocked()'), '瀏覽器重開要鎖著');
  check((await page.eval(`PK.webauthnClient.unlock().then(() => 'ok', (e) => e.message)`)) === 'ok', '按系統驗證要解得開');
  const after = await passwordsNow();
  check(!after.locked && after.passwords[0] === 'right', '解鎖後要讀得到帳密：' + JSON.stringify(after));
  await page.eval(`document.querySelector('#tab-settings > details.card').open = true; renderLock()`);
  await sleep(300);
  await page.eval(`document.querySelector('#tab-settings > details.card').scrollIntoView()`);
  await page.screenshot(path.join(SHOTS, 'lock-mode-hello.png'));

  // 改成自訂密碼加密：系統驗證的鑰匙一起刪掉，之後只能打自訂密碼
  check((await setMode({ mode: 'password', setup: { password: MASTER } })) === 'ok', '改成自訂密碼加密要成功');
  check(!(await w.eval(`chrome.storage.local.get('webauthn').then((x) => 'webauthn' in x)`)), '系統驗證的鑰匙要刪掉');
  await w.eval('setLocked(true)');
  check((await page.eval(`PK.webauthnClient.unlock().then(() => 'ok', (e) => e.message)`)) !== 'ok', '系統驗證不能解開自訂密碼加密');
  check((await unlockPassword(MASTER)) === 'ok', '打自訂密碼要解得開');
  await closePage(page);
});

test('解鎖視窗：自訂密碼加密、瀏覽器重開過，直接問自訂密碼，不叫系統驗證', async () => {
  await seedEntry('right');
  await setBackupPassword();
  check((await setMode({ mode: 'password', setup: { password: MASTER } })) === 'ok', '設自訂密碼要成功');
  // 就算留著系統驗證的鑰匙也一樣：自訂密碼加密不叫系統驗證
  await w.eval(`chrome.storage.local.set({ webauthn: { id: 'AAAA', alg: -7, publicKey: 'AAAA', transports: [], createdAt: 1 } }).then(() => true)`);
  await restartBrowser();
  const page = await openUnlock(FAKE_HELLO);
  check(await until(() => page.eval(`!document.getElementById('pwForm').hidden`), 3000), '要直接顯示自訂密碼輸入框');
  const st = await unlockState(page);
  check(st.calls.length === 0 && !st.waiting, '不能叫系統驗證：' + JSON.stringify(st));
  await page.screenshot(path.join(SHOTS, 'unlock-password.png'));
  await page.eval(`document.getElementById('pw').value = 'wrong-pass-12345'; document.getElementById('pwSubmit').click();`);
  const wrong = await until(() => page.eval(`document.getElementById('pwError').textContent`), 3000);
  check(wrong === (await msgOf('bg_master_password_wrong')), '打錯要顯示：' + wrong);
  await page.eval(`document.getElementById('pw').value = '${MASTER}'; document.getElementById('pwSubmit').click();`);
  check(await until(() => page.eval('window.__closed === true'), 5000), '解鎖後要自己關視窗');
  check(!(await w.eval('isLocked()')), '背景程式要解鎖');
  await closePage(page);
});

test('解鎖視窗：自訂密碼加密閒置鎖定時，也直接問自訂密碼，不叫系統驗證', async () => {
  await seedEntry('right');
  await setBackupPassword();
  check((await setMode({ mode: 'password', setup: { password: MASTER } })) === 'ok', '設自訂密碼要成功');
  // 閒置鎖定：金鑰還在記憶體，只是畫面鎖住
  await w.eval('setLocked(true)');
  const page = await openUnlock(FAKE_HELLO);
  check(await until(() => page.eval(`!document.getElementById('pwForm').hidden`), 3000), '要直接顯示自訂密碼輸入框');
  await sleep(300);
  const st = await unlockState(page);
  check(st.calls.length === 0 && !st.waiting, '不能叫系統驗證：' + JSON.stringify(st));
  await page.eval(`document.getElementById('pw').value = '${MASTER}'; document.getElementById('pwSubmit').click();`);
  check(await until(() => page.eval('window.__closed === true'), 5000), '解鎖後要自己關視窗');
  check(!(await w.eval('isLocked()')), '背景程式要解鎖');
  await closePage(page);
});

test('管理頁：自訂密碼加密的驗證畫面要打自訂密碼，也找得到忘了怎麼辦', async () => {
  await seedEntry('right');
  await setBackupPassword();
  check((await setMode({ mode: 'password', setup: { password: MASTER } })) === 'ok', '設自訂密碼要成功');
  await restartBrowser();
  const page = await open('chrome-extension://' + extId + '/src/options/options.html', 1200);
  const seen = (id) => page.eval(`document.getElementById('${id}').checkVisibility()`);
  check(await seen('lockScreen'), '要先顯示驗證畫面');
  check((await seen('lockPwForm')) && !(await seen('helloRow')) && (await seen('lockForgot')), '要有自訂密碼輸入框和忘了怎麼辦，沒有系統驗證按鈕');
  await page.screenshot(path.join(SHOTS, 'options-lock-password.png'));
  await page.eval(`document.getElementById('lockPw').value = '${MASTER}'; document.getElementById('lockPwSubmit').click();`);
  check(await until(() => page.eval(`!document.getElementById('pageMain').hidden`), 5000), '打對要顯示管理頁：' + (await page.eval(`document.getElementById('lockError').textContent`)));
  await closePage(page);
});

test('管理頁：忘了自訂密碼要確認兩次，第二次寫出最近備份、照打「清除」才按得下去', async () => {
  await seedEntry('right');
  await setBackupPassword();
  check((await setMode({ mode: 'password', setup: { password: MASTER } })) === 'ok', '設自訂密碼要成功');
  await restartBrowser();
  const page = await open('chrome-extension://' + extId + '/src/options/options.html', 1200);
  const dialog = () =>
    page.eval(`({
      open: document.getElementById('choiceDialog').open,
      text: document.getElementById('choiceText').textContent,
      typing: document.getElementById('choiceTypeRow').checkVisibility(),
      danger: (() => {
        const b = document.querySelector('#choiceButtons .danger');
        return b ? { label: b.textContent, disabled: b.disabled } : null;
      })(),
    })`);
  const openSecond = async () => {
    await page.click('#lockForgot');
    const first = await until(async () => ((await dialog()).open ? dialog() : null), 2000);
    check(first && !first.typing && first.danger.label === '繼續', '第一層不用打字，按鈕是「繼續」：' + JSON.stringify(first));
    await page.eval(`document.querySelector('#choiceButtons .danger').click()`);
    return until(async () => {
      const d = await dialog();
      return d.open && d.typing ? d : null;
    }, 2000);
  };
  const typeWord = (word) => page.eval(`(() => { const i = document.getElementById('choiceType'); i.value = ${JSON.stringify(word)}; i.dispatchEvent(new Event('input')); })()`);
  const encrypted = () => w.eval(`chrome.storage.local.get('vaultKeyLock').then((x) => !!x.vaultKeyLock)`);

  // 沒有備份紀錄：第二層要警告救不回來，打錯字或取消都不能清
  let d = await openSecond();
  check(d && d.text === (await msgOf('opt_lock_reset_no_backup')) && d.danger.disabled, '沒有備份要警告，按鈕先不能按：' + JSON.stringify(d));
  await typeWord('清掉');
  check((await dialog()).danger.disabled, '打錯字還是不能按');
  await page.eval(`document.querySelector('#choiceButtons button').click()`);
  await sleep(200);
  check(await encrypted(), '取消不能清掉');

  // 有備份紀錄：第二層寫出最近一次備份的時間，打對字才按得下去
  const lastAt = new Date(2026, 10, 18, 9, 30).getTime();
  await w.eval(`setSettings({ lastBackupAt: ${lastAt} }).then(() => true)`);
  d = await openSecond();
  const when = await page.eval(`fmtDate(${lastAt})`);
  check(d && d.text === (await msgOf('opt_lock_reset_last_backup', when)), '要寫出最近一次備份：' + JSON.stringify(d));
  await typeWord('清除');
  check(!(await dialog()).danger.disabled, '打對字要按得下去');
  await page.screenshot(path.join(SHOTS, 'lock-reset-confirm.png'));
  await page.eval(`document.querySelector('#choiceButtons .danger').click()`);
  check(await until(async () => !(await encrypted()), 3000), '按下去要清掉');
  await closePage(page);
});

test('管理頁：保護方式有三張卡片，沒設自動備份密碼選加密會被擋', async () => {
  await seedEntry('right');
  const page = await open('chrome-extension://' + extId + '/src/options/options.html#settings', 1200);
  await page.eval(`document.querySelector('#tab-settings > details.card').open = true`);
  await sleep(200);
  const modes = await page.eval(`Array.from(document.querySelectorAll('input[name="lockMode"]')).map((r) => [r.value, r.checked, r.closest('label').textContent.trim()])`);
  check(sameList(modes.map((m) => m[0]), ['off', 'password', 'hello']), '要有三種，沒有只鎖畫面：' + JSON.stringify(modes));
  check(modes[0][1], '預設要是關閉：' + JSON.stringify(modes));
  // 每張卡片：[防旁人偷看, 防資料被拷走] 有沒有打勾、怎麼解鎖那行有沒有字
  const cards = await page.eval(`Array.from(document.querySelectorAll('label.lock-card')).map((c) => [
    c.querySelector('input').value,
    ...Array.from(c.querySelectorAll('.lock-check')).map((x) => !x.classList.contains('no')),
    !!c.querySelector('.lock-card-how').textContent.trim(),
  ])`);
  check(
    JSON.stringify(cards) === JSON.stringify([['off', false, false, true], ['password', true, true, true], ['hello', true, true, true]]),
    '卡片要標出擋得住什麼、怎麼解鎖：' + JSON.stringify(cards)
  );
  const notes = () => page.eval(`Array.from(document.querySelectorAll('.lock-card-note')).map((n) => [n.closest('label').querySelector('input').value, n.checkVisibility()])`);
  check(JSON.stringify(await notes()) === JSON.stringify([['password', true], ['hello', true]]), '沒設自動備份密碼，加密的卡片要直接寫出來：' + JSON.stringify(await notes()));
  await page.eval(`document.querySelector('#tab-settings > details.card').scrollIntoView()`);
  await page.screenshot(path.join(SHOTS, 'lock-cards-no-backup.png'));
  await page.click('input[name="lockMode"][value="password"]');
  const toastText = await until(() => page.eval(`document.getElementById('toast').textContent`), 3000);
  check(toastText.includes('自動備份密碼'), '要說先設自動備份密碼：' + toastText);
  check(await until(() => page.eval(`document.querySelector('input[name="lockMode"][value="off"]').checked`), 2000), '沒改成功要回到關閉');

  await setBackupPassword();
  await page.eval('renderLock()');
  check(await until(async () => (await notes()).every((n) => !n[1]), 2000), '設好自動備份密碼，提示要拿掉：' + JSON.stringify(await notes()));
  // 走管理頁選自訂密碼加密的流程：問密碼的對話框一打開就填好按確定，系統驗證一叫就記下來
  const viaPage = await page.eval(`(async () => {
    const calls = [];
    for (const name of ['create', 'setupHello', 'assertion']) PK.webauthnClient[name] = async () => { calls.push(name); throw new Error(name); };
    const dlg = document.getElementById('pwDialog');
    const answer = new MutationObserver(() => {
      if (!dlg.open) return;
      document.getElementById('pw1').value = ${JSON.stringify(MASTER)};
      document.getElementById('pw2').value = ${JSON.stringify(MASTER)};
      document.getElementById('pwOk').click();
    });
    answer.observe(dlg, { attributes: true, attributeFilter: ['open'] });
    const result = await changeLockMode('password').catch((e) => e.message);
    answer.disconnect();
    return { result, calls };
  })()`);
  check(viaPage.result === 'done' && viaPage.calls.length === 0, '選自訂密碼加密不能叫系統驗證：' + JSON.stringify(viaPage));
  await page.eval('renderLock()');
  await sleep(200);
  const st = await page.eval(`({
    checked: document.querySelector('input[name="lockMode"]:checked').value,
    changePw: document.getElementById('lockChangePw').checkVisibility(),
    onStartup: [document.getElementById('lockOnStartup').checked, document.getElementById('lockOnStartup').disabled],
    state: document.getElementById('lockState').textContent,
    border: getComputedStyle(document.querySelector('input[name="lockMode"][value="password"]').closest('label')).borderTopWidth,
  })`);
  check(st.checked === 'password' && st.changePw && st.state === '自訂密碼加密', '要顯示自訂密碼加密和更改自訂密碼：' + JSON.stringify(st));
  check(st.onStartup[0] && st.onStartup[1], '加密時「瀏覽器重開就鎖」要固定勾著：' + JSON.stringify(st.onStartup));
  check(st.border === '2px', '選到的卡片要框起來：' + st.border);
  await page.eval(`document.querySelector('#tab-settings > details.card').scrollIntoView()`);
  await page.screenshot(path.join(SHOTS, 'lock-mode-password.png'));
  await closePage(page);
});

test('保護方式：舊的只鎖畫面照常用、有提示，改成加密後就不能再選回來', async () => {
  await seedEntry('right');
  check((await setMode({ mode: 'screen' })) === (await msgOf('bg_lock_mode_unknown')), '關閉時不能新選只鎖畫面');
  // 1.15.0 以前開了工具鎖定的樣子：有系統驗證的鑰匙、enabled: true
  await w.eval(`(async () => {
    await chrome.storage.local.set({ webauthn: { id: 'x', alg: -7, publicKey: 'x', transports: [], createdAt: 1 } });
    const s = await getSettings();
    await setSettings({ lock: { ...s.lock, enabled: true } });
  })()`);
  const page = await open('chrome-extension://' + extId + '/src/options/options.html#settings', 1200);
  await page.eval(`document.querySelector('#tab-settings > details.card').open = true`);
  await sleep(200);
  const st = await page.eval(`({
    main: !document.getElementById('pageMain').hidden,
    legacy: document.getElementById('lockLegacy').checkVisibility(),
    checked: Array.from(document.querySelectorAll('input[name="lockMode"]:checked')).map((r) => r.value),
    state: document.getElementById('lockState').textContent,
  })`);
  check(st.main, '沒鎖要直接打開管理頁：' + JSON.stringify(st));
  check(st.legacy && st.checked.length === 0 && st.state.startsWith('只鎖畫面'), '要提示改選，三張卡片都不選：' + JSON.stringify(st));
  await page.eval(`document.querySelector('#tab-settings > details.card').scrollIntoView()`);
  await page.screenshot(path.join(SHOTS, 'lock-legacy-screen.png'));
  await setBackupPassword();
  check((await setMode({ mode: 'password', setup: { password: MASTER } })) === 'ok', '舊的只鎖畫面要能改成自訂密碼加密');
  check((await setMode({ mode: 'screen', proof: { password: MASTER } })) === (await msgOf('bg_lock_mode_unknown')), '改了就不能選回只鎖畫面');
  await page.eval('renderLock()');
  check(await until(() => page.eval(`!document.getElementById('lockLegacy').checkVisibility()`), 2000), '改了之後提示要拿掉');
  await closePage(page);
});

test('管理頁：工具沒鎖就直接打開，鎖著才要驗證，在別處解鎖後自己進去', async () => {
  await seedEntry('right');
  await setBackupPassword();
  check((await setMode({ mode: 'password', setup: { password: MASTER } })) === 'ok', '設自訂密碼要成功');
  const page = await open('chrome-extension://' + extId + '/src/options/options.html', 1200);
  check(await page.eval(`!document.getElementById('pageMain').hidden && document.getElementById('lockScreen').hidden`), '沒鎖要直接顯示管理頁，不問驗證');
  await w.eval('setLocked(true)');
  check(await until(() => page.eval(`!document.getElementById('lockScreen').hidden && document.getElementById('pageMain').hidden`), 3000), '鎖上要回到驗證畫面');
  // 像是在小視窗的解鎖視窗打自訂密碼
  check((await unlockPassword(MASTER)) === 'ok', '在別處解鎖要成功');
  check(await until(() => page.eval(`!document.getElementById('pageMain').hidden`), 3000), '別處解鎖後，停在驗證畫面的管理頁要自己進去');
  await closePage(page);
});

test('忘了自訂密碼：清掉後回到不加密，自動備份的金鑰還在', async () => {
  await seedEntry('right');
  await setBackupPassword();
  check((await setMode({ mode: 'password', setup: { password: MASTER } })) === 'ok', '設自訂密碼要成功');
  await restartBrowser();
  const fromWeb = await w.eval(`handlers['lock.reset']({}, { url: 'https://example.test/' }).then(() => 'ok', (e) => e.message)`);
  check(fromWeb === (await msgOf('bg_extension_page_only')), '網頁裡的程式不能清：' + fromWeb);
  check((await w.eval(`handlers['lock.reset']({}, ${asPage}).then(() => 'ok', (e) => e.message)`)) === 'ok', '要清得掉');
  const r = await w.eval(`(async () => {
    const all = await chrome.storage.local.get(null);
    return { vault: 'vault' in all, lock: 'vaultKeyLock' in all, backupKey: 'autoBackupKey' in all, mode: (await getSettings()).lock.mode, locked: await isLocked(), count: (await loadEntries()).length };
  })()`);
  check(!r.vault && !r.lock && r.backupKey && r.mode === 'off' && !r.locked && r.count === 0, '清完要回到不加密、沒有帳密，自動備份金鑰留著：' + JSON.stringify(r));
});

// ---- 大區塊收合和立即備份 ----

const blocksOf = (page, tab) =>
  page.eval(`Array.from(document.querySelectorAll('#tab-${tab} > details.card')).map((d) => [d.querySelector('summary').firstChild.textContent.trim(), d.open])`);

test('區塊：有好幾個區塊的分頁可以點標題收合，預設狀態照設計', async () => {
  const page = await open('chrome-extension://' + extId + '/src/options/options.html#settings', 1200);
  const expected = {
    backup: [['備份', true], ['和瀏覽器互搬密碼', false], ['自動備份', true], ['備份紀錄', false]],
    settings: [['工具鎖定', false], ['填入', true], ['自動點選', true], ['危險區', false]],
    versions: [['檢查新版', true], ['版本功能歷程', true]],
  };
  for (const [tab, want] of Object.entries(expected)) {
    const got = await blocksOf(page, tab);
    check(sameList(got, want), tab + ' 預設狀態：' + JSON.stringify(got));
    const plain = await page.eval(`Array.from(document.querySelectorAll('#tab-${tab} > .card:not(details)')).map((c) => c.outerHTML.slice(0, 60))`);
    check(plain.length === 0, tab + ' 還有不能收合的區塊：' + JSON.stringify(plain));
  }
  await page.screenshot(path.join(SHOTS, 'blocks-settings.png'));

  // 分頁只有一個區塊就不用收合
  for (const [tab, title] of [['trash', '回收桶'], ['help', '怎麼用']]) {
    const got = await page.eval(`(() => {
      const root = document.getElementById('tab-${tab}');
      const heading = root.querySelector(':scope > .card > h2');
      return { details: root.querySelectorAll('details').length, blocks: root.querySelectorAll(':scope > .card').length, title: heading && heading.textContent };
    })()`);
    check(got.details === 0 && got.blocks === 1 && got.title === title, tab + ' 只有一個區塊，不該有收合：' + JSON.stringify(got));
  }

  check((await page.eval(`document.getElementById('lockState').textContent`)) === '未啟用', '工具鎖定收著，標題旁邊要看得出沒開');
  check(!(await page.eval(`document.getElementById('deleteAll').checkVisibility()`)), '危險區收著時看不到刪除按鈕');

  // 真的點標題，收起來和打開
  const summaries = await page.eval(`Array.from(document.querySelectorAll('#tab-settings > details.card > summary')).length`);
  for (let i = 0; i < summaries; i++) {
    const selector = '#tab-settings > details.card:nth-of-type(' + (i + 1) + ') > summary';
    const state = () => page.eval(`document.querySelector(${JSON.stringify(selector)}).parentElement.open`);
    await page.eval(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({ block: 'center' })`);
    const before = await state();
    await page.click(selector);
    await sleep(100);
    check((await state()) === !before, '第 ' + (i + 1) + ' 塊點標題要換狀態');
    await page.click(selector);
    await sleep(100);
    check((await state()) === before, '第 ' + (i + 1) + ' 塊再點要換回來');
  }

  // 自動點選收起來再打開，裡面的網站區塊不受影響，字也不能變大
  const sizes = await page.eval(`(() => {
    const out = {};
    out.block = getComputedStyle(document.querySelector('#tab-settings > details.card > summary')).fontSize;
    return out;
  })()`);
  check(sizes.block === '15px', '大區塊標題的字：' + JSON.stringify(sizes));

  // 換分頁再回來，開合要留著
  await page.eval(`document.querySelector('#tab-settings > details.card').open = true; showTab('backup'); showTab('settings')`);
  check(await page.eval(`document.querySelector('#tab-settings > details.card').open`), '換分頁不能把開合重設');
  await closePage(page);
});

test('區塊：工具鎖定標題旁邊看得出有沒有開，網站區塊的標題字不受影響', async () => {
  await seedRules([{ host: 'a.example.test', path: '/', selector: '#a', text: 'A', when: 'onLoad' }]);
  const page = await openRuleOptions();
  const size = await page.eval(`getComputedStyle(document.querySelector('.rule-site > summary')).fontSize`);
  check(size === '13px', '網站區塊標題的字不能跟著變大：' + size);
  await w.eval(`(async () => {
    await chrome.storage.local.set({ webauthn: { id: 'x', alg: -7, publicKey: 'x', transports: [], createdAt: 1 } });
    const s = await getSettings();
    await setSettings({ lock: { ...s.lock, enabled: true } });
  })()`);
  await page.eval('renderLock()');
  await sleep(200);
  const state = await page.eval(`document.getElementById('lockState').textContent`);
  check(state.startsWith('只鎖畫面'), '開了要顯示用哪種保護方式：' + state);
  await closePage(page);
});

test('立即備份：在自動備份標題旁邊，沒設密碼不能按，按了不會把區塊收起來', async () => {
  await seedEntry('right');
  const page = await open('chrome-extension://' + extId + '/src/options/options.html#backup', 1200);
  const info = await page.eval(`(() => {
    const btn = document.getElementById('abRunNow');
    return {
      text: btn.textContent,
      block: btn.closest('summary').firstChild.textContent.trim(),
      inForm: !!btn.closest('.form'),
      primary: btn.classList.contains('primary'),
      disabled: btn.disabled,
    };
  })()`);
  check(info.text === '立即備份', '按鈕文字：' + info.text);
  check(info.block === '自動備份' && !info.inForm, '要在自動備份的標題旁邊：' + JSON.stringify(info));
  check(info.primary, '要夠顯眼');
  check(info.disabled, '沒設密碼不能按');
  const block =`document.getElementById('abRunNow').closest('details')`;
  await page.click('#abRunNow');
  await sleep(100);
  check(await page.eval(block + '.open'), '點灰掉的按鈕不能把區塊收起來');

  await w.eval(`handlers['autoBackup.set']({ password: 'not-a-real-one' })`);
  await page.eval('renderBackup()');
  await sleep(300);
  check(!(await page.eval(`document.getElementById('abRunNow').disabled`)), '設了密碼要能按');

  // 不要真的寫檔到下載資料夾
  await w.eval(`(() => {
    self.__realRunNow = handlers['autoBackup.runNow'];
    self.__runNowCalls = 0;
    handlers['autoBackup.runNow'] = async () => {
      self.__runNowCalls++;
      return { ran: true, path: 'C:\\\\fake\\\\backup.pkbak', count: 1 };
    };
  })()`);
  await page.click('#abRunNow');
  await sleep(300);
  const calls = await w.eval('self.__runNowCalls');
  const toastText = await page.eval(`document.getElementById('toast').textContent`);
  const stillOpen = await page.eval(block + '.open');

  // 點旁邊的「?」也不能收起來
  await page.click(`#abRunNow ~ .tip`);
  await sleep(100);
  const openAfterTip = await page.eval(block + '.open');
  const tip = await tipBox(page);

  // 鍵盤按也一樣。按鈕要收到字元才會動，所以 Enter 和空白鍵都帶 text。
  const typeKey = async (key, code, vk, text) => {
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, text });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
    await sleep(200);
  };
  await page.eval(`document.getElementById('abRunNow').focus()`);
  await typeKey('Enter', 'Enter', 13, '\r');
  const callsByKey = await w.eval('self.__runNowCalls');
  const openAfterKey = await page.eval(block + '.open');
  await typeKey(' ', 'Space', 32, ' ');
  const callsBySpace = await w.eval('self.__runNowCalls');
  const openAfterSpace = await page.eval(block + '.open');
  await page.eval(`document.querySelector('#abRunNow ~ .tip').focus()`);
  await typeKey('Enter', 'Enter', 13, '\r');
  const openAfterTipKey = await page.eval(block + '.open');
  await typeKey(' ', 'Space', 32, ' ');
  const openAfterTipSpace = await page.eval(block + '.open');

  // 區塊收起來也按得到
  await page.eval(`document.activeElement.blur(); ${block}.open = false`);
  await sleep(100);
  const visibleWhenClosed = await page.eval(`document.getElementById('abRunNow').checkVisibility()`);
  await page.screenshot(path.join(SHOTS, 'run-now-closed.png'));
  await page.click('#abRunNow');
  await sleep(300);
  const callsClosed = await w.eval('self.__runNowCalls');
  const closedAfterClick = !(await page.eval(block + '.open'));
  await w.eval(`handlers['autoBackup.runNow'] = self.__realRunNow`);

  check(calls === 1, '按了要備份，實際 ' + calls + ' 次');
  check(toastText.includes('已備份到'), '要告訴使用者存到哪：' + toastText);
  check(stillOpen, '按了不能把區塊收起來');
  check(openAfterTip, '點「?」不能把區塊收起來');
  check(tip && tip.text.includes('沒改過密碼也會存'), '點「?」要顯示說明：' + JSON.stringify(tip));
  check(callsByKey === 2 && openAfterKey, '按 Enter 要備份、不能收起來：' + callsByKey + ' ' + openAfterKey);
  check(callsBySpace === 3 && openAfterSpace, '按空白鍵要備份、不能收起來：' + callsBySpace + ' ' + openAfterSpace);
  check(openAfterTipKey, '在「?」上按 Enter 不能把區塊收起來');
  check(openAfterTipSpace, '在「?」上按空白鍵不能把區塊收起來');
  check(visibleWhenClosed, '區塊收起來也要看得到按鈕');
  check(callsClosed === 4 && closedAfterClick, '區塊收起來也按得到，而且不會自己打開：' + callsClosed + ' ' + closedAfterClick);
  await closePage(page);
});

// ---- 既有功能沒壞 ----

test('自動備份：預設存到「下載」底下的 password-keeper，存過舊名稱的照舊', async () => {
  check((await w.eval('getSettings().then((s) => s.autoBackup.folder)')) === 'password-keeper', '沒存過設定時預設要是 password-keeper');
  const page = await open('chrome-extension://' + extId + '/src/options/options.html#backup', 1200);
  const shown = await page.eval(`document.getElementById('abFolder').value`);
  check(shown === 'password-keeper', '管理頁的資料夾欄要顯示 password-keeper：' + shown);
  await closePage(page);
  // 1.13.0 以前存過設定的人，settings 裡寫的是舊的預設名稱，不能被換掉
  await w.eval(`setSettings({ autoBackup: { ...DEFAULT_SETTINGS.autoBackup, folder: '密碼小管家備份' } }).then(() => true)`); // i18n-ignore：舊版的資料夾名稱
  check((await w.eval('getSettings().then((s) => s.autoBackup.folder)')) === '密碼小管家備份', '存過的舊資料夾名稱要照舊'); // i18n-ignore：舊版的資料夾名稱
  check((await w.eval(`safeFolder('')`)) === 'password-keeper', '資料夾名稱清空時要退回 password-keeper');
});

test('既有功能：沒規則的頁面登入後照常問要不要儲存', async () => {
  const page = await open(T + 'harness.html', 800);
  await page.click('#u');
  await page.eval(`(() => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    for (const [id, v] of [['u', 'typed-user'], ['p', 'typed-pass']]) {
      const el = document.getElementById(id);
      set.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
  })()`);
  await page.click('button[type=submit]');
  const ok = await until(async () => (await page.shadowTexts()).some((t) => /要儲存這組密碼嗎/.test(t)), 5000);
  check(ok, '應該跳儲存提示');
  await closePage(page);
});

test('既有功能：自動填入照常，存的帳號會填到欄位', async () => {
  await seedEntry('right');
  const page = await open(T + 'harness.html', 1200);
  check((await page.eval(`document.getElementById('u').value`)) === 'test-user@example.test', '帳號要填');
  check((await page.eval(`document.getElementById('p').value`)) === 'right', '密碼要填');
  await closePage(page);
});

// ---- 網頁上的帳號清單和自動填入：擋點擊劫持、隱形表單、沒加密的網頁、sandbox ----

const fieldValues = (page) => page.eval(`({ u: document.getElementById('u').value, p: document.getElementById('p').value })`);

// 自動填入關掉，欄位才是空的，看得出是不是從清單填進去的
const noAutoFill = () => w.eval(`setSettings({ autoFill: false }).then(() => true)`);

const listShown = async (page, text = 'test-user@example.test') => until(async () => (await page.shadowTexts()).includes(text), 4000);

// 真人點帳號欄打開清單，再等過清單剛出現時不收點擊的那段時間
async function openAccountList(page) {
  await page.click('#u');
  check(await listShown(page), '帳號清單應該出現');
  await sleep(700);
}

// 清單被網頁收掉也算擋下來，找不到清單就不點
async function clickAccountIfShown(page) {
  try {
    await page.clickShadow('test-user@example.test', 'DIV');
  } catch {
    // 清單已經被收掉
  }
  await sleep(300);
}

test('帳號清單：真人點帳號照常填入，真人按下鍵和 Enter 也照常填入', async () => {
  await seedEntry('right');
  await noAutoFill();
  let page = await open(T + 'harness.html', 1000);
  await openAccountList(page);
  await page.clickShadow('test-user@example.test', 'DIV');
  await sleep(300);
  let v = await fieldValues(page);
  check(v.u === 'test-user@example.test' && v.p === 'right', '點清單應該填入：' + JSON.stringify(v));
  await closePage(page);

  page = await open(T + 'harness.html', 1000);
  await openAccountList(page);
  await page.press('ArrowDown', 'ArrowDown', 40);
  await page.press('Enter', 'Enter', 13);
  await sleep(300);
  v = await fieldValues(page);
  check(v.p === 'right', '真人按下鍵和 Enter 應該填入：' + JSON.stringify(v));
  await closePage(page);
});

test('安全：網頁用樣式表把整頁設成透明，點帳號清單不會填', async () => {
  await seedEntry('right');
  await noAutoFill();
  const page = await open(T + 'harness.html', 1000);
  await openAccountList(page);
  // 加樣式表不會改到 html 的屬性，要靠點下去那一刻的檢查擋
  await page.eval(`(() => { const s = document.createElement('style'); s.textContent = 'html { opacity: 0 !important; }'; document.head.appendChild(s); return true; })()`);
  await sleep(200);
  await clickAccountIfShown(page);
  const v = await fieldValues(page);
  check(!v.u && !v.p, '不應該填：' + JSON.stringify(v));
  check(/擋住/.test(await page.toastText()), '應該提示被擋住，實際 ' + (await page.toastText()));
  await closePage(page);
});

test('安全：網頁改 html 的 style 變透明，清單收掉，點了不會填', async () => {
  await seedEntry('right');
  await noAutoFill();
  const page = await open(T + 'harness.html', 1000);
  await openAccountList(page);
  await page.eval(`document.documentElement.style.opacity = '0.01'`);
  await sleep(300);
  await clickAccountIfShown(page);
  const v = await fieldValues(page);
  check(!v.u && !v.p, '不應該填：' + JSON.stringify(v));
  await closePage(page);
});

test('安全：網頁開點擊穿透的 popover 蓋住清單，點了不會填', async () => {
  await seedEntry('right');
  await noAutoFill();
  const page = await open(T + 'harness.html', 1000);
  await openAccountList(page);
  await page.eval(`(() => {
    const d = document.createElement('div');
    d.setAttribute('popover', 'manual');
    d.style.cssText = 'pointer-events: none; position: fixed; inset: 0; width: 100vw; height: 100vh; margin: 0; border: 0; background: #fff;';
    d.textContent = '接受 cookie';
    document.body.appendChild(d);
    d.showPopover();
    return true;
  })()`);
  await sleep(200);
  await clickAccountIfShown(page);
  const v = await fieldValues(page);
  check(!v.u && !v.p, '不應該填：' + JSON.stringify(v));
  await closePage(page);
});

test('安全：網頁在清單後面加一層蓋上去，清單會移回最上層', async () => {
  await seedEntry('right');
  await noAutoFill();
  const page = await open(T + 'harness.html', 1000);
  await openAccountList(page);
  const moved = await page.eval(`(async () => {
    const d = document.createElement('div');
    d.id = 'cover';
    d.style.cssText = 'pointer-events: none; position: fixed; inset: 0; z-index: 2147483647; background: #fff;';
    document.documentElement.appendChild(d);
    await new Promise((r) => setTimeout(r, 200));
    return document.documentElement.lastElementChild.id !== 'cover';
  })()`);
  check(moved, '小管家的畫面應該移回 html 的最後面');
  await closePage(page);
});

test('安全：清單剛出現就被點，不會填', async () => {
  await seedEntry('right');
  await noAutoFill();
  const page = await open(T + 'harness.html', 1000);
  // 清單畫在帳號欄正下方，第一個帳號在標題那一行下面。先算好位置，focus 之後馬上點
  const r = await page.eval(`(() => { const r = document.getElementById('u').getBoundingClientRect(); return { x: r.left + 30, y: r.bottom + 2 + 24 + 16 }; })()`);
  const started = Date.now();
  await page.eval(`document.getElementById('u').focus()`);
  await sleep(120);
  await page.clickAt(r.x, r.y);
  const elapsed = Date.now() - started;
  await sleep(300);
  const v = await fieldValues(page);
  // 測試機太慢、點下去時已經過了 0.5 秒，這一次就看不出來，不算失敗
  if (elapsed < 450) check(!v.p, '清單剛出現就被點不應該填：' + JSON.stringify(v) + '，經過 ' + elapsed + 'ms');
  else console.log('  （點下去時已經過了 ' + elapsed + 'ms，這一次看不出來）');
  // 同一個位置等一下再點會填，證明上面點的位置是對的
  await page.click('#u');
  await sleep(700);
  await page.clickAt(r.x, r.y);
  await sleep(300);
  check((await fieldValues(page)).p === 'right', '等清單出現一陣子再點同一個位置應該填入');
  await closePage(page);
});

test('安全：網頁自己送的下鍵和 Enter 不會從清單填入', async () => {
  await seedEntry('right');
  await noAutoFill();
  const page = await open(T + 'harness.html', 1000);
  await page.eval(`document.getElementById('u').focus()`);
  check(await listShown(page), '帳號清單應該出現');
  await sleep(700);
  await page.eval(`(() => {
    const u = document.getElementById('u');
    for (const key of ['ArrowDown', 'Enter']) u.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    return true;
  })()`);
  await sleep(300);
  const v = await fieldValues(page);
  check(!v.p, '網頁送的假按鍵不應該填：' + JSON.stringify(v));
  await closePage(page);
});

test('安全：看不見的表單不自動填，淡入的登入框淡入後照常填', async () => {
  await seedEntry('right');
  const result = {};
  for (const mode of ['normal', 'opacity', 'faint', 'offscreen', 'fade']) {
    const page = await open(ORIGIN + '/hidden-login?mode=' + mode, 2800);
    result[mode] = (await fieldValues(page)).p;
    await closePage(page);
  }
  check(result.normal === 'right', '看得見的表單應該填：' + JSON.stringify(result));
  check(result.fade === 'right', '淡入的表單淡入後應該填：' + JSON.stringify(result));
  for (const mode of ['opacity', 'faint', 'offscreen']) check(result[mode] === '', mode + ' 的表單不應該填：' + JSON.stringify(result));
});

test('安全：HTTP 網頁不自動填 HTTPS 存的帳號，從清單選要先確認', async () => {
  await w.eval(`handlers['entries.save']({ entry: { host: '127.0.0.1', origin: 'https://127.0.0.1', username: 'test-user@example.test', password: 'right' } }, ${fromOptions}).then(() => true)`);
  const page = await open(T + 'harness.html', 1500);
  let v = await fieldValues(page);
  check(!v.p, 'HTTP 網頁不應該自動填 HTTPS 的帳號：' + JSON.stringify(v));
  await openAccountList(page);
  await page.clickShadow('test-user@example.test', 'DIV');
  await sleep(300);
  v = await fieldValues(page);
  check(!v.p, '選了帳號還沒確認，不應該填：' + JSON.stringify(v));
  const texts = await page.shadowTexts();
  check(texts.some((x) => /沒有加密/.test(x)), '應該問網頁沒有加密要不要填，實際 ' + JSON.stringify(texts));
  await sleep(600);
  await page.clickShadow('填入', 'DIV');
  await sleep(300);
  v = await fieldValues(page);
  check(v.p === 'right', '確認後應該填入：' + JSON.stringify(v));
  await closePage(page);
});

test('安全：HTTP 存的帳號在 HTTP 網頁照常自動填', async () => {
  await seedEntry('right');
  const page = await open(T + 'harness.html', 1500);
  check((await fieldValues(page)).p === 'right', '應該照常自動填');
  await closePage(page);
});

test('安全：sandbox iframe 裡不自動填，一般的同網站 iframe 照常填', async () => {
  await seedEntry('right');
  const got = {};
  for (const mode of ['plain', 'sandbox']) {
    const page = await open(ORIGIN + '/sandbox-wrap?' + mode, 3000);
    got[mode] = await page.eval(`window.__got && window.__got.p`);
    await closePage(page);
  }
  check(got.plain === 'right', '一般的同網站 iframe 應該照常填：' + JSON.stringify(got));
  check(got.sandbox === '', 'sandbox iframe 不應該填：' + JSON.stringify(got));
});

test('安全：跨網站 iframe 裡從清單選帳號要先確認，小視窗的填入不會填進去', async () => {
  await w.eval(`handlers['entries.save']({ entry: { host: 'localhost', origin: 'http://localhost:${PORT}', username: 'test-user@example.test', password: 'right' } }, ${fromOptions}).then(() => true)`);
  const page = await open(ORIGIN + '/wrap?src=' + encodeURIComponent('http://localhost:' + PORT + '/test/harness.html'), 1500);
  const frame = await attachFrame(b.cdp, 'localhost');
  const off = await page.eval(`(() => { const e = document.getElementById('f'); const r = e.getBoundingClientRect(); return { x: r.left + e.clientLeft, y: r.top + e.clientTop }; })()`);
  const clickInFrame = async (text) => {
    const hit = (await frame.shadowNodes()).find((n) => n.name === 'DIV' && n.text.trim() === text);
    check(hit, 'iframe 裡找不到 ' + text);
    const { model } = await frame.send('DOM.getBoxModel', { nodeId: hit.nodeId });
    const q = model.content;
    await page.clickAt(off.x + (q[0] + q[2]) / 2, off.y + (q[1] + q[5]) / 2);
    await sleep(300);
  };
  const frameValues = () => frame.eval(`({ u: document.getElementById('u').value, p: document.getElementById('p').value })`);

  // 小視窗、快捷鍵送的填入，跨網站 iframe 不收
  await w.eval(`(async () => {
    const [tab] = await chrome.tabs.query({ url: ${JSON.stringify(ORIGIN + '/wrap*')} });
    await chrome.tabs.sendMessage(tab.id, { type: 'fill', entry: { username: 'popup-user', password: 'popup-pass' } }).catch(() => null);
    return true;
  })()`);
  await sleep(600);
  check((await frameValues()).p === '', '跨網站 iframe 不應該收小視窗的填入：' + JSON.stringify(await frameValues()));

  const u = await frame.centerOf('#u');
  await page.clickAt(off.x + u.x, off.y + u.y);
  check(await until(async () => (await frame.shadowTexts()).includes('test-user@example.test'), 4000), 'iframe 裡應該跳帳號清單');
  await sleep(700);
  await clickInFrame('test-user@example.test');
  check(!(await frameValues()).p, '還沒確認不應該填');
  const texts = await frame.shadowTexts();
  check(texts.some((x) => /框進來/.test(x)), '應該問是別的網站框進來的，實際 ' + JSON.stringify(texts));
  await sleep(600);
  await clickInFrame('填入');
  check((await frameValues()).p === 'right', '確認後應該填入：' + JSON.stringify(await frameValues()));
  await closePage(page);
});

test('剪貼簿：時間到清掉小管家複製的密碼，使用者後來複製的不動', async () => {
  await w.eval(`setSettings({ clipboardClearSeconds: 30 }).then(() => true)`);
  const page = await open('chrome-extension://' + extId + '/src/options/options.html#settings', 1200);
  await page.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  const write = (text) => page.eval(`navigator.clipboard.writeText(${JSON.stringify(text)}).then(() => true)`);
  const read = () => page.eval(`navigator.clipboard.readText()`);

  await write('copied-secret-1');
  await w.eval(`handlers['clipboard.copied']({ text: 'copied-secret-1' }, ${fromOptions}).then(() => true)`);
  check((await w.eval(`chrome.alarms.get('clipboardClear').then((a) => !!a)`)) === true, '應該排好清除的時間');
  await w.eval(`clearClipboardIfOurs().then(() => true)`);
  check((await read()) === '', '時間到應該清掉，實際 ' + JSON.stringify(await read()));

  await write('copied-secret-2');
  await w.eval(`handlers['clipboard.copied']({ text: 'copied-secret-2' }, ${fromOptions}).then(() => true)`);
  await write('something the user copied later');
  await w.eval(`clearClipboardIfOurs().then(() => true)`);
  check((await read()) === 'something the user copied later', '使用者後來複製的不應該清，實際 ' + JSON.stringify(await read()));

  // 選「不清除」時不排時間
  await w.eval(`setSettings({ clipboardClearSeconds: 0 }).then(() => chrome.alarms.clear('clipboardClear'))`);
  await w.eval(`handlers['clipboard.copied']({ text: 'copied-secret-3' }, ${fromOptions}).then(() => true)`);
  check((await w.eval(`chrome.alarms.get('clipboardClear').then((a) => !!a)`)) === false, '不清除時不應該排時間');
  await closePage(page);
});

test('剪貼簿：管理頁選了秒數才要權限，不給就退回不清除', async () => {
  const page = await open('chrome-extension://' + extId + '/src/options/options.html#settings', 1200);
  // e2e 按不到瀏覽器的權限對話框，換成假的，記下要了哪些權限
  await page.eval(`(() => {
    window.__asked = [];
    chrome.permissions.request = async (p) => { window.__asked.push(p.permissions.join(',')); return window.__grant; };
    return true;
  })()`);
  const choose = async (value, grant) => {
    await page.eval(`(() => { window.__grant = ${grant}; const s = document.getElementById('clipClear'); s.value = ${JSON.stringify(value)}; s.dispatchEvent(new Event('change')); return true; })()`);
    await sleep(500);
    return {
      shown: await page.eval(`document.getElementById('clipClear').value`),
      saved: await w.eval(`getSettings().then((s) => s.clipboardClearSeconds)`),
      asked: await page.eval(`window.__asked.slice()`),
    };
  };
  let r = await choose('30', false);
  check(r.shown === '0' && r.saved === 0, '不給權限要退回不清除：' + JSON.stringify(r));
  check(r.asked.length === 1 && r.asked[0] === 'clipboardRead,clipboardWrite,offscreen', '要剪貼簿和 offscreen 的權限：' + JSON.stringify(r));
  r = await choose('60', true);
  check(r.shown === '60' && r.saved === 60, '給了權限要存 60 秒：' + JSON.stringify(r));
  r = await choose('0', true);
  check(r.saved === 0 && r.asked.length === 2, '選不清除不用再要權限：' + JSON.stringify(r));
  await closePage(page);
});

test('剪貼簿：鎖定時清掉小管家複製的密碼', async () => {
  await w.eval(`setSettings({ clipboardClearSeconds: 120 }).then(() => true)`);
  const page = await open('chrome-extension://' + extId + '/src/options/options.html#settings', 1200);
  await page.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await page.eval(`navigator.clipboard.writeText('copied-secret-lock').then(() => true)`);
  await w.eval(`handlers['clipboard.copied']({ text: 'copied-secret-lock' }, ${fromOptions}).then(() => true)`);
  // 閒置、Windows 鎖定、按小視窗的鎖定，最後都是叫 setLocked(true)
  await w.eval(`setLocked(true).then(() => true)`);
  await sleep(500);
  check((await page.eval(`navigator.clipboard.readText()`)) === '', '鎖定時應該清掉');
  await w.eval(`setLocked(false).then(() => true)`);
  await closePage(page);
});

// ---- 多國語系：另外開繁中以外介面的瀏覽器 ----

// 同一個擴充功能、同一個測試伺服器，只換瀏覽器的介面語言。用完就關。
// pick 是開好之後從語言選單選的語言：瀏覽器沒有台語介面，台語要用繁中瀏覽器開再選。
async function withLang(lang, fn, { pick } = {}) {
  const lb = await launch(browserPath, extDir, { lang });
  try {
    const sw = await findServiceWorker(lb.cdp);
    if (!sw) throw new Error(lang + ' 的瀏覽器沒裝起來擴充功能');
    const lw = await attachWorker(lb.cdp, sw);
    await until(() => lw.eval("typeof handlers === 'object'"), 10000);
    if (pick) await lw.eval(`handlers['language.set']({ language: ${JSON.stringify(pick)} }).then(() => true)`);
    await fn({ cdp: lb.cdp, lw, base: 'chrome-extension://' + sw.url.split('/')[2] + '/' });
  } finally {
    await lb.close();
  }
}

// 日文本來就有漢字，改找只有繁體中文才用的字，出現了就是漏翻
const ZH_ONLY = /[這們嗎沒說點會關號讓從與對傳檔實擇麼幫啟稱單錄數據變顯腦碼]/;
const HAN = /[㐀-鿿]/;
// 台語也寫漢字，改找只有華語才用、台語不用的字（們、嗎、給、把……），出現了就是直接沿用華語原文
const MANDARIN_ONLY = /[們嗎麼沒吧給把什誰]/;

// browser：開瀏覽器用的介面語言，pick：開好之後從語言選單選的，tag：html 的 lang 應該是什麼（沒寫就跟 locale 一樣）
const I18N_CASES = [
  { locale: 'en', browser: 'en', bad: HAN },
  { locale: 'ja', browser: 'ja', bad: ZH_ONLY },
  { locale: 'ko', browser: 'ko', bad: HAN },
  { locale: 'de', browser: 'de', bad: HAN },
  { locale: 'ru', browser: 'ru', bad: HAN },
  { locale: 'th', browser: 'th', bad: HAN },
  { locale: 'nan_TW', browser: 'zh-TW', pick: 'nan_TW', tag: 'nan-Hant-TW', bad: MANDARIN_ONLY },
];

// 整頁的文字（藏起來的對話框、分頁也算）、title、placeholder、aria-label、「?」說明，挑出有問題的字詞
const scanPage = (page, bad) =>
  page.eval(`(() => {
    const body = document.body.cloneNode(true);
    // 語言選單的選項一律寫各語言自己的名稱（繁體中文、日本語），英文介面出現這兩個詞是對的
    body.querySelectorAll('script, style, #langSelect').forEach((x) => x.remove());
    const attrs = Array.from(document.querySelectorAll('[placeholder], [title], [aria-label], [data-tip]'))
      .flatMap((e) => ['placeholder', 'title', 'aria-label', 'data-tip'].map((a) => e.getAttribute(a)).filter(Boolean));
    const bad = ${bad.toString()};
    const words = [document.title, ...body.textContent.split(/\\s+/), ...attrs].filter((x) => bad.test(x));
    return { lang: document.documentElement.lang, words: Array.from(new Set(words)).slice(0, 15) };
  })()`);

for (const { locale: lang, browser, pick, tag, bad } of I18N_CASES) {
  test('多國語系：' + lang + ' 介面沒有漏翻的中文', async () => {
    const problems = [];
    const look = async (page, name) => {
      const r = await scanPage(page, bad);
      if (r.lang !== (tag || lang)) problems.push(name + ' 的 lang 是 ' + r.lang);
      if (r.words.length) problems.push(name + '：' + JSON.stringify(r.words));
      await page.screenshot(path.join(SHOTS, 'i18n-' + lang + '-' + name + '.png'));
    };
    await withLang(browser, async ({ cdp, lw, base }) => {
      if ((await lw.eval('uiLocale()')) !== lang) problems.push('背景程式用的是 ' + (await lw.eval('uiLocale()')));
      // 俄文 1、21 用 _one，2～4 用 _few，5～20 用 _many
      if (lang === 'ru') {
        const ru = JSON.parse(fs.readFileSync(path.join(extDir, '_locales', 'ru', 'messages.json'), 'utf8'));
        const want = [[1, 'one'], [2, 'few'], [5, 'many'], [21, 'one']].map(([n, form]) => ru['pop_account_count_' + form].message.replace(/\$1/g, n));
        const got = await lw.eval(`[1, 2, 5, 21].map((n) => tn('pop_account_count', n))`);
        if (JSON.stringify(got) !== JSON.stringify(want)) problems.push('俄文的數量寫法：' + JSON.stringify(got) + '，應該是 ' + JSON.stringify(want));
      }
      await lw.eval(`(async () => {
        await handlers['entries.save']({ entry: { host: '127.0.0.1', origin: ${JSON.stringify(ORIGIN)}, username: 'test-user@example.test', password: 'right' } }, ${fromOptions});
        await setSettings({ clickRules: [{ id: 'r1', host: '127.0.0.1', enabled: true, createdAt: 1, path: '/order', selector: '#nope', text: 'nope', when: 'onLoad' }] });
        await chrome.storage.local.set({ webauthn: { id: 'AAAA', alg: -7, publicKey: 'AAAA', transports: [], createdAt: 1 } });
        const s = await getSettings();
        await setSettings({ lock: { ...s.lock, enabled: true } });
        return true;
      })()`);
      // 按鈕文字是英文的測試頁：選取模式的卡片會顯示網頁上的按鈕文字，用中文的頁面會誤判成漏翻
      const target = await openPage(cdp, ORDER);
      await sleep(1500);

      // 小視窗：工具鎖定開著沒鎖，右上角才有「鎖定」。電腦閒置時背景程式會自己鎖上，打開前再解一次
      await lw.eval('setLocked(false)');
      const popup = await openPage(cdp, 'about:blank', POPUP_STUB);
      await popup.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 620, deviceScaleFactor: 1, mobile: false });
      await popup.goto(base + 'src/popup/popup.html', 1200);
      await look(popup, 'popup');

      // 解鎖視窗：第一次假裝按了取消，再按「再試一次」回到等驗證
      await lw.eval('setLocked(true)');
      const unlock = await openPage(cdp, 'about:blank', FAKE_HELLO_CANCEL_FIRST);
      await unlock.send('Emulation.setDeviceMetricsOverride', { width: 460, height: 268, deviceScaleFactor: 1, mobile: false });
      await unlock.goto(base + 'src/unlock/unlock.html', 1000);
      await look(unlock, 'unlock-failed');
      await unlock.click('#hello');
      await sleep(400);
      await look(unlock, 'unlock-waiting');

      // 管理頁：關掉工具鎖定，表格和版本紀錄才會畫出來
      await lw.eval(`(async () => {
        const s = await getSettings();
        await setSettings({ lock: { ...s.lock, enabled: false } });
        await setLocked(false);
        return true;
      })()`);
      const options = await openPage(cdp, 'about:blank');
      await options.send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 800, deviceScaleFactor: 1, mobile: false });
      await options.goto(base + 'src/options/options.html#settings', 1500);
      await look(options, 'options');

      // 網頁上的選取模式：提示和選好按鈕後的確認卡片
      const started = await lw.eval(`(async () => {
        const tabs = await chrome.tabs.query({});
        const tab = tabs.find((x) => x.url && x.url.startsWith(${JSON.stringify(ORDER)}));
        const res = tab && (await chrome.tabs.sendMessage(tab.id, { type: 'pickStart' }));
        return !!(res && res.ok);
      })()`);
      if (!started) problems.push('網頁進不了選取模式');
      await cdp.send('Target.activateTarget', { targetId: target.targetId });
      await target.send('Page.bringToFront');
      await sleep(400);
      await target.click('#a');
      await sleep(600);
      const shadow = (await target.shadowTexts()).filter((x) => bad.test(x));
      if (shadow.length) problems.push('網頁上的選取模式：' + JSON.stringify(shadow.slice(0, 15)));
      await target.screenshot(path.join(SHOTS, 'i18n-' + lang + '-pick.png'));

      // 網頁上的「要儲存這組密碼嗎？」：用還沒存過的帳號登入一次。英文、日文的按鈕比較寬，要截圖看排得下
      const login = await openPage(cdp, T + 'harness.html');
      await sleep(1500);
      await cdp.send('Target.activateTarget', { targetId: login.targetId });
      await login.send('Page.bringToFront');
      await login.eval(`(() => {
        for (const [id, value] of [['u', 'new-user@example.test'], ['p', 'not-a-real-one']]) {
          const box = document.getElementById(id);
          box.value = value;
          box.dispatchEvent(new Event('input', { bubbles: true }));
        }
        return true;
      })()`);
      await login.click('#login button');
      const banner = (await until(async () => {
        const texts = await login.shadowTexts();
        return texts.length ? texts : null;
      }, 6000)) || [];
      if (!banner.length) problems.push('登入後沒有問要不要儲存');
      const bannerBad = banner.filter((x) => bad.test(x));
      if (bannerBad.length) problems.push('要不要儲存：' + JSON.stringify(bannerBad.slice(0, 15)));
      await login.screenshot(path.join(SHOTS, 'i18n-' + lang + '-save.png'));
    }, { pick });
    check(problems.length === 0, problems.join(' / '));
  });
}

// ---- 介面語言：管理頁右上角的語言選單 ----

// 改語言選單，等管理頁重新整理好。重新整理前先在頁面上做記號，記號不見了才算整理完。
async function switchLanguage(page, language) {
  await page.eval(`(() => {
    window.__beforeSwitch = true;
    const select = document.getElementById('langSelect');
    select.value = ${JSON.stringify(language)};
    select.dispatchEvent(new Event('change'));
    return true;
  })()`);
  const done = await until(() => safeEval(page, `!window.__beforeSwitch && document.readyState === 'complete' && !!document.getElementById('langSelect')`), 8000);
  check(done, '換成 ' + language + ' 之後，管理頁要重新整理');
  await sleep(300);
}

const headerOf = (page) =>
  page.eval(`({ lang: document.documentElement.lang, title: document.querySelector('h1').textContent, picked: document.getElementById('langSelect').value })`);

test('語言：管理頁選日文，各畫面和背景程式都換成日文，選回跟著瀏覽器就恢復', async () => {
  await seedEntry('right');
  // 先開著一個網頁：換語言之後不用重新整理，網頁上的提示就要換
  const target = await open(ORDER, 800);
  const page = await open('chrome-extension://' + extId + '/src/options/options.html', 1200);
  try {
    check((await page.eval(`document.getElementById('langSelect').value`)) === 'auto', '預設要跟著瀏覽器');
    const autoText = await page.eval(`document.getElementById('langAuto').textContent`);
    check(autoText === '跟著瀏覽器（繁體中文）', '跟著瀏覽器要寫出目前是哪一種：' + autoText);
    await page.screenshot(path.join(SHOTS, 'lang-picker.png'));

    await switchLanguage(page, 'ja');
    const ja = await headerOf(page);
    check(ja.lang === 'ja' && ja.title === 'パスワードキーパー' && ja.picked === 'ja', '管理頁要換成日文：' + JSON.stringify(ja));
    await page.screenshot(path.join(SHOTS, 'lang-options-ja.png'));

    const err = await w.eval(`handlers['clickRules.add']({ rule: { host: '', path: '/x', selector: '#a', when: 'onLoad' } }).then(() => 'ok', (e) => e.message)`);
    check(err === 'サイトを入力してください', '背景程式的錯誤訊息要是日文：' + err);

    const popup = await openPage(b.cdp, 'about:blank', POPUP_STUB);
    await popup.goto('chrome-extension://' + extId + '/src/popup/popup.html', 1200);
    const pop = await popup.eval(`({ lang: document.documentElement.lang, add: document.getElementById('addBtn').textContent })`);
    check(pop.lang === 'ja' && /アカウント/.test(pop.add), '小視窗打開就要是日文：' + JSON.stringify(pop));
    await closePage(popup);

    await enableLock(true);
    const unlock = await openUnlock(FAKE_HELLO);
    const wait = await unlock.eval(`document.getElementById('waitTitle').textContent`);
    check(/認証/.test(wait), '解鎖視窗打開就要是日文：' + wait);
    await closePage(unlock);
    await w.eval('setLocked(false)');

    check((await startPick(ORDER)) === 'ok', '開著的網頁要進得了選取模式');
    await sleep(400);
    const hint = (await target.shadowTexts()).join(' ');
    check(/[぀-ヿ]/.test(hint) && !ZH_ONLY.test(hint), '開著的網頁不用重新整理，提示就要是日文：' + hint);
    await target.press('Escape', 'Escape', 27);

    await switchLanguage(page, 'auto');
    const back = await headerOf(page);
    check(back.lang === 'zh-Hant-TW' && back.title === '密碼小管家' && back.picked === 'auto', '選回跟著瀏覽器要恢復繁中：' + JSON.stringify(back));
    check((await w.eval('uiLocale()')) === 'zh_TW', '背景程式要回到繁中');
    check((await page.eval(`localStorage.getItem('pk.uiLanguage')`)) === null, '頁面先用的那份語言要清掉');
  } finally {
    // 沒過也要清掉，不然後面的案例畫面會是日文
    await w.eval(`chrome.storage.local.remove('uiLanguage').then(() => true)`);
    await safeEval(page, `(localStorage.removeItem('pk.uiLanguage'), true)`);
    await closePage(page);
    await closePage(target);
  }
});

test('語言：英文的瀏覽器也能選繁體中文', async () => {
  await withLang('en', async ({ cdp, lw, base }) => {
    const page = await openPage(cdp, 'about:blank');
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 800, deviceScaleFactor: 1, mobile: false });
    await page.goto(base + 'src/options/options.html', 1200);
    const auto = await page.eval(`document.getElementById('langAuto').textContent`);
    check(auto === 'Browser default (English)', '跟著瀏覽器要寫出目前是英文：' + auto);
    await page.screenshot(path.join(SHOTS, 'lang-picker-en.png'));
    await switchLanguage(page, 'zh_TW');
    const zh = await headerOf(page);
    check(zh.lang === 'zh-Hant-TW' && zh.title === '密碼小管家' && zh.picked === 'zh_TW', '英文瀏覽器選繁中要換成繁中：' + JSON.stringify(zh));
    check((await lw.eval('uiLocale()')) === 'zh_TW', '背景程式要換成繁中');
  });
});

// ---- 檢查新版：背景程式的 updateApi 換成本機的假 GitHub（ROUTES 的 /fake-gh/latest） ----

const FAKE_GH = ORIGIN + '/fake-gh/latest';
const GH_RELEASES = 'https://github.com/Mukula1221/PasswordKeeperExtension/releases/';
const useFakeGitHub = (url) => w.eval(`(useUpdateApi(${JSON.stringify(url)}), true)`);
const checkNow = () => w.eval(`handlers['update.check']()`);

test('檢查新版：開發版不自動問，按立即檢查才問；有新版時小視窗和管理頁都會提醒', async () => {
  const current = await w.eval('chrome.runtime.getManifest().version');
  let options = null;
  let popup = null;
  try {
    await useFakeGitHub(FAKE_GH + '?v=99.0.0');
    const before = hitCount('/fake-gh/');
    await w.eval('updateTick()');
    check(hitCount('/fake-gh/') === before, '開發版不該自動到 GitHub 問');

    const info = await checkNow();
    check(hitCount('/fake-gh/') === before + 1, '按立即檢查要問一次');
    check(info.available && info.latest.version === '99.0.0' && !info.release, '要看出有新版：' + JSON.stringify(info));
    check(info.latest.zipUrl === GH_RELEASES + 'download/v99.0.0/password-keeper-99.0.0.zip', '下載網址要是那一版的 zip：' + info.latest.zipUrl);
    check(info.latest.pageUrl === GH_RELEASES + 'tag/v99.0.0', '說明頁網址：' + info.latest.pageUrl);

    options = await open('chrome-extension://' + extId + '/src/options/options.html#versions', 1200);
    const view = await options.eval(`(() => {
      const shown = (id) => document.getElementById(id).checkVisibility();
      return {
        state: document.getElementById('updateState').textContent,
        download: shown('updateDownload'),
        extensions: shown('updateExtensions'),
        page: shown('updatePage'),
        steps: shown('updateSteps'),
        header: shown('headerUpdate'),
        dev: shown('updateDev'),
        autoDisabled: document.getElementById('updateAuto').disabled,
        autoShown: shown('updateAutoWrap'),
        summary: document.getElementById('updateSummary').textContent,
      };
    })()`);
    check(view.state.includes('99.0.0'), '要寫出新版的版本號：' + view.state);
    check(view.download && view.extensions && view.page && view.steps, '有新版時要有下載、管理頁、說明和步驟：' + JSON.stringify(view));
    check(view.header, '頁首要有「有新版」');
    check(view.dev && view.autoDisabled && !view.autoShown, '開發版要說明不會自動檢查，不顯示自動檢查的勾選框：' + JSON.stringify(view));
    check(view.summary.includes('99.0.0'), '標題旁邊要寫有新版：' + view.summary);
    await options.screenshot(path.join(SHOTS, 'update-available.png'));

    popup = await open('chrome-extension://' + extId + '/src/popup/popup.html', 1200);
    const bar = await popup.eval(`(() => { const b = document.getElementById('updateBar'); return b.checkVisibility() ? b.textContent : ''; })()`);
    check(bar.includes('99.0.0'), '小視窗要提醒有新版：' + bar);
    await closePage(popup);
    popup = null;

    // 一樣的版本：在管理頁按「立即檢查」，提醒要收掉
    await useFakeGitHub(FAKE_GH + '?v=' + current);
    await options.click('#updateCheckNow');
    const stateNow = () => options.eval(`document.getElementById('updateState').textContent`);
    check(await until(async () => (await stateNow()) === '已經是最新版', 4000), '一樣的版本要寫已經是最新版：' + (await stateNow()));
    const after = await options.eval(`(() => ({
      header: document.getElementById('headerUpdate').checkVisibility(),
      download: document.getElementById('updateDownload').checkVisibility(),
      checkedAt: document.getElementById('updateCheckedAt').textContent,
      button: document.getElementById('updateCheckNow').textContent,
    }))()`);
    check(!after.header && !after.download, '沒新版時不提醒、不給下載：' + JSON.stringify(after));
    check(after.checkedAt.startsWith('上次檢查：') && after.button === '立即檢查', '要寫上次檢查的時間，按鈕恢復：' + JSON.stringify(after));

    // 回傳的下載網址不是這個 repo 的：不給下載
    await useFakeGitHub(FAKE_GH + '?v=99.0.1&evil=1');
    const evil = await checkNow();
    check(evil.available && evil.latest.zipUrl === '' && evil.latest.pageUrl === '', '別的網站的網址不能收：' + JSON.stringify(evil.latest));
    const blocked = await w.eval(`handlers['update.download']().then(() => 'downloaded', (e) => e.message)`);
    check(blocked.includes('zip'), '沒有可以下載的 zip 要擋下來：' + blocked);

    // 還沒有發布過（GitHub 回 404）：不算錯
    await useFakeGitHub(ORIGIN + '/fake-gh/none');
    const none = await checkNow();
    check(!none.available && !none.error && none.latest === null, '還沒發布不算錯誤：' + JSON.stringify(none));

    // 連不上：寫錯誤，之前知道的新版留著
    await useFakeGitHub(FAKE_GH + '?v=99.0.0');
    await checkNow();
    await useFakeGitHub('http://127.0.0.1:1/');
    const offline = await checkNow();
    check(offline.error === '連不到 GitHub，檢查網路之後再試。', '連不上要寫原因：' + offline.error);
    check(offline.available && offline.latest.version === '99.0.0', '一時連不上不能把新版提醒弄掉');
  } finally {
    await w.eval(`(useUpdateApi(null), chrome.storage.local.remove('updateInfo').then(() => true))`);
    if (popup) await closePage(popup);
    if (options) await closePage(options);
  }
});

// ---- 三種版本：商店版由商店更新。從商店裝的測不到，把 management.getSelf 換成回 normal ----

test('商店版：不連 GitHub，版本分頁只寫由商店更新', async () => {
  const kind = await w.eval(`typeof (chrome.management && chrome.management.getSelf)`);
  check(kind === 'function', '沒要 management 權限也要叫得到 management.getSelf：' + kind);
  const dev = await w.eval(`handlers['update.status']().then((s) => s.channel)`);
  check(dev === 'dev', '載入原始碼資料夾的要算開發版：' + dev);
  let options = null;
  try {
    await w.eval(`(globalThis.__pkRealGetSelf = chrome.management.getSelf, chrome.management.getSelf = async () => ({ installType: 'normal' }), true)`);
    await useFakeGitHub(FAKE_GH + '?v=99.0.0');
    const before = hitCount('/fake-gh/');
    const blocked = await w.eval(`handlers['update.check']().then(() => 'checked', (e) => e.message)`);
    check(blocked === '從商店安裝的版本由商店更新，不會到 GitHub 檢查。', '商店版不能到 GitHub 檢查：' + blocked);
    await w.eval(`handlers['update.setAuto']({ enabled: true }).then(() => true)`);
    check(hitCount('/fake-gh/') === before, '商店版打開自動檢查也不能連 GitHub');

    options = await open('chrome-extension://' + extId + '/src/options/options.html#versions', 1200);
    const view = await options.eval(`(() => {
      const shown = (id) => document.getElementById(id).checkVisibility();
      return {
        state: document.getElementById('updateState').textContent,
        check: shown('updateCheckNow'),
        auto: shown('updateAutoWrap'),
        dev: shown('updateDev'),
        hintHidden: document.getElementById('browserHint').hidden,
        versionNow: document.getElementById('versionNow').textContent,
        summary: document.getElementById('updateSummary').textContent,
      };
    })()`);
    check(view.state === '商店會自動更新。', '要寫由商店更新：' + view.state);
    check(view.summary.startsWith('商店版 v'), '標題旁邊要寫是商店版：' + view.summary);
    check(view.versionNow === '目前版本 ' + (await w.eval('chrome.runtime.getManifest().version')) + '。', '目前版本那一行不提重新載入：' + view.versionNow);
    check(!view.check && !view.auto && !view.dev && view.hintHidden, '檢查新版的按鈕、勾選框、開發版說明、重新載入說明都不顯示：' + JSON.stringify(view));
    await options.screenshot(path.join(SHOTS, 'update-store.png'));
  } finally {
    await w.eval(`(chrome.management.getSelf = globalThis.__pkRealGetSelf, useUpdateApi(null), chrome.storage.local.remove('updateInfo').then(() => true))`);
    if (options) await closePage(options);
  }
});

// ---- 網站存取權：使用者在瀏覽器收回網站權限時，小視窗提示要權限 ----

test('網站存取權：被收回時小視窗提示，按了只要這個網站的權限', async () => {
  const target = await open(T + 'harness.html', 800);
  // 小視窗用分頁開，「目前的分頁」改成測試網站那一頁
  const asPopup = `const q = chrome.tabs.query.bind(chrome.tabs);
    chrome.tabs.query = async (info) => (info && info.active && info.currentWindow ? q({ url: '*://127.0.0.1/*' }) : q(info));
    window.close = () => {};`;
  let popup = null;
  try {
    // 真的權限：安裝時就給了所有網站，不該提示。也確認不帶連接埠的網址規則瀏覽器收。
    popup = await openPage(b.cdp, 'about:blank', `{ ${asPopup} }`);
    await popup.goto('chrome-extension://' + extId + '/src/popup/popup.html', 1200);
    const site = await popup.eval(`document.getElementById('site').textContent`);
    check(site === '127.0.0.1', '小視窗要對到測試網站：' + site);
    const real = await popup.eval(`chrome.permissions.contains({ origins: ['http://127.0.0.1/*'] })`);
    check(real === true, '安裝時給的權限要包含測試網站');
    check(!(await popup.eval(`document.getElementById('accessBar').checkVisibility()`)), '有權限不該提示');
    await closePage(popup);

    const revoked = `{ ${asPopup}
      window.__pkRequests = [];
      chrome.permissions.contains = async () => false;
      chrome.permissions.request = async (p) => (window.__pkRequests.push(p), true);
    }`;
    popup = await openPage(b.cdp, 'about:blank', revoked);
    await popup.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 480, deviceScaleFactor: 1, mobile: false });
    await popup.goto('chrome-extension://' + extId + '/src/popup/popup.html', 1200);
    const bar = await popup.eval(`(() => { const b = document.getElementById('accessBar'); return b.checkVisibility() ? b.textContent : ''; })()`);
    check(bar === '密碼小管家不能在這個網站填入和儲存密碼，點這裡允許。', '沒權限要提示：' + bar);
    await popup.screenshot(path.join(SHOTS, 'popup-site-access.png'));
    await popup.click('#accessBar');
    const asked = await until(() => popup.eval(`window.__pkRequests.length ? JSON.stringify(window.__pkRequests) : ''`), 3000);
    check(asked === JSON.stringify([{ origins: ['http://127.0.0.1/*'] }]), '只要這個網站、不帶連接埠：' + asked);
    const after = await popup.eval(`({ bar: document.getElementById('accessBar').checkVisibility(), toast: document.getElementById('toast').textContent })`);
    check(!after.bar && after.toast === '已允許，重新整理網頁後就能用。', '允許後收掉提示、說要重新整理：' + JSON.stringify(after));
  } finally {
    if (popup) await closePage(popup);
    await closePage(target);
  }
});

// ---- 跑 ----

// 只有這份腳本用得到的頁面
const ROUTES = {
  // 登入表單包在看不見的外框裡。mode：normal 看得見、opacity 全透明、faint 幾乎透明、offscreen 移到畫面外、fade 0.6 秒後淡入
  '/hidden-login': (url) => {
    const mode = url.searchParams.get('mode');
    const style = { normal: '', opacity: 'opacity: 0', faint: 'opacity: 0.05', offscreen: 'position: absolute; left: -9999px; top: 0', fade: 'opacity: 0; transition: opacity 0.3s' }[mode];
    return `<!doctype html><meta charset="utf-8"><title>hidden</title>
<div id="w" style="${style}">
  <form><input id="u" name="username" autocomplete="username"><input id="p" name="password" type="password" autocomplete="current-password"><button>登入</button></form>
</div>
${mode === 'fade' ? `<script>setTimeout(() => { document.getElementById('w').style.opacity = '1'; }, 600);</script>` : ''}`;
  },
  // ?sandbox 的 iframe 有 sandbox 屬性，來源變成 null；?plain 是一般的同網站 iframe。iframe 裡的欄位值用 postMessage 傳出來
  '/sandbox-wrap': (url) =>
    `<!doctype html><meta charset="utf-8"><title>sandbox</title>
<script>window.__got = null; addEventListener('message', (e) => { window.__got = e.data; });</script>
<iframe id="f" width="600" height="300" ${url.searchParams.has('sandbox') ? 'sandbox="allow-scripts allow-forms"' : ''} src="/sandbox-login"></iframe>`,
  '/sandbox-login': () => `<!doctype html><meta charset="utf-8"><title>sandbox login</title>
<form><input id="u" name="username" autocomplete="username"><input id="p" name="password" type="password" autocomplete="current-password"><button>登入</button></form>
<script>setInterval(() => parent.postMessage({ u: document.getElementById('u').value, p: document.getElementById('p').value }, '*'), 300);</script>`,
  // 假的 GitHub /releases/latest。?v= 是版本號，?evil=1 的網址指到別的網站
  '/fake-gh/latest': (url) => {
    const v = url.searchParams.get('v');
    const base = url.searchParams.has('evil') ? 'https://evil.example/' : GH_RELEASES;
    return JSON.stringify({
      tag_name: 'v' + v,
      html_url: base + 'tag/v' + v,
      published_at: '2026-11-07T04:00:00Z',
      assets: [
        { name: 'password-keeper-' + v + '.zip.sha256', browser_download_url: base + 'download/v' + v + '/password-keeper-' + v + '.zip.sha256' },
        { name: 'password-keeper-' + v + '.zip', browser_download_url: base + 'download/v' + v + '/password-keeper-' + v + '.zip' },
      ],
    });
  },
  // 點過的按鈕記在 sessionStorage，頁面重新載入後還在。
  // ?hide=a 那顆不出現；?late=a&ms=2000 那顆晚一點才出現；?reload=a 點了整頁重新載入，之後那顆就不見了；?form=毫秒 晚一點才出現登入表單
  '/order': () => `<!doctype html><meta charset="utf-8"><title>order</title><div id="app"></div>
<script>
  const q = new URLSearchParams(location.search);
  const app = document.getElementById('app');
  window.__clicks = () => JSON.parse(sessionStorage.clicks || '[]');
  function add(name, parent) {
    const btn = document.createElement('button');
    btn.id = name;
    btn.type = 'button';
    btn.textContent = name;
    btn.addEventListener('click', () => {
      sessionStorage.clicks = JSON.stringify([...window.__clicks(), name]);
      if (q.get('reload') !== name) return;
      sessionStorage.gone = name;
      location.reload();
    });
    parent.appendChild(btn);
  }
  for (const name of ['a', 'b', 'c']) {
    if (q.get('hide') === name || sessionStorage.gone === name) continue;
    if (q.get('late') === name) setTimeout(() => add(name, app), Number(q.get('ms')));
    else add(name, app);
  }
  if (q.has('form')) {
    setTimeout(() => {
      const form = document.createElement('form');
      form.innerHTML = '<input id="u" name="username" type="text"><input id="p" name="password" type="password">';
      add('go', form);
      app.appendChild(form);
    }, Number(q.get('form')));
  }
</script>`,
  '/wrap': (url) => '<!doctype html><meta charset="utf-8"><h1>外框頁</h1><iframe id="f" width="700" height="400" src="' + url.searchParams.get('src') + '"></iframe>',
  '/dup': (url) => `<!doctype html><meta charset="utf-8"><title>dup</title>
<script>function hit(el) { window.__clicked = el.textContent.trim(); }</script>
<style>.item { padding: 6px 16px; margin: 6px; background: #eef; cursor: pointer; width: 200px; }</style>
${url.searchParams.has('shift') ? '<div class="item" onclick="hit(this)">A0</div>' : ''}
<div class="item" onclick="hit(this)">A</div>
<div class="item" onclick="hit(this)">B</div>
<div class="item" onclick="hit(this)">C</div>`,
  '/spa': () => `<!doctype html><meta charset="utf-8"><title>spa</title><div id="app"></div>
<script>
  function render() {
    const app = document.getElementById('app');
    if (location.hash === '#/login') {
      app.innerHTML = '<button id="ssoBtn">SSO</button>';
      document.getElementById('ssoBtn').addEventListener('click', () => { window.__clicked = true; });
    } else {
      app.innerHTML = '<p>home</p>';
    }
  }
  window.addEventListener('hashchange', render);
  render();
</script>`,
  '/twins': () => `<!doctype html><meta charset="utf-8"><title>twins</title>
<script>window.__clicks = 0;</script>
<button onclick="window.__clicks++">送出</button>
<button onclick="window.__clicks++">送出</button>`,
};

(async () => {
  browserPath = findBrowser(process.argv[2] || 'edge');
  const only = process.argv[3] || '';
  extDir = copyExtension();
  // 剪貼簿的權限是選用的，要使用者在瀏覽器的對話框按允許，e2e 按不到，所以測試用的複本直接給
  const manifestFile = path.join(extDir, 'manifest.json');
  const testManifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  testManifest.permissions = [...testManifest.permissions, ...(testManifest.optional_permissions || [])];
  fs.writeFileSync(manifestFile, JSON.stringify(testManifest, null, 2));
  const srv = await startServer(PORT, ROUTES);
  hits = srv.hits;
  b = await launch(browserPath, extDir);
  const sw = await findServiceWorker(b.cdp);
  if (!sw) throw new Error('擴充功能沒裝起來');
  extId = sw.url.split('/')[2];
  w = await attachWorker(b.cdp, sw);
  await until(() => w.eval("typeof handlers === 'object' && typeof chrome === 'object'"), 10000);
  console.log('版本', await w.eval('chrome.runtime.getManifest().version'), path.basename(browserPath));
  for (const c of cases) {
    if (only && !c.name.includes(only)) continue;
    await reset();
    w.console.length = 0;
    const started = Date.now();
    try {
      await c.fn();
      results.push({ name: c.name, ok: true });
      console.log('PASS', c.name, '(' + (Date.now() - started) + 'ms)');
    } catch (err) {
      results.push({ name: c.name, ok: false, err: err.message });
      console.log('FAIL', c.name, '=>', err.message);
    }
    for (const line of w.console) console.log('  背景程式', line.split('\n')[0]);
    // 清掉這個案例留下的分頁
    const { targetInfos } = await b.cdp.send('Target.getTargets');
    for (const t of targetInfos) {
      if (t.type === 'page' && !t.url.startsWith('about:blank')) await b.cdp.send('Target.closeTarget', { targetId: t.targetId }).catch(() => {});
    }
  }
  const failed = results.filter((r) => !r.ok);
  console.log('結果：' + (results.length - failed.length) + ' 過、' + failed.length + ' 沒過，共 ' + results.length);
  console.log('截圖在 ' + SHOTS);
  await b.close();
  srv.server.close();
  process.exit(failed.length ? 1 : 0);
})().catch(async (err) => {
  console.error('跑不起來：', err);
  if (b) await b.close();
  process.exit(2);
});
