# ObsidianGSync

Two-way sync between an [Obsidian](https://obsidian.md) vault and a folder in Google Drive, using the Google Drive API directly.

Works on **Windows, macOS, Linux, Android, and iPad/iPhone**, including mobile devices that can't use Google Drive for Desktop.

> Plugin ID: `gdrive-vault-sync` · Display name: **Google Drive Vault Sync**

---

## Features

- **Two-way sync**: changes on either side are copied to the other.
- **Conflict-safe**: if a note changed in both places, nothing is overwritten. Your local version keeps the name and the Drive version is saved beside it as `note (conflict YYYY-MM-DD HHmm).md`.
- **Deletes go to the trash**: deleted files go to Drive's trash (kept 30 days) or Obsidian's trash, never hard-deleted. Deletion sync can be turned off.
- **Leaves device settings alone**: hidden folders like `.obsidian`, `.trash`, and `.git` are never synced, so each device keeps its own settings and plugins.
- **Mobile-friendly**: progress is saved every 10 files, large files can be skipped, and an interrupted sync resumes where it stopped.
- **Works with existing Drive folders**: point it at a folder that already has your notes and the first sync compares contents, so it doesn't duplicate them.
- **Your own Google credentials**: you create your own OAuth client, and no third-party server ever sees your data.

---

## ⚠️ Don't double-sync

If a device's vault already lives inside **Google Drive for Desktop** (e.g. `G:\My Drive\...`), Drive for Desktop is already syncing it. Don't also run this plugin on that device against the same Drive folder, or two sync engines will fight over the same files.

A common setup:

| Device | Vault location | Sync method |
|---|---|---|
| Windows PC | Inside `G:\My Drive\...` | Google Drive for Desktop (plugin installed only to sign in; auto-sync off) |
| Android phone | Local storage | This plugin |
| iPad / iPhone | On My iPad / On My iPhone | This plugin |

Also disable any other sync plugin (e.g. Remotely Save) that points at the same folder.

---

## 1. Create a Google OAuth client (one time)

1. Go to <https://console.cloud.google.com/> and create a project.
2. **APIs & Services → Library**: search **Google Drive API** and click **Enable**.
3. **Google Auth Platform / OAuth consent screen**: user type **External**; fill in an app name and your email; add your Google account as a **test user**.
4. **Publish the app** (Audience → *Publish app* → **In production**).
   If you leave it in *Testing*, Google expires your sign-in every 7 days.
   Because the app is unverified, Google shows a warning when you sign in. Click **Advanced → Go to (app name)**. That's expected for a personal app.
5. **Credentials → Create credentials → OAuth client ID → Application type: Desktop app**.
   Copy the **Client ID** and **Client secret**.

---

## 2. Install

### Option A: BRAT (recommended; makes updates easy)

1. In Obsidian: **Settings → Community plugins → Browse**, search **BRAT**, install and enable it.
2. Open BRAT's settings → **Add beta plugin** → enter:
   ```
   dg0988/ObsidianGSync
   ```
3. Back in **Community plugins**, enable **Google Drive Vault Sync**.

BRAT installs new releases automatically.

### Option B: Manual

Download `main.js` and `manifest.json` from the [latest release](https://github.com/dg0988/ObsidianGSync/releases/latest) and place them in:

```
<your vault>/.obsidian/plugins/gdrive-vault-sync/
```

Then fully restart Obsidian and enable the plugin under **Community plugins**.

**Windows/macOS/Linux:** in **Settings → Community plugins**, click the folder icon next to *Installed plugins* to open the plugins folder directly.

**Android:** copy the files over USB (`Internal storage/Documents/<vault>/.obsidian/plugins/`) or with **Files by Google** with *Show hidden files* turned on. Make sure the files aren't renamed to `manifest (1).json` or `main.js.txt`.

**iPad / iPhone:** the Files app hides `.obsidian`, so use BRAT or the free **a-Shell** app:
1. In Files, move `main.js` and `manifest.json` into your vault folder (**On My iPad → Obsidian → your vault**).
2. In a-Shell, run `pickFolder` and select your vault folder.
3. Run:
   ```
   mkdir -p .obsidian/plugins/gdrive-vault-sync
   mv main.js manifest.json .obsidian/plugins/gdrive-vault-sync/
   ```
4. Fully close and reopen Obsidian, then enable the plugin.

---

## 3. Sign in

Google sign-in has to be done **on a desktop** (it uses a temporary local web server to receive Google's response). Mobile devices use a refresh token copied from desktop.

### Desktop

1. **Settings → Google Drive Vault Sync**.
2. Paste the **Client ID** and **Client secret**.
3. Click **Sign in with Google** and approve in the browser.
4. Status shows **✅ Signed in**.

If this desktop's vault is already synced by Google Drive for Desktop, now set **Auto-sync** to `0`, turn off **Sync when Obsidian starts**, and don't press Sync on this machine.

### Phone / tablet

1. On desktop, click **Copy refresh token**.
2. Send it to the device privately (e.g. a note to yourself that you delete afterwards).
3. On the device, paste the **Client ID**, **Client secret**, and **Refresh token (manual)**.

The same refresh token works on any number of devices.

---

## 4. Configure and sync

Set **Google Drive folder** to the folder's path under *My Drive*, using `/` between folders:

```
e.g. "Folder/Obsidian Notes"
```

The path must match the Drive folder's name exactly (same spelling and capitalization). If the folder doesn't exist, it is created.

Then start a sync using any of:
- **Settings → Google Drive Vault Sync → Sync now**
- The 🔄 icon in the left ribbon
- Command palette (**Ctrl/⌘ + P**, or swipe down on mobile): **Google Drive Vault Sync: Sync now**

**First sync on mobile:** keep Obsidian open and the screen on until the progress notice disappears. Mobile operating systems pause apps in the background. Avoid browsing folders while hundreds of files are arriving.

---

## Settings

| Setting | Default | Description |
|---|---|---|
| OAuth client ID / secret | — | From your Google Cloud **Desktop app** OAuth client. |
| Refresh token (manual) | — | Filled automatically on desktop; paste on mobile. |
| Google Drive folder | `Obsidian/<vault name>` | Path under *My Drive*. Backslashes are converted to `/`. |
| Auto-sync every (minutes) | `10` | `0` disables auto-sync. Only runs while Obsidian is open. |
| Sync when Obsidian starts | On | Skipped automatically if the previous sync didn't finish. |
| Sync deletions | On | Off = files deleted on one side come back on the next sync. |
| Max file size (MB) | `25` | Larger files are skipped and listed. `0` = no limit. Use ~10 on phones. |
| Exclude | `desktop.ini`, `Thumbs.db`, `_debug_remotely_save/` | One rule per line (see below). |
| Reset sync state | — | Forgets sync history. The next sync compares every file by content; nothing is deleted. |

### Exclude rules

```
# comments start with #
Templates/        # a folder (prefix) and everything in it
*.exe             # a file extension
desktop.ini       # an exact file name, anywhere
Notes/draft.md    # an exact path
```

Suggested additions on phones and tablets (installers and archives don't belong on mobile):

```
Software/
*.exe
*.msi
*.zip
*.7z
*.iso
```

Excluded files stay in Drive and on other devices. They just aren't synced to this one.

---

## How sync works

The plugin remembers what each file looked like on both sides at the last sync:

| Situation | Result |
|---|---|
| Changed locally only | Uploaded |
| Changed in Drive only | Downloaded |
| Changed on both sides | Local keeps the name; Drive version saved as a `(conflict …)` copy |
| Deleted locally, unchanged in Drive | Moved to Drive trash |
| Deleted in Drive, unchanged locally | Moved to Obsidian trash |
| Deleted on one side, edited on the other | The edit wins; the file is restored |
| Exists on both sides, never synced before | Contents compared; identical files are left alone |

**Limitations**
- Renames sync as a delete plus a new file.
- Empty folders aren't synced.
- Google Docs/Sheets/Slides in the Drive folder are ignored.
- Hidden files and folders (names starting with `.`) are never synced.
- Sync runs only while Obsidian is open and in the foreground.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `redirect_uri_mismatch` during sign-in | The OAuth client was created as *Web application*. Create a new one with type **Desktop app**. |
| "Access blocked" / `access_denied` | Add your account as a test user on the consent screen, or publish the app. |
| `invalid_grant`, or sign-in expires every ~7 days | Publish the OAuth app to **In production**, then sign in again on desktop and re-copy the token to each device. |
| `Drive API 403` on first sync | Enable the **Google Drive API** for your project. |
| A new, empty folder appeared in Drive | The folder path doesn't match. Check spelling, capitalization, and use `/` between folders. Delete the stray folder. |
| "Up to date" but no notes appear | Same as above: wrong folder path. |
| "The last sync didn't finish…" | Obsidian closed or crashed mid-sync. Progress was saved; tap **Sync now** to resume. |
| Obsidian crashes during the first mobile sync | Lower **Max file size** to 10, exclude installers/archives, and leave the app on one note until the sync finishes. |
| Plugin doesn't appear in Community plugins | Check the folder is exactly `.obsidian/plugins/gdrive-vault-sync/` with `main.js` and `manifest.json` (no extra folder level, no renamed files), then fully restart Obsidian. |

Detailed errors are logged to the developer console (desktop: **Ctrl+Shift+I**) with the prefix `[gdrive-vault-sync]`.

---

## Security and privacy

- Files go directly between your device and Google's API. There is no intermediate server.
- Your client ID, client secret, and refresh token are stored only in each device's
  `.obsidian/plugins/gdrive-vault-sync/data.json`. **Never commit or share that file.** The refresh token grants access to your Google Drive.
- The plugin requests the full Drive scope (`https://www.googleapis.com/auth/drive`) so it can see files already in your folder that it didn't create itself. It only reads and writes inside the folder you configure.
- To revoke access everywhere, remove the app at <https://myaccount.google.com/permissions>.

---

## Releasing a new version

1. Update `version` in `manifest.json` (e.g. `0.1.4`).
2. Commit `main.js` and `manifest.json`.
3. Create a GitHub release whose tag exactly matches the version (`0.1.4`, no `v`), and attach `main.js` and `manifest.json` as release assets.

BRAT users receive the update automatically.
