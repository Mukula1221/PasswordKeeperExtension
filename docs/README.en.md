# Password Keeper

[繁體中文](../README.md) | English | [日本語](README.ja.md)

A browser extension that brings back "save passwords" and "autofill" when the browser's own password manager has been turned off. Works in Edge and Chrome.

Passwords are stored only in this computer's browser. They are never uploaded anywhere, and the extension doesn't connect to any external server.

## Features

- Offers to save your password after you sign in, and fills it in the next time you open the sign-in page.
- Handles two-step sign-in (username first, password on the next page) and the browser's own sign-in prompts.
- Generates strong passwords. You choose the length and which characters to use.
- Auto-click: after your username and password are filled in, it clicks a button you picked, such as a single sign-on button.
- App lock: lock it when you leave your desk, and unlock it with Windows Hello, Touch ID, or a security key.
- Encrypted backups and auto backup. You can also move passwords to and from Chrome, Edge, and Firefox with CSV files.
- The interface is available in Traditional Chinese, English, and Japanese. It follows your browser language by default, and you can change it at the top right of the manager page.

## Install

1. Go to [Releases](../../../releases) and download the latest `password-keeper-<version>.zip`.
2. Extract it to a folder you won't delete, such as a "Password Keeper" folder under Documents. The browser loads the extension from this folder every time it starts, so deleting the folder stops the extension from working.
3. Open the extensions page:
   - Edge: type `edge://extensions` in the address bar
   - Chrome: type `chrome://extensions` in the address bar
4. Turn on "Developer mode". In Edge it's at the bottom left; in Chrome it's at the top right.
5. Click "Load unpacked" and pick the folder you just extracted, the one that contains `manifest.json`.
6. A blue lock icon appears in the toolbar. Click the puzzle icon in the toolbar to pin it.

Tabs that were already open before you installed need to be refreshed once before the extension works in them.

Edge and Chrome don't let you install `.crx` files from outside their stores, so extract the zip and use "Load unpacked" instead.

To check that the download hasn't been changed, compute its hash in PowerShell and compare it with the `.sha256` file of the same name on the Releases page:

```powershell
Get-FileHash password-keeper-1.13.0.zip
```

## Update

1. First export an encrypted backup from the "Backup" tab on the manager page, just in case.
2. Download the new zip and extract it. You can extract it over the old folder or into a new folder.
3. If you replaced the old folder, click "Reload" on the Password Keeper card on the extensions page. If you used a new folder, click "Load unpacked" and pick it, then delete the old folder once the new version works.
4. Refresh any open tabs once.

Release versions downloaded from Releases always have the extension ID `fgmjnolhbeohanamhnomcpmolhdapdkg`. A new version installed from a different folder is still the same extension, so your saved passwords, settings, and app lock stay. If a new version needs new permissions, the browser asks once.

Loading the source folder directly gives you a development version. Its ID depends on the folder location, so it's a different extension from the release version and they don't share data. To switch from the development version to the release version, export an encrypted backup from the development version, install the release version, import the backup, and turn app lock on again. Don't keep both versions turned on at the same time, or both will autofill.

## How to use

