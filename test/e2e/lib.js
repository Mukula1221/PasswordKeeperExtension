// test/e2e 共用的工具：開一個拋棄式的瀏覽器，把擴充功能裝進去，用 CDP（瀏覽器的除錯協定）操作。
// 假 chrome API（shim.js）跑在網頁的主環境，測不到 content script 隔離環境才有的問題，例如 CSP 擋 javascript: 連結。
// 只用 Node 內建的東西。瀏覽器設定檔放系統暫存資料夾、跑完就刪，不會動到平常用的設定。
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const PACKAGE_FILES = require('../../tools/files');

const ROOT = path.join(__dirname, '..', '..');
const WORK = path.join(os.tmpdir(), 'pk-e2e');

const BROWSER_PATHS = {
  edge: ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'],
  chrome: ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'],
};

function findBrowser(nameOrPath) {
  const found = (BROWSER_PATHS[nameOrPath] || [nameOrPath]).find((p) => fs.existsSync(p));
  if (!found) throw new Error('找不到瀏覽器：' + nameOrPath + '。可以直接給執行檔的完整路徑');
  return found;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// 複製到暫存資料夾再載入，不讓瀏覽器直接開雲端硬碟裡的檔案。
// 只帶 tools/files.js 列的檔案，跟正式版 zip 裡的一樣，漏列的檔案在測試就會出問題。
function copyExtension() {
  const dest = path.join(WORK, 'ext');
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  for (const name of PACKAGE_FILES) {
    fs.cpSync(path.join(ROOT, name), path.join(dest, name), { recursive: true });
  }
  return dest;
}

// 測試頁原本會載假的 chrome API 和整份擴充功能，裝真的擴充功能測的時候要拿掉，不然會有兩份 content.js 一起跑
function startServer(port, routes = {}) {
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css' };
  const hits = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    hits.push(req.url);
    if (routes[url.pathname]) {
      res.writeHead(200, { 'Content-Type': types['.html'], 'Cache-Control': 'no-store' });
      return res.end(routes[url.pathname](url));
    }
    const file = path.join(ROOT, url.pathname);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404);
      return res.end('not found');
    }
    let body = fs.readFileSync(file);
    if (file.endsWith('.html')) {
      body = body.toString('utf8').replace(/<script src="(shim\.js|\.\.\/src\/background\/crypto\.js|\.\.\/src\/background\/background\.js|\.\.\/src\/content\/content\.js)"><\/script>\s*/g, '');
    }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(body);
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ server, hits })));
}

// 用 pipe 連線，訊息是以 NUL 結尾的 JSON。Chrome 正式版不收 --load-extension，只能在 pipe 模式用 Extensions.loadUnpacked 裝擴充功能。
class Cdp {
  constructor(input, output) {
    this.input = input;
    this.next = 1;
    this.pending = new Map();
    this.listeners = [];
    let buf = '';
    // 中文可能被切在兩段資料中間，setEncoding 才接得回來
    output.setEncoding('utf8');
    output.on('data', (chunk) => {
      buf += chunk;
      let end;
      while ((end = buf.indexOf('\0')) >= 0) {
        this.receive(JSON.parse(buf.slice(0, end)));
        buf = buf.slice(end + 1);
      }
    });
    input.on('error', (err) => this.failAll(err));
  }
  receive(m) {
    if (m.id && this.pending.has(m.id)) {
      const { resolve, reject } = this.pending.get(m.id);
      this.pending.delete(m.id);
      if (m.error) reject(new Error(m.error.message + ' (' + JSON.stringify(m.error) + ')'));
      else resolve(m.result);
    } else {
      for (const fn of this.listeners) fn(m);
    }
  }
  send(method, params = {}, sessionId) {
    const id = this.next++;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.input.write(JSON.stringify(msg) + '\0');
    });
  }
  on(fn) {
    this.listeners.push(fn);
  }
  // 瀏覽器中途結束時，還在等回覆的呼叫要失敗，不然腳本會一直卡著
  failAll(err) {
    for (const { reject } of this.pending.values()) reject(err);
    this.pending.clear();
  }
}

