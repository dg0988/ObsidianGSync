import { Notice, ObsidianProtocolData, Platform, Plugin } from "obsidian";
import { exchangeCode, isPendingValid, PendingAuth, prepareSignIn, PreparedSignIn, PROTOCOL_ACTION, refreshAccessToken } from "./auth";
import { DriveClient } from "./drive";
import { DEFAULT_SETTINGS, GSyncSettings, GSyncSettingTab } from "./settings";
import { runSync, SyncState } from "./sync";

interface PluginData {
  settings?: Partial<GSyncSettings>;
  state?: SyncState;
  syncInProgress?: boolean;
  pendingAuth?: PendingAuth | null;
}

export default class GSyncPlugin extends Plugin {
  settings: GSyncSettings = { ...DEFAULT_SETTINGS };
  state: SyncState = {};
  private accessToken = "";
  private expiresAt = 0;
  private syncing = false;
  private syncInProgress = false;
  private interruptedLastTime = false;
  private pendingAuth: PendingAuth | null = null;
  private prepared: PreparedSignIn | null = null;
  private autoSyncId: number | null = null;
  private statusEl!: HTMLElement;
  private settingTab!: GSyncSettingTab;
  private drive = new DriveClient(() => this.getAccessToken());

  async onload() {
    const data = ((await this.loadData()) ?? {}) as PluginData;
    this.settings = { ...DEFAULT_SETTINGS, ...(data.settings ?? {}) };
    this.state = data.state ?? {};
    this.interruptedLastTime = !!data.syncInProgress;
    this.pendingAuth = data.pendingAuth ?? null;
    this.settings.remoteFolder = this.settings.remoteFolder.replace(/\\/g, "/");
    if (!this.settings.remoteFolder) this.settings.remoteFolder = `Obsidian/${this.app.vault.getName()}`;

    this.settingTab = new GSyncSettingTab(this.app, this);
    this.addSettingTab(this.settingTab);
    this.statusEl = this.addStatusBarItem();
    this.setStatus("GSync: idle");

    this.addRibbonIcon("refresh-cw", "Sync with Google Drive", () => void this.sync(false));
    this.addCommand({ id: "sync-now", name: "Sync now", callback: () => void this.sync(false) });

    // Google -> callback.html -> obsidian://gsync-auth?code=...&state=...
    this.registerObsidianProtocolHandler(PROTOCOL_ACTION, (params) => {
      void this.finishSignIn(params);
    });

    this.app.workspace.onLayoutReady(() => {
      if (this.interruptedLastTime) {
        new Notice("GSync: the last sync didn't finish (Obsidian closed or crashed). Auto-sync on startup was skipped. Progress was saved, so tap Sync now to resume.", 15000);
        return;
      }
      if (this.settings.syncOnStartup && this.settings.refreshToken) {
        window.setTimeout(() => void this.sync(true), 5000);
      }
    });
    this.scheduleAutoSync();
  }

  async saveAll() {
    await this.saveData({
      settings: this.settings,
      state: this.state,
      syncInProgress: this.syncInProgress,
      pendingAuth: this.pendingAuth,
    } satisfies PluginData);
  }

  /** Called when the settings tab opens, so the tap can open the browser instantly. */
  async prepareSignInLink(): Promise<void> {
    const { clientId, redirectUri } = this.settings;
    if (!clientId) return;
    const fresh =
      this.prepared &&
      this.prepared.url.includes(encodeURIComponent(clientId)) &&
      this.prepared.pending.redirectUri === redirectUri &&
      isPendingValid(this.prepared.pending);
    if (fresh) return;
    try {
      this.prepared = await prepareSignIn(clientId, redirectUri, this.app.vault.getName());
    } catch (e) {
      console.error("[gsync] could not prepare sign-in", e);
      this.prepared = null;
    }
  }

  /** Must run synchronously inside the button tap (no await before window.open). */
  startSignIn(): void {
    const p = this.prepared;
    if (!p || !p.url.includes(encodeURIComponent(this.settings.clientId)) || p.pending.redirectUri !== this.settings.redirectUri) {
      new Notice("Preparing sign-in… tap Sign in with Google again in a moment.");
      void this.prepareSignInLink();
      return;
    }
    const win = window.open(p.url);
    this.pendingAuth = p.pending;
    this.prepared = null; // each attempt gets fresh codes
    if (win === null) {
      // Browser was blocked: hand the link over another way.
      void navigator.clipboard.writeText(p.url).catch(() => undefined);
      new Notice("Couldn't open your browser. The sign-in link was copied: paste it into Safari or Chrome.", 15000);
    } else {
      new Notice("Finish signing in in your browser. It will send you back to Obsidian.", 10000);
    }
    void this.saveAll(); // survives the app being closed while the browser is open
    void this.prepareSignInLink(); // ready for a retry
  }

