// 跑在網頁自己的環境（manifest 的 world: MAIN），不是 content.js 那個隔離環境。只做一件事：替自動點選按最後那一下。
// content.js 的環境有擴充功能自己的 CSP，點 javascript: 連結（舊系統常見的 __doPostBack）會被瀏覽器擋掉，在這裡按才會動。
// 網頁也能發這個事件，但它本來就能按自己的按鈕，沒有多給它什麼。
document.addEventListener(
  '__pkClick',
  (e) => {
    e.preventDefault();
    const { clientX, clientY } = JSON.parse(e.detail);
    e.target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true, view: window, button: 0, clientX, clientY }));
  },
  true
);
