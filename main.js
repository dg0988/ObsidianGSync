"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/main.ts
var main_exports = {};
__export(main_exports, {
  default: () => GDriveSyncPlugin
});
module.exports = __toCommonJS(main_exports);
var import_obsidian5 = require("obsidian");

// src/auth.ts
var import_obsidian = require("obsidian");
var AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
var TOKEN_URL = "https://oauth2.googleapis.com/token";
var SCOPE = "https://www.googleapis.com/auth/drive";
function base64url(bytes) {
  let s = "";
  bytes.forEach((b) => s += String.fromCharCode(b));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function makePkce() {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: base64url(new Uint8Array(digest)) };
}
function formBody(o) {
  return Object.entries(o).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
}
async function signInDesktop(clientId, clientSecret) {
  if (!import_obsidian.Platform.isDesktopApp) {
    throw new Error("Sign-in only works on desktop. Copy the refresh token from your desktop settings instead.");
  }
  const http = require("http");
  const { verifier, challenge } = await makePkce();
  const state = base64url(crypto.getRandomValues(new Uint8Array(16)));
  let redirectUri = "";
  let timer = 0;
  const code = await new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      var _a;
      const url = new URL((_a = req.url) != null ? _a : "/", "http://127.0.0.1");
      const err = url.searchParams.get("error");
      const c = url.searchParams.get("code");
      if (!c && !err) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        err ? `<h2>Sign-in failed: ${err}</h2>` : "<h2>Signed in to Google Drive Vault Sync.</h2><p>You can close this tab and return to Obsidian.</p>"
      );
      window.clearTimeout(timer);
      server.close();
      if (err) reject(new Error(`Google returned: ${err}`));
      else if (url.searchParams.get("state") !== state) reject(new Error("OAuth state mismatch"));
      else resolve(c);
    });
    timer = window.setTimeout(() => {
      server.close();
      reject(new Error("Sign-in timed out after 5 minutes"));
    }, 5 * 60 * 1e3);
    server.on("error", (e) => reject(e));
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      redirectUri = `http://127.0.0.1:${port}`;
      const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: SCOPE,
        code_challenge: challenge,
        code_challenge_method: "S256",
        access_type: "offline",
        prompt: "consent",
        state
      });
      window.open(`${AUTH_URL}?${params.toString()}`);
    });
  });
  const r = await (0, import_obsidian.requestUrl)({
    url: TOKEN_URL,
    method: "POST",
    contentType: "application/x-www-form-urlencoded",
    body: formBody({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      code_verifier: verifier,
      grant_type: "authorization_code",
      redirect_uri: redirectUri
    }),
    throw: false
  });
  if (r.status !== 200) throw new Error(`Token exchange failed (${r.status}): ${r.text}`);
  const j = r.json;
  if (!j.refresh_token) throw new Error("Google did not return a refresh token. Remove the app's access in your Google account and try again.");
  return {
    accessToken: j.access_token,
    refreshToken: j.refresh_token,
    expiresAt: Date.now() + (j.expires_in - 60) * 1e3
  };
}
async function refreshAccessToken(clientId, clientSecret, refreshToken) {
  const r = await (0, import_obsidian.requestUrl)({
    url: TOKEN_URL,
    method: "POST",
    contentType: "application/x-www-form-urlencoded",
    body: formBody({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token"
    }),
    throw: false
  });
  if (r.status !== 200) {
    if (r.text.includes("invalid_grant")) {
      throw new Error(
        "Google rejected the saved sign-in (invalid_grant). Sign in again. If this keeps happening every ~7 days, publish your OAuth app to 'In production' in Google Cloud."
      );
    }
    throw new Error(`Token refresh failed (${r.status}): ${r.text}`);
  }
  const j = r.json;
  return { accessToken: j.access_token, expiresAt: Date.now() + (j.expires_in - 60) * 1e3 };
}

// src/drive.ts
var import_obsidian2 = require("obsidian");
var API = "https://www.googleapis.com/drive/v3";
var UPLOAD = "https://www.googleapis.com/upload/drive/v3";
var FOLDER_MIME = "application/vnd.google-apps.folder";
var FIELDS = "id,name,mimeType,md5Checksum,modifiedTime,size";
function q(s) {
  return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}
