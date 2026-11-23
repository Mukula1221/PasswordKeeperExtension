'use strict';
// 每天到 GitHub 檢查有沒有新版。
(() => {
  const PK = (globalThis.PK ??= {});
  const { t } = PK.i18n;

  // 到 GitHub 的 Releases 問最新的版本號。只送一個不帶 cookie 的 GET，不會送出任何帳密、網站或設定。
  // 瀏覽器不讓「載入解壓縮」裝的擴充功能自己換掉檔案，所以這裡只負責知道有沒有新版、幫忙下載 zip，載入新版要使用者自己按。
  // 自動檢查只在正式版做。開發版用 git 更新，拿下載的 zip 蓋掉原始碼資料夾會讓 ID 變掉，存的資料就看不到了。

  // repo 要是公開的，沒登入的人才問得到 Releases。repo 改名或搬家要改這裡。
  const UPDATE_REPO = 'Mukula1221/PasswordKeeperExtension';

  const UPDATE_API = 'https://api.github.com/repos/' + UPDATE_REPO + '/releases/latest';

  let updateApi = UPDATE_API;

  // e2e 換成本機的假 GitHub，給 null 換回來
  function useUpdateApi(url) {
    updateApi = url || UPDATE_API;
  }

  // 正式版 zip 的 manifest 有固定的公鑰，ID 一定是這個，見 tools/build.js
  const RELEASE_ID = 'fgmjnolhbeohanamhnomcpmolhdapdkg';

  const UPDATE_ALARM = 'update-check';

  const UPDATE_TIMEOUT_MS = 15000;

  const SEMVER = /^\d+\.\d+\.\d+$/;

  // 三種版本：
  //   github：從 Releases 下載、載入解壓縮的正式版，ID 是 RELEASE_ID，每天到 GitHub 問有沒有新版。
  //   store：從商店裝的。商店會自己更新，Edge 商店也規定只能透過商店更新，所以完全不連 GitHub。
  //   dev：直接載入原始碼資料夾的開發版，不自動問，按「立即檢查」才問。
  // management.getSelf 不用另外要 management 權限。installType 是 development 代表載入解壓縮。
  async function releaseChannel() {
    const self = await chrome.management.getSelf();
    if (self.installType !== 'development') return 'store';
    return chrome.runtime.id === RELEASE_ID ? 'github' : 'dev';
  }

  function compareVersions(a, b) {
    const x = a.split('.').map(Number);
    const y = b.split('.').map(Number);
    for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
    return 0;
  }

  // 只收這個 repo 自己的網址。GitHub 回的資料不對勁時，下載按鈕也不會指到別的地方。
  function releaseUrl(raw, kind) {
    const prefix = 'https://github.com/' + UPDATE_REPO + '/releases/' + kind + '/';
    return typeof raw === 'string' && raw.startsWith(prefix) ? raw : '';
  }

  // GitHub 的 /releases/latest 只會回正式發布的版本，草稿和預先發行版不算
  function parseRelease(data) {
    const version = String((data && data.tag_name) || '').replace(/^v/, '');
    if (!SEMVER.test(version)) throw new Error(t('bg_update_bad_reply'));
    const zipName = 'password-keeper-' + version + '.zip';
    const asset = (Array.isArray(data.assets) ? data.assets : []).find((a) => a && a.name === zipName);
    return {
      version,
      publishedAt: Date.parse(data.published_at) || 0,
      pageUrl: releaseUrl(data.html_url, 'tag'),
      zipUrl: asset ? releaseUrl(asset.browser_download_url, 'download') : '',
    };
  }

  // 自己丟的 Error 已經是給使用者看的話；連不上、逾時是 TypeError、DOMException；回的不是 JSON 是 SyntaxError
  function updateErrorText(err) {
    if (err && err.constructor === Error) return err.message;
    if (err instanceof SyntaxError) return t('bg_update_bad_reply');
    return t('bg_update_offline');
  }

  // 結果存在 storage.local 的 updateInfo：{ checkedAt, latest: { version, publishedAt, pageUrl, zipUrl } | null, error }
  async function checkUpdateOnce() {
    // 錯誤訊息要用管理頁指定的語言，背景程式剛醒來時語言可能還沒讀好
    await PK.locale.localeReady();
    if ((await releaseChannel()) === 'store') throw new Error(t('bg_update_store'));
    const { updateInfo } = await chrome.storage.local.get('updateInfo');
    const info = { checkedAt: Date.now(), latest: null, error: '' };
    try {
      const res = await fetch(updateApi, {
        headers: { Accept: 'application/vnd.github+json' },
        credentials: 'omit',
        cache: 'no-store',
        signal: AbortSignal.timeout(UPDATE_TIMEOUT_MS),
      });
      // 404 是還沒發布過正式版，或 repo 不是公開的
      if (res.status !== 404) {
        if (res.status === 403 || res.status === 429) throw new Error(t('bg_update_busy'));
        if (!res.ok) throw new Error(t('bg_update_http', res.status));
        info.latest = parseRelease(await res.json());
      }
    } catch (err) {
      info.error = updateErrorText(err);
      // 這次沒問到就沿用上次知道的新版，提醒不會因為一時連不上就消失
      info.latest = (updateInfo && updateInfo.latest) || null;
    }
    await chrome.storage.local.set({ updateInfo: info });
  }

  // 管理頁連按「立即檢查」、背景程式剛好也在問的時候，共用同一次
  let updateRun = null;

  function checkUpdate() {
    if (!updateRun) updateRun = checkUpdateOnce().finally(() => (updateRun = null));
    return updateRun;
  }

  async function updateStatus() {
    const settings = await PK.settings.getSettings();
    const { updateInfo } = await chrome.storage.local.get('updateInfo');
    const info = updateInfo || { checkedAt: 0, latest: null, error: '' };
    const current = chrome.runtime.getManifest().version;
    const channel = await releaseChannel();
    return {
      auto: !!settings.updateCheck,
      channel,
      release: channel === 'github',
      current,
      checkedAt: info.checkedAt || 0,
      error: info.error || '',
      latest: info.latest || null,
      available: !!(info.latest && compareVersions(info.latest.version, current) > 0),
    };
  }

  // 背景程式每次醒來都看一次，距離上次檢查超過一天才問。關機、瀏覽器沒開錯過的，下次醒來就補。
  async function updateTick() {
    const settings = await PK.settings.getSettings();
    if (!settings.updateCheck || (await releaseChannel()) !== 'github') return;
    const { updateInfo } = await chrome.storage.local.get('updateInfo');
    if (updateInfo && Math.abs(Date.now() - updateInfo.checkedAt) < PK.vault.DAY_MS) return;
    await checkUpdate();
  }

  // 背景程式一直沒被叫醒時，靠這個計時器每 6 小時叫一次
  chrome.alarms.get(UPDATE_ALARM).then((alarm) => {
    if (!alarm) chrome.alarms.create(UPDATE_ALARM, { periodInMinutes: 360 });
  });

  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === UPDATE_ALARM) updateTick().catch((err) => console.warn('[密碼小管家] 檢查新版失敗', err)); // i18n-ignore：給開發者看的
  });

  updateTick().catch((err) => console.warn('[密碼小管家] 檢查新版失敗', err)); // i18n-ignore：給開發者看的

  PK.update = { RELEASE_ID, UPDATE_REPO, checkUpdate, updateStatus, updateTick, useUpdateApi };
})();