// lang 是瀏覽器的介面語言，擴充功能的文字跟著它。預設繁體中文，測試檢查的中文字才對得上，在英文系統上跑也一樣。
async function launch(browserPath, extDir, { lang = 'zh-TW' } = {}) {
  const profile = path.join(WORK, 'profile-' + Date.now());
  fs.mkdirSync(profile, { recursive: true });
  const proc = spawn(
    browserPath,
    [
      '--remote-debugging-pipe',
      '--enable-unsafe-extension-debugging',
      '--user-data-dir=' + profile,
      '--lang=' + lang,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-sync',
      '--window-size=1280,900',
      '--headless=new',
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] }
  );
  const cdp = new Cdp(proc.stdio[3], proc.stdio[4]);
  proc.on('exit', (code) => cdp.failAll(new Error('瀏覽器結束了，結束代碼 ' + code)));
  await cdp.send('Extensions.loadUnpacked', { path: extDir });
  await cdp.send('Target.setDiscoverTargets', { discover: true });
  return {
    cdp,
    async close() {
      cdp.send('Browser.close').catch(() => {
        // 瀏覽器關掉時這個呼叫本來就可能等不到回覆，不用理
      });
      await Promise.race([new Promise((r) => proc.once('exit', r)), sleep(3000)]);
      if (proc.exitCode == null) proc.kill();
      // Windows 要等瀏覽器放開檔案才刪得掉
      await sleep(500);
      fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    },
  };
}

async function findServiceWorker(cdp, timeoutMs = 15000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const { targetInfos } = await cdp.send('Target.getTargets');
    const sw = targetInfos.find((t) => t.type === 'service_worker' && t.url.includes('background.js'));
    if (sw) return sw;
    await sleep(300);
  }
  return null;
}

