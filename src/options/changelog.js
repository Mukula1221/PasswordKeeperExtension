// 版本功能歷程。管理頁的「版本」分頁照這個陣列畫出來，新版本加在最前面。
// 每一版：version（要和 manifest.json 一致）、date、items（加了什麼）、notes（要注意的事，沒有就整個省略）。
// items、notes 照語言分開寫：{ zh_TW: [...], en: [...], ja: [...] }，三種語言的條數要一樣、順序要對應。
// 翻譯直接寫在這裡、不用 t()：tools/ 產生 CHANGELOG.md 和 GitHub Release 說明時也會讀這個檔，那裡沒有 chrome.i18n。
const CHANGELOG = [
  {
    version: '1.14.0',
    date: '2026-11-07',
    items: {
      zh_TW: [
        '會到 GitHub 檢查有沒有新版。有新版時小視窗和管理頁會提醒，管理頁「版本」分頁可以直接下載新版的 zip，也有更新步驟。',
        '從 Releases 下載的正式版預設每天自動檢查一次，可以在「版本」分頁關掉，也可以按「立即檢查」。只會問 GitHub 最新的版本號，不會送出任何密碼、帳號或設定。',
        '自動備份預設的子資料夾改成「下載」底下的 password-keeper。',
      ],
      en: [
        'The extension now checks GitHub for new versions. When one is available, the popup and the manager page let you know, and the Versions tab on the manager page lets you download the new zip and shows how to update.',
        'Release versions downloaded from Releases check automatically once a day. You can turn this off or click "Check now" in the Versions tab. It only asks GitHub for the latest version number and never sends passwords, accounts, or settings.',
        'The default auto backup subfolder is now password-keeper under Downloads.',
      ],
      ja: [
        'GitHub で新しいバージョンを確認するようになりました。新しいバージョンがあると、ポップアップと管理ページでお知らせします。管理ページの「バージョン」タブから新しい zip をダウンロードでき、更新手順も表示されます。',
        'Releases からダウンロードしたリリース版は、既定で 1 日 1 回自動で確認します。「バージョン」タブでオフにしたり、「今すぐ確認」を押したりできます。GitHub に最新のバージョン番号を問い合わせるだけで、パスワード、アカウント、設定は送信しません。',
        '自動バックアップの既定のサブフォルダーを、「ダウンロード」の下の password-keeper に変更しました。',
      ],
    },
    notes: {
      zh_TW: ['已經存過設定的人，自動備份照舊存到原本的資料夾，不會被搬走。要換的話到管理頁「備份」分頁改資料夾名稱。'],
      en: ["If you've already saved settings, auto backups keep going to your current folder and aren't moved. To change it, edit the folder name in the Backup tab on the manager page."],
      ja: ['すでに設定を保存している場合、自動バックアップはこれまでのフォルダーに保存され続け、移動されません。変更するときは、管理ページの「バックアップ」タブでフォルダー名を変えてください。'],
    },
  },
  {
    version: '1.13.0',
    date: '2026-11-06',
    items: {
      zh_TW: [
        '介面支援繁體中文、英文、日文。預設跟著瀏覽器的語言，瀏覽器是其他語言時顯示英文。',
        '管理頁右上角可以選介面語言：跟著瀏覽器、繁體中文、English、日本語。小視窗、解鎖視窗、網頁上的提示和背景程式的訊息都會跟著換。',
        '日文網站上也認得帳號欄、登入按鈕和登出按鈕。',
        '開始在 GitHub 發布。每一版都有可以直接載入的打包檔，從 Releases 下載的正式版換資料夾更新，存的密碼和設定都會留著。',
      ],
      en: [
        'The interface is now available in Traditional Chinese, English, and Japanese. It follows the browser language by default and shows English for other languages.',
        'You can choose the display language at the top right of the manager page: browser default, Traditional Chinese, English, or Japanese. The popup, the unlock window, prompts on web pages, and messages from the extension all follow it.',
        'Username fields and sign-in and sign-out buttons are now also recognized on Japanese sites.',
        'Releases are now published on GitHub. Every version comes with a package you can load directly, and release versions keep your saved passwords and settings when you update from a different folder.',
      ],
      ja: [
        '画面の表示が繁体字中国語・英語・日本語に対応しました。既定ではブラウザーの言語に合わせて表示され、それ以外の言語では英語で表示されます。',
        '管理ページの右上で表示言語を選べます（ブラウザーに合わせる、繁体字中国語、英語、日本語）。ポップアップ、ロック解除ウィンドウ、Web ページ上の表示、拡張機能からのメッセージも切り替わります。',
        '日本語のサイトでも、ユーザー名の欄とログイン・ログアウトのボタンを認識するようになりました。',
        'GitHub でリリースを公開するようになりました。各バージョンにそのまま読み込めるパッケージがあり、Releases からダウンロードしたリリース版は別のフォルダーから更新しても、保存したパスワードと設定が残ります。',
      ],
    },
    notes: {
      zh_TW: [
        '從 Releases 下載的正式版，跟直接載入原始碼資料夾的開發版是兩個不同的擴充功能，資料不互通。要換成正式版，先匯出加密備份，裝好後再匯入。',
        '擴充功能管理頁上的名稱和說明、快捷鍵的說明、工具列圖示的提示文字，還是跟著瀏覽器的語言，擴充功能改不了。',
      ],
      en: [
        'A release version downloaded from Releases and a copy loaded from the source folder are two different extensions and don\'t share data. To switch to the release version, export an encrypted backup, then import it after installing.',
        "The extension's name and description on the extensions page, the shortcut description, and the toolbar icon tooltip still follow the browser language. Extensions can't change these.",
      ],
      ja: [
        'Releases からダウンロードしたリリース版と、ソースのフォルダーを直接読み込んだ開発版は別の拡張機能で、データは共有されません。リリース版に切り替えるときは、暗号化バックアップをエクスポートし、インストール後にインポートしてください。',
        '拡張機能ページの名前と説明、ショートカットの説明、ツールバーのアイコンのツールチップは、ブラウザーの言語のままです。拡張機能からは変更できません。',
      ],
    },
  },
  {
    version: '1.12.0',
    date: '2026-11-06',
    items: {
      zh_TW: [
        '解鎖視窗等 Windows Hello 時只顯示「沒有自動跳出來？點這裡重新開啟」，不再同時出現解鎖按鈕。Windows Hello 按了取消或逾時，才出現「再試一次」。',
        '修正：Windows Hello 跳在別的視窗後面時，按解鎖視窗的按鈕沒有反應。現在按「點這裡重新開啟」會重新叫一次。',
        '小視窗拿掉搜尋框下面的空白。「自動填入」「自動填完就按登入」「選要自動點的按鈕」集中到「這個網站」底下。',
        '小視窗的「鎖定」移到右上角，改成有鎖頭圖示的按鈕。',
      ],
      en: [
        'While waiting for Windows Hello, the unlock window shows only "Didn\'t pop up? Click here to open it again", without an unlock button. "Try again" appears only after you cancel Windows Hello or it times out.',
        'Fixed: When Windows Hello opened behind another window, the button in the unlock window did nothing. "Click here to open it again" now brings it up again.',
        'The popup no longer has a blank space below the search box. "Autofill", "Sign in after autofill", and "Pick a button to auto-click" are now grouped under "This site".',
        'The popup\'s "Lock" is now a button with a lock icon in the top-right corner.',
      ],
      ja: [
        'Windows Hello を待っている間、ロック解除ウィンドウには「自動で表示されませんか？ここをクリックしてもう一度開く」だけを表示し、ロック解除ボタンは同時に表示されなくなりました。Windows Hello でキャンセルしたかタイムアウトしたときだけ「再試行」が表示されます。',
        '修正：Windows Hello がほかのウィンドウの後ろに表示されたとき、ロック解除ウィンドウのボタンを押しても反応しませんでした。「ここをクリックしてもう一度開く」を押すと、もう一度呼び出すようになりました。',
        'ポップアップの検索ボックスの下の余白をなくしました。「自動入力」「自動入力後にログイン」「自動クリックするボタンを選ぶ」は「このサイト」の下にまとめました。',
        'ポップアップの「ロック」を右上に移し、鍵のアイコン付きのボタンにしました。',
      ],
    },
  },
  {
    version: '1.11.0',
    date: '2026-11-05',
    items: {
      zh_TW: [
        '管理頁的自動點選可以按「＋ 新增」手動新增規則。貼整個網址會自動拆成網站和網址。',
        '各畫面的說明改短，細節放進旁邊的「?」，滑鼠移上去或按 Tab 移過去就會顯示。',
        '備份和設定分頁的每個區塊都可以點標題收合。工具鎖定、危險區、和瀏覽器互搬密碼、備份紀錄預設收合。',
        '「立即備份一次」改名「立即備份」，按鈕移到「自動備份」標題旁邊，區塊收起來也按得到。',
        '修正：管理頁開著對話框時工具鎖定被觸發，對話框還蓋在驗證畫面上，按「顯示」看得到密碼。現在鎖定時會關掉對話框，打到一半的密碼也會清掉。',
      ],
      en: [
        'You can now add auto-click rules manually with "+ Add" on the manager page. Pasting a full URL splits it into the site and the path automatically.',
        'Help text on each screen is shorter, with details in the "?" next to it. Hover over the "?" or move to it with Tab to see them.',
        'Every section on the Backup and Settings tabs can be collapsed by clicking its title. App lock, Danger zone, moving passwords to and from browsers, and backup history are collapsed by default.',
        '"Back up once now" is renamed "Back up now". Its button is now next to the "Auto backup" title, so you can click it even when the section is collapsed.',
        'Fixed: When App lock triggered while a dialog was open on the manager page, the dialog stayed on top of the verification screen, and clicking "Show" revealed the password. Locking now closes the dialog and also clears a half-typed password.',
      ],
      ja: [
        '管理ページの自動クリックで「＋ 追加」を押すと、ルールを手動で追加できます。URL 全体を貼り付けると、サイトとパスに自動で分けます。',
        '各画面の説明を短くし、詳しい内容は横の「?」に入れました。マウスを合わせるか Tab キーで移動すると表示されます。',
        'バックアップと設定のタブでは、各セクションの見出しをクリックすると折りたためます。アプリロック、危険な操作、ブラウザーとのパスワードの移行、バックアップ履歴は最初から折りたたまれています。',
        '「今すぐ 1 回バックアップ」を「今すぐバックアップ」に名前を変えました。ボタンは「自動バックアップ」の見出しの横に移したので、セクションを折りたたんでいても押せます。',
        '修正：管理ページでダイアログを開いたままアプリロックがかかると、ダイアログが認証画面の上に残り、「表示」を押すとパスワードが見えていました。ロック時にダイアログを閉じ、入力途中のパスワードも消すようになりました。',
      ],
    },
  },
  {
    version: '1.10.0',
    date: '2026-11-05',
    items: {
      zh_TW: [
        '管理頁的自動點選改成按網站分開，每個網站可以收合。',
        '同一個網站的規則可以用 ▲▼ 調整順序。同一頁有好幾條時，前一條點完才輪下一條。',
        '每條規則可以選等不到按鈕時要怎麼辦：跳過、換下一條，或停止、後面都不點。',
        '每條規則顯示選擇器和按鈕文字，都可以改。',
        '間隔可以用秒設定。每條規則可以自己填，沒填的規則和「自動填完按登入」用共用的間隔預設值。',
        '按登出後暫停多久可以另外設定，填 0 不暫停。',
      ],
      en: [
        'Auto-click rules on the manager page are now grouped by site, and each site can be collapsed.',
        'You can reorder a site\'s rules with ▲▼. When a page has several rules, the next rule waits until the previous one has clicked.',
        'Each rule can set what to do when its button never appears: skip and move on to the next rule, or stop and click nothing after it.',
        'Each rule shows its selector and button text, and you can edit both.',
        'Intervals can be set in seconds. Each rule can have its own. Rules without one, and "Sign in after autofill", use the shared default interval.',
        'The pause after sign-out can be set separately. Enter 0 for no pause.',
      ],
      ja: [
        '管理ページの自動クリックをサイトごとに分け、サイトごとに折りたためるようにしました。',
        '同じサイトのルールは ▲▼ で順番を変えられます。同じページに複数のルールがあるときは、前のルールのクリックが終わってから次のルールに進みます。',
        'ルールごとに、ボタンが現れないときの動作を選べます：スキップして次のルールに進む、または停止して以降はクリックしない。',
        '各ルールにセレクターとボタンのテキストを表示し、どちらも編集できます。',
        '間隔を秒単位で設定できます。ルールごとに個別に入力でき、入力していないルールと「自動入力後にログイン」は共通の既定の間隔を使います。',
        'ログアウト後の一時停止の長さを個別に設定できます。0 を入力すると一時停止しません。',
      ],
    },
    notes: {
      zh_TW: ['同一頁有好幾條時，前一條的按鈕還沒出現，後面的會等它，最多 15 秒。以前是誰先出現就先點誰。'],
      en: ['When a page has several rules and the previous rule\'s button hasn\'t appeared yet, later rules wait for it, up to 15 seconds. Previously, whichever button appeared first was clicked first.'],
      ja: ['同じページに複数のルールがあり、前のルールのボタンがまだ表示されていない場合、後のルールは最大 15 秒待ちます。以前は先に表示されたボタンから順にクリックしていました。'],
    },
  },
  {
    version: '1.9.0',
    date: '2026-11-03',
    items: {
      zh_TW: [
        '自動點選：在網頁上選一顆按鈕，之後開到那一頁就自動點。可以選「自動填完才點」或「頁面一打開就點」，後者不用存帳號。',
        '小視窗加「選要自動點的按鈕」。管理頁「設定」分頁加「自動點選」表，可以開關、改網址、刪除。',
        '同一個分頁 5 分鐘內，同一條規則只點一次。按了登出的網站，這個分頁 5 分鐘內不自動點。',
        '修正：「自動填完按登入」遇到密碼錯、頁面重新載入時會一直重試。現在同一個分頁 5 分鐘內只按一次。',
        '完整的加密備份會帶上自動點選的規則。',
        '管理頁的密碼、備份紀錄、各網站、自動點選表和回收桶，列太多時自己捲動，表格的標題固定在上面。',
      ],
      en: [
        'Auto-click: Pick a button on a web page, and it\'s clicked automatically whenever you open that page. You can choose "After autofill" or "As soon as the page opens". The latter doesn\'t need a saved account.',
        'The popup has a new "Pick a button to auto-click" button. The manager page\'s "Settings" tab has a new "Auto-click" table where you can turn rules on or off, change URLs, and delete them.',
        'In the same tab, each rule clicks only once within 5 minutes. After you click sign out on a site, that tab doesn\'t auto-click for 5 minutes.',
        'Fixed: "Sign in after autofill" kept retrying when the password was wrong and the page reloaded. It now clicks only once per tab within 5 minutes.',
        'Full encrypted backups include auto-click rules.',
        'On the manager page, the passwords, backup history, per-site settings, auto-click, and Trash tables scroll on their own when they have many rows, with the table headers fixed at the top.',
      ],
      ja: [
        '自動クリック：ウェブページ上のボタンを選ぶと、次からそのページを開いたときに自動でクリックします。「自動入力が終わったら」か「ページを開いたらすぐ」を選べます。後者はアカウントを保存していなくても使えます。',
        'ポップアップに「自動クリックするボタンを選ぶ」を追加しました。管理ページの「設定」タブに「自動クリック」の表を追加し、オン／オフの切り替え、URL の変更、削除ができます。',
        '同じタブでは、同じルールは 5 分以内に 1 回だけクリックします。ログアウトを押したサイトでは、そのタブで 5 分間は自動クリックしません。',
        '修正：「自動入力後にログイン」は、パスワードが間違っていてページが再読み込みされると、何度も再試行していました。同じタブでは 5 分以内に 1 回だけ押すようになりました。',
        '完全な暗号化バックアップに自動クリックのルールも含めます。',
        '管理ページのパスワード、バックアップ履歴、サイト別設定、自動クリック、ごみ箱の表は、行が多いと表の中でスクロールし、見出しは上に固定されます。',
      ],
    },
    notes: {
      zh_TW: ['最低瀏覽器版本從 108 改成 111。'],
      en: ['The minimum browser version is now 111, up from 108.'],
      ja: ['対応するブラウザーの最低バージョンを 108 から 111 に変更しました。'],
    },
  },
  {
    version: '1.8.0',
    date: '2026-10-30',
    items: {
      zh_TW: [
        '管理頁「設定」分頁加「各網站」表，每個網站可以分開設定自動填入和自動填完按登入，不用先開到那個網站。',
        '「各網站」表每一欄都有全選、清除所有，改完按「套用」才生效。',
        '小視窗的「自動填入」改成「這個網站自動填入」，只管目前這個網站。',
      ],
      en: [
        'The manager page\'s "Settings" tab has a new "Per-site settings" table. Each site\'s autofill and "Sign in after autofill" can be set separately, without opening the site first.',
        'Every column in the "Per-site settings" table can be selected or cleared all at once. Changes take effect only after you click "Apply".',
        'The popup\'s "Autofill" is now "Autofill on this site" and applies only to the current site.',
      ],
      ja: [
        '管理ページの「設定」タブに「サイト別設定」の表を追加しました。サイトを開かなくても、サイトごとに自動入力と自動入力後のログインを設定できます。',
        '「サイト別設定」の表は、列ごとにすべて選択とすべてクリアができます。変更は「適用」を押すと反映されます。',
        'ポップアップの「自動入力」を「このサイトで自動入力」に変え、今開いているサイトだけに適用されるようにしました。',
      ],
    },
    notes: {
      zh_TW: ['「打開登入頁時自動填入帳號密碼」還是總開關，關掉時所有網站都不自動填。'],
      en: ['"Autofill usernames and passwords when a sign-in page opens" is still the master switch. When it\'s off, no site is autofilled.'],
      ja: ['「ログインページを開いたときにユーザー名とパスワードを自動入力」は引き続きマスタースイッチです。オフにすると、どのサイトでも自動入力しません。'],
    },
  },
  {
    version: '1.7.0',
    date: '2026-10-30',
    items: {
      zh_TW: [
        '修正：瀏覽器開著不關時，自動備份幾乎不會跑。',
        '自動備份可以指定每天或每週的幾點，錯過時間會在下次開瀏覽器時補做。',
        '自動備份區塊顯示下次備份時間和上次檢查結果。',
        '刪除、復原、匯入帳號也算有改過，自動備份不會跳過。',
        '「立即備份一次」的紀錄和檔名改成「立即備份」，算手動。',
        '備份紀錄可以按自動、手動篩選。',
        '備份紀錄可以刪除，也可以連備份檔一起刪。',
        '回收桶可以勾選多筆一起還原或永久刪除。',
        '回收桶的保留天數可以改。',
      ],
      en: [
        'Fixed: Auto backup almost never ran while the browser stayed open.',
        'Auto backup can run at a set time every day or every week. If that time is missed, it runs the next time you open the browser.',
        'The auto backup section shows the next backup time and the result of the last check.',
        'Deleting, restoring, and importing accounts also count as changes, so auto backup doesn\'t skip them.',
        '"Back up once now" backups are now labeled "Back up now" in the history and file name, and count as manual.',
        'Backup history can be filtered by auto or manual.',
        'Backup history entries can be deleted, with or without their backup files.',
        'In Trash, you can select several items to restore or delete permanently at once.',
        'You can change how many days Trash keeps items.',
      ],
      ja: [
        '修正：ブラウザーを開いたままにしていると、自動バックアップがほとんど実行されませんでした。',
        '自動バックアップは毎日または毎週の時刻を指定できます。その時刻を過ぎていた場合は、次にブラウザーを開いたときに実行します。',
        '自動バックアップのセクションに、次回のバックアップ時刻と前回の確認結果を表示します。',
        'アカウントの削除、復元、インポートも変更として扱うので、自動バックアップがスキップされません。',
        '「今すぐ 1 回バックアップ」の履歴とファイル名を「今すぐバックアップ」に変え、手動として扱います。',
        'バックアップ履歴を自動と手動で絞り込めます。',
        'バックアップ履歴を削除できます。バックアップファイルもまとめて削除できます。',
        'ごみ箱で複数の項目を選んで、まとめて復元または完全に削除できます。',
        'ごみ箱の保存日数を変更できます。',
      ],
    },
    notes: {
      zh_TW: [
        '之前「立即備份一次」的紀錄已經記成自動備份，分不回來。',
        '已經開著自動備份的，更新後時間是 12:00，選每週的是星期一。',
      ],
      en: [
        'Earlier "Back up once now" records were already saved as auto backups and can\'t be told apart.',
        'If auto backup was already on, it runs at 12:00 after the update, and weekly backups run on Monday.',
      ],
      ja: [
        '以前の「今すぐ 1 回バックアップ」の履歴はすでに自動バックアップとして記録されているため、区別できません。',
        'すでに自動バックアップをオンにしていた場合、更新後の時刻は 12:00、毎週の場合は月曜日になります。',
      ],
    },
  },
  {
    version: '1.6.0',
    date: '2026-10-28',
    items: {
      zh_TW: [
        '匯入 CSV 看得懂 Chrome、Edge、Firefox、Safari 匯出的密碼檔；用 Excel 存過變成 Big5 的檔案也讀得出來。Firefox 檔案裡的建立、使用、改密碼時間會沿用。',
        '和瀏覽器來回搬不會把新密碼蓋回舊的：檔案裡的密碼如果是這邊已經換掉的舊密碼，保留這邊的。檔案裡沒有備註也不會清掉這邊的備註。',
        '手機 App 的密碼（android:// 開頭）和其他不是網站的項目不再被匯入成怪網站。',
        '匯出 CSV 超過 3000 筆會分成幾個檔，配合 Chrome、Edge 一次最多匯入 3000 筆；欄位太長、瀏覽器會略過的筆數會提醒。',
        '匯入完在備份分頁留一行結果，略過的原因分開算：密碼一樣、檔案的比較舊、不是網站或沒有密碼。',
        '備份分頁多「和瀏覽器互搬密碼」說明，寫各瀏覽器密碼頁在哪、怎麼匯出匯入。',
        '修正：管理頁表格密碼欄的「顯示」「複製」「舊密碼」按鈕疊在一起。',
      ],
      en: [
        'CSV import understands password files exported from Chrome, Edge, Firefox, and Safari. It can also read files that turned into Big5 after being saved in Excel. Created, last used, and password changed times in Firefox files are kept.',
        'Moving passwords back and forth with a browser doesn\'t overwrite new passwords with old ones: if a password in the file is an old one you already changed here, the one here is kept. A file without notes doesn\'t clear the notes here.',
        'Mobile app passwords (starting with android://) and other non-website items are no longer imported as odd sites.',
        'CSV exports with more than 3,000 entries are split into several files, because Chrome and Edge import at most 3,000 at a time. It also warns how many entries the browser would skip because a field is too long.',
        'After an import, the Backup tab shows a one-line result, with skipped entries counted by reason: same password, older copy in the file, or not a site or no password.',
        'The Backup tab has a new "Move passwords to and from browsers" guide that shows where each browser\'s password page is and how to export and import.',
        'Fixed: The "Show", "Copy", and "Previous passwords" buttons in the password column of the manager page\'s table overlapped.',
      ],
      ja: [
        'CSV のインポートで、Chrome、Edge、Firefox、Safari からエクスポートしたパスワードファイルを読み込めます。Excel で保存して Big5 になったファイルも読み込めます。Firefox のファイルにある作成日時、使用日時、パスワード変更日時は引き継ぎます。',
        'ブラウザーとの間でパスワードをやり取りしても、新しいパスワードが古いもので上書きされません。ファイル内のパスワードがこちらで変更済みの古いパスワードなら、こちらのものを残します。ファイルにメモがなくても、こちらのメモは消えません。',
        'スマートフォンアプリのパスワード（android:// で始まるもの）やサイト以外の項目が、おかしなサイトとしてインポートされなくなりました。',
        'CSV のエクスポートで 3000 件を超えると、複数のファイルに分けます。Chrome と Edge は一度に 3000 件までしかインポートできないためです。項目が長すぎてブラウザーにスキップされる件数もお知らせします。',
        'インポート後、バックアップタブに 1 行の結果を残します。スキップした件数は理由ごとに数えます：パスワードが同じ、ファイルの方が古い、サイトではないかパスワードがない。',
        'バックアップタブに「ブラウザーとのパスワードの移行」の説明を追加しました。各ブラウザーのパスワードページの場所と、エクスポートとインポートの方法を説明しています。',
        '修正：管理ページの表のパスワード列で、「表示」「コピー」「以前のパスワード」ボタンが重なっていました。',
      ],
    },
    notes: {
      zh_TW: ['匯入加密備份也一樣：備份檔裡是這邊已經換掉的舊密碼、或改密碼時間比這邊早的，保留這邊的。'],
      en: ['The same applies to importing encrypted backups: if the backup has an old password you already changed here, or its password changed time is earlier than here, the one here is kept.'],
      ja: ['暗号化バックアップのインポートも同様です。バックアップファイルのパスワードがこちらで変更済みの古いものか、パスワードの変更日時がこちらより前の場合は、こちらのものを残します。'],
    },
  },
  {
    version: '1.5.0',
    date: '2026-10-27',
    items: {
      zh_TW: [
        '「閒置鎖定」改名「工具鎖定」，搬到設定分頁最上面：一把鎖管整個工具，閒置和瀏覽器重開只是底下的「什麼時候自動鎖上」。',
        '工具鎖定拿掉 PIN，只用系統驗證：啟用、解鎖、停用都走 Windows Hello（Mac 是 Touch ID，其他系統用安全金鑰或手機）。',
        '只要有啟用鎖定，每次打開管理頁都要先驗證；管理頁開著時鎖定被觸發，會立刻回到驗證畫面。',
        '自動備份區塊重排：先設密碼，再選多久一次和存到哪，最後才是開關。密碼沒設之前開關不能按。',
        '管理頁多「版本」分頁，列出每一版加了什麼。右上角的版本號點了直接跳過去。',
      ],
      en: [
        '"Idle lock" is renamed "App lock" and is now at the top of the Settings tab. One lock covers the whole extension. Idle and browser restart are just options under "When to lock automatically".',
        'App lock no longer uses a PIN, only system verification. Turning it on, unlocking, and turning it off all use Windows Hello (Touch ID on Mac, a security key or phone on other systems).',
        'When the lock is on, you need to verify every time you open the manager page. If the lock triggers while the manager page is open, it goes straight back to the verification screen.',
        'The auto backup section is reordered: set the password first, then choose how often and where to save, and turn it on last. The switch can\'t be clicked until the password is set.',
        'The manager page has a new "Versions" tab that lists what each version adds. Click the version number in the top-right corner to go straight there.',
      ],
      ja: [
        '「アイドルロック」を「アプリロック」に名前を変え、設定タブの一番上に移しました。1 つのロックで拡張機能全体を守ります。アイドルとブラウザーの再起動は、その下の「自動でロックするタイミング」の選択肢になりました。',
        'アプリロックから PIN をなくし、システム認証だけを使います。有効化、ロック解除、無効化はすべて Windows Hello で行います（Mac では Touch ID、ほかのシステムではセキュリティキーまたはスマートフォン）。',
        'ロックを有効にしていると、管理ページを開くたびに認証が必要です。管理ページを開いている間にロックがかかると、すぐに認証画面に戻ります。',
        '自動バックアップのセクションを並べ替えました。まずパスワードを設定し、次に頻度と保存先を選び、最後にオンにします。パスワードを設定するまでスイッチは押せません。',
        '管理ページに「バージョン」タブを追加し、各バージョンで追加された内容を一覧にしました。右上のバージョン番号をクリックすると直接移動します。',
      ],
    },
    notes: {
      zh_TW: ['1.4 以前只設 PIN 的鎖定，升級後會被關掉，要到設定分頁的「工具鎖定」重新啟用。'],
      en: ['Locks set up with only a PIN in 1.4 or earlier are turned off after the upgrade. Turn it on again under "App lock" on the Settings tab.'],
      ja: ['1.4 以前に PIN だけで設定したロックは、アップグレード後にオフになります。設定タブの「アプリロック」でもう一度有効にしてください。'],
    },
  },
  {
    version: '1.4.0',
    date: '2026-10-27',
    items: {
      zh_TW: [
        '閒置鎖定可以用系統驗證解鎖：Windows 用 Windows Hello，Mac 用 Touch ID，其他系統用安全金鑰或手機。PIN 留著當備援。',
        '小視窗按「用系統驗證解鎖」會先開一個小獨立視窗再驗證，驗過視窗自己關掉。',
        '管理頁改成五個分頁：密碼、備份、設定、回收桶、說明。健檢縮成一行摘要，備份紀錄收成可展開的區塊。',
        '修正：設了 display 的區塊加 hidden 之後還是看得到，造成分頁疊在一起、小視窗多出不該出現的勾選。',
      ],
      en: [
        'Idle lock can be unlocked with system verification: Windows Hello on Windows, Touch ID on Mac, and a security key or phone on other systems. The PIN stays as a backup.',
        'Clicking "Unlock with system verification" in the popup first opens a small separate window for verification, which closes itself after you verify.',
        'The manager page now has five tabs: Passwords, Backup, Settings, Trash, and Help. The health check is now a one-line summary, and backup history is a section you can expand.',
        'Fixed: Sections with a CSS display value stayed visible after getting the hidden attribute, so tabs overlapped and the popup showed checkboxes it shouldn\'t have.',
      ],
      ja: [
        'アイドルロックをシステム認証で解除できます。Windows では Windows Hello、Mac では Touch ID、ほかのシステムではセキュリティキーまたはスマートフォンを使います。PIN は予備として残ります。',
        'ポップアップで「システム認証でロック解除」を押すと、まず小さな別ウィンドウを開いて認証します。認証が終わるとウィンドウは自動で閉じます。',
        '管理ページを 5 つのタブに分けました：パスワード、バックアップ、設定、ごみ箱、ヘルプ。診断は 1 行の概要にし、バックアップ履歴は展開できるセクションにまとめました。',
        '修正：display を指定した領域に hidden を付けても表示されたままで、タブが重なったり、ポップアップに出てはいけないチェックボックスが表示されたりしていました。',
      ],
    },
    notes: {
      zh_TW: ['系統驗證的鑰匙綁在擴充功能的資料夾位置上，資料夾搬家要重新設定。'],
      en: ['The system verification key is tied to the extension\'s folder location. If you move the folder, set it up again.'],
      ja: ['システム認証のキーは拡張機能のフォルダーの場所に結び付いています。フォルダーを移動した場合は、もう一度設定してください。'],
    },
  },
  {
    version: '1.3.0',
    date: '2026-10-27',
    items: {
      zh_TW: [
        '小視窗最上面加搜尋框，搜所有網站的帳號，Enter 直接開那個網站並自動填。',
        '逐站自動登入：小視窗勾「這個網站自動填完就按登入」，自動填好就幫你按登入。',
        '瀏覽器自己跳的「需要驗證」小視窗，有存帳號就自動回答。',
        '閒置鎖定：沒碰電腦 N 分鐘或瀏覽器重開就鎖，要輸 PIN 才能用。連續輸錯 5 次等 30 秒。',
      ],
      en: [
        'The popup has a search box at the top that searches accounts on all sites. Press Enter to open that site and autofill.',
        'Per-site auto sign-in: Check "Sign in after autofill on this site" in the popup, and it signs in for you once autofill is done.',
        'The browser\'s own "Authentication required" pop-up is answered automatically when you have a saved account.',
        'Idle lock: Locks after N minutes without using the computer or when the browser restarts, and you need your PIN to use it again. After 5 wrong tries in a row, wait 30 seconds.',
      ],
      ja: [
        'ポップアップの一番上に検索ボックスを追加しました。すべてのサイトのアカウントを検索でき、Enter でそのサイトを開いて自動入力します。',
        'サイトごとの自動ログイン：ポップアップで「このサイトで自動入力後にログイン」をオンにすると、自動入力のあとにログインボタンを押します。',
        'ブラウザー自身が表示する「認証が必要です」のダイアログに、保存したアカウントがあれば自動で応答します。',
        'アイドルロック：パソコンを N 分間操作しないか、ブラウザーを再起動するとロックし、PIN を入力しないと使えません。5 回続けて間違えると 30 秒待つ必要があります。',
      ],
    },
    notes: {
      zh_TW: ['多了「閒置偵測」和「網路請求驗證」兩個權限。'],
      en: ['Requires two new permissions: "Idle detection" and "Web request authentication".'],
      ja: ['「アイドル検出」と「ネットワーク リクエストの認証」の 2 つの権限が増えました。'],
    },
  },
  {
    version: '1.2.0',
    date: '2026-10-27',
    items: {
      zh_TW: [
        '密碼歷史：每筆帳號保留最近 5 個舊密碼，管理頁可以展開看。',
        '回收桶：刪掉的帳號放 30 天可以復原，刪除全部也先進回收桶。',
        '自動加密備份：到時間自動存到「下載」資料夾底下的子資料夾。',
        '備份紀錄：每次備份的時間、方式、完整路徑、筆數都記下來，換過位置也記一筆。',
        '手動匯出改成每次跳「另存新檔」讓你選位置。',
        '密碼健檢：列出重複使用、太弱、超過一年沒改的帳號。',
        '挑幾筆匯出：勾選帳號匯成加密檔給同事。',
      ],
      en: [
        'Password history: Each account keeps its last 5 previous passwords, which you can expand to see on the manager page.',
        'Trash: Deleted accounts stay for 30 days and can be restored. Deleting everything also moves them to Trash first.',
        'Automatic encrypted backup: When it\'s time, it saves to a subfolder in your Downloads folder.',
        'Backup history: Records the time, method, full path, and number of entries of every backup, and also logs location changes.',
        'Manual export now opens "Save as" every time so you can choose where to save.',
        'Password health check: Lists accounts with reused passwords, weak passwords, or passwords not changed for over a year.',
        'Export selected: Check accounts and export them as an encrypted file for a coworker.',
      ],
      ja: [
        'パスワード履歴：アカウントごとに直近 5 つの以前のパスワードを残し、管理ページで展開して確認できます。',
        'ごみ箱：削除したアカウントは 30 日間残り、復元できます。すべて削除した場合も、まずごみ箱に入ります。',
        '自動暗号化バックアップ：時間になると「ダウンロード」フォルダーの中のサブフォルダーに自動で保存します。',
        'バックアップ履歴：バックアップごとに日時、方法、フルパス、件数を記録し、保存先を変えたときも記録します。',
        '手動エクスポートでは、毎回「名前を付けて保存」を表示して保存先を選べるようにしました。',
        'パスワード診断：パスワードの使い回し、弱いパスワード、1 年以上変更していないアカウントを一覧にします。',
        '選択してエクスポート：アカウントを選んで暗号化ファイルにエクスポートし、同僚に渡せます。',
      ],
    },
    notes: {
      zh_TW: ['多了「下載」和「排程」兩個權限。'],
      en: ['Requires two new permissions: "Downloads" and "Scheduling".'],
      ja: ['「ダウンロード」と「スケジュール」の 2 つの権限が増えました。'],
    },
  },
  {
    version: '1.1.0',
    date: '2026-10-25',
    items: {
      zh_TW: [
        '有密碼保護的加密備份檔（.pkbak），匯出匯入都要備份密碼。',
        '備份提醒：超過 30 天沒備份、期間有改過密碼，小視窗出現提示。',
        '產生強密碼：字數範圍、大小寫、數字、特殊符號都可以設，註冊或改密碼時清單裡可以直接填。',
        '快捷鍵 Ctrl+Shift+L 直接填入，清單可以用上下鍵選、Enter 填。',
        '登入失敗退回同一頁時不再問「要儲存嗎」。',
      ],
      en: [
        'Password-protected encrypted backup files (.pkbak). Exporting and importing both need the backup password.',
        'Backup reminder: If you haven\'t backed up for over 30 days and have changed passwords since, the popup shows a reminder.',
        'Generate a strong password: You can set the length range, uppercase and lowercase letters, numbers, and symbols. Fill it straight from the list when signing up or changing a password.',
        'Press Ctrl+Shift+L to fill directly. In the list, use the up and down arrow keys to choose and Enter to fill.',
        'You\'re no longer asked "Save this password?" when a failed sign-in returns to the same page.',
      ],
      ja: [
        'パスワードで保護された暗号化バックアップファイル（.pkbak）。エクスポートにもインポートにもバックアップ用パスワードが必要です。',
        'バックアップの通知：30 日以上バックアップしておらず、その間にパスワードを変更していると、ポップアップにお知らせを表示します。',
        '強力なパスワードを生成：文字数の範囲、大文字・小文字、数字、記号を設定できます。登録時やパスワード変更時に、一覧から直接入力できます。',
        'ショートカットキー Ctrl+Shift+L ですぐに入力できます。一覧では上下キーで選び、Enter で入力します。',
        'ログインに失敗して同じページに戻ったときは、「このパスワードを保存しますか？」と聞かなくなりました。',
      ],
    },
  },
  {
    version: '1.0.0',
    date: '2026-10-22',
    items: {
      zh_TW: [
        '登入後問要不要儲存密碼，支援更新密碼、這個網站永遠不問。',
        '開登入頁自動填入，多組帳號時點欄位跳清單選。',
        '兩段式登入（先打帳號、下一頁才打密碼）有處理。',
        '工具列小視窗：看目前網站的帳號、填入、複製密碼、新增。',
        '管理頁：搜尋、修改、刪除、CSV 匯入匯出，格式和 Edge、Chrome 相同。',
        '網站用完整網域區分，jira.example.com 和 gitlab.example.com 是兩個網站。',
      ],
      en: [
        'Asks whether to save the password after you sign in, with options to update the password or never ask on this site.',
        'Autofills when you open a sign-in page. With several accounts, click the field to pick from a list.',
        'Handles two-step sign-in (username first, password on the next page).',
        'Toolbar popup: View accounts for the current site, fill them in, copy passwords, and add new ones.',
        'Manager page: Search, edit, delete, and import or export CSV in the same format as Edge and Chrome.',
        'Sites are told apart by their full domain, so jira.example.com and gitlab.example.com are two different sites.',
      ],
      ja: [
        'ログイン後にパスワードを保存するか確認します。パスワードの更新や、このサイトでは今後確認しない設定にも対応しています。',
        'ログインページを開くと自動入力します。アカウントが複数あるときは、欄をクリックすると一覧から選べます。',
        '2 段階のログイン（先にユーザー名、次のページでパスワードを入力）にも対応しています。',
        'ツールバーのポップアップ：今のサイトのアカウントの確認、入力、パスワードのコピー、追加ができます。',
        '管理ページ：検索、編集、削除、CSV のインポートとエクスポートができます。形式は Edge、Chrome と同じです。',
        'サイトは完全なドメイン名で区別します。jira.example.com と gitlab.example.com は別のサイトです。',
      ],
    },
  },
];