var sleep = (ms) => new Promise((r) => window.setTimeout(r, ms));
var DriveClient = class {
  constructor(getToken) {
    this.getToken = getToken;
  }
  async req(url, opts = {}) {
    var _a;
    for (let attempt = 0; ; attempt++) {
      const token = await this.getToken();
      const r = await (0, import_obsidian2.requestUrl)({
        url,
        method: (_a = opts.method) != null ? _a : "GET",
        body: opts.body,
        contentType: opts.contentType,
        headers: { Authorization: `Bearer ${token}` },
        throw: false
      });
      if ((r.status === 429 || r.status >= 500) && attempt < 4) {
        await sleep(1e3 * 2 ** attempt);
        continue;
      }
      if (r.status >= 400) {
        let detail = "";
        try {
          detail = r.text.slice(0, 300);
        } catch (e) {
        }
        throw new Error(`Drive API ${r.status}: ${detail}`);
      }
      return r;
    }
  }
  async listChildren(folderId) {
    var _a;
    const out = [];
    let pageToken = "";
    do {
      const params = new URLSearchParams({
        q: `'${q(folderId)}' in parents and trashed = false`,
        fields: `nextPageToken, files(${FIELDS})`,
        pageSize: "1000",
        spaces: "drive"
      });
      if (pageToken) params.set("pageToken", pageToken);
      const r = await this.req(`${API}/files?${params.toString()}`);
      out.push(...r.json.files);
      pageToken = (_a = r.json.nextPageToken) != null ? _a : "";
    } while (pageToken);
    return out;
  }
  async createFolder(name, parentId) {
    const r = await this.req(`${API}/files?fields=id`, {
      method: "POST",
      contentType: "application/json",
      body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] })
    });
    return r.json.id;
  }
  /** Resolve a path like "Obsidian/My Vault" under My Drive, creating missing folders. */
  async ensureFolderPath(path) {
    let parent = "root";
    for (const name of path.split(/[\/\\]/).map((s) => s.trim()).filter(Boolean)) {
      const params = new URLSearchParams({
        q: `'${q(parent)}' in parents and name = '${q(name)}' and mimeType = '${FOLDER_MIME}' and trashed = false`,
        fields: "files(id)",
        spaces: "drive"
      });
      const r = await this.req(`${API}/files?${params.toString()}`);
      const found = r.json.files;
      parent = found.length ? found[0].id : await this.createFolder(name, parent);
    }
    return parent;
  }
  async listTree(rootId) {
    const files = /* @__PURE__ */ new Map();
    const folders = /* @__PURE__ */ new Map([["", rootId]]);
    const warnings = [];
    const queue = [["", rootId]];
    while (queue.length) {
      const [prefix, id] = queue.shift();
      for (const f of await this.listChildren(id)) {
        const path = prefix ? `${prefix}/${f.name}` : f.name;
        if (f.mimeType === FOLDER_MIME) {
          if (!folders.has(path)) {
            folders.set(path, f.id);
            queue.push([path, f.id]);
          }
        } else if (f.mimeType.startsWith("application/vnd.google-apps.")) {
          continue;
        } else if (files.has(path)) {
          warnings.push(`Duplicate name in Drive, ignoring extra copy: ${path}`);
        } else {
          files.set(path, f);
        }
      }
    }
    return { files, folders, warnings };
  }
  async download(id) {
    const r = await this.req(`${API}/files/${id}?alt=media`);
    return r.arrayBuffer;
  }
  async createFile(name, parentId, data) {
    const boundary = "gdvs-" + Math.random().toString(36).slice(2);
    const enc = new TextEncoder();
    const head = enc.encode(
      `--${boundary}\r
Content-Type: application/json; charset=UTF-8\r
\r
` + JSON.stringify({ name, parents: [parentId] }) + `\r
--${boundary}\r
Content-Type: application/octet-stream\r
\r
`
    );
    const tail = enc.encode(`\r
--${boundary}--`);
    const body = new Uint8Array(head.length + data.byteLength + tail.length);
    body.set(head, 0);
    body.set(new Uint8Array(data), head.length);
    body.set(tail, head.length + data.byteLength);
    const r = await this.req(`${UPLOAD}/files?uploadType=multipart&fields=${FIELDS}`, {
      method: "POST",
      contentType: `multipart/related; boundary=${boundary}`,
      body: body.buffer
    });
    return r.json;
  }
  async updateFile(id, data) {
    const r = await this.req(`${UPLOAD}/files/${id}?uploadType=media&fields=${FIELDS}`, {
      method: "PATCH",
      contentType: "application/octet-stream",
      body: data
    });
    return r.json;
  }
  /** Moves to Drive's trash (recoverable for 30 days), never hard-deletes. */
  async trash(id) {
    await this.req(`${API}/files/${id}`, {
      method: "PATCH",
      contentType: "application/json",
      body: JSON.stringify({ trashed: true })
    });
  }
};