// 一個分頁或跨網站 iframe 的操作
class Page {
  constructor(cdp, targetId, sessionId) {
    this.cdp = cdp;
    this.targetId = targetId;
    this.sessionId = sessionId;
    this.console = [];
    this.dialogs = [];
    cdp.on((m) => {
      if (m.sessionId !== sessionId) return;
      if (m.method === 'Runtime.consoleAPICalled') {
        this.console.push(m.params.type + ': ' + m.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
      }
      if (m.method === 'Runtime.exceptionThrown') {
        this.console.push('exception: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
      }
      if (m.method === 'Log.entryAdded') {
        this.console.push('log.' + m.params.entry.level + ': ' + m.params.entry.text);
      }
      if (m.method === 'Page.javascriptDialogOpening') {
        this.dialogs.push(m.params.message);
        cdp.send('Page.handleJavaScriptDialog', { accept: true }, sessionId).catch(() => {
          // 對話框可能已經跟著頁面一起關了，不用理
        });
      }
    });
  }
  send(method, params) {
    return this.cdp.send(method, params, this.sessionId);
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error('eval 失敗：' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result.value;
  }
  async goto(url, waitMs = 0) {
    await this.send('Page.navigate', { url });
    if (waitMs) await sleep(waitMs);
  }
  url() {
    return this.eval('location.href');
  }
  async mouse(type, x, y, extra = {}) {
    await this.send('Input.dispatchMouseEvent', { type, x, y, ...extra });
  }
  async moveTo(x, y) {
    await this.mouse('mouseMoved', x, y);
  }
  // 從這裡發的滑鼠事件 isTrusted 是 true，跟真人按的一樣。選取模式只認這種。
  async clickAt(x, y) {
    await this.mouse('mouseMoved', x, y);
    await sleep(60);
    await this.mouse('mousePressed', x, y, { button: 'left', buttons: 1, clickCount: 1 });
    await sleep(40);
    await this.mouse('mouseReleased', x, y, { button: 'left', buttons: 0, clickCount: 1 });
  }
  async centerOf(selector) {
    const r = await this.eval(
      '(()=>{const e=document.querySelector(' + JSON.stringify(selector) + ');if(!e)return null;const r=e.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2,w:r.width,h:r.height};})()'
    );
    if (!r) throw new Error('找不到 ' + selector);
    return r;
  }
  async click(selector) {
    const c = await this.centerOf(selector);
    await this.clickAt(c.x, c.y);
  }
  async press(key, code, vk) {
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
  }
  // 小管家的畫面在 closed shadow DOM 裡，網頁的程式碰不到，要用 CDP 的 pierce 才看得到
  async shadowNodes() {
    const { root } = await this.send('DOM.getDocument', { depth: -1, pierce: true });
    const out = [];
    const textOf = (n) => (n.nodeType === 3 ? n.nodeValue : (n.children || []).map(textOf).join(''));
    const walk = (n, inShadow) => {
      if (inShadow && n.nodeType === 1) out.push({ nodeId: n.nodeId, name: n.nodeName, attrs: n.attributes || [], text: textOf(n) });
      for (const c of n.children || []) walk(c, inShadow);
      // 瀏覽器內建的 shadow（輸入框內部）不算，裡面有欄位的值
      for (const s of n.shadowRoots || []) if (s.shadowRootType !== 'user-agent') walk(s, true);
      if (n.contentDocument) walk(n.contentDocument, inShadow);
    };
    walk(root, false);
    return out;
  }
  async shadowTexts() {
    return (await this.shadowNodes()).filter((n) => /^(DIV|H2|SPAN|LABEL|BUTTON)$/.test(n.name)).map((n) => n.text.trim()).filter(Boolean);
  }
  async toastText() {
    const nodes = await this.shadowNodes();
    const hit = nodes.filter((n) => {
      const i = n.attrs.indexOf('class');
      return i >= 0 && n.attrs[i + 1] === 'toast';
    });
    return hit.length ? hit[hit.length - 1].text : '';
  }
  async clickShadow(text, name = 'BUTTON') {
    const nodes = await this.shadowNodes();
    const hit = nodes.find((n) => n.name === name && n.text.trim() === text);
    if (!hit) throw new Error('shadow 裡找不到 ' + text + '，現有：' + JSON.stringify(nodes.map((n) => n.text.trim()).filter(Boolean).slice(0, 20)));
    const { model } = await this.send('DOM.getBoxModel', { nodeId: hit.nodeId });
    const q = model.content;
    await this.clickAt((q[0] + q[2]) / 2, (q[1] + q[5]) / 2);
  }
  async screenshot(file) {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
  }
}

// 跨網站的 iframe 跑在別的行程，要另外接上去
async function attachFrame(cdp, urlPart) {
  const { targetInfos } = await cdp.send('Target.getTargets');
  const t = targetInfos.find((x) => x.type === 'iframe' && x.url.includes(urlPart));
  if (!t) throw new Error('找不到 iframe ' + urlPart + '，現有：' + JSON.stringify(targetInfos.map((x) => x.type + ' ' + x.url)));
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
  const page = new Page(cdp, t.targetId, sessionId);
  await page.send('Runtime.enable');
  await page.send('DOM.enable');
  return page;
}

async function openPage(cdp, url = 'about:blank', extraInit) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const page = new Page(cdp, targetId, sessionId);
  await page.send('Page.enable');
  await page.send('Runtime.enable');
  await page.send('Log.enable');
  await page.send('DOM.enable');
  if (extraInit) await page.send('Page.addScriptToEvaluateOnNewDocument', { source: extraInit });
  if (url !== 'about:blank') await page.goto(url);
  return page;
}

// 接到背景程式上。background.js 最外層的函式和變數（像 handlers）都叫得到。
async function attachWorker(cdp, sw) {
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: sw.targetId, flatten: true });
  // 背景程式印的 error/warn 和沒接住的例外，就是 chrome://extensions「錯誤」按鈕會列出來的東西
  const logs = [];
  cdp.on((m) => {
    if (m.sessionId !== sessionId) return;
    if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'warning')) {
      logs.push(m.params.type + ': ' + m.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
    }
    if (m.method === 'Runtime.exceptionThrown') {
      logs.push('exception: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
    }
  });
  await cdp.send('Runtime.enable', {}, sessionId);
  return {
    console: logs,
    async eval(expression) {
      const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
      if (r.exceptionDetails) throw new Error('背景程式 eval 失敗：' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
      return r.result.value;
    },
  };
}

module.exports = { findBrowser, copyExtension, startServer, launch, findServiceWorker, openPage, attachFrame, attachWorker, sleep, WORK };
