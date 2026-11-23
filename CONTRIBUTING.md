# 參與開發

## 開發環境

- Edge 或 Chrome，版本 111 以上。
- Node.js 22 以上，建議用目前的 LTS 版（2026 年 11 月是 26）。只用來跑檢查、測試和打包，不用 `npm install`，也沒有要裝的套件。GitHub Actions 一律用最新的 LTS 和最新的修補版。

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
_locales/            介面文字，一種語言一個資料夾
icons/               工具列圖示
docs/                英文、日文版的 README
platforms/           各瀏覽器 manifest.json 不一樣的地方
tools/               檢查、打包、產生版本紀錄的腳本
test/                測試頁、單元測試和 e2e 測試
```

| 路徑 | 負責什麼 |
| --- | --- |
| `manifest.json` | 擴充功能的設定檔，宣告權限、快捷鍵和要注入哪些網頁。版本號以這裡為準。 |
| `src/background/background.js` | 背景程式的進入點，只負責照順序載入 `src/background/` 的其他檔。 |
| `src/background/messages.js` | 收各畫面送來的訊息，檢查是誰送的、鎖住時能不能做，再交給對應的處理函式。 |
| `src/background/vault.js` | 讀寫加密的密碼庫，所有寫入都排進同一個佇列。 |
| `src/background/` 的其他檔 | 背景程式照功能分的檔，例如工具鎖定 `lock.js`、自動備份 `auto-backup.js`、檢查新版 `update.js`。每個檔開頭第一句寫它負責什麼。 |
| `src/background/crypto.js` | 加解密的工具函式。 |
| `src/content/content.js` | 注入到每個網頁的腳本，負責跳儲存提示、自動填入、帳號清單和自動點選。 |
| `src/content/ui.js` | 網頁上的畫面都畫在一個 closed shadow DOM 裡，這個檔負責建它和建元素的小工具。 |
| `src/content/fields.js` | 找網頁上的登入欄位和填值。 |
| `src/content/click-target.js` | 自動點選時，找到使用者選的那顆按鈕並按下去。 |
| `src/content/page-click.js` | 跑在網頁自己環境的小腳本，替自動點選按最後那一下，`javascript:` 連結才點得動。 |
| `src/popup/` | 工具列圖示點開的小視窗，含搜尋、產生密碼、備份提醒和解鎖。 |
| `src/unlock/` | 從小視窗按「用 Windows Hello 解鎖」開出來的獨立解鎖視窗。 |
| `src/options/options.html`、`options.js` | 管理頁，含備份和設定。 |
| `src/options/changelog.js` | 每一版改了什麼，三種語言都寫。管理頁「版本」分頁照它畫，`CHANGELOG.md` 也從它產生。 |
| `src/shared/platform.js` | 各瀏覽器、作業系統不一樣的地方都集中在這裡，所有畫面和背景程式最先載入它。 |
| `src/shared/i18n.js` | 所有畫面共用，照瀏覽器的介面語言拿文字。 |
| `src/shared/domain.js` | 網域和網址比對，背景程式和網頁裡的腳本共用。 |
| `src/shared/page.js` | 小視窗和管理頁共用的小工具：叫背景程式、跳提示、建元素。 |
| `src/shared/webauthn-client.js` | 管理頁、小視窗、解鎖視窗共用，負責叫 Windows Hello 這類系統驗證。 |
| `src/shared/tip.js` | 管理頁和小視窗共用，顯示欄位旁邊「?」的說明。 |
| `src/shared/ui.css` | 小視窗和管理頁共用的樣式。 |
| `platforms/firefox/manifest.json` | Firefox 版的 manifest 跟共用的不一樣的地方，打包時蓋上去。 |
| `_locales/` | 介面文字，一種語言一個資料夾：繁體中文 `zh_TW`、台語 `nan_TW`、英文 `en`、日文 `ja`、韓文 `ko`、德文 `de`、俄文 `ru`、泰文 `th`。 |
| `icons/` | 工具列圖示。 |
| `docs/` | 英文版（`README.en.md`）、日文版（`README.ja.md`）的說明。 |
| `tools/files.js` | 正式版 zip 要放哪些檔案。`src/` 整個資料夾都會打包，`src/` 以外多了要打包的檔案才要加在這裡。 |
| `tools/check.js` | 檢查版本號、版本紀錄、打包清單和程式語法，CI 每次都會跑。 |
| `tools/build.js` | 打包正式版 zip 到 `dist/`。加 `firefox` 打包 Firefox 測試版到 `dist/firefox/`。 |
| `tools/changelog.js` | 從 `src/options/changelog.js` 重新產生 `CHANGELOG.md`。 |
| `tools/release-notes.js` | 產生 GitHub Release 頁面上的說明。 |
| `tools/make-icons.js` | 產生圖示，只有改圖示時才需要。 |
| `test/` | 開發時用的測試頁，正式版不會帶。 |
| `test/e2e/` | 把擴充功能裝進真的瀏覽器跑完整流程的測試。 |
| `test/unit/` | 不開瀏覽器的單元測試，把背景程式載進 Node 測訊息規則、檔案怎麼組織和計算用的函式。 |
| `.github/workflows/` | GitHub Actions：推上去或開 PR 時檢查和打包、推 `v` 開頭的標籤時建立 Release、手動跑 e2e。 |

`src/` 裡的頁面用相對路徑載入別的檔案，例如 `../shared/ui.css`、`../../icons/icon32.png`。背景程式的 `importScripts` 也是從 `background.js` 所在的資料夾算。只有 `chrome.runtime.getURL` 要寫從最外層算的完整路徑，例如 `src/options/options.html`。

## 程式怎麼組織

程式都是一般的腳本，不用 `import`／`export`，也不用打包工具，原始碼就是出貨的程式。每個檔照這個樣子寫：

```js
'use strict';
// 這個檔負責什麼，一句話
(() => {
  const PK = (globalThis.PK ??= {});
  const { t } = PK.i18n;              // 先載入的共用檔，開頭解構

  function loadEntries() { ... }      // 只有這個檔看得到

  PK.vault = { loadEntries };         // 別的檔要用的才放進 PK
})();
```

- 每個檔包在自己的閉包裡，全域只留一個 `PK`。`tools/check.js` 會擋最外層的 `const`、`let`、`function`，也擋 `window.xxx =` 這種掛到全域的寫法。
- 共用檔（`platform.js`、`i18n.js`、`domain.js`、`crypto.js`）一定比用它的檔先載入，所以在檔案開頭解構。
- 背景程式各檔之間會互相呼叫，載入順序沒辦法讓每個檔都排在用它的檔前面，所以呼叫的地方寫完整的 `PK.vault.loadEntries()`，等真的呼叫時才去拿。這樣也一眼看得出用到哪個檔。
- 會變的狀態不要直接放進 `PK`，放進去的是當下那個值，之後就不會跟著變。要給別的檔用，寫一個函式回傳目前的值，例如 `localeReady()`、`PK.contentUi.host()`。
- 背景程式的載入順序寫在 `src/background/background.js`，網頁裡的腳本寫在 `manifest.json` 的 `content_scripts`，頁面寫在各自的 HTML。新增檔案時記得加進去，`platform.js` 永遠排第一個。
- 判斷是哪個瀏覽器、哪個作業系統，或寫到 `chrome-extension://` 這種網址開頭，一律寫在 `src/shared/platform.js`，`tools/check.js` 會擋其他檔。
- e2e 在背景程式或頁面裡執行程式時，`test/e2e/lib.js` 會讓 `PK` 底下的名稱直接叫得到，測試照舊寫 `getSettings()`，不用寫 `PK.settings.getSettings()`。這些名稱不會變成全域，正式程式漏寫 `PK.` 的地方不會被測試蓋過去。