- **Save**: Sign in to any site once and "Save this password?" appears at the top right. Click "Save" to keep it. After you click "Never for this site", that site won't ask again.
- **Autofill**: The next time you open the same site's sign-in page, your username and password are filled in. You can turn this off per site in the "Per-site settings" table on the "Settings" tab of the manager page, or with "Autofill" under "This site" in the popup. The autofill switch on the "Settings" tab is the master switch: when it's off, nothing is filled in on any site.
- **Choose an account**: If you saved several accounts for the same site, clicking the username or password field shows a list. Use the arrow keys to choose, Enter to fill, and Esc to close. Pressing the down arrow in a focused field also opens the list.
- **Shortcut**: Press `Ctrl+Shift+L` to fill in the most recently used account for the current site. To change the shortcut, go to `edge://extensions/shortcuts` (Chrome: `chrome://extensions/shortcuts`).
- **Generate a strong password**: When you sign up or change a password, click the new password field. "Generate a strong password" is at the top of the list. It fills in both the new password and the confirmation field, and copies the password to the clipboard. After you submit the form, you're asked whether to save it as usual. Set the length and character types under "Generate password" in the toolbar popup.
- **Toolbar icon**: Click the lock to see the accounts saved for the current site, fill them in, copy passwords, add accounts, and generate passwords. The number on the icon is how many accounts the current site has.
- **Manager page**: Click the lock, then "Manage all passwords" to search, edit, delete, back up, and turn off autofill. On the "Backup" and "Settings" tabs, click a section title to collapse it.
- **Display language**: Use the menu next to the globe icon at the top right of the manager page to choose the browser default, 繁體中文, English, or 日本語. The manager page switches right away, the popup and unlock window use the new language the next time they open, and prompts on open web pages switch too. The extension's name and description on the extensions page, the shortcut description, and the toolbar icon tooltip are shown by the browser, so they still follow the browser language.
- **Previous passwords**: For accounts whose password you changed, the password column on the manager page has "Previous passwords" that you can expand. Up to 5 are kept. If the site didn't actually accept the change, you can get the old password back here.
- **Trash**: Deleted accounts go to the trash first, and so does "Delete all passwords". They're kept for 30 days by default and can be restored during that time, then removed automatically. Change the number of days on the "Trash" tab (1–365). You can select several to restore or delete permanently at once.
- **Password health check**: The manager page lists passwords used on several sites, passwords that are too short or use only one kind of character, and passwords not changed for over a year. You can edit each one directly.
- **Share a few with a colleague**: Select the accounts in the manager page table, export the selected ones as an encrypted file, and set a password. Your colleague imports it with "Import encrypted backup". Tell them the password separately.
- **Quick sign-in**: Type part of a site or username in the search box at the top of the popup to list matching accounts. Click "Open" or press Enter to open that site in a new tab; this account is filled in when the page loads.
- **Sign in automatically**: Check "Sign in after autofill" in the "Per-site settings" table on the "Settings" tab of the manager page, or under "This site" in the popup. From then on, when you open that site's sign-in page, the extension signs in for you right after autofill. It only clicks when autofill succeeded and the page has exactly one sign-in form. Choosing an account from the list by hand doesn't sign in.
- **Auto-click**: Use this when you still have to click a button after your username and password are filled in, or when the page only has a single sign-on button. Open that page, click "Pick a button to auto-click" in the popup, and click the button on the page. This only selects the button and doesn't actually click it. Then choose whether to click after autofill or as soon as the page opens. From then on, the button is clicked automatically when you open that page. You can pick several buttons on the same page; each rule waits until the previous one is done. Rules are in the "Auto-click" section of the "Settings" tab on the manager page, grouped by site, and each site can be collapsed. You can reorder rules with ▲▼, turn them on or off, delete them, or change the button text, URL, selector, when to click, the interval, and what to do if the button never appears. By default a rule only applies to the page you picked it on. `*` matches any characters, so use `*` for the whole site. Changing the selector clears the button text, and an empty button text means only the selector is used.
- **Add auto-click rules by hand**: In the "Auto-click" section of the "Settings" tab, click "+ Add" and fill in the site, URL, and selector. The button next to the section title adds a rule for a new site. The button inside each site section fills in that site, and the new rule goes to the end of that site. You can paste a full URL into the site field; it's split into the site and the URL automatically, without the query string. You can't add a rule if one with the same site, URL, and selector already exists.
- **The browser's own sign-in prompt**: For sign-in prompts that the browser shows itself (Jenkins and network devices, for example), if that site has a saved account here, the prompt is answered automatically and doesn't appear. If the username or password is wrong, the prompt appears as usual the second time. Credentials typed into that prompt can't be saved; save them first with "Add account" in the popup.
- **App lock**: A lock for the whole tool. Turn on "App lock" on the "Settings" tab of the manager page and verify once with your system: Windows Hello on Windows, Touch ID on Mac, or a security key or phone on systems without a built-in authenticator. While it's locked, the popup, the manager page, autofill on web pages, the shortcut, and the browser's sign-in prompts all need verification first. It locks when you haven't used the computer for a set number of minutes, when Windows goes to the lock screen, when the browser restarts (you can turn this off), or when you click "Lock" at the top right of the popup. The manager page asks for verification every time you open it. Verifying from the popup opens a small separate window, which closes itself once you're verified. If Windows Hello doesn't pop up, click "Click here to open it again" in that window. Turning the lock off also requires verification. There's no backup PIN.

## Backup

Your passwords exist only in this browser. If you remove the extension, or clear browsing data with extension data included, your passwords are gone. Back up regularly.

