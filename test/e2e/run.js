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
    await chrome.storage.local.remove(['vault', 'settings', 'webauthn', 'uiLanguage', 'updateInfo']);
    await chrome.storage.session.clear();
    return true;
  })()`);

const seedEntry = (password = 'right', host = '127.0.0.1') =>
  w.eval(`handlers['entries.save']({ entry: { host: ${JSON.stringify(host)}, origin: ${JSON.stringify('http://' + host + ':' + PORT)}, username: 'test-user@example.test', password: ${JSON.stringify(password)} } }).then(() => true)`);

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
    const sender = { tab: { id: 9001 } };
    await handlers['clickRules.pause']({ host: 'jira.example.com.tw' }, sender);
    return {
      sameBase: await handlers['clickRules.claim']({ key: 'a', host: 'sso.example.com.tw' }, sender),
      otherBase: await handlers['clickRules.claim']({ key: 'b', host: 'other.example.com' }, sender),
      otherTab: await handlers['clickRules.claim']({ key: 'c', host: 'sso.example.com.tw' }, { tab: { id: 9002 } }),
      again: await handlers['clickRules.claim']({ key: 'b', host: 'other.example.com' }, sender),
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
        await dispatch({ type, id: 'rule-0', patch: { enabled: false }, rule: { host: 'a.com', path: '/', selector: '#x' } }, {});
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
      await handlers['entries.save']({ entry: { host, origin: 'https://' + host, username: 'test-user', password: 'not-a-real-one' } });
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
      await handlers['entries.save']({ entry: { host, origin: 'https://' + host, username: 'test-user', password: 'not-a-real-one' } });
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
    const sender = { tab: { id: 9100 } };
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
    await handlers['clickRules.save']({ rule: { host: '127.0.0.1', path: '/order', selector: '#a', text: 'a', when: 'onLoad' } });
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
  await w.eval(`handlers['clickRules.save']({ rule: { host: 'b.example.test', path: '/new', selector: '#n', text: 'N', when: 'onLoad' } })`);
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
  // 測試沒辦法叫 Windows Hello，直接當作驗證過
  const unlock = async () => {
    await w.eval('setLocked(false)');
    await page.eval('pageVerified = true; load()');
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
  check((await page.eval(`document.getElementById('lockState').textContent`)) === '已啟用', '開了要顯示已啟用');
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

// ---- 多國語系：另外開英文、日文介面的瀏覽器 ----

// 同一個擴充功能、同一個測試伺服器，只換瀏覽器的介面語言。用完就關。
async function withLang(lang, fn) {
  const lb = await launch(browserPath, extDir, { lang });
  try {
    const sw = await findServiceWorker(lb.cdp);
    if (!sw) throw new Error(lang + ' 的瀏覽器沒裝起來擴充功能');
    const lw = await attachWorker(lb.cdp, sw);
    await until(() => lw.eval("typeof handlers === 'object'"), 10000);
    await fn({ cdp: lb.cdp, lw, base: 'chrome-extension://' + sw.url.split('/')[2] + '/' });
  } finally {
    await lb.close();
  }
}

// 日文本來就有漢字，改找只有繁體中文才用的字，出現了就是漏翻
const ZH_ONLY = /[這們嗎沒說點會關號讓從與對傳檔實擇麼幫啟稱單錄數據變顯腦碼]/;
const HAN = /[㐀-鿿]/;

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

for (const lang of ['en', 'ja']) {
  test('多國語系：' + lang + ' 介面沒有漏翻的中文', async () => {
    const bad = lang === 'ja' ? ZH_ONLY : HAN;
    const problems = [];
    const look = async (page, name) => {
      const r = await scanPage(page, bad);
      if (r.lang !== lang) problems.push(name + ' 的 lang 是 ' + r.lang);
      if (r.words.length) problems.push(name + '：' + JSON.stringify(r.words));
      await page.screenshot(path.join(SHOTS, 'i18n-' + lang + '-' + name + '.png'));
    };
    await withLang(lang, async ({ cdp, lw, base }) => {
      await lw.eval(`(async () => {
        await handlers['entries.save']({ entry: { host: '127.0.0.1', origin: ${JSON.stringify(ORIGIN)}, username: 'test-user@example.test', password: 'right' } });
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
    });
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
const useFakeGitHub = (url) => w.eval(`(updateApi = ${JSON.stringify(url)}, true)`);
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
      };
    })()`);
    check(view.state.includes('99.0.0'), '要寫出新版的版本號：' + view.state);
    check(view.download && view.extensions && view.page && view.steps, '有新版時要有下載、管理頁、說明和步驟：' + JSON.stringify(view));
    check(view.header, '頁首要有「有新版」');
    check(view.dev && view.autoDisabled, '開發版要說明不會自動檢查，自動檢查的勾選框不能按：' + JSON.stringify(view));
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
    check(await until(async () => (await stateNow()) === '已經是最新版。', 4000), '一樣的版本要寫已經是最新版：' + (await stateNow()));
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
    await w.eval(`(updateApi = 'https://api.github.com/repos/' + UPDATE_REPO + '/releases/latest', chrome.storage.local.remove('updateInfo').then(() => true))`);
    if (popup) await closePage(popup);
    if (options) await closePage(options);
  }
});

// ---- 跑 ----

// 只有這份腳本用得到的頁面
const ROUTES = {
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