## 各瀏覽器的版本

各瀏覽器打包的檔案一樣，只有 `manifest.json` 不同。Edge、Chrome 直接用專案裡的 `manifest.json`，Firefox 版由 `tools/build.js` 產生：

- 把 `platforms/firefox/manifest.json` 蓋到共用的 manifest 上，值是 `null` 的欄位會刪掉。
- 背景程式改成 Firefox 要的 `background.scripts`，清單從 `src/background/background.js` 的 `importScripts` 讀出來，不用另外維護。

Firefox 版還沒正式支援，也還沒簽章。`node tools/build.js firefox` 打包出來的檔案，只能在 Firefox 的 `about:debugging` 暫時載入測試。CI 每次都會打包一份放在 Artifacts，不會放上 Releases。

## 背景程式的訊息

小視窗、管理頁、解鎖視窗和網頁裡的 `content.js` 都用 `chrome.runtime.sendMessage` 送 `{ type: 'entries.forHost', ... }` 這種訊息給背景程式。網頁的執行程序被攻破時，攻擊者可以冒充 `content.js` 送任何訊息，所以背景程式要檢查是誰送來的。

- 每種訊息都要在 `src/background/messages.js` 的 `MESSAGE_RULES` 寫一行，沒寫的訊息一律拒絕。
- `from: 'any'` 是 `content.js` 也能叫，`from: 'extension'` 只收擴充功能自己的頁面。`content.js` 用不到的訊息一律寫 `'extension'`。
- 鎖住時也要能叫的訊息加 `whenLocked: true`，沒寫就要先解鎖。
- `content.js` 送來的網站一律用 `callerHost()` 從瀏覽器給的 `sender.url` 算，不信訊息裡帶的 `host`。存帳號、設成永遠不問只能是 `contentSaveSites()` 列的網站。
- `test/unit/` 會比對 `MESSAGE_RULES` 和實際的訊息是不是一對一，也會比對 `from: 'any'` 的訊息和 `content.js` 送得出去的訊息是不是同一批。