// src/settings.ts
var import_obsidian3 = require("obsidian");
var DEFAULT_SETTINGS = {
  clientId: "",
  clientSecret: "",
  refreshToken: "",
  remoteFolder: "",
  autoSyncMinutes: 10,
  syncOnStartup: true,
  propagateDeletes: true,
  excludes: "# One rule per line. Hidden files/folders (.obsidian etc.) are always skipped.\n# Examples:  Templates/   *.tmp   desktop.ini\ndesktop.ini\nThumbs.db\n_debug_remotely_save/\n",
  maxFileSizeMB: 25
};
var GDriveSyncSettingTab = class extends import_obsidian3.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  display() {
    const { containerEl } = this;
    const s = this.plugin.settings;
    containerEl.empty();
    new import_obsidian3.Setting(containerEl).setName("Google account").setHeading();
    new import_obsidian3.Setting(containerEl).setName("OAuth client ID").setDesc("From Google Cloud Console \u2192 Credentials \u2192 OAuth client (Desktop app).").addText(
      (t) => t.setValue(s.clientId).onChange(async (v) => {
        s.clientId = v.trim();
        await this.plugin.saveAll();
      })
    );
    new import_obsidian3.Setting(containerEl).setName("OAuth client secret").addText((t) => {
      t.inputEl.type = "password";
      t.setValue(s.clientSecret).onChange(async (v) => {
        s.clientSecret = v.trim();
        await this.plugin.saveAll();
      });
    });
    const status = new import_obsidian3.Setting(containerEl).setName("Status").setDesc(s.refreshToken ? "\u2705 Signed in" : "Not signed in");
    if (import_obsidian3.Platform.isDesktopApp) {
      status.addButton(
        (b) => b.setButtonText(s.refreshToken ? "Sign in again" : "Sign in with Google").setCta().onClick(async () => {
          if (!s.clientId || !s.clientSecret) {
            new import_obsidian3.Notice("Enter the client ID and secret first.");
            return;
          }
          try {
            new import_obsidian3.Notice("Finish signing in in your browser\u2026");
            const tokens = await signInDesktop(s.clientId, s.clientSecret);
            s.refreshToken = tokens.refreshToken;
            this.plugin.setAccessToken(tokens.accessToken, tokens.expiresAt);
            await this.plugin.saveAll();
            new import_obsidian3.Notice("Signed in to Google Drive.");
            this.display();
          } catch (e) {
            new import_obsidian3.Notice(`Sign-in failed: ${e.message}`, 1e4);
          }
        })
      );
      if (s.refreshToken) {
        status.addButton(
          (b) => b.setButtonText("Copy refresh token").onClick(async () => {
            await navigator.clipboard.writeText(s.refreshToken);
            new import_obsidian3.Notice("Refresh token copied. Paste it into this plugin's settings on your phone. Keep it private.");
          })
        );
      }
    }
    if (s.refreshToken) {
      status.addButton(
        (b) => b.setButtonText("Sign out").setWarning().onClick(async () => {
          s.refreshToken = "";
          this.plugin.setAccessToken("", 0);
          await this.plugin.saveAll();
          this.display();
        })
      );
    }
    new import_obsidian3.Setting(containerEl).setName("Refresh token (manual)").setDesc("On mobile, paste the token copied from desktop here. On desktop, the button above fills this in.").addText((t) => {
      t.inputEl.type = "password";
      t.setValue(s.refreshToken).onChange(async (v) => {
        s.refreshToken = v.trim();
        this.plugin.setAccessToken("", 0);
        await this.plugin.saveAll();
      });
    });
    new import_obsidian3.Setting(containerEl).setName("Sync").setHeading();
    new import_obsidian3.Setting(containerEl).setName("Sync now").setDesc('Also available from the \u{1F504} ribbon icon and the command palette ("Google Drive Vault Sync: Sync now").').addButton(
      (b) => b.setButtonText("Sync now").setCta().onClick(async () => {
        b.setDisabled(true).setButtonText("Syncing\u2026");
        try {
          await this.plugin.sync(false);
        } finally {
          b.setDisabled(false).setButtonText("Sync now");
        }
      })
    );
    new import_obsidian3.Setting(containerEl).setName("Google Drive folder").setDesc('Path under "My Drive", e.g. Obsidian/Notes. Created if it does not exist.').addText(
      (t) => t.setValue(s.remoteFolder).onChange(async (v) => {
        const next = v.trim().replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/^\/+|\/+$/g, "");
        if (next !== s.remoteFolder) this.plugin.state = {};
        s.remoteFolder = next;
        await this.plugin.saveAll();
      })
    );
    new import_obsidian3.Setting(containerEl).setName("Auto-sync every (minutes)").setDesc("0 turns auto-sync off.").addText(
      (t) => t.setValue(String(s.autoSyncMinutes)).onChange(async (v) => {
        const n = Math.max(0, parseInt(v, 10) || 0);
        s.autoSyncMinutes = n;
        await this.plugin.saveAll();
        this.plugin.scheduleAutoSync();
      })
    );
    new import_obsidian3.Setting(containerEl).setName("Sync when Obsidian starts").addToggle(
      (t) => t.setValue(s.syncOnStartup).onChange(async (v) => {
        s.syncOnStartup = v;
        await this.plugin.saveAll();
      })
    );
    new import_obsidian3.Setting(containerEl).setName("Sync deletions").setDesc("Deleting a note on one side moves it to the trash on the other (Drive trash / Obsidian trash). Off = deleted files come back on next sync.").addToggle(
      (t) => t.setValue(s.propagateDeletes).onChange(async (v) => {
        s.propagateDeletes = v;
        await this.plugin.saveAll();
      })
    );
    new import_obsidian3.Setting(containerEl).setName("Max file size (MB)").setDesc("Larger files are skipped (listed in the sync notice). Keeps phones from running out of memory. 0 = no limit.").addText(
      (t) => t.setValue(String(s.maxFileSizeMB)).onChange(async (v) => {
        s.maxFileSizeMB = Math.max(0, parseInt(v, 10) || 0);
        await this.plugin.saveAll();
      })
    );
    new import_obsidian3.Setting(containerEl).setName("Exclude").setDesc("Folder/ prefixes, *.ext patterns, or exact file names.").addTextArea((t) => {
      t.inputEl.rows = 6;
      t.inputEl.style.width = "100%";
      t.setValue(s.excludes).onChange(async (v) => {
        s.excludes = v;
        await this.plugin.saveAll();
      });
    });
    new import_obsidian3.Setting(containerEl).setName("Reset sync state").setDesc("Forgets what was synced. Next sync compares every file by content; nothing is deleted.").addButton(
      (b) => b.setButtonText("Reset").onClick(async () => {
        this.plugin.state = {};
        await this.plugin.saveAll();
        new import_obsidian3.Notice("Sync state reset.");
      })
    );
  }
};

