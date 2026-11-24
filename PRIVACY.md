# 隱私權政策

繁體中文 | [English](#privacy-policy) | [日本語](#プライバシーポリシー)

密碼小管家是瀏覽器擴充功能，幫你在網站上儲存和自動填入帳號密碼。這份說明寫的是擴充功能會碰到哪些資料、存在哪裡、會不會送出去。

## 存哪些資料、存在哪裡

- 你按「儲存」或自己新增的帳號、密碼、網站、備註，以及擴充功能的設定和備份紀錄。
- 這些資料只存在這台電腦的瀏覽器裡，不會上傳到任何伺服器，開發者也拿不到。
- 移除擴充功能時，瀏覽器會一起刪掉這些資料。你自己匯出、或自動備份存到「下載」資料夾的備份檔不會被刪。

## 擴充功能在網頁上做什麼

- 讀網頁上的登入欄位，登入後問你要不要儲存，下次打開登入頁時自動填入。
- 只在你所在的那個網站填入那個網站的帳號，網頁的內容不會送到任何地方。
- 瀏覽器跳出「需要驗證」的帳密視窗時，那個網站有存帳號的話，直接交給瀏覽器回答。
- Firefox 的私密視窗裡什麼都不做：不填入、不問要不要儲存，私密瀏覽的資料一律不存。

## 剪貼簿

- 管理頁打開「複製密碼後自動清除剪貼簿」時，瀏覽器會問要不要給剪貼簿的權限。沒打開就不會要這個權限。
- 給了權限之後，擴充功能只在時間到、或工具鎖上時讀一次剪貼簿，比對是不是擴充功能自己複製的那組密碼，是的話才清掉。
- 讀到的內容不會存下來，也不會送到任何地方。擴充功能只在記憶體裡記著複製的那組密碼的雜湊值，用來比對。

## 會不會連到外面

- 從瀏覽器商店安裝的版本，不會自己連到外面。只有按「檢查有沒有外洩」時會連，見下一點。
- 在管理頁按「檢查有沒有外洩」時，會連到 Have I Been Pwned（`api.pwnedpasswords.com`）。每組密碼只送 SHA-1 雜湊值的前 5 碼，拿回所有前 5 碼一樣的雜湊值後段，在這台電腦比對。對方看不到密碼，也猜不出是哪組密碼。請求不帶 cookie，結果不會存。沒按就不會連。Firefox 版第一次按時，Firefox 會先問你同不同意。
- 從 GitHub Releases 下載的 Edge、Chrome 版，每天一次到 GitHub（`api.github.com`）問最新的版本號，可以在管理頁「版本」分頁關掉。從 GitHub Releases 下載的 Firefox 版，只在使用者按「立即檢查」時才問。這個請求不帶 cookie，不會送出任何帳號、密碼、網站或設定。

## 不做的事

- 不蒐集使用資料，不做統計或追蹤，也沒有廣告。
- 不把任何資料賣給或交給第三方。外洩檢查送出的只有密碼雜湊值的前 5 碼，對方從這段沒辦法知道密碼。

## 聯絡

有問題請到 [GitHub 專案](https://github.com/Mukula1221/PasswordKeeperExtension) 開 issue。資安問題照 [SECURITY.md](SECURITY.md) 私下回報。這份政策有改的話，會寫在 [CHANGELOG.md](CHANGELOG.md)。

---

# Privacy Policy

Password Keeper is a browser extension that saves and fills in your usernames and passwords on websites. This page explains what data the extension handles, where it is stored, and whether it is ever sent anywhere.

## What is stored and where

- The usernames, passwords, sites, and notes you choose to save or add yourself, plus the extension's settings and backup log.
- This data stays in the browser on this computer. It is never uploaded to any server, and the developer has no access to it.
- When you remove the extension, the browser deletes this data. Backup files you exported, or that auto backup saved to your Downloads folder, are not deleted.

## What the extension does on web pages

- It reads login fields on web pages, offers to save a login after you sign in, and fills it in the next time you open the login page.
- It fills in only the accounts saved for the site you are on. Page content is never sent anywhere.
- When the browser shows its own sign-in prompt (HTTP authentication) for a site with a saved account, the extension answers it for you.
- In Firefox private windows it does nothing: no autofill and no offer to save. Nothing from private browsing is ever stored.

## Clipboard

- When you turn on "Clear the clipboard after copying a password" on the manager page, the browser asks for clipboard permission. The extension doesn't ask for it unless you turn this on.
- With the permission, the extension reads the clipboard only when the time is up or the extension locks, to check whether it still holds the password the extension copied. If it does, the extension clears it.
- What it reads is never stored or sent anywhere. The extension keeps only a hash of the copied password in memory for the comparison.

## Network connections

- Versions installed from a browser store never connect out on their own. They connect only when you click "Check for breaches", described next.
- When you click "Check for breaches" on the manager page, the extension connects to Have I Been Pwned (`api.pwnedpasswords.com`). For each password it sends only the first 5 characters of its SHA-1 hash, gets back every hash suffix with that prefix, and compares them on this computer. The service never sees your passwords and can't tell which password you asked about. The request carries no cookies, and results aren't saved. Nothing is sent unless you click. In the Firefox version, Firefox asks for your consent the first time.
- The Edge and Chrome versions downloaded from GitHub Releases ask GitHub (`api.github.com`) for the latest version number once a day. You can turn it off in the Versions tab on the manager page. The Firefox version from GitHub Releases asks only when you click "Check now". The request carries no cookies and sends no usernames, passwords, sites, or settings.

## What the extension never does

- It does not collect usage data, run analytics or tracking, or show ads.
- It does not sell or share any data with third parties. The breach check sends only the first 5 characters of each password's hash, which can't reveal the password.

## Contact

Open an issue on the [GitHub project](https://github.com/Mukula1221/PasswordKeeperExtension) for questions. Report security issues privately as described in [SECURITY.md](SECURITY.md). Changes to this policy are listed in [CHANGELOG.md](CHANGELOG.md).

---

# プライバシーポリシー

パスワードキーパーは、Web サイトのユーザー名とパスワードを保存して自動入力するブラウザー拡張機能です。このページでは、拡張機能が扱うデータ、保存場所、外部に送信されるかどうかを説明します。

## 保存するデータと保存場所

- 保存を選んだ、または自分で追加したユーザー名、パスワード、サイト、メモ。拡張機能の設定とバックアップの記録。
- これらのデータはこのパソコンのブラウザーにだけ保存されます。どのサーバーにもアップロードされず、開発者もアクセスできません。
- 拡張機能を削除すると、ブラウザーがこれらのデータも削除します。自分でエクスポートしたバックアップや、自動バックアップで「ダウンロード」フォルダーに保存されたファイルは削除されません。

## Web ページ上での動作

- Web ページのログイン欄を読み取り、ログイン後に保存するか確認し、次にログインページを開いたときに自動入力します。
- 入力するのは、開いているサイトに保存されたアカウントだけです。ページの内容はどこにも送信しません。
- サイトに保存済みのアカウントがある場合、ブラウザーが表示する認証ダイアログ（HTTP 認証）に代わりに応答します。
- Firefox のプライベートウィンドウでは何もしません。自動入力も保存の確認も行わず、プライベートブラウジングのデータは一切保存しません。

## クリップボード

- 管理ページで「パスワードをコピーしたらクリップボードを消去」をオンにすると、ブラウザーがクリップボードの権限を求めます。オンにしない限り、この権限は求めません。
- 権限を与えると、拡張機能は時間になったときかロックしたときにだけクリップボードを一度読み、拡張機能がコピーしたパスワードのままかどうかを確かめます。そのままなら消去します。
- 読み取った内容は保存も送信もしません。比較のため、コピーしたパスワードのハッシュ値だけをメモリーに保持します。

## 外部への接続

- ブラウザーのストアからインストールした版は、自分から外部に接続しません。「漏えいを確認」を押したときだけ接続します（次の項目を参照）。
- 管理ページで「漏えいを確認」を押すと、Have I Been Pwned（`api.pwnedpasswords.com`）に接続します。各パスワードについて送るのは SHA-1 ハッシュ値の先頭 5 文字だけで、同じ先頭を持つハッシュ値の残りの部分を受け取り、このパソコンで照合します。相手にパスワードは見えず、どのパスワードかも分かりません。Cookie は付けず、結果も保存しません。押さない限り接続しません。Firefox 版では、初回に Firefox が同意を確認します。
- GitHub Releases からダウンロードした Edge 版と Chrome 版は、1 日 1 回 GitHub（`api.github.com`）に最新のバージョン番号を問い合わせます。管理ページの「バージョン」タブでオフにできます。GitHub Releases の Firefox 版は「今すぐ確認」を押したときだけ問い合わせます。この通信には Cookie を付けず、ユーザー名、パスワード、サイト、設定は送信しません。

## 行わないこと

- 利用データの収集、分析、追跡、広告表示は行いません。
- データを第三者に販売したり提供したりしません。漏えいの確認で送るのはパスワードのハッシュ値の先頭 5 文字だけで、そこからパスワードは分かりません。

## お問い合わせ

ご質問は [GitHub プロジェクト](https://github.com/Mukula1221/PasswordKeeperExtension) の issue でお寄せください。セキュリティの問題は [SECURITY.md](SECURITY.md) の手順に従って非公開で報告してください。このポリシーを変更した場合は [CHANGELOG.md](CHANGELOG.md) に記載します。
