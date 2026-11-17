import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type GSyncPlugin from "./main";
import { DEFAULT_REDIRECT } from "./auth";
import { DEFAULT_TRANSFER_CHUNK_MIB, normalizeTransferChunkSizeMiB, TRANSFER_CHUNK_OPTIONS_MIB } from "./transfer-settings";
import { ConfigSyncSettings, DEFAULT_CONFIG_SYNC } from "./config-sync";
import { isSharedDrivePath } from "./drive";

/** An extra vault folder synced with its own Drive folder. */
export interface FolderPair {
  id: string;
  /** Vault folder, e.g. "Work". */
  local: string;
  /** Drive folder, e.g. "Company/Notes" or "Shared drives/Company/Notes". */
  remote: string;
}

export const cleanPath = (v: string) => v.trim().replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/^\/+|\/+$/g, "");

const DONATE_URL = "https://www.paypal.com/donate/?hosted_button_id=N8NVQRB353E2G";

export interface GSyncSettings {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  redirectUri: string;
  remoteFolder: string;
  autoSyncMinutes: number;
  syncOnStartup: boolean;
  propagateDeletes: boolean;
  excludes: string;
  maxFileSizeMB: number;
  transferChunkSizeMiB: number;
  /** Extra vault folders, each synced with its own Drive folder. */
  pairs: FolderPair[];
  configSync: ConfigSyncSettings;
}

export const DEFAULT_SETTINGS: GSyncSettings = {
  clientId: "",
  clientSecret: "",
  refreshToken: "",
  redirectUri: DEFAULT_REDIRECT,
  remoteFolder: "",
  autoSyncMinutes: 10,
  syncOnStartup: true,
  propagateDeletes: true,
  excludes: "# One rule per line. Hidden files/folders and the vault config folder are always skipped.\n# Examples:  Templates/   *.tmp   desktop.ini\ndesktop.ini\nThumbs.db\n",
  maxFileSizeMB: 25,
  transferChunkSizeMiB: DEFAULT_TRANSFER_CHUNK_MIB,
  pairs: [],
  configSync: { ...DEFAULT_CONFIG_SYNC },
};

