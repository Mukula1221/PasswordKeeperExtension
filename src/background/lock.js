'use strict';
// 工具鎖定：鎖上、解鎖、換保護方式、閒置自動鎖。
(() => {
  const PK = (globalThis.PK ??= {});
  const { t } = PK.i18n;
  const { b64urlToBytes, bytesToB64, unwrapWithPassword, unwrapWithPrf, wrapWithPassword, wrapWithPrf } = PK.crypto;

  function lockedError() {
    const err = new Error(t('bg_locked'));
    err.locked = true;
    return err;
  }

  // 鎖住時背景程式不給任何帳號資料，網頁不自動填、小視窗和管理頁要先通過系統驗證（Windows Hello 之類）或自訂密碼。
  // 鎖定狀態放 storage.session：服務工作者重開還在，瀏覽器關掉就清掉。
  // 閒置或手動鎖定只擋畫面，加密的保護方式也不清掉記憶體裡的金鑰。解鎖還是要通過系統驗證，自訂密碼加密要打自訂密碼。

  // screen 只鎖畫面是 1.15.0 以前的設定，硬碟上的密碼沒有加密。舊使用者照常用，但不能新選。
  const LOCK_MODES = ['off', 'screen', 'password', 'hello'];

  const MASTER_PASSWORD_MIN = 12;

  function isEncryptedMode(mode) {
    return mode === 'password' || mode === 'hello';
  }

  // 1.15 以前只有 enabled，沒有 mode。沒加密的兩種（off、screen）照 enabled 決定，加密的兩種照 mode 決定，
  // 這樣舊程式寫的 { ...lock, enabled: false } 也照樣能用。
  function normalizeLock(raw) {
    const lock = { ...PK.settings.DEFAULT_SETTINGS.lock, ...(raw || {}) };
    if (isEncryptedMode(lock.mode)) lock.enabled = true;
    else lock.mode = lock.enabled ? 'screen' : 'off';
    return lock;
  }

  async function isLocked() {
    const settings = await PK.settings.getSettings();
    if (!settings.lock.enabled) return false;
    const { locked, vaultKey } = await chrome.storage.session.get(['locked', 'vaultKey']);
    if (locked) return true;
    // 加密的保護方式，金鑰不在記憶體（瀏覽器重開過、擴充功能更新過）就算鎖著
    return isEncryptedMode(settings.lock.mode) && !vaultKey;
  }

  async function setLocked(locked) {
    await chrome.storage.session.set({ locked: !!locked });
    PK.badge.refreshActiveBadges();
    // 管理頁開著的時候鎖定一觸發要立刻回到驗證畫面，所以也通知擴充功能自己的頁面
    chrome.runtime.sendMessage({ type: 'lockChanged', locked: !!locked }).catch(() => {
      // 沒有頁面開著就會失敗，不用理
    });
    if (!locked) {
      // 開著的分頁要重新自動填，所以廣播一聲
      const tabs = await chrome.tabs.query({});
      for (const t of tabs) {
        if (t.id == null) continue;
        chrome.tabs.sendMessage(t.id, { type: 'unlocked' }).catch(() => {
          // 沒有 content.js 的分頁（瀏覽器自己的頁面）會失敗，不用理
        });
      }
    }
  }

  // needsKey：加密的保護方式、金鑰不在記憶體。自訂密碼加密這時只能打自訂密碼，系統驗證加密要拿 PRF 秘密值。
  async function lockStatus() {
    const settings = await PK.settings.getSettings();
    const { webauthn } = await chrome.storage.local.get('webauthn');
    const { vaultKey } = await chrome.storage.session.get('vaultKey');
    return {
      ...settings.lock,
      locked: await isLocked(),
      webauthn: !!webauthn,
      needsKey: isEncryptedMode(settings.lock.mode) && !vaultKey,
      masterPasswordMin: MASTER_PASSWORD_MIN,
      // 解不開要清掉資料時，管理頁拿這個告訴使用者有沒有備份可以還原。鎖住時讀不到 vault，所以放這裡。
      lastBackupAt: settings.lastBackupAt || 0,
    };
  }

  // storage.local 的 vaultKeyLock：
  //   { mode: 'password', password: { kdf, iv, data } }                  vault 金鑰用自訂密碼加密
  //   { mode: 'hello', hello: { credentialId, prfSalt, iv, data } }       vault 金鑰用系統驗證吐出的 PRF 秘密值加密

  // 自訂密碼對了就把金鑰放進記憶體
  async function unlockWithPassword(password) {
    const { vaultKeyLock } = await chrome.storage.local.get('vaultKeyLock');
    if (!vaultKeyLock || !vaultKeyLock.password) throw new Error(t('bg_master_password_not_set'));
    let keyB64;
    try {
      keyB64 = await unwrapWithPassword(String(password || ''), vaultKeyLock.password);
    } catch {
      // AES-GCM 密碼不對會直接解不開，丟給畫面的是「自訂密碼不對」
      throw new Error(t('bg_master_password_wrong'));
    }
    await chrome.storage.session.set({ vaultKey: keyB64 });
  }

  // 系統驗證通過之後：金鑰不在記憶體的話（瀏覽器重開過），系統驗證加密用 PRF 秘密值解開。
  // 自訂密碼加密不管什麼時候都只能打自訂密碼，系統驗證解不開。
  async function unlockWithHello(prfB64url) {
    const settings = await PK.settings.getSettings();
    if (settings.lock.mode === 'password') throw new Error(t('bg_need_master_password'));
    if (!isEncryptedMode(settings.lock.mode)) return;
    const { vaultKey } = await chrome.storage.session.get('vaultKey');
    if (vaultKey) return;
    const { vaultKeyLock } = await chrome.storage.local.get('vaultKeyLock');
    if (!vaultKeyLock || !vaultKeyLock.hello || !prfB64url) throw new Error(t('bg_hello_no_secret'));
    let keyB64;
    try {
      keyB64 = await unwrapWithPrf(b64urlToBytes(prfB64url), vaultKeyLock.hello);
    } catch {
      // 秘密值不對多半是用了別把鑰匙（例如重新註冊過），丟給畫面的是「解不開」
      throw new Error(t('bg_hello_wrong_secret'));
    }
    await chrome.storage.session.set({ vaultKey: keyB64 });
  }

  // 拿掉加密、關掉鎖定算「降低保護」，要再驗一次；改自訂密碼也要打舊的。
  function needsProof(current, target) {
    if (current === target) return current === 'password';
    if (target === 'off') return current !== 'off';
    return false;
  }

  // 原本是自訂密碼加密就打自訂密碼，其他用系統驗證
  async function checkProof(current, proof) {
    if (current === 'password') {
      const { vaultKeyLock } = await chrome.storage.local.get('vaultKeyLock');
      try {
        await unwrapWithPassword(String((proof && proof.password) || ''), vaultKeyLock.password);
      } catch {
        throw new Error(t('bg_master_password_wrong'));
      }
      return;
    }
    if (!proof || !proof.assertion) throw new Error(t('bg_lock_needs_verify'));
    await PK.webauthn.verifyAssertion(proof.assertion);
  }

  // 換保護方式。要拿得到目前的金鑰，所以只能在解鎖時叫。
  // setup.password：新的自訂密碼。setup.credential：系統驗證加密時，頁面剛建的系統驗證鑰匙。
  // setup.assertion：系統驗證加密時，用新鑰匙驗一次拿到的結果，裡面的 prf 是秘密值；setup.prfSalt 是要秘密值用的 salt。
  async function setLockMode({ mode, proof, setup, idleMinutes, onStartup }) {
    if (!LOCK_MODES.includes(mode)) throw new Error(t('bg_lock_mode_unknown'));
    setup = setup || {};
    const settings = await PK.settings.getSettings();
    const current = settings.lock.mode;
    // 只鎖畫面留給 1.15.0 以前的舊設定照常用，不能新選
    if (mode === 'screen' && current !== 'screen') throw new Error(t('bg_lock_mode_unknown'));
    // 管理頁在這種瀏覽器不顯示，這裡再擋一次，見 platform.js 的 extensionWebAuthn
    if (mode === 'hello' && !PK.platform.can('extensionWebAuthn')) throw new Error(t('wa_unsupported'));
    // 先做完所有檢查才動資料，中途失敗不會留下改一半的狀態
    if (needsProof(current, mode)) await checkProof(current, proof);
    if (isEncryptedMode(mode) && !(await PK.autoBackup.getAutoBackupKey())) throw new Error(t('bg_lock_needs_backup_password'));
    if (mode === 'password' && String(setup.password || '').length < MASTER_PASSWORD_MIN) {
      throw new Error(t('bg_master_password_too_short', MASTER_PASSWORD_MIN));
    }
    if (mode === 'hello' && (!setup.credential || !setup.assertion || !setup.assertion.prf || !setup.prfSalt)) {
      throw new Error(t('bg_hello_no_secret'));
    }
    const keyB64 = await PK.vault.currentVaultKeyB64();
    const newCredential = mode === 'hello' && setup.credential ? await PK.webauthn.checkNewCredential(setup.credential) : null;
    // 用新鑰匙驗一次：確定公鑰對得上，秘密值也真的是這把鑰匙吐出來的
    if (mode === 'hello') await PK.webauthn.verifyAssertion(setup.assertion, newCredential);
    const webauthn = newCredential || (await chrome.storage.local.get('webauthn')).webauthn;
    if ((mode === 'screen' || mode === 'hello') && !webauthn) throw new Error(t('bg_webauthn_not_set_up'));

    // 新鑰匙跟金鑰一起寫：寫一半失敗的話，系統驗證加密會變成鑰匙和加密過的金鑰對不上，再也解不開
    const items = newCredential ? { webauthn: newCredential } : {};
    if (isEncryptedMode(mode)) {
      // 從沒加密改成加密時換一把新金鑰：舊的 keyB64 可能還留在瀏覽器的資料檔裡，不能讓它解得開之後的 vault
      const newKeyB64 = isEncryptedMode(current) ? keyB64 : bytesToB64(crypto.getRandomValues(new Uint8Array(32)));
      const vaultKeyLock = { mode };
      if (mode === 'password') {
        vaultKeyLock.password = await wrapWithPassword(String(setup.password), newKeyB64, PK.backup.BACKUP_ITERATIONS);
      } else {
        const wrapped = await wrapWithPrf(b64urlToBytes(setup.assertion.prf), newKeyB64);
        vaultKeyLock.hello = { credentialId: webauthn.id, prfSalt: setup.prfSalt, iv: wrapped.iv, data: wrapped.data };
      }
      // 自訂密碼加密只用自訂密碼，從系統驗證加密或只鎖畫面改過來時，原本的系統驗證鑰匙一起刪掉
      await PK.vault.replaceVaultKey(newKeyB64, { ...items, vaultKeyLock }, mode === 'password' ? ['keyB64', 'webauthn'] : ['keyB64']);
    } else {
      await PK.vault.replaceVaultKey(keyB64, { ...items, keyB64 }, mode === 'off' ? ['vaultKeyLock', 'webauthn'] : ['vaultKeyLock']);
      await chrome.storage.session.remove('vaultKey');
    }

    const next = { ...settings.lock, mode, enabled: mode !== 'off' };
    if (idleMinutes != null) next.idleMinutes = Math.min(Math.max(parseInt(idleMinutes, 10) || 10, 1), 720);
    if (onStartup != null) next.onStartup = !!onStartup;
    await PK.settings.setSettings({ lock: next });
    await chrome.storage.session.set({ locked: false });
    applyIdleInterval();
    PK.badge.refreshActiveBadges();
    await PK.autoBackup.refreshAutoBackupReadyLater();
    return lockStatus();
  }

  async function applyIdleInterval() {
    const settings = await PK.settings.getSettings();
    // chrome.idle 最少 15 秒
    const seconds = Math.max(15, Math.round((settings.lock.idleMinutes || 10) * 60));
    chrome.idle.setDetectionInterval(seconds);
  }

  chrome.idle.onStateChanged.addListener(async (state) => {
    if (state === 'active') return;
    const settings = await PK.settings.getSettings();
    if (settings.lock.enabled) await setLocked(true);
  });

  chrome.runtime.onStartup.addListener(async () => {
    const settings = await PK.settings.getSettings();
    if (settings.lock.enabled && settings.lock.onStartup) await chrome.storage.session.set({ locked: true });
    applyIdleInterval();
  });

  applyIdleInterval();

  // 1.5 以前的鎖定是用 PIN。舊的 PIN 紀錄清掉；只有 PIN、沒有系統驗證鑰匙的鎖定直接關掉，不然會被鎖在外面。
  // 自訂密碼加密可以沒有系統驗證鑰匙，不能關。
  async function migrateLock() {
    const { pin, webauthn } = await chrome.storage.local.get(['pin', 'webauthn']);
    if (pin) await chrome.storage.local.remove('pin');
    const settings = await PK.settings.getSettings();
    if (settings.lock.mode === 'screen' && !webauthn) {
      await PK.settings.setSettings({ lock: { ...settings.lock, enabled: false } });
      await chrome.storage.session.set({ locked: false });
    }
  }

  migrateLock().catch((err) => console.warn('[密碼小管家] 鎖定設定升級失敗', err)); // i18n-ignore：給開發者看的

  PK.lock = { applyIdleInterval, isEncryptedMode, isLocked, lockStatus, lockedError, normalizeLock, setLockMode, setLocked, unlockWithHello, unlockWithPassword };
})();
