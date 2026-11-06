# 參與開發

## 開發環境

- Edge 或 Chrome，版本 111 以上。
- Node.js 18 以上。只用來跑檢查、測試和打包，不用 `npm install`，也沒有要裝的套件。

## 載入開發中的版本

1. 打開擴充功能管理頁（`edge://extensions` 或 `chrome://extensions`），打開「開發人員模式」。
2. 按「載入解壓縮」，選這個專案的資料夾，也就是有 `manifest.json` 的那一層。
3. 改了 `src/background/` 或 `src/content/` 之後，在擴充功能管理頁按「重新載入」，開著的網頁也要重新整理。只改小視窗或管理頁的話，重新打開那一頁就好。

直接載入專案資料夾的是開發版。開發版的擴充功能 ID 跟資料夾位置綁在一起，跟從 Releases 下載的正式版是兩個不同的擴充功能，存的資料不互通。同一個瀏覽器不要同時開著開發版和正式版，不然兩個都會自動填入。

## 專案結構

`manifest.json` 放在最外層，專案資料夾本身就能直接載入。擴充功能的程式都在 `src/`，照畫面分資料夾。`_locales/` 一定要跟 `manifest.json` 在同一層，這是瀏覽器的規定。

```text
manifest.json        擴充功能的設定檔
src/
  background/        背景程式
  content/           注入到網頁的腳本
  popup/             工具列圖示點開的小視窗
  options/           管理頁
  unlock/            獨立的解鎖視窗
  shared/            好幾個畫面共用的程式和樣式
_locales/            三種語言的介面文字
icons/               工具列圖示
docs/                英文、日文版的 README
tools/               檢查、打包、產生版本紀錄的腳本
test/                測試頁和 e2e 測試
```

| 路徑 | 負責什麼 |
| --- | --- |
| `manifest.json` | 擴充功能的設定檔，宣告權限、快捷鍵和要注入哪些網頁。版本號以這裡為準。 |
| `src/background/background.js` | 背景程式，所有密碼的讀寫、加解密、產生密碼、備份匯出匯入都在這裡。 |
| `src/background/crypto.js` | 加解密的工具函式，`background.js` 會載入。 |
| `src/content/content.js` | 注入到每個網頁的腳本，負責找登入欄位、跳儲存提示、自動填入、帳號清單和自動點選。 |
| `src/content/page-click.js` | 跑在網頁自己環境的小腳本，替自動點選按最後那一下，`javascript:` 連結才點得動。 |
| `src/popup/` | 工具列圖示點開的小視窗，含搜尋、產生密碼、備份提醒和解鎖。 |
| `src/unlock/` | 從小視窗按「用 Windows Hello 解鎖」開出來的獨立解鎖視窗。 |
| `src/options/options.html`、`options.js` | 管理頁，含備份和設定。 |
| `src/options/changelog.js` | 每一版改了什麼，三種語言都寫。管理頁「版本」分頁照它畫，`CHANGELOG.md` 也從它產生。 |
| `src/shared/webauthn-client.js` | 管理頁、小視窗、解鎖視窗共用，負責叫 Windows Hello 這類系統驗證。 |
| `src/shared/tip.js` | 管理頁和小視窗共用，顯示欄位旁邊「?」的說明。 |
| `src/shared/i18n.js` | 所有畫面共用，照瀏覽器的介面語言拿文字。 |
| `src/shared/ui.css` | 小視窗和管理頁共用的樣式。 |
| `_locales/` | 繁體中文（`zh_TW`）、英文（`en`）、日文（`ja`）的介面文字。 |
| `icons/` | 工具列圖示。 |
| `docs/` | 英文版（`README.en.md`）、日文版（`README.ja.md`）的說明。 |
| `tools/files.js` | 正式版 zip 要放哪些檔案。`src/` 整個資料夾都會打包，`src/` 以外多了要打包的檔案才要加在這裡。 |
| `tools/check.js` | 檢查版本號、版本紀錄、打包清單和程式語法，CI 每次都會跑。 |
| `tools/build.js` | 打包正式版 zip 到 `dist/`。 |
| `tools/changelog.js` | 從 `src/options/changelog.js` 重新產生 `CHANGELOG.md`。 |
| `tools/release-notes.js` | 產生 GitHub Release 頁面上的說明。 |
| `tools/make-icons.js` | 產生圖示，只有改圖示時才需要。 |
| `test/` | 開發時用的測試頁，正式版不會帶。 |
| `test/e2e/` | 把擴充功能裝進真的瀏覽器跑完整流程的測試。 |
| `.github/workflows/` | GitHub Actions：推上去時檢查和打包、推標籤時建立 Release、手動跑 e2e。 |

`src/` 裡的頁面用相對路徑載入別的檔案，例如 `../shared/ui.css`、`../../icons/icon32.png`。背景程式的 `importScripts` 也是從 `background.js` 所在的資料夾算。只有 `chrome.runtime.getURL` 要寫從最外層算的完整路徑，例如 `src/options/options.html`。

## 介面文字和多國語系

介面有繁體中文、英文、日文三份。預設跟著瀏覽器的語言，瀏覽器是其他語言時用英文（`manifest.json` 的 `default_locale`）。

管理頁右上角可以指定語言，存在 `chrome.storage.local` 的 `uiLanguage`：