export class GSyncSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: GSyncPlugin) {
    super(app, plugin);
  }

  display(): void {
    this.refresh();
  }

  /** Rebuilds the settings UI (also called after sign-in completes). */
  refresh(): void {
    const { containerEl } = this;
    const s = this.plugin.settings;
    containerEl.empty();
    void this.plugin.prepareSignInLink();

    new Setting(containerEl).setName("Google account").setHeading();

    new Setting(containerEl)
      .setName("OAuth client ID")
      .setDesc("From Google Cloud Console: Credentials, OAuth client ID (type: Web application).")
      .addText((t) =>
        t.setValue(s.clientId).onChange(async (v) => {
          s.clientId = v.trim();
          await this.plugin.saveAll();
          void this.plugin.prepareSignInLink();
        })
      );

    new Setting(containerEl).setName("OAuth client secret").addText((t) => {
      t.inputEl.type = "password";
      t.setValue(s.clientSecret).onChange(async (v) => {
        s.clientSecret = v.trim();
        await this.plugin.saveAll();
      });
    });

    const status = new Setting(containerEl)
      .setName("Status")
      .setDesc(s.refreshToken ? "Signed in." : "Not signed in.");

    status.addButton((b) =>
      b
        .setButtonText(s.refreshToken ? "Sign in again" : "Sign in with Google")
        .setCta()
        .onClick(() => {
          if (!s.clientId || !s.clientSecret) {
            new Notice("Enter the client ID and secret first.");
            return;
          }
          this.plugin.startSignIn();
        })
    );

    if (s.refreshToken) {
      status.addButton((b) =>
        b.setButtonText("Copy refresh token").onClick(async () => {
          await navigator.clipboard.writeText(s.refreshToken);
          new Notice("Refresh token copied. Keep it private.");
        })
      );
      status.addButton((b) =>
        b.setButtonText("Sign out").onClick(async () => {
          s.refreshToken = "";
          this.plugin.setAccessToken("", 0);
          await this.plugin.saveAll();
          this.refresh();
        })
      );
    }

    new Setting(containerEl)
      .setName("Refresh token (manual)")
      .setDesc("Optional. Paste a token from another device instead of signing in here.")
      .addText((t) => {
        t.inputEl.type = "password";
        t.setValue(s.refreshToken).onChange(async (v) => {
          s.refreshToken = v.trim();
          this.plugin.setAccessToken("", 0);
          await this.plugin.saveAll();
        });
      });

    new Setting(containerEl)
      .setName("Sign-in redirect page")
      .setDesc("Must exactly match an authorized redirect URI on your OAuth client. Leave the default unless you host your own copy of callback.html.")
      .addText((t) =>
        t.setValue(s.redirectUri).onChange(async (v) => {
          s.redirectUri = v.trim() || DEFAULT_REDIRECT;
          await this.plugin.saveAll();
          void this.plugin.prepareSignInLink();
        })
      );

    new Setting(containerEl).setName("Sync").setHeading();

    new Setting(containerEl)
      .setName("Sync now")
      .setDesc("Also available from the ribbon icon and the command palette (\"GSync: Sync now\").")
      .addButton((b) =>
        b
          .setButtonText("Sync now")
          .setCta()
          .onClick(async () => {
            b.setDisabled(true).setButtonText("Syncing…");
            try {
              await this.plugin.sync(false);
            } finally {
              b.setDisabled(false).setButtonText("Sync now");
            }
          })
      );

    const main = new Setting(containerEl)
      .setName("Google Drive folder")
      .setDesc(this.folderDesc('Whole vault. Path under "My Drive", e.g. Obsidian/Notes. Created if it does not exist.', "main", s.remoteFolder))
      .addText((t) =>
        t.setValue(s.remoteFolder).onChange(async (v) => {
          const next = cleanPath(v);
          if (next !== s.remoteFolder) this.plugin.state = {}; // new target -> fresh comparison
          s.remoteFolder = next;
          await this.plugin.saveAll();
        })
      );
    this.addAccessButton(main, s.remoteFolder);

    new Setting(containerEl).setName("More folders").setHeading();
    new Setting(containerEl).setDesc(
      'Sync a vault folder with a different Drive folder, e.g. vault "Work" with a folder your team shares. ' +
        "The whole-vault folder above leaves these vault folders alone. " +
        'Folders in Shared Drives ("Shared drives/<drive name>/<folder>") need the GSync Teams add-on.'
    );
    for (const pair of s.pairs) {
      const row = new Setting(containerEl)
        .setName(pair.local ? `Vault folder: ${pair.local}` : "New folder pair")
        .setDesc(this.folderDesc("", pair.id, pair.remote))
        .addText((t) =>
          t.setPlaceholder("Vault folder, e.g. Work").setValue(pair.local).onChange(async (v) => {
            const next = cleanPath(v);
            if (next !== pair.local) delete this.plugin.pairStates[pair.id];
            pair.local = next;
            await this.plugin.saveAll();
          })
        )
        .addText((t) =>
          t.setPlaceholder("Drive folder").setValue(pair.remote).onChange(async (v) => {
            const next = cleanPath(v);
            if (next !== pair.remote) delete this.plugin.pairStates[pair.id];
            pair.remote = next;
            await this.plugin.saveAll();
          })
        );
      this.addAccessButton(row, pair.remote);
      row.addExtraButton((b) =>
        b.setIcon("trash").setTooltip("Stop syncing this folder (no files are deleted)").onClick(async () => {
          s.pairs = s.pairs.filter((p) => p !== pair);
          delete this.plugin.pairStates[pair.id];
          await this.plugin.saveAll();
          this.refresh();
        })
      );
    }
    new Setting(containerEl).addButton((b) =>
      b.setButtonText("Add a folder").onClick(async () => {
        s.pairs.push({ id: crypto.randomUUID(), local: "", remote: "" });
        await this.plugin.saveAll();
        this.refresh();
      })
    );

    new Setting(containerEl)
      .setName("Auto-sync every (minutes)")
      .setDesc("0 turns auto-sync off.")
      .addText((t) =>
        t.setValue(String(s.autoSyncMinutes)).onChange(async (v) => {
          const n = Math.max(0, parseInt(v, 10) || 0);
          s.autoSyncMinutes = n;
          await this.plugin.saveAll();
          this.plugin.scheduleAutoSync();
        })
      );

    new Setting(containerEl).setName("Sync when Obsidian starts").addToggle((t) =>
      t.setValue(s.syncOnStartup).onChange(async (v) => {
        s.syncOnStartup = v;
        await this.plugin.saveAll();
      })
    );

    new Setting(containerEl)
      .setName("Sync deletions")
      .setDesc("Deleting a note on one side moves it to the trash on the other (Drive trash / Obsidian trash). Off = deleted files come back on next sync.")
      .addToggle((t) =>
        t.setValue(s.propagateDeletes).onChange(async (v) => {
          s.propagateDeletes = v;
          await this.plugin.saveAll();
        })
      );

    new Setting(containerEl)
      .setName("Max file size (MB)")
      .setDesc("Larger files are skipped (listed in the sync notice). Keeps phones from running out of memory. 0 = no limit.")
      .addText((t) =>
        t.setValue(String(s.maxFileSizeMB)).onChange(async (v) => {
          s.maxFileSizeMB = Math.max(0, parseInt(v, 10) || 0);
          await this.plugin.saveAll();
        })
      );

    new Setting(containerEl)
      .setName("Transfer chunk size (MiB)")
      .setDesc("Android downloads and uploads. Larger blocks reduce requests but use more memory. Applies to the next file transfer; smaller files use a single block.")
      .addDropdown((dropdown) => {
        for (const size of TRANSFER_CHUNK_OPTIONS_MIB) dropdown.addOption(String(size), String(size));
        dropdown.setValue(String(normalizeTransferChunkSizeMiB(s.transferChunkSizeMiB))).onChange(async (value) => {
          s.transferChunkSizeMiB = normalizeTransferChunkSizeMiB(Number(value));
          await this.plugin.saveAll();
        });
      });

    new Setting(containerEl)
      .setName("Exclude")
      .setDesc("Folder/ prefixes, *.ext patterns, or exact file names.")
      .addTextArea((t) => {
        t.inputEl.rows = 6;
        t.setValue(s.excludes).onChange(async (v) => {
          s.excludes = v;
          await this.plugin.saveAll();
        });
      });

    new Setting(containerEl)
      .setName("Reset sync state")
      .setDesc("Forgets what was synced. Next sync compares every file by content; nothing is deleted.")
      .addButton((b) =>
        b.setButtonText("Reset").onClick(async () => {
          this.plugin.state = {};
          this.plugin.pairStates = {};
          this.plugin.configState = {};
          await this.plugin.saveAll();
          new Notice("Sync state reset.");
        })
      );

    this.settingsSyncSection(containerEl);

    new Setting(containerEl).setName("Support").setHeading();

    new Setting(containerEl)
      .setName("Support GSync")
      .setDesc("GSync is free and open source. If it saves you a subscription, you can chip in to support development.")
      .addButton((b) =>
        b.setButtonText("Donate via PayPal").onClick(() => {
          window.open(DONATE_URL);
        })
      );
  }

  /** Description for a folder row, including this device's access from the last sync. */
  private folderDesc(text: string, pairId: string, remote: string): DocumentFragment {
    const frag = createFragment();
    if (text) frag.appendText(text);
    const access = this.plugin.access.get(pairId);
    const notes: string[] = [];
    if (access && !access.canEdit) notes.push("View only: Drive changes download here; edits on this device stay local.");
    if (isSharedDrivePath(remote) && !this.plugin.isTeams()) notes.push("Folders in Shared Drives need the GSync Teams add-on.");
    for (const n of notes) {
      if (frag.childNodes.length) frag.createEl("br");
      frag.appendText(n);
    }
    return frag;
  }

  /** The GSync Teams add-on adds a "manage access" button to each folder. */
  private addAccessButton(setting: Setting, remote: string) {
    const teams = this.plugin.teams;
    if (!teams || !remote) return;
    setting.addExtraButton((b) =>
      b.setIcon("users").setTooltip("Manage who can access this Drive folder (GSync Teams)").onClick(() => teams.manageAccess(remote))
    );
  }

  private settingsSyncSection(containerEl: HTMLElement) {
    const c = this.plugin.settings.configSync;
    new Setting(containerEl).setName("Plugins and preferences").setHeading();
    new Setting(containerEl)
      .setName("Sync settings and plugins")
      .setDesc(
        "Keeps Obsidian settings, themes and community plugins the same on every device, using the " +
          "vault's config folder inside the whole-vault Drive folder. The first time you turn this on, " +
          "this device takes the settings already in Drive. GSync's own settings and each device's window " +
          "layout are never synced. Restart Obsidian after changes arrive."
      )
      .addToggle((t) =>
        t.setValue(c.enabled).onChange(async (v) => {
          c.enabled = v;
          await this.plugin.saveAll();
          this.refresh();
        })
      );
    if (!c.enabled) return;
    const toggle = (key: "core" | "appearance" | "pluginList" | "plugins", name: string, desc: string) =>
      new Setting(containerEl)
        .setName(name)
        .setDesc(desc)
        .addToggle((t) =>
          t.setValue(c[key]).onChange(async (v) => {
            c[key] = v;
            await this.plugin.saveAll();
          })
        );
    toggle("core", "Core settings and hotkeys", "Editor, files and links, hotkeys, core plugins and their options.");
    toggle("appearance", "Appearance", "Theme choice, installed themes and CSS snippets.");
    toggle("pluginList", "Enabled plugins list", "Which community plugins are turned on.");
    toggle("plugins", "Installed plugins", "Community plugins and their settings.");
    new Setting(containerEl)
      .setName("Keep these plugins separate")
      .setDesc("One plugin folder name per line (as in the config folder's plugins/ folder). These plugins, and whether they're turned on, stay separate on each device.")
      .addTextArea((t) => {
        t.inputEl.rows = 4;
        t.setPlaceholder("One per line, e.g. obsidian-git").setValue(c.excludedPlugins).onChange(async (v) => {
          c.excludedPlugins = v;
          await this.plugin.saveAll();
        });
      });
  }
}