// src/sync.ts
var import_obsidian4 = require("obsidian");
var rev = (f) => {
  var _a;
  return (_a = f.md5Checksum) != null ? _a : f.modifiedTime;
};
function parseExcludes(raw) {
  return raw.split("\n").map((s) => s.trim()).filter((s) => s && !s.startsWith("#"));
}
function isExcluded(path, rules) {
  var _a;
  if (path.split("/").some((seg) => seg.startsWith("."))) return true;
  const name = (_a = path.split("/").pop()) != null ? _a : path;
  return rules.some((r) => {
    if (r.startsWith("*.")) return path.toLowerCase().endsWith(r.slice(1).toLowerCase());
    if (r.endsWith("/")) return path.startsWith(r);
    return path === r || name === r || path.startsWith(r + "/");
  });
}
function sameBytes(a, b) {
  if (a.byteLength !== b.byteLength) return false;
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}
function conflictPath(path) {
  const d = /* @__PURE__ */ new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}${pad(d.getMinutes())}`;
  const slash = path.lastIndexOf("/");
  const dir = slash >= 0 ? path.slice(0, slash + 1) : "";
  const file = path.slice(slash + 1);
  const dot = file.lastIndexOf(".");
  const base = dot > 0 ? file.slice(0, dot) : file;
  const ext = dot > 0 ? file.slice(dot) : "";
  return `${dir}${base} (conflict ${stamp})${ext}`;
}
async function runSync(app, drive, settings, state, hooks) {
  var _a;
  const vault = app.vault;
  const res = { uploaded: 0, downloaded: 0, deletedLocal: 0, deletedRemote: 0, conflicts: [], errors: [], warnings: [], skipped: [] };
  const maxBytes = Math.max(0, settings.maxFileSizeMB) * 1024 * 1024;
  const rules = parseExcludes(settings.excludes);
  const rootId = await drive.ensureFolderPath(settings.remoteFolder);
  const tree = await drive.listTree(rootId);
  res.warnings.push(...tree.warnings);
  const local = /* @__PURE__ */ new Map();
  for (const f of vault.getFiles()) if (!isExcluded(f.path, rules)) local.set(f.path, f);
  const remote = tree.files;
  const record = async (path, r) => {
    const st = await vault.adapter.stat(path);
    if (!st) return;
    state[path] = { remoteId: r.id, remoteRev: rev(r), localMtime: st.mtime, localSize: st.size };
  };
  const ensureRemoteParent = async (path) => {
    const parts = path.split("/").slice(0, -1);
    let cur = "";
    let parentId = tree.folders.get("");
    for (const p of parts) {
      cur = cur ? `${cur}/${p}` : p;
      let id = tree.folders.get(cur);
      if (!id) {
        id = await drive.createFolder(p, parentId);
        tree.folders.set(cur, id);
      }
      parentId = id;
    }
    return parentId;
  };
  const ensureLocalParent = async (path) => {
    const parts = path.split("/").slice(0, -1);
    let cur = "";
    for (const p of parts) {
      cur = cur ? `${cur}/${p}` : p;
      if (!vault.getAbstractFileByPath(cur)) await vault.createFolder(cur);
    }
  };
  const writeLocal = async (path, data) => {
    const existing = vault.getAbstractFileByPath(path);
    if (existing instanceof import_obsidian4.TFile) await vault.modifyBinary(existing, data);
    else {
      await ensureLocalParent(path);
      await vault.createBinary(path, data);
    }
  };
  const uploadNew = async (path, data) => {
    const parentId = await ensureRemoteParent(path);
    const name = path.split("/").pop();
    return drive.createFile(name, parentId, data);
  };
  const localChangedSince = (f, s) => f.stat.mtime !== s.localMtime || f.stat.size !== s.localSize;
  const resolveBothChanged = async (path, l, r) => {
    const [ld, rd] = await Promise.all([vault.readBinary(l), drive.download(r.id)]);
    if (sameBytes(ld, rd)) {
      await record(path, r);
      return;
    }
    const cPath = conflictPath(path);
    await writeLocal(cPath, rd);
    const cRemote = await uploadNew(cPath, rd);
    await record(cPath, cRemote);
    const updated = await drive.updateFile(r.id, ld);
    await record(path, updated);
    res.conflicts.push(path);
  };
  const paths = Array.from(/* @__PURE__ */ new Set([...local.keys(), ...remote.keys(), ...Object.keys(state)])).sort();
  const work = () => res.uploaded + res.downloaded + res.deletedLocal + res.deletedRemote + res.conflicts.length;
  let lastCheckpointWork = 0;
  let lastCheckpointAt = Date.now();
  let done = 0;
  for (const path of paths) {
    done++;
    if (done % 10 === 0) hooks.progress(done, paths.length, work());
    if (work() - lastCheckpointWork >= 10 || work() > lastCheckpointWork && Date.now() - lastCheckpointAt > 5e3) {
      await hooks.checkpoint();
      lastCheckpointWork = work();
      lastCheckpointAt = Date.now();
    }
    if (isExcluded(path, rules)) continue;
    try {
      const l = local.get(path);
      const r = remote.get(path);
      if (maxBytes > 0 && (l && l.stat.size > maxBytes || r && Number((_a = r.size) != null ? _a : 0) > maxBytes)) {
        res.skipped.push(path);
        continue;
      }
      const s = state[path];
      if (l && r) {
        if (!s) {
          await resolveBothChanged(path, l, r);
          continue;
        }
        const lChanged = localChangedSince(l, s);
        const rChanged = rev(r) !== s.remoteRev || r.id !== s.remoteId;
        if (lChanged && rChanged) await resolveBothChanged(path, l, r);
        else if (lChanged) {
          const updated = await drive.updateFile(r.id, await vault.readBinary(l));
          await record(path, updated);
          res.uploaded++;
        } else if (rChanged) {
          await writeLocal(path, await drive.download(r.id));
          await record(path, r);
          res.downloaded++;
        }
      } else if (l && !r) {
        if (s && settings.propagateDeletes && !localChangedSince(l, s)) {
          await app.fileManager.trashFile(l);
          delete state[path];
          res.deletedLocal++;
        } else {
          const created = await uploadNew(path, await vault.readBinary(l));
          await record(path, created);
          res.uploaded++;
        }
      } else if (!l && r) {
        if (s && settings.propagateDeletes && rev(r) === s.remoteRev) {
          await drive.trash(r.id);
          delete state[path];
          res.deletedRemote++;
        } else {
          await writeLocal(path, await drive.download(r.id));
          await record(path, r);
          res.downloaded++;
        }
      } else {
        delete state[path];
      }
    } catch (e) {
      res.errors.push(`${path}: ${e.message}`);
    }
  }
  hooks.progress(paths.length, paths.length, work());
  return res;
}

// src/main.ts
var GDriveSyncPlugin = class extends import_obsidian5.Plugin {
  constructor() {
    super(...arguments);
    this.settings = { ...DEFAULT_SETTINGS };
    this.state = {};
    this.accessToken = "";
    this.expiresAt = 0;
    this.syncing = false;
    this.syncInProgress = false;
    this.interruptedLastTime = false;
    this.autoSyncId = null;
    this.drive = new DriveClient(() => this.getAccessToken());
  }
  async onload() {
    var _a, _b, _c;
    const data = (_a = await this.loadData()) != null ? _a : {};
    this.settings = { ...DEFAULT_SETTINGS, ...(_b = data.settings) != null ? _b : {} };
    this.state = (_c = data.state) != null ? _c : {};
    this.interruptedLastTime = !!data.syncInProgress;
    if (!this.settings.excludes.includes("_debug_remotely_save")) {
      this.settings.excludes = this.settings.excludes.replace(/\n*$/, "\n") + "_debug_remotely_save/\n";
    }
    const fixed = this.settings.remoteFolder.replace(/\\/g, "/");
    if (fixed !== this.settings.remoteFolder) {
      this.settings.remoteFolder = fixed;
      this.state = {};
      await this.saveAll();
    }
    if (!this.settings.remoteFolder) this.settings.remoteFolder = `Obsidian/${this.app.vault.getName()}`;
    this.addSettingTab(new GDriveSyncSettingTab(this.app, this));
    this.statusEl = this.addStatusBarItem();
    this.setStatus("Drive: idle");
    this.addRibbonIcon("refresh-cw", "Sync with Google Drive", () => this.sync(false));
    this.addCommand({ id: "sync-now", name: "Sync now", callback: () => this.sync(false) });
    this.app.workspace.onLayoutReady(() => {
      if (this.interruptedLastTime) {
        new import_obsidian5.Notice("Google Drive sync: the last sync didn't finish (Obsidian closed or crashed). Auto-sync on startup was skipped. Progress was saved, so tap Sync now to resume.", 15e3);
        return;
      }
      if (this.settings.syncOnStartup && this.settings.refreshToken) {
        window.setTimeout(() => this.sync(true), 5e3);
      }
    });
    this.scheduleAutoSync();
  }
  async saveAll() {
    await this.saveData({ settings: this.settings, state: this.state, syncInProgress: this.syncInProgress });
  }
  setAccessToken(token, expiresAt) {
    this.accessToken = token;
    this.expiresAt = expiresAt;
  }
  async getAccessToken() {
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
      this.autoSyncId = window.setInterval(() => this.sync(true), mins * 60 * 1e3);
      this.registerInterval(this.autoSyncId);
    }
  }
  setStatus(text) {
    this.statusEl.setText(text);
  }
  async sync(quiet) {
    if (this.syncing) {
      if (!quiet) new import_obsidian5.Notice("Sync already running.");
      return;
    }
    const s = this.settings;
    if (!s.clientId || !s.clientSecret || !s.refreshToken) {
      if (!quiet) new import_obsidian5.Notice("Google Drive Sync: set up and sign in from the plugin settings first.");
      return;
    }
    this.syncing = true;
    this.syncInProgress = true;
    this.interruptedLastTime = false;
    await this.saveAll();
    this.setStatus("Drive: syncing\u2026");
    let progressNotice = null;
    try {
      const r = await runSync(this.app, this.drive, s, this.state, {
        checkpoint: () => this.saveAll(),
        progress: (done, total, transferred) => {
          const msg = `Drive: syncing ${done}/${total}${transferred ? ` (${transferred} changed)` : ""}`;
          this.setStatus(msg);
          if (import_obsidian5.Platform.isMobile && (transferred > 0 || !quiet) && done < total) {
            if (!progressNotice) progressNotice = new import_obsidian5.Notice(msg, 0);
            else progressNotice.setMessage(msg);
          }
        }
      });
      this.syncInProgress = false;
      await this.saveAll();
      const parts = [];
      if (r.uploaded) parts.push(`\u2191${r.uploaded}`);
      if (r.downloaded) parts.push(`\u2193${r.downloaded}`);
      if (r.deletedLocal + r.deletedRemote) parts.push(`\u{1F5D1}${r.deletedLocal + r.deletedRemote}`);
      if (r.conflicts.length) parts.push(`\u26A0 ${r.conflicts.length} conflict(s)`);
      const summary = parts.length ? parts.join(" ") : "up to date";
      this.setStatus(`Drive: ${(/* @__PURE__ */ new Date()).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} ${r.errors.length ? "\u26A0" : "\u2713"}`);
      if (!quiet || parts.length || r.errors.length) new import_obsidian5.Notice(`Google Drive sync: ${summary}`);
      if (r.conflicts.length) {
        new import_obsidian5.Notice(`Both sides changed; Drive's version saved as a "(conflict \u2026)" copy:
${r.conflicts.slice(0, 5).join("\n")}`, 15e3);
      }
      if (r.errors.length) {
        console.error("[gdrive-vault-sync] errors", r.errors);
        new import_obsidian5.Notice(`${r.errors.length} file(s) failed to sync. First: ${r.errors[0]}`, 15e3);
      }
      if (r.skipped.length) {
        new import_obsidian5.Notice(`Skipped ${r.skipped.length} file(s) over ${s.maxFileSizeMB} MB:
${r.skipped.slice(0, 5).join("\n")}`, 15e3);
      }
      if (r.warnings.length) console.warn("[gdrive-vault-sync] warnings", r.warnings);
    } catch (e) {
      this.setStatus("Drive: error");
      console.error("[gdrive-vault-sync]", e);
      new import_obsidian5.Notice(`Google Drive sync failed: ${e.message}`, 15e3);
    } finally {
      progressNotice == null ? void 0 : progressNotice.hide();
      if (this.syncInProgress) {
        this.syncInProgress = false;
        await this.saveAll();
      }
      this.syncing = false;
    }
  }
};