## 介面文字和多國語系

介面有繁體中文、台語、英文、日文、韓文、德文、俄文、泰文八份。預設跟著瀏覽器的語言，瀏覽器是其他語言時用英文（`manifest.json` 的 `default_locale`）。

台語（`nan_TW`）比較特別：瀏覽器沒有台語介面，Chrome 也不認得 `nan_TW` 這個資料夾，只會略過，不會自己挑它。所以台語只能從管理頁的語言選單選，選了之後由 `i18n.js` 自己讀 `_locales/nan_TW/messages.json`。瀏覽器也沒有台語的日期格式，日期用台灣華語的寫法（`i18n.js` 的 `formatLang()`）。

管理頁右上角可以指定語言，存在 `chrome.storage.local` 的 `uiLanguage`：

- 瀏覽器內建的 `chrome.i18n` 只會照瀏覽器的語言，指定了別的語言時，`i18n.js` 改成自己讀那一份 `messages.json` 查表。
- 小視窗、管理頁、解鎖視窗打開時要馬上知道用哪種語言，所以管理頁換語言時另外在 `localStorage` 存一份 `pk.uiLanguage`。兩份對不上時以 `uiLanguage` 為準，頁面會更新那一份再重新整理。
- 背景程式和網頁裡的 `content.js` 啟動時讀 `uiLanguage`，改了會收到 storage 的變更通知自己換。背景程式讀好語言之前收到的訊息會先等。
- 擴充功能管理頁上的名稱和說明、快捷鍵的說明、工具列圖示的提示文字是瀏覽器用 `__MSG_…__` 顯示的，一定跟著瀏覽器的語言。

- 文字放在 `_locales/<語言>/messages.json`，每種語言的 key 要一樣。
- 程式裡先在檔案開頭寫 `const { t, tn } = PK.i18n;`，再用 `t('key')` 拿文字，有替換值的寫 `t('key', 值)`，訊息裡用 `$1`、`$2` 對應。顯示數量的用 `tn('key', 數量)`，翻譯檔要有 `key_one` 和 `key_other`。`tn` 用 `Intl.PluralRules` 照各語言的文法挑：俄文另外要 `key_few`（2～4）和 `key_many`（0、5～20），中文、日文、韓文、泰文、台語不分單複數，`_one`、`_other` 寫一樣。
- HTML 寫 `<span data-i18n="key">繁體中文原文</span>`，屬性用 `data-i18n-placeholder`、`data-i18n-title`、`data-i18n-aria-label`、`data-i18n-tip`。HTML 裡的中文要跟繁體中文翻譯檔一字不差。
- key 要寫死在程式裡，不能用字串拼出來，`tools/check.js` 才找得到。
- 用來比對網頁上文字的中文（例如認登入按鈕的關鍵字）不是介面文字，在同一行註解寫 `i18n-ignore`。
- `node tools/check.js` 會擋：各語言的 key 不一樣（俄文少了 `_few`、`_many` 也算）、替換值對不上、用到的 key 不存在、留著沒用的 key、程式或 HTML 裡還有沒翻到的中文。
- `node test/e2e/run.js` 的多國語系案例會用繁中以外的每一種介面打開各畫面，找漏翻的字，截圖放在測試輸出的資料夾。

要加新語言：

