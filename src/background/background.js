'use strict';
// 背景程式的進入點：依序載入各個檔。所有密碼的讀寫都在背景程式，小視窗、管理頁、網頁腳本都用 chrome.runtime.sendMessage 來叫它。
// 訊息格式：{ type: 'entries.forHost', ... }，回覆固定是 { ok: true, data } 或 { ok: false, error }。
// 每個檔包在自己的閉包裡，只把別的檔要用的函式放進全域的 PK，例如 PK.vault.loadEntries。
// 檔案一載入就會註冊事件、開始做事，所以被用到的檔排前面。Firefox 版的背景程式清單由 tools/build.js 從這裡產生。
importScripts('../shared/platform.js');
importScripts('../shared/i18n.js');
importScripts('../shared/domain.js');
importScripts('crypto.js');
importScripts('locale.js');
importScripts('settings.js');
importScripts('vault.js');
importScripts('entries.js');
importScripts('clipboard.js');
importScripts('lock.js');
importScripts('callers.js');
importScripts('webauthn.js');
importScripts('pending.js');
importScripts('wordlist.js');
importScripts('generator.js');
importScripts('backup.js');
importScripts('backup-files.js');
importScripts('auto-backup.js');
importScripts('update.js');
importScripts('breach.js');
importScripts('badge.js');
importScripts('shortcut.js');
importScripts('http-auth.js');
importScripts('click-rules.js');
importScripts('messages.js');