  private async finishSignIn(params: ObsidianProtocolData) {
    const pending = this.pendingAuth;
    try {
      if (params.error) throw new Error(`Google returned: ${params.error}`);
      if (!params.code) throw new Error("No sign-in code was received.");
      if (!isPendingValid(pending)) throw new Error("This sign-in link expired or wasn't started on this device. Tap Sign in with Google again.");
      if (params.state !== pending.state) throw new Error("Sign-in state didn't match. Tap Sign in with Google again.");
      const tokens = await exchangeCode(this.settings.clientId, this.settings.clientSecret, params.code, pending);
      this.settings.refreshToken = tokens.refreshToken;
      this.setAccessToken(tokens.accessToken, tokens.expiresAt);
      new Notice("GSync: signed in to Google Drive.");
    } catch (e) {
      new Notice(`GSync sign-in failed: ${(e as Error).message}`, 15000);
    } finally {
      this.pendingAuth = null;
      await this.saveAll();
      this.settingTab.refresh();
    }
  }

  setAccessToken(token: string, expiresAt: number) {
    this.accessToken = token;
    this.expiresAt = expiresAt;
  }

  private async getAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.expiresAt) return this.accessToken;
    const { clientId, clientSecret, refreshToken } = this.settings;
    if (!refreshToken) throw new Error("Not signed in to Google Drive.");
    const t = await refreshAccessToken(clientId, clientSecret, refreshToken);
    this.setAccessToken(t.accessToken, t.expiresAt);
    return t.accessToken;
  }

  scheduleAutoSync() {
    if (this.autoSyncId !== null) window.clearInterval(this.autoSyncId);
    this.autoSyncId = null;
    const mins = this.settings.autoSyncMinutes;
    if (mins > 0) {
      this.autoSyncId = window.setInterval(() => void this.sync(true), mins * 60 * 1000);
      this.registerInterval(this.autoSyncId);
    }
  }

  private setStatus(text: string) {
    this.statusEl.setText(text);
  }

  async sync(quiet: boolean) {
    if (this.syncing) {
      if (!quiet) new Notice("Sync already running.");
      return;
    }
    const s = this.settings;
    if (!s.clientId || !s.clientSecret || !s.refreshToken) {
      if (!quiet) new Notice("GSync: set up and sign in from the plugin settings first.");
      return;
    }
    this.syncing = true;
    this.syncInProgress = true;
    this.interruptedLastTime = false;
    await this.saveAll();
    this.setStatus("GSync: syncing…");
    let progressNotice: Notice | null = null;
    try {
      const r = await runSync(this.app, this.drive, s, this.state, {
        checkpoint: () => this.saveAll(),
        progress: (done, total, transferred) => {
          const msg = `GSync: syncing ${done}/${total}${transferred ? ` (${transferred} changed)` : ""}`;
          this.setStatus(msg);
          // Mobile has no status bar, so show a live notice once real work is happening.
          if (Platform.isMobile && (transferred > 0 || !quiet) && done < total) {
            if (!progressNotice) progressNotice = new Notice(msg, 0);
            else progressNotice.setMessage(msg);
          }
        },
      });
      this.syncInProgress = false;
      await this.saveAll();
      const parts: string[] = [];
      if (r.uploaded) parts.push(`↑${r.uploaded}`);
      if (r.downloaded) parts.push(`↓${r.downloaded}`);
      if (r.deletedLocal + r.deletedRemote) parts.push(`🗑${r.deletedLocal + r.deletedRemote}`);
      if (r.conflicts.length) parts.push(`⚠ ${r.conflicts.length} conflict(s)`);
      const summary = parts.length ? parts.join(" ") : "up to date";
      this.setStatus(`GSync: ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} ${r.errors.length ? "⚠" : "✓"}`);

      if (!quiet || parts.length || r.errors.length) new Notice(`GSync: ${summary}`);
      if (r.conflicts.length) {
        new Notice(`Both sides changed; Drive's version saved as a "(conflict …)" copy:\n${r.conflicts.slice(0, 5).join("\n")}`, 15000);
      }
      if (r.errors.length) {
        console.error("[gsync] errors", r.errors);
        new Notice(`${r.errors.length} file(s) failed to sync. First: ${r.errors[0]}`, 15000);
      }
      if (r.skipped.length) {
        new Notice(`Skipped ${r.skipped.length} file(s) over ${s.maxFileSizeMB} MB:\n${r.skipped.slice(0, 5).join("\n")}`, 15000);
      }
      if (r.warnings.length) console.warn("[gsync] warnings", r.warnings);
    } catch (e) {
      this.setStatus("GSync: error");
      console.error("[gsync]", e);
      new Notice(`GSync failed: ${(e as Error).message}`, 15000);
    } finally {
      (progressNotice as Notice | null)?.hide();
      if (this.syncInProgress) {
        // Failed with an error (not a crash): nothing to resume-warn about.
        this.syncInProgress = false;
        await this.saveAll();
      }
      this.syncing = false;
    }
  }
}