- **Encrypted backup (recommended)**: Click "Export encrypted backup" on the manager page, set a backup password, and choose where to save the file. It's saved as a `.pkbak` file. The file can't be opened without this password, and a forgotten password can't be recovered. "Import encrypted backup" restores it after you pick the file and enter the password. Existing accounts are merged, not duplicated.
- **Auto backup**: Turn it on in the "Backup" section of the manager page. First set an auto backup password (stored in the extension with the same protection as your other data), choose daily or weekly and a time, and name a subfolder. At that time, if your passwords changed since the last backup, an encrypted file is saved to that subfolder under the browser's Downloads folder. If the time is missed, the backup runs the next time you open the browser. Extensions can only write under Downloads; that's a browser limitation. "Back up now" next to the "Auto backup" title saves a copy right away and is recorded as manual.
- **Backup history**: The full path and number of accounts of each backup are recorded in the "Backup history" table on the manager page. You can filter by auto or manual, and up to 100 entries are kept. Changing the auto backup subfolder is also recorded. Older files stay in the old location, so delete them yourself if you want.
- **Delete backup history**: For one entry, click "Delete" on that row. For several, select them and delete them together. You're asked whether to delete the backup files on the computer too. Files that can't be deleted are listed so you can delete them yourself.
- **CSV**: "Export CSV" saves an unencrypted CSV file with the same columns that Chrome and Edge use (`name,url,username,password,note`). Chrome, Edge, and Firefox can import it directly. Keep it somewhere safe. More than 3000 accounts are split into several files, because Chrome and Edge import at most 3000 at a time. "Import CSV" reads these files and the password files exported by Chrome, Edge, Firefox, and Safari, including files saved by Excel in Big5.
- **Move passwords to and from the browser**: Extensions can't read or write the browser's built-in passwords directly, so passwords can only be moved with CSV files, and nothing syncs automatically. The browser password pages are Chrome `chrome://password-manager/settings`, Edge `edge://settings/passwords`, and Firefox `about:logins`; look for export and import there. When you import here, accounts with the same site and username are merged. If the file has an old password that was already changed here, or a Firefox file records an earlier change time, the one here is kept, so moving back and forth won't replace a newer password with an older one. A file without notes won't clear the notes here. Passwords for mobile apps (starting with `android://`) aren't imported. Delete the CSV file when you're done.
- **Reminder**: If you haven't backed up for more than 30 days and passwords were added or changed in that time, a yellow reminder appears at the top of the toolbar popup. Change the number of days in the "Backup" section of the manager page; 0 turns it off.

## Good to know

- **There's no master password.** To work like the browser's built-in password manager without typing a password, passwords are stored in the browser profile with only simple encryption, and the key is kept in the same place. Anyone who gets into your Windows account can see all your passwords, so lock your computer. Encrypted backup files are different: they can't be opened without the backup password.
- **Developer mode is required.** If your company has also locked developer mode, you can't install the extension. Edge and Chrome may warn about developer mode extensions when they start; choose to keep the extension.
- **Firefox isn't supported.** Firefox background scripts work differently and would need changes.
- **Sites are matched by their full domain.** jira.example.com and gitlab.example.com are two sites, and their accounts don't show up on each other. www.example.com and example.com also count as two.
- **App lock isn't encryption.** System verification only stops someone from looking around while you're away from your desk; it doesn't change how the data on disk is protected. Verification is tied to the extension ID: the release version isn't affected by changing folders, but the development version needs app lock turned on again after its folder moves. If system verification stops working (for example, your company turns off Windows Hello), you can't unlock, and you'd have to remove the extension, install it again, and import a backup. Export an encrypted backup before turning app lock on, and keep auto backup on. Auto backup still runs while locked.
- **No autofill in cross-site iframes.** For safety, sign-in pages framed inside another site aren't filled in automatically, but you can still click a field and choose an account.
- **No prompt when sign-in fails.** If you're still on the same URL and the sign-in form is still there after you submit, it's treated as a wrong password and you aren't asked to save. A few sites return to the same URL with the sign-in box still there even after a successful sign-in. Those sites won't ask, so save the account by hand with "Add account" in the popup.
- **Two-step sign-in** (username first, password on the next page, like Microsoft's sign-in page) is supported, but every site does it differently. If a site can't be filled in, use "Fill" or "Copy password" in the toolbar popup.
- **When auto-click doesn't click**: app lock is locked; this tab already clicked the same rule within the interval; this tab clicked sign out and the pause hasn't ended; the button didn't appear within 15 seconds of this rule's turn; or the button text differs from when you picked it. Rules that click after autofill also need the username and password filled in and no empty fields in the form. Pages with a verification code aren't clicked, and empty optional fields count as empty.
- **Auto-click timing**: The timing settings have a default interval and a pause after sign-out, both 300 seconds by default. Set the pause to 0 to turn it off. Each rule can have its own interval; leave it empty to use the default. "Sign in after autofill" also uses the default interval. The interval only decides how soon the button can be clicked again; it's clicked again only after the page reopens or navigates. For sites where you might mistype a password, don't set the interval too short, or your account might get locked.
- **Auto-click order**: Each rule waits up to 15 seconds. If the button doesn't appear, a rule set to skip moves on to the next rule, and a rule set to stop doesn't click the later ones; it starts over when the page changes. Rules that click after autofill join the queue only after the username and password are filled in, and on pages without a sign-in form they don't hold up later rules. Iframes in a page keep their own order and don't wait for the outer page.
- **What auto-click can't do**: If the site checks whether a real person clicked, or the button opens a new window, auto-click does nothing or is blocked by the browser. Buttons inside web components (Shadow DOM) can't be picked. Iframes from other sites aren't clicked.

## Development

Development setup, project structure, tests, and the release process are described in [CONTRIBUTING.md](../CONTRIBUTING.md) (in Traditional Chinese). See [CHANGELOG.md](../CHANGELOG.md) for what changed in each version; the "Versions" tab on the manager page shows the same history.

Please report security issues privately as described in [SECURITY.md](../SECURITY.md) instead of opening a public issue.

## License

[MIT](../LICENSE)
