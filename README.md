# GSync

Two-way sync between an Obsidian vault and a folder in Google Drive, using the Google Drive API directly.

Works on **Windows, macOS, Linux, Android, and iPad/iPhone**, including mobile devices that can't run Google Drive for Desktop.

**Available in Obsidian's Community plugins:** [community.obsidian.md/plugins/gsync](https://community.obsidian.md/plugins/gsync)

---

## Features

- **Two-way sync**: changes on either side are copied to the other.
- **Conflict-safe**: if a note changed in both places, nothing is overwritten. Your local version keeps the name and the Drive version is saved beside it as `note (conflict YYYY-MM-DD HHmm).md`.
- **Deletes go to the trash**: deleted files go to Drive's trash (kept 30 days) or Obsidian's trash, never hard-deleted. Deletion sync can be turned off.
- **Works with existing Drive folders**: point it at a folder that already holds your notes (for example one kept by Google Drive for Desktop). The first sync compares contents, so nothing is duplicated.
- **Leaves device settings alone**: hidden folders like `.obsidian`, `.trash`, and `.git` are never synced, so each device keeps its own settings and plugins.
- **Mobile-friendly**: progress is saved every 10 files, large files can be skipped, and an interrupted sync resumes where it stopped.
- **Your own Google credentials**: you create your own OAuth client. No third-party server stores your data or tokens.

---

## Why GSync?

Many Google Drive sync plugins expect to own their Drive folder: start from an empty vault, sync only through the plugin, and nothing else may touch the folder. GSync is built for the opposite case. Your notes already live in Google Drive, and you want them on your phone and tablet too.

- **Works alongside Google Drive for Desktop and existing folders.** GSync sees every file in the folder you choose, however it got there: uploaded by Drive for Desktop, added through the Drive website, or synced by GSync from another device.
- **No empty-vault requirement.** Point GSync at a vault that already has notes and a Drive folder that already has notes. The first sync compares contents and only transfers what differs.
- **Catches edits made outside Obsidian.** Changes are detected by comparing files on every sync (timestamps, sizes, and Drive checksums), not by watching edits inside the app. Files changed by another editor, a script, or while Obsidian was closed are still picked up.
- **Never silently picks a winner.** When a note changed on both sides, you keep both versions: yours keeps the name, and the Drive version is saved beside it as a conflict copy.
- **Safe to interrupt.** Progress is saved every 10 files. If the app closes, crashes, or loses its connection mid-sync, the next sync resumes where it stopped.
- **No middleman server.** Files and tokens go directly between your device and Google, using your own Google OAuth client. The only other piece is a static redirect page used during sign-in, which you can host yourself.
- **Full two-way sync, automatically.** Every sync runs in both directions: on startup, on a timer, or when you tap Sync now.

### When something else may fit better

GSync makes deliberate trade-offs:

- **Setup takes about 10 minutes**, because you create your own Google Cloud OAuth client. Plugins that sign you in through their own service are quicker to set up, in exchange for routing sign-in through the developer's server.
- **Settings and plugins aren't synced.** GSync never touches your vault's configuration folder, so each device keeps its own settings, plugins, and themes. If you want identical settings everywhere, you'll need another tool for that part.
- **The Drive folder is found by its path.** If you rename or move the folder in Google Drive, update the path in GSync's settings.

---

## Requirements and disclosures

- **Google account required.** You also need a free Google Cloud project to create your own OAuth client (setup below).
- **Network use.** GSync connects to:
  - `accounts.google.com` and `oauth2.googleapis.com`: Google sign-in and refreshing access tokens.
  - `www.googleapis.com`: the Google Drive API, to list, download, upload, and trash files in the folder you choose.
  - `dg0988.github.io` (only during sign-in, and only if you keep the default redirect page): a static page in this repository ([`docs/callback.html`](docs/callback.html)) that hands Google's one-time sign-in code back to Obsidian through an `obsidian://` link. It has no server-side code and stores nothing. You can host your own copy instead.
