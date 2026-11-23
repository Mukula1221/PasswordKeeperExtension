'use strict';
// 判斷訊息是誰送來的：擴充功能自己的頁面，還是網頁裡的 content.js。
(() => {
  const PK = (globalThis.PK ??= {});
  const { t } = PK.i18n;
  const { hostFromUrl, originFromUrl } = PK.domain;

  // sender.url 是瀏覽器填的，網頁改不了。小視窗、管理頁、解鎖視窗的網址都在擴充功能自己底下。
  function fromExtensionPage(sender) {
    return String((sender && sender.url) || '').startsWith(PK.platform.extensionOrigin() + '/');
  }

  // dispatch 已經照 MESSAGE_RULES 擋過。換保護方式、清掉資料、打自訂密碼這幾個在處理函式裡再擋一次，
  // 以後改 MESSAGE_RULES 寫錯也不會放行。
  function requireExtensionPage(sender) {
    if (!fromExtensionPage(sender)) throw new Error(t('bg_extension_page_only'));
  }

  // 小視窗、管理頁要操作別的網站，用訊息裡帶的 host。
  // content.js 一律用它所在的網址算，網頁的執行程序被攻破時，攻擊者才不能冒充 content.js 拿別的網站的帳密。
  function callerHost(msgHost, sender) {
    if (fromExtensionPage(sender)) return String(msgHost || '').toLowerCase();
    return hostFromUrl(sender && sender.url);
  }

  // content.js 能存的網站：它自己所在的網站，加上這個分頁暫存的登入資料那個網站。
  // 登入後跳到別的網域、或登入框在 iframe 裡時，跳「要儲存嗎？」的是另一個網站的 content.js。
  // 暫存的 host 和 origin 是 pending.set 時用那個 content.js 的網址算的，不是網頁給的。
  async function contentSaveSites(sender) {
    const sites = [];
    // 暫存的排前面：同一個網站時，用登入當時那一頁的 origin
    const pending = sender.tab ? await PK.pending.getPending(sender.tab.id) : null;
    if (pending && pending.host) sites.push({ host: pending.host, origin: pending.origin });
    sites.push({ host: hostFromUrl(sender.url), origin: originFromUrl(sender.url) });
    return sites;
  }

  function siteNotAllowed() {
    return new Error(t('bg_site_not_allowed'));
  }

  // 私密分頁裡的 content.js 送來的，而且這個瀏覽器不能在私密視窗用（見 platform.js 的 privateWindows）。
  // content.js 在這種分頁一開始就停了，這裡是第二道。管理頁不算：管理的是已經存好的帳號，不是私密瀏覽的資料。
  function fromBlockedPrivateTab(sender) {
    return !fromExtensionPage(sender) && PK.platform.privateBlocked(sender && sender.tab && sender.tab.incognito);
  }

  PK.callers = { callerHost, contentSaveSites, fromBlockedPrivateTab, fromExtensionPage, requireExtensionPage, siteNotAllowed };
})();
