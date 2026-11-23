'use strict';
// 小視窗和管理頁共用的小工具：$ 拿元素、el 建元素、send 叫背景程式、toast 在畫面下方跳提示。
(() => {
  const PK = (globalThis.PK ??= {});
  if (PK.page) return;

  const $ = (id) => document.getElementById(id);

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  // 兩個畫面的提示停留時間、背景程式沒回應時的文字不一樣，用參數帶進來
  function pageHelpers({ noResponse, toastMs }) {
    function send(msg) {
      return new Promise((resolve) => {
        chrome.runtime.sendMessage(msg, (res) => {
          if (chrome.runtime.lastError) return resolve({ ok: false, error: chrome.runtime.lastError.message });
          resolve(res || { ok: false, error: noResponse() });
        });
      });
    }

    let toastTimer = null;
    function toast(text) {
      const box = $('toast');
      box.textContent = text;
      box.classList.add('show');
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => box.classList.remove('show'), toastMs);
    }

    return { send, toast };
  }

  PK.page = { $, el, pageHelpers };
})();
