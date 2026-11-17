import type { App, DataAdapter } from "obsidian";
import type { DriveClient, RemoteFile } from "./drive";
import type { SyncRecord, SyncState } from "./sync";

/**
 * Settings sync: mirrors the vault's config folder (usually .obsidian) to a folder of the
 * same name inside the main Drive folder. That's exactly where Google Drive for Desktop
 * already keeps a desktop vault's config, so phones and tablets pick up the same setup.
 */
export interface ConfigSyncSettings {
  enabled: boolean;
  /** app.json, hotkeys.json, core-plugins.json and other top-level settings files. */
  core: boolean;
  /** appearance.json, themes/, snippets/. */
  appearance: boolean;
  /** community-plugins.json: which community plugins are turned on. */
  pluginList: boolean;
  /** plugins/<id>/: the plugins themselves and their settings. */
  plugins: boolean;
  /** Plugin folder names (one per line) that stay separate on each device. */
  excludedPlugins: string;
}

export const DEFAULT_CONFIG_SYNC: ConfigSyncSettings = {
  enabled: false,
  core: true,
  appearance: true,
  pluginList: true,
  plugins: true,
  excludedPlugins: "",
};

/** Plugins that must never be synced: GSync's own sign-in data and per-device state live there. */
export const ALWAYS_LOCAL_PLUGINS = ["gsync", "gdrive-vault-sync"];

/** Per-device files: window layout and recent files. */
const NEVER_SYNC_FILES = new Set(["workspace.json", "workspace-mobile.json"]);

export type ConfigCategory = "core" | "appearance" | "pluginList" | "plugins";

export function parsePluginList(raw: string): string[] {
  return raw
    .split("\n")
    .map((s) => s.trim().replace(/^plugins\//, "").replace(/\/+$/, ""))
    .filter((s) => s && !s.startsWith("#"));
}

export function localPlugins(cfg: ConfigSyncSettings): Set<string> {
  return new Set([...ALWAYS_LOCAL_PLUGINS, ...parsePluginList(cfg.excludedPlugins)]);
}

/**
 * Which category a path inside the config folder belongs to, or null if it is never synced.
 * `rel` is relative to the config folder, e.g. "plugins/dataview/main.js".
 */
export function configCategory(rel: string, cfg: ConfigSyncSettings): ConfigCategory | null {
  const parts = rel.split("/");
  if (parts.some((p) => !p || p.startsWith(".") || p === "node_modules")) return null;
  const name = parts[parts.length - 1];
  if (name === "desktop.ini" || name === "Thumbs.db") return null;
  let cat: ConfigCategory | null = null;
  if (parts.length === 1) {
    if (NEVER_SYNC_FILES.has(name)) return null;
    if (name === "appearance.json") cat = "appearance";
    else if (name === "community-plugins.json") cat = "pluginList";
    else if (name.endsWith(".json")) cat = "core";
  } else if (parts[0] === "themes" || parts[0] === "snippets") {
    cat = "appearance";
  } else if (parts[0] === "plugins" && parts.length >= 3) {
    if (localPlugins(cfg).has(parts[1])) return null;
    cat = "plugins";
  }
  return cat && cfg[cat] ? cat : null;
}

function parseIds(text: string): string[] | null {
  try {
    const v: unknown = JSON.parse(text);
    return Array.isArray(v) && v.every((x) => typeof x === "string") ? v : null;
  } catch {
    return null;
  }
}

/**
 * Merge the enabled-plugin lists. Shared plugins follow `primary`; plugins kept local
 * (GSync itself and the exclude list) keep `keepLocalFrom`'s on/off state.
 */
export function mergePluginLists(primary: string[], keepLocalFrom: string[], local: Set<string>): string[] {
  const out = primary.filter((id) => !local.has(id));
  for (const id of keepLocalFrom) if (local.has(id) && !out.includes(id)) out.push(id);
  return out;
}

function sameSet(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x) => b.includes(x));
}

export interface ConfigSyncResult {
  uploaded: number;
  downloaded: number;
  deleted: number;
  errors: string[];
  /** True when something arrived from Drive that needs an Obsidian restart. */
  needsRestart: boolean;
}

const rev = (f: RemoteFile) => f.md5Checksum ?? f.modifiedTime;
const enc = new TextEncoder();
const dec = new TextDecoder();

async function listLocal(adapter: DataAdapter, root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string) => {
    const { files, folders } = await adapter.list(dir);
    for (const f of files) out.push(f.slice(root.length + 1));
    for (const d of folders) {
      const name = d.slice(d.lastIndexOf("/") + 1);
      if (!name.startsWith(".") && name !== "node_modules") await walk(d);
    }
  };
  if (await adapter.exists(root)) await walk(root);
  return out;
}

async function ensureLocalDir(adapter: DataAdapter, path: string) {
  const parts = path.split("/").slice(0, -1);
  for (let i = 1; i <= parts.length; i++) {
    const dir = parts.slice(0, i).join("/");
    if (!(await adapter.exists(dir))) await adapter.mkdir(dir);
  }
}

/**
 * Two-way sync of the config folder. Settings files are small, so whole-file transfers are
 * fine; anything over `maxBytes` is skipped.
 * - First run on a device: where both sides have a file and they differ, Drive's copy wins,
 *   so a new phone adopts the existing setup instead of overwriting it.
 * - Later: if both sides changed, this device wins (no conflict copies inside the config folder).
 */
