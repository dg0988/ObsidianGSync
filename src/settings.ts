import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type GSyncPlugin from "./main";
import { DEFAULT_REDIRECT } from "./auth";

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
  excludes: "# One rule per line. Hidden files/folders (.obsidian etc.) are always skipped.\n# Examples:  Templates/   *.tmp   desktop.ini\ndesktop.ini\nThumbs.db\n",
  maxFileSizeMB: 25,
};

export class GSyncSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: GSyncPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    const s = this.plugin.settings;
    containerEl.empty();

    new Setting(containerEl).setName("Google account").setHeading();

    new Setting(containerEl)
      .setName("OAuth client ID")
      .setDesc("From Google Cloud Console: Credentials, OAuth client ID (type: Web application).")
      .addText((t) =>
        t.setValue(s.clientId).onChange(async (v) => {
          s.clientId = v.trim();
          await this.plugin.saveAll();
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
        .onClick(async () => {
          if (!s.clientId || !s.clientSecret) {
            new Notice("Enter the client ID and secret first.");
            return;
          }
          await this.plugin.startSignIn();
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
        b.setButtonText("Sign out").setWarning().onClick(async () => {
          s.refreshToken = "";
          this.plugin.setAccessToken("", 0);
          await this.plugin.saveAll();
          this.display();
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

    new Setting(containerEl)
      .setName("Google Drive folder")
      .setDesc('Path under "My Drive", e.g. Obsidian/Notes. Created if it does not exist.')
      .addText((t) =>
        t.setValue(s.remoteFolder).onChange(async (v) => {
          const next = v.trim().replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/^\/+|\/+$/g, "");
          if (next !== s.remoteFolder) this.plugin.state = {}; // new target -> fresh comparison
          s.remoteFolder = next;
          await this.plugin.saveAll();
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
          await this.plugin.saveAll();
          new Notice("Sync state reset.");
        })
      );
  }
}