- 瀏覽器內建的 `chrome.i18n` 只會照瀏覽器的語言，指定了別的語言時，`i18n.js` 改成自己讀那一份 `messages.json` 查表。
- 小視窗、管理頁、解鎖視窗打開時要馬上知道用哪種語言，所以管理頁換語言時另外在 `localStorage` 存一份 `pk.uiLanguage`。兩份對不上時以 `uiLanguage` 為準，頁面會更新那一份再重新整理。
- 背景程式和網頁裡的 `content.js` 啟動時讀 `uiLanguage`，改了會收到 storage 的變更通知自己換。背景程式讀好語言之前收到的訊息會先等。
- 擴充功能管理頁上的名稱和說明、快捷鍵的說明、工具列圖示的提示文字是瀏覽器用 `__MSG_…__` 顯示的，一定跟著瀏覽器的語言。

- 文字放在 `_locales/<語言>/messages.json`，三種語言的 key 要一樣。
- 程式裡用 `t('key')` 拿文字，有替換值的寫 `t('key', 值)`，訊息裡用 `$1`、`$2` 對應。顯示數量、英文要分單複數的用 `tn('key', 數量)`，翻譯檔要有 `key_one` 和 `key_other`。
- HTML 寫 `<span data-i18n="key">繁體中文原文</span>`，屬性用 `data-i18n-placeholder`、`data-i18n-title`、`data-i18n-aria-label`、`data-i18n-tip`。HTML 裡的中文要跟繁體中文翻譯檔一字不差。
- key 要寫死在程式裡，不能用字串拼出來，`tools/check.js` 才找得到。
- 用來比對網頁上文字的中文（例如認登入按鈕的關鍵字）不是介面文字，在同一行註解寫 `i18n-ignore`。
- `node tools/check.js` 會擋：三種語言的 key 不一樣、替換值對不上、用到的 key 不存在、留著沒用的 key、程式或 HTML 裡還有沒翻到的中文。
- `node test/e2e/run.js` 的多國語系案例會用英文、日文介面打開各畫面，找漏翻的字，截圖放在測試輸出的資料夾。

要加新語言：

1. 複製 `_locales/en` 成新的語言代碼資料夾（例如 `ko`），把裡面的文字翻掉，`locale_code` 和 `lang_tag` 改成新的語言代碼。
2. `src/options/changelog.js` 每一版的 `items`、`notes` 加上那個語言。
3. 語言代碼加進 `tools/lib/i18n-check.js` 的 `LOCALES` 和 `src/shared/i18n.js` 的 `i18nLocales()`，`tools/lib/project.js` 的 `RELEASE_TEXT` 加上那個語言的 Release 說明。
4. 管理頁頁首的語言選單（`src/options/options.html` 的 `langSelect`）加一個選項，每一份翻譯檔都加 `lang_name_<語言代碼>`，內容一律寫那個語言自己的寫法，例如 `한국어`。
5. `test/e2e/run.js` 的多國語系案例加上那個語言。

## 檢查和測試

改完送出之前，至少跑前兩項：

```bash
node tools/check.js
```

```bash
node test/e2e/run.js
```

- `node tools/check.js`：檢查版本號、版本紀錄、打包清單和程式語法。
- `node test/e2e/run.js`：把擴充功能裝進真的 Edge 跑完整流程，大約 3 分鐘。看不到視窗，也不會動到平常用的瀏覽器設定。後面加 `chrome` 改測 Chrome，再加一個關鍵字只跑名稱含那個字的案例，例如 `node test/e2e/run.js edge 解鎖視窗`。
- `node test/e2e/package.js`：打包之後解壓縮載入，確認擴充功能 ID 固定，解壓縮到別的資料夾裝新版時資料還在。

`test/*.html` 是配假 chrome API 的測試頁，測不到 content script 隔離環境才有的問題，例如 CSP。要確認行為，以 `test/e2e/` 的結果為準。

## 版本號

照[語意化版本](https://semver.org/lang/zh-TW/)：

- 只修問題：加第三碼，例如 1.12.0 → 1.12.1。
- 加功能或改畫面：加第二碼，例如 1.12.0 → 1.13.0。
- 舊資料或舊設定不能直接沿用：加第一碼，例如 1.12.0 → 2.0.0。

## 發布新版

1. 改 `manifest.json` 的 `version`。
2. 在 `src/options/changelog.js` 最上面加這一版的說明。
3. 執行 `node tools/changelog.js` 更新 `CHANGELOG.md`。
4. 執行 `node tools/check.js` 和 e2e 測試。
5. commit 之後打標籤，推上 GitHub：

   ```bash
   git tag v1.13.0
   ```

   ```bash
   git push origin main --tags
   ```

6. GitHub Actions 會再檢查一次，確認標籤跟 `manifest.json` 的版本一樣，接著打包並建立 Release，附上 `password-keeper-1.13.0.zip` 和 `.sha256`。

想在本機先看打包結果，執行 `node tools/build.js`，檔案會在 `dist/`。同一版每次打包出來的 zip 都一模一樣。

## 正式版的擴充功能 ID

`tools/build.js` 打包時會在 zip 裡的 `manifest.json` 加上一把固定的公鑰（`key` 欄位），正式版的擴充功能 ID 一律是 `fgmjnolhbeohanamhnomcpmolhdapdkg`。使用者把新版解壓縮到別的資料夾，也還是同一個擴充功能，存的密碼和設定都在。

- 不要改 `tools/build.js` 裡的公鑰。改了之後，已經裝過正式版的人裝新版會變成另一個擴充功能，看不到原本的資料。
- 專案資料夾裡的 `manifest.json` 不放這把公鑰，開發版的 ID 才不會變。
- 這把公鑰只用來固定 ID，對應的私鑰沒有保存。Edge 和 Chrome 不讓商店以外的 `.crx` 安裝，用不到私鑰。