- **Vault access.** To compare your vault with Drive, GSync lists every file in the vault (except excluded files, hidden files, and the vault's config folder) and reads or writes only the files it syncs.
- **Clipboard.** GSync only *writes* to the clipboard, and only when you ask: the **Copy refresh token** button, or copying the sign-in link if your browser can't be opened. It never reads the clipboard.
- No telemetry, analytics, or ads. Nothing is sent anywhere except Google.

---

## ⚠️ Don't double-sync

If a device's vault already lives inside **Google Drive for Desktop** (e.g. `G:\My Drive\...`), Drive for Desktop is already syncing it. Don't also run GSync on that device against the same Drive folder, or two sync engines will fight over the same files.

A common setup:

| Device | Vault location | Sync method |
|---|---|---|
| Windows/Mac computer | Inside the Google Drive for Desktop folder | Google Drive for Desktop (GSync off, or auto-sync set to 0) |
| Android phone | Local storage | GSync |
| iPad / iPhone | On My iPad / On My iPhone | GSync |

Also disable any other sync plugin that points at the same folder.

---

## 1. Create a Google OAuth client (one time)

1. Go to <https://console.cloud.google.com/> and create a project.
2. **APIs & Services → Library**: search **Google Drive API** and click **Enable**.
3. **Google Auth Platform / OAuth consent screen**: user type **External**; fill in an app name and your email; add your Google account as a **test user**.
4. **Publish the app** (Audience → *Publish app* → **In production**).
   If you leave it in *Testing*, Google expires your sign-in every 7 days.
   Because the app is unverified, Google shows a warning when you sign in. Click **Advanced → Go to (app name)**. That's expected for a personal app.
5. **Credentials → Create credentials → OAuth client ID**:
   - Application type: **Web application**
   - Authorized redirect URIs: add
     ```
     https://dg0988.github.io/ObsidianGSync/callback.html
     ```
   Copy the **Client ID** and **Client secret**.

---

## 2. Install

### From Community plugins (recommended)

GSync is published in Obsidian's community directory: [community.obsidian.md/plugins/gsync](https://community.obsidian.md/plugins/gsync)

- On the directory page, click **Add to Obsidian**, or
- In Obsidian, go to **Settings → Community plugins → Browse**, search **GSync**, then install and enable it.

Updates arrive through Obsidian's built-in plugin updates.

### With BRAT (beta versions)

Only needed if you want to test unreleased versions. Install **BRAT** from Community plugins, then **Add beta plugin** → `dg0988/ObsidianGSync`.

### Manual

Download `main.js` and `manifest.json` from the [latest release](https://github.com/dg0988/ObsidianGSync/releases/latest) into:

```
<your vault>/.obsidian/plugins/gsync/
```

Then fully restart Obsidian and enable **GSync** under Community plugins. (On iPad/iPhone the Files app hides `.obsidian`; use BRAT, or an app like a-Shell to create the folder.)

---

## 3. Sign in (on each device)

1. **Settings → GSync**: paste the **Client ID** and **Client secret**.
2. Tap **Sign in with Google**. Your browser opens.
3. Choose your account and approve access.
4. The browser shows a "Returning to Obsidian" page and Obsidian reopens. If it doesn't, tap **Open Obsidian** on that page.
5. GSync shows **Signed in.**

This works the same on desktop, Android, and iOS. As an alternative, you can copy a refresh token from a signed-in device (**Copy refresh token**) and paste it into **Refresh token (manual)** on another device.

---

## 4. Configure and sync

Set **Google Drive folder** to the folder's path under *My Drive*, using `/` between folders:

```
Obsidian/Notes
```

The path must match the Drive folder's name exactly (same spelling and capitalization). If it doesn't exist, it is created.

Start a sync with any of:
- **Settings → GSync → Sync now**
- The ribbon icon (**Sync with Google Drive**)
- Command palette: **GSync: Sync now**

**First sync on mobile:** keep Obsidian open and the screen on until the progress notice disappears. Mobile operating systems pause apps in the background.

---

## Settings

| Setting | Default | Description |
|---|---|---|
| OAuth client ID / secret | — | From your Google Cloud **Web application** OAuth client. |
| Refresh token (manual) | — | Filled in by signing in; or paste one from another device. |
| Sign-in redirect page | `https://dg0988.github.io/ObsidianGSync/callback.html` | Must exactly match an authorized redirect URI on your OAuth client. |
| Google Drive folder | `Obsidian/<vault name>` | Path under *My Drive*. Backslashes are converted to `/`. |
| Auto-sync every (minutes) | `10` | `0` disables auto-sync. Only runs while Obsidian is open. |
| Sync when Obsidian starts | On | Skipped automatically if the previous sync didn't finish. |
| Sync deletions | On | Off = files deleted on one side come back on the next sync. |
| Max file size (MB) | `25` | Larger files are skipped and listed. `0` = no limit. Use ~10 on phones. |
| Exclude | `desktop.ini`, `Thumbs.db` | One rule per line (see below). |
| Reset sync state | — | Forgets sync history. The next sync compares every file by content; nothing is deleted. |

### Exclude rules

```
# comments start with #
Templates/        # a folder (prefix) and everything in it
*.exe             # a file extension
desktop.ini       # an exact file name, anywhere
Notes/draft.md    # an exact path
```

Excluded files stay in Drive and on other devices; they just aren't synced to this one.

---

## How sync works

GSync remembers what each file looked like on both sides at the last sync:

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
| `redirect_uri_mismatch` | Your OAuth client must be type **Web application**, with the redirect page URL added exactly as shown in GSync's settings. |
| Browser doesn't return to Obsidian | Tap **Open Obsidian** on the page. On Android, allow the browser to open Obsidian if asked. |
| "This sign-in link expired…" | Sign-in must finish within 15 minutes, on the same device where it started. Tap **Sign in with Google** again. |
| "Access blocked" / `access_denied` | Add your account as a test user on the consent screen, or publish the app. |
| `invalid_grant`, or sign-in expires every ~7 days | Publish the OAuth app to **In production**, then sign in again. |
| `Drive API 403` on first sync | Enable the **Google Drive API** for your project. |
| A new, empty folder appeared in Drive | The folder path doesn't match. Check spelling and capitalization, and use `/` between folders. Delete the stray folder. |
| "The last sync didn't finish…" | Obsidian closed or crashed mid-sync. Progress was saved; tap **Sync now** to resume. |
| Obsidian crashes during the first mobile sync | Lower **Max file size** to 10, exclude installers and archives, and leave the app on one note until the sync finishes. |

Errors are logged to the developer console (desktop: **Ctrl+Shift+I**) with the prefix `[gsync]`.

---

## Security and privacy

- Files go directly between your device and Google's API.
- Your client ID, client secret, and refresh token are stored only in each device's `.obsidian/plugins/gsync/data.json`. **Never commit or share that file.** The refresh token grants access to your Google Drive.
- Sign-in uses PKCE. The code passed through the redirect page is useless without the secret verifier that stays on your device.
- GSync requests the full Drive scope (`https://www.googleapis.com/auth/drive`) so it can see files already in your folder that it didn't create. It only reads and writes inside the folder you configure.
- To revoke access everywhere, remove the app at <https://myaccount.google.com/permissions>.

---

## Development

```
npm install
npm run dev     # watch build
npm run build   # type-check + production build -> main.js
```

### Releasing

Releases are built and signed by GitHub Actions ([`.github/workflows/release.yml`](.github/workflows/release.yml)), so the published `main.js` has a verifiable [build provenance attestation](https://docs.github.com/en/actions/security-for-github-actions/using-artifact-attestations/using-artifact-attestations-to-establish-provenance-for-builds).

1. Update `version` in `manifest.json` and `package.json`, and add it to `versions.json`.
2. Commit and push.
3. Publish a GitHub release with a new tag that exactly matches the version (e.g. `1.0.3`, no `v`). Don't attach files: the workflow builds `main.js` from the tagged source, attests it, and attaches `main.js` and `manifest.json`.

To verify a downloaded `main.js`:

```
gh attestation verify main.js --repo dg0988/ObsidianGSync
```

---

## License

[MIT](LICENSE)
