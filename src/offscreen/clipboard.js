'use strict';
// Edge、Chrome 的背景程式不能碰剪貼簿，由這個看不到的頁面（offscreen document）代為比對和清除，見 background/clipboard.js。
// 只回答「有沒有清」，不把剪貼簿的內容傳出去。
(() => {
  async function sha256(text) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(text)));
    return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
  }

  // 這個頁面沒有焦點，navigator.clipboard 讀不到，改用 execCommand 貼進輸入框再讀出來
  function readClipboard() {
    const box = document.getElementById('box');
    box.value = '';
    box.focus();
    document.execCommand('paste');
    const text = box.value;
    box.value = '';
    return text;
  }

  // 沒選到文字時 execCommand('copy') 不會動剪貼簿，所以在 copy 事件裡把內容換成空字串
  function clearClipboard() {
    const onCopy = (e) => {
      e.clipboardData.setData('text/plain', '');
      e.preventDefault();
    };
    document.addEventListener('copy', onCopy);
    try {
      document.execCommand('copy');
    } finally {
      document.removeEventListener('copy', onCopy);
    }
  }

  // 背景程式送來的才理。網頁裡的 content.js 也送得到這裡，sender 會帶分頁和網頁的網址。
  function fromBackground(sender) {
    return sender.id === chrome.runtime.id && !sender.tab && String(sender.url || '').startsWith(chrome.runtime.getURL(''));
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.target !== 'offscreen-clipboard' || !fromBackground(sender)) return false;
    sha256(readClipboard()).then(
      (hash) => {
        const ours = hash === msg.hash;
        if (ours) clearClipboard();
        sendResponse({ cleared: ours });
      },
      (err) => sendResponse({ error: String(err) })
    );
    return true;
  });
})();