1. 複製 `_locales/en` 成新的語言代碼資料夾（例如法文 `fr`），把裡面的文字翻掉，`locale_code` 和 `lang_tag` 改成新的語言代碼。
2. 語言代碼加進 `tools/lib/i18n-check.js` 的 `LOCALES` 和 `src/shared/i18n.js` 的 `i18nLocales()`。`tools/check.js` 會比對這兩份清單和語言選單。
3. 版本紀錄（`src/options/changelog.js`）和 GitHub Release 說明只寫繁中、英文、日文三種，新語言的介面會顯示英文的版本紀錄，不用加。
4. 管理頁頁首的語言選單（`src/options/options.html` 的 `langSelect`）加一個選項，`src/options/options.js` 的 `renderLanguagePicker` 加上那個語言的名稱。每一份翻譯檔都加 `lang_name_<語言代碼>`，內容一律寫那個語言自己的寫法，例如 `Français`。
5. 字型跟繁中不合的語言（例如日文、韓文、泰文），`src/shared/ui.css` 和 `src/content/ui.js` 的 `FONTS` 加上那個語言的字型。
6. `test/e2e/run.js` 的多國語系案例（`I18N_CASES`）加上那個語言。

## 檢查和測試

改完送出之前，至少跑前三項：

```bash
node tools/check.js
```

```bash
node --test test/unit/*.test.js
```

```bash
node test/e2e/run.js
```

- `node tools/check.js`：檢查版本號、版本紀錄、打包清單和程式語法。要打包的程式裡出現 `innerHTML`、`eval`、`new Function`、`document.write` 這類會把字串當成 HTML 或程式執行的寫法也會擋下來，畫面一律用 `textContent`、`createElement` 建。另外也擋：檔案第一句不是 `'use strict';`、最外層定義了全域的名稱、在 `platform.js` 以外判斷瀏覽器，見「程式怎麼組織」。
- `node --test test/unit/*.test.js`：不開瀏覽器，幾秒鐘跑完。把 `background.js` 載進 Node，配一份放在記憶體的假 chrome API，測訊息規則和計算用的函式。CI 每次都會跑。
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
5. commit 之後打標籤，推上 GitHub。標籤一定要 `v` 開頭，像 `1.13.0` 這種沒有 `v` 的標籤不會觸發發布：

   ```bash
   git tag v1.14.0
   ```

   ```bash
   git push origin main --tags
   ```

6. GitHub Actions 會再檢查一次，確認標籤跟 `manifest.json` 的版本一樣，接著打包並建立 Release，附上 `password-keeper-1.14.0.zip` 和 `.sha256`。Release 頁面上 GitHub 自己加的「Source code (zip)」是原始碼，不能直接載入，要下載的是 `password-keeper-版本號.zip`。

想在本機先看打包結果，執行 `node tools/build.js`，檔案會在 `dist/`。同一版每次打包出來的 zip 都一模一樣。

推上分支或開 PR 時，CI 也會打包一份，放在那次執行頁面最下面的「Artifacts」，名稱就是 zip 的檔名，下載下來就是可以解壓縮載入的檔案。這份只給測試用，90 天後會被 GitHub 刪掉，正式版一律從 Releases 下載。

## 檢查新版

正式版每天到 GitHub 問一次 `releases/latest`，有比自己新的版本就在小視窗和管理頁提醒。要能運作有幾個條件：

- repo 要是公開的。私人 repo 沒登入問不到，擴充功能會當作「還沒有發布正式版」。
- Release 要附上 `password-keeper-版本號.zip`，檔名對不上就不會出現下載按鈕。照上面的流程發布就會有。
- repo 改名或搬家時，改 `src/background/background.js` 的 `UPDATE_REPO`。

只有擴充功能 ID 是正式版的 `fgmjnolhbeohanamhnomcpmolhdapdkg` 才會自動檢查，開發版只能在「版本」分頁手動按「立即檢查」。e2e 測試把 `updateApi` 換成本機的假 GitHub，不會真的連出去。

## 正式版的擴充功能 ID

`tools/build.js` 打包時會在 zip 裡的 `manifest.json` 加上一把固定的公鑰（`key` 欄位），正式版的擴充功能 ID 一律是 `fgmjnolhbeohanamhnomcpmolhdapdkg`。使用者把新版解壓縮到別的資料夾，也還是同一個擴充功能，存的密碼和設定都在。

- 不要改 `tools/build.js` 裡的公鑰。改了之後，已經裝過正式版的人裝新版會變成另一個擴充功能，看不到原本的資料。
- 專案資料夾裡的 `manifest.json` 不放這把公鑰，開發版的 ID 才不會變。
- 這把公鑰只用來固定 ID，對應的私鑰沒有保存。Edge 和 Chrome 不讓商店以外的 `.crx` 安裝，用不到私鑰。
