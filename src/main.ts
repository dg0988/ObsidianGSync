import { SyncProgress } from "./progress";
import { Notice, ObsidianProtocolData, Platform, Plugin } from "obsidian";
import { exchangeCode, isPendingValid, PendingAuth, prepareSignIn, PreparedSignIn, PROTOCOL_ACTION, refreshAccessToken } from "./auth";
import { DriveClient, FolderAccess, isSharedDrivePath } from "./drive";
import { normalizeTransferChunkSizeMiB } from "./transfer-settings";
import { cleanPath, DEFAULT_SETTINGS, GSyncSettings, GSyncSettingTab } from "./settings";
import { runSync, SyncResult, SyncScope, SyncState, underPrefix } from "./sync";
import { DEFAULT_CONFIG_SYNC, runConfigSync } from "./config-sync";
import { GSYNC_API_VERSION, GSyncApi, GSyncFolder, TeamsExtension } from "./api";

interface PluginData {
  settings?: Partial<GSyncSettings>;
  /** Sync history for the whole-vault folder. */
  state?: SyncState;
  /** Sync history for each extra folder pair, by pair id. */
  pairStates?: Record<string, SyncState>;
  /** Sync history for settings sync. */
  configState?: SyncState;
  syncInProgress?: boolean;
  pendingAuth?: PendingAuth | null;
}

export default class GSyncPlugin extends Plugin {
  settings: GSyncSettings = { ...DEFAULT_SETTINGS };
  state: SyncState = {};
  pairStates: Record<string, SyncState> = {};
  configState: SyncState = {};
  /** This device's access to each folder pair ("main" = whole vault), from the last sync. */
  access = new Map<string, FolderAccess>();
  /** The GSync Teams add-on, when it's installed, enabled and licensed. */
  teams: TeamsExtension | null = null;
  private accessToken = "";
  private expiresAt = 0;
  private syncing = false;
  private syncInProgress = false;
  private interruptedLastTime = false;
  private pendingAuth: PendingAuth | null = null;
  private prepared: PreparedSignIn | null = null;
  private autoSyncId: number | null = null;
  private statusEl!: HTMLElement;
  private activeProgress: SyncProgress | null = null;
  private progressNotice: Notice | null = null;
  private progressLastPaint = 0;
  private settingTab!: GSyncSettingTab;
  private drive = new DriveClient(() => this.getAccessToken());

  get driveClient(): DriveClient {
    return this.drive;
  }

  isTeams(): boolean {
    return this.teams !== null;
  }

  /** Interface for add-ons such as GSync Teams (see src/api.ts). */
  readonly api: GSyncApi = {
    version: GSYNC_API_VERSION,
    request: (url, opts) => this.drive.request(url, opts),
    ensureFolderPath: (path) => this.drive.ensureFolderPath(path),
    folderAccess: (folderId) => this.drive.folderAccess(folderId),
    folders: (): GSyncFolder[] => [
      { id: "main", local: "", remote: this.settings.remoteFolder },
      ...this.settings.pairs.filter((p) => p.local && p.remote).map((p) => ({ id: p.id, local: p.local, remote: p.remote })),
    ],
    registerTeams: (ext) => {
      this.teams = ext;
      this.drive.sharedDriveResolver = (name) => ext.resolveSharedDrive(name);
      return () => {
        if (this.teams !== ext) return;
        this.teams = null;
        this.drive.sharedDriveResolver = null;
      };
    },
  };