export async function runConfigSync(
  app: App,
  drive: DriveClient,
  cfg: ConfigSyncSettings,
  mainRootId: string,
  state: SyncState,
  opts: { propagateDeletes: boolean; maxBytes: number }
): Promise<ConfigSyncResult> {
  const adapter = app.vault.adapter;
  const configDir = app.vault.configDir;
  const res: ConfigSyncResult = { uploaded: 0, downloaded: 0, deleted: 0, errors: [], needsRestart: false };
  const rootId = await drive.ensureChildFolder(mainRootId, configDir);
  const tree = await drive.listTree(rootId);
  const local = new Set((await listLocal(adapter, configDir)).filter((rel) => configCategory(rel, cfg)));
  const remote = new Map([...tree.files].filter(([rel]) => configCategory(rel, cfg)));
  const keepLocal = localPlugins(cfg);

  const full = (rel: string) => `${configDir}/${rel}`;
  const record = async (rel: string, r: RemoteFile) => {
    const st = await adapter.stat(full(rel));
    if (st) state[rel] = { remoteId: r.id, remoteRev: rev(r), localMtime: st.mtime, localSize: st.size };
  };
  const remoteParent = async (rel: string): Promise<string> => {
    let parentId = rootId;
    let cur = "";
    for (const p of rel.split("/").slice(0, -1)) {
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
  const write = async (rel: string, data: ArrayBuffer) => {
    await ensureLocalDir(adapter, full(rel));
    await adapter.writeBinary(full(rel), data);
    res.needsRestart = true;
  };
  const upload = async (rel: string, data: ArrayBuffer, remoteId?: string): Promise<RemoteFile> =>
    remoteId ? drive.updateFile(remoteId, data) : drive.createFile(rel.split("/").pop() as string, await remoteParent(rel), data);
  const changedLocally = async (rel: string, s: SyncRecord) => {
    const st = await adapter.stat(full(rel));
    return !st || st.mtime !== s.localMtime || st.size !== s.localSize;
  };

  /** community-plugins.json: shared entries sync, locally-kept plugins keep this device's state. */
  const syncPluginList = async (rel: string, r: RemoteFile | undefined, s: SyncRecord | undefined) => {
    const hasLocal = local.has(rel);
    const L = hasLocal ? parseIds(await adapter.read(full(rel))) : null;
    const R = r ? parseIds(dec.decode(await drive.download(r.id))) : null;
    if (hasLocal && L === null) throw new Error("Local community-plugins.json is not valid JSON");
    const lChanged = hasLocal && (!s || (await changedLocally(rel, s)));
    const rChanged = !!r && (!s || rev(r) !== s.remoteRev || r.id !== s.remoteId);
    if (!lChanged && !rChanged) return;
    // Drive's list wins on the first run and whenever this device didn't change its own list.
    const fromDrive = R !== null && (!s || !lChanged || L === null);
    const merged = fromDrive ? mergePluginLists(R, L ?? [], keepLocal) : mergePluginLists(L ?? [], L ?? [], keepLocal);
    // This code runs inside GSync, so GSync is on: never let a synced list turn it off.
    if (!merged.includes("gsync")) merged.push("gsync");
    if (L === null || !sameSet(L, merged)) await write(rel, enc.encode(JSON.stringify(merged, null, 2)).buffer);
    // What Drive should hold: this device's shared entries, plus Drive's state for locally-kept plugins.
    const forDrive = mergePluginLists(merged, R ?? [], keepLocal);
    let updated = r;
    if (!R || !sameSet(R, forDrive)) {
      updated = await upload(rel, enc.encode(JSON.stringify(forDrive, null, 2)).buffer, r?.id);
      res.uploaded++;
    } else if (fromDrive) res.downloaded++;
    if (updated) await record(rel, updated);
  };

  const paths = Array.from(new Set([...local, ...remote.keys(), ...Object.keys(state)])).sort();
  for (const rel of paths) {
    try {
      if (!configCategory(rel, cfg)) continue;
      const hasLocal = local.has(rel);
      const r = remote.get(rel);
      const s = state[rel];
      const st = hasLocal ? await adapter.stat(full(rel)) : null;
      if (opts.maxBytes > 0 && ((st && st.size > opts.maxBytes) || (r && Number(r.size ?? 0) > opts.maxBytes))) continue;
      if (rel === "community-plugins.json") {
        await syncPluginList(rel, r, s);
        continue;
      }
      if (hasLocal && r) {
        const lChanged = !s || (await changedLocally(rel, s));
        const rChanged = !s || rev(r) !== s.remoteRev || r.id !== s.remoteId;
        if (!s) {
          const data = await adapter.readBinary(full(rel));
          const remoteData = await drive.download(r.id);
          const a = new Uint8Array(data), b = new Uint8Array(remoteData);
          if (a.length !== b.length || a.some((x, i) => x !== b[i])) {
            await write(rel, remoteData); // first run: adopt the setup already in Drive
            res.downloaded++;
          }
          await record(rel, r);
        } else if (lChanged) {
          await record(rel, await upload(rel, await adapter.readBinary(full(rel)), r.id));
          res.uploaded++;
        } else if (rChanged) {
          await write(rel, await drive.download(r.id));
          await record(rel, r);
          res.downloaded++;
        }
      } else if (hasLocal) {
        if (s && opts.propagateDeletes && !(await changedLocally(rel, s))) {
          await adapter.remove(full(rel)); // removed on another device
          delete state[rel];
          res.deleted++;
          res.needsRestart = true;
        } else {
          await record(rel, await upload(rel, await adapter.readBinary(full(rel))));
          res.uploaded++;
        }
      } else if (r) {
        if (s && opts.propagateDeletes && rev(r) === s.remoteRev) {
          await drive.trash(r.id); // removed on this device
          delete state[rel];
          res.deleted++;
        } else {
          await write(rel, await drive.download(r.id));
          await record(rel, r);
          res.downloaded++;
        }
      } else {
        delete state[rel];
      }
    } catch (e) {
      res.errors.push(`${configDir}/${rel}: ${(e as Error).message}`);
    }
  }
  return res;
}
