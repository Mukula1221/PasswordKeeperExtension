// Firefox 用的測試工具：開一個拋棄式的 Firefox，用 WebDriver BiDi（新一代的瀏覽器控制標準）操作。
// Firefox 已經拿掉 CDP，Edge、Chrome 用的 lib.js 那一套在這裡不能用。只用 Node 內建的 WebSocket，不用裝套件。
// Firefox 設定檔放系統暫存資料夾、跑完就刪，不會動到平常用的設定。
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { sleep, WORK } = require('./lib');

class Bidi {
  constructor(ws) {
    this.ws = ws;
    this.next = 1;
    this.pending = new Map();
    this.listeners = [];
    ws.addEventListener('message', (e) => this.receive(JSON.parse(e.data)));
    ws.addEventListener('close', () => this.failAll(new Error('跟 Firefox 的連線斷了')));
  }
  receive(m) {
    if (m.id != null && this.pending.has(m.id)) {
      const { resolve, reject, method } = this.pending.get(m.id);
      this.pending.delete(m.id);
      if (m.type === 'error') reject(new Error(method + ' 失敗：' + m.error + ' ' + m.message));
      else resolve(m.result);
    } else if (m.type === 'event') {
      for (const fn of this.listeners) fn(m);
    }
  }
  send(method, params = {}) {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  on(fn) {
    this.listeners.push(fn);
  }
  failAll(err) {
    for (const { reject } of this.pending.values()) reject(err);
    this.pending.clear();
  }
}

// Firefox 一開始還沒開好連接埠，連不上就再試
async function connect(url, timeoutMs) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    try {
      const ws = new WebSocket(url);
      await new Promise((resolve, reject) => {
        ws.addEventListener('open', resolve, { once: true });
        ws.addEventListener('error', () => reject(new Error('連不上 ' + url)), { once: true });
      });
      return ws;
    } catch (err) {
      last = err;
      await sleep(300);
    }
  }
  throw last;
}

// prefs 寫進設定檔的 user.js，Firefox 啟動時讀。files 是要先放進設定檔資料夾的其他檔案，{ 檔名: 內容 }。
async function launchFirefox(firefoxPath, { port, prefs = {}, files = {} }) {
  const profile = path.join(WORK, 'ff-profile-' + Date.now());
  fs.mkdirSync(profile, { recursive: true });
  const lines = Object.entries(prefs).map(([k, v]) => 'user_pref(' + JSON.stringify(k) + ', ' + JSON.stringify(v) + ');');
  fs.writeFileSync(path.join(profile, 'user.js'), lines.join('\n') + '\n');
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(profile, name), content);
  // MOZ_REMOTE_ALLOW_SYSTEM_ACCESS：BiDi 預設不准開 moz-extension:// 的頁面，測試要開管理頁和小視窗
  const proc = spawn(firefoxPath, ['--remote-debugging-port', String(port), '--profile', profile, '--no-remote', '--new-instance', '--headless', 'about:blank'], {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: '1' },
  });
  const stderr = [];
  proc.stderr.on('data', (d) => stderr.push(String(d)));
  let ws;
  try {
    ws = await connect('ws://127.0.0.1:' + port + '/session', 30000);
  } catch (err) {
    proc.kill();
    throw new Error(err.message + '。Firefox 的輸出：' + stderr.join('').slice(-800));
  }
  const bidi = new Bidi(ws);
  await bidi.send('session.new', { capabilities: {} });
  return {
    bidi,
    profile,
    async close() {
      await bidi.send('browser.close').catch(() => {
        // Firefox 關掉時這個呼叫本來就可能等不到回覆，不用理
      });
      await Promise.race([new Promise((r) => proc.once('exit', r)), sleep(5000)]);
      if (proc.exitCode == null) proc.kill();
      // Windows 要等 Firefox 放開檔案才刪得掉
      await sleep(800);
      fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    },
  };
}

// 一個分頁。eval 的結果用 JSON 傳回來，只能回傳 JSON 表示得出來的值。
class Tab {
  constructor(bidi, context) {
    this.bidi = bidi;
    this.context = context;
  }
  async goto(url, waitMs = 0) {
    await this.bidi.send('browsingContext.navigate', { context: this.context, url, wait: 'complete' });
    if (waitMs) await sleep(waitMs);
  }
  async eval(expression) {
    const r = await this.bidi.send('script.evaluate', {
      expression: '(async () => JSON.stringify(await (' + expression + ')))()',
      target: { context: this.context },
      awaitPromise: true,
    });
    if (r.type === 'exception') throw new Error('eval 失敗：' + r.exceptionDetails.text);
    const v = r.result.value;
    return v === undefined ? undefined : JSON.parse(v);
  }
  async screenshot(file) {
    const { data } = await this.bidi.send('browsingContext.captureScreenshot', { context: this.context });
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
  }
  async close() {
    await this.bidi.send('browsingContext.close', { context: this.context }).catch(() => {
      // 分頁可能已經被頁面自己關掉，不用理
    });
  }
}

async function openTab(bidi, url, waitMs) {
  const { context } = await bidi.send('browsingContext.create', { type: 'tab' });
  const tab = new Tab(bidi, context);
  if (url) await tab.goto(url, waitMs);
  return tab;
}

module.exports = { launchFirefox, openTab };