  async onload() {
    const data = ((await this.loadData()) ?? {}) as PluginData;
    this.settings = { ...DEFAULT_SETTINGS, ...(data.settings ?? {}) };
    this.settings.configSync = { ...DEFAULT_CONFIG_SYNC, ...(data.settings?.configSync ?? {}) };
    this.settings.pairs = (this.settings.pairs ?? []).map((p) => ({ ...p }));
    this.pairStates = data.pairStates ?? {};
    this.configState = data.configState ?? {};
    this.settings.transferChunkSizeMiB = normalizeTransferChunkSizeMiB(this.settings.transferChunkSizeMiB);
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

    this.addCommand({ id: "show-sync-progress", name: "Show sync progress", callback: () => this.showSyncProgress() });
    this.register(() => this.progressNotice?.hide());

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
      pairStates: this.pairStates,
      configState: this.configState,
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

  private showSyncProgress() {
    if (!this.activeProgress) { new Notice("No sync in progress."); return; }
    this.progressNotice?.hide();
    this.progressNotice = new Notice(this.activeProgress.text(), 0);
  }

  private renderProgress(force = false, showNotice = false) {
    if (!this.activeProgress) return;
    const now = performance.now();
    if (!force && now - this.progressLastPaint < 250) return;
    this.progressLastPaint = now;
    const text = this.activeProgress.text();
    this.setStatus(text.replace(/\n/g, " · "));
    if (this.progressNotice) this.progressNotice.setMessage(text);
    else if (showNotice && Platform.isMobile) this.showSyncProgress();
  }

  /** Problems with the folder pairs, by pair id. A bad pair is skipped; the rest still sync. */
  validatePairs(): Map<string, string> {
    const problems = new Map<string, string>();
    const pairs = this.settings.pairs;
    for (const p of pairs) {
      const local = cleanPath(p.local);
      if (!local || !p.remote) problems.set(p.id, "Set both a vault folder and a Drive folder.");
      else if (local.split("/").some((seg) => seg.startsWith("."))) problems.set(p.id, "Hidden folders can't be synced.");
      else if (pairs.some((o) => o !== p && o.local && (underPrefix(local, cleanPath(o.local)) || underPrefix(cleanPath(o.local), local))))
        problems.set(p.id, `"${local}" overlaps another folder pair.`);
      else if (isSharedDrivePath(p.remote) && !this.isTeams()) problems.set(p.id, "Folders in Shared Drives need the GSync Teams add-on.");
    }
    return problems;
  }

  private async syncAllFolders(quiet: boolean): Promise<SyncResult & { needsRestart: boolean }> {
    const s = this.settings;
    this.drive.resetCache();
    const total: SyncResult & { needsRestart: boolean } = {
      uploaded: 0, downloaded: 0, deletedLocal: 0, deletedRemote: 0,
      conflicts: [], errors: [], warnings: [], skipped: [], readOnlyKept: [], needsRestart: false,
    };
    const add = (r: SyncResult) => {
      total.uploaded += r.uploaded;
      total.downloaded += r.downloaded;
      total.deletedLocal += r.deletedLocal;
      total.deletedRemote += r.deletedRemote;
      for (const k of ["conflicts", "errors", "warnings", "skipped", "readOnlyKept"] as const) total[k].push(...r[k]);
    };
    const hooks = {
      checkpoint: () => this.saveAll(),
      progress: (done: number, count: number, transferred: number) => {
        this.activeProgress?.files(done, count);
        this.renderProgress(done === count, transferred > 0 || !quiet);
      },
      transfer: (progress: Parameters<NonNullable<Parameters<typeof runSync>[4]["transfer"]>>[0]) => {
        const changed = this.activeProgress?.transfer(progress);
        this.renderProgress(changed, true);
      },
    };

    const problems = this.validatePairs();
    const pairs = s.pairs.filter((p) => !problems.has(p.id));
    for (const [id, msg] of problems) {
      const p = s.pairs.find((x) => x.id === id);
      if (p && (p.local || p.remote)) total.errors.push(`Folder pair "${p.local || p.remote}": ${msg}`);
    }

    const jobs: { id: string; scope: Omit<SyncScope, "readOnly">; state: () => SyncState }[] = [
      {
        id: "main",
        scope: { localPrefix: "", remotePath: s.remoteFolder, otherPrefixes: pairs.map((p) => cleanPath(p.local)) },
        state: () => this.state,
      },
      ...pairs.map((p) => ({
        id: p.id,
        scope: { localPrefix: cleanPath(p.local), remotePath: p.remote, otherPrefixes: [] },
        state: () => (this.pairStates[p.id] ??= {}),
      })),
    ];
    if (isSharedDrivePath(s.remoteFolder) && !this.isTeams()) {
      jobs.shift();
      total.errors.push("The whole-vault Drive folder is in a Shared Drive, which needs the GSync Teams add-on.");
    }

    for (const job of jobs) {
      try {
        const rootId = await this.drive.ensureFolderPath(job.scope.remotePath);
        const access = await this.drive.folderAccess(rootId);
        this.access.set(job.id, access);
        add(await runSync(this.app, this.drive, s, job.state(), hooks, { ...job.scope, readOnly: !access.canEdit }));
        if (job.id === "main" && s.configSync.enabled) {
          if (!access.canEdit) total.warnings.push("Settings sync skipped: the whole-vault Drive folder is view-only for you.");
          else {
            const c = await runConfigSync(this.app, this.drive, s.configSync, rootId, this.configState, {
              propagateDeletes: s.propagateDeletes,
              maxBytes: Math.max(0, s.maxFileSizeMB) * 1024 * 1024,
            });
            total.uploaded += c.uploaded;
            total.downloaded += c.downloaded;
            total.deletedRemote += c.deleted;
            total.errors.push(...c.errors);
            total.needsRestart ||= c.needsRestart;
          }
        }
      } catch (e) {
        total.errors.push(`${job.scope.remotePath || "Drive folder"}: ${(e as Error).message}`);
      }
      await this.saveAll();
    }
    return total;
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
    this.activeProgress = new SyncProgress();
    this.renderProgress(true, !quiet);
    try {
      const r = await this.syncAllFolders(quiet);
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
      if (r.readOnlyKept.length) {
        new Notice(`${r.readOnlyKept.length} change(s) in view-only folders stayed on this device (edits are kept as "(local edit …)" copies):\n${r.readOnlyKept.slice(0, 5).join("\n")}`, 15000);
      }
      if (r.needsRestart) {
        new Notice("GSync: settings or plugins arrived from another device. Restart Obsidian to apply them.", 0);
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
      this.progressNotice?.hide();
      this.progressNotice = null;
      this.activeProgress = null;
      if (this.syncInProgress) {
        // Failed with an error (not a crash): nothing to resume-warn about.
        this.syncInProgress = false;
        await this.saveAll();
      }
      this.syncing = false;
    }
  }
}
