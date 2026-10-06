import { App, TFile } from "obsidian";
import { DriveClient, RemoteFile, RemoteTree } from "./drive";
import { GSyncSettings } from "./settings";

/** What both sides looked like the last time this path was in sync. */
export interface SyncRecord {
  remoteId: string;
  remoteRev: string;
  localMtime: number;
  localSize: number;
}
export type SyncState = Record<string, SyncRecord>;

export interface SyncResult {
  uploaded: number;
  downloaded: number;
  deletedLocal: number;
  deletedRemote: number;
  conflicts: string[];
  errors: string[];
  warnings: string[];
  skipped: string[];
}

export interface SyncHooks {
  /** Persist state mid-sync so a crash doesn't lose finished work. */
  checkpoint: () => Promise<void>;
  progress: (done: number, total: number, transferred: number) => void;
}

const rev = (f: RemoteFile) => f.md5Checksum ?? f.modifiedTime;

function parseExcludes(raw: string): string[] {
  return raw
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith("#"));
}

function isExcluded(path: string, rules: string[]): boolean {
  // Never touch hidden files/folders (.obsidian, .trash, .git ...) on either side.
  if (path.split("/").some((seg) => seg.startsWith("."))) return true;
  const name = path.split("/").pop() ?? path;
  return rules.some((r) => {
    if (r.startsWith("*.")) return path.toLowerCase().endsWith(r.slice(1).toLowerCase());
    if (r.endsWith("/")) return path.startsWith(r);
    return path === r || name === r || path.startsWith(r + "/");
  });
}

function sameBytes(a: ArrayBuffer, b: ArrayBuffer): boolean {
  if (a.byteLength !== b.byteLength) return false;
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}

function conflictPath(path: string): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}${pad(d.getMinutes())}`;
  const slash = path.lastIndexOf("/");
  const dir = slash >= 0 ? path.slice(0, slash + 1) : "";
  const file = path.slice(slash + 1);
  const dot = file.lastIndexOf(".");
  const base = dot > 0 ? file.slice(0, dot) : file;
  const ext = dot > 0 ? file.slice(dot) : "";
  return `${dir}${base} (conflict ${stamp})${ext}`;
}

export async function runSync(
  app: App,
  drive: DriveClient,
  settings: GSyncSettings,
  state: SyncState,
  hooks: SyncHooks
): Promise<SyncResult> {
  const vault = app.vault;
  const res: SyncResult = { uploaded: 0, downloaded: 0, deletedLocal: 0, deletedRemote: 0, conflicts: [], errors: [], warnings: [], skipped: [] };
  const maxBytes = Math.max(0, settings.maxFileSizeMB) * 1024 * 1024;
  const rules = parseExcludes(settings.excludes);

  const rootId = await drive.ensureFolderPath(settings.remoteFolder);
  const tree: RemoteTree = await drive.listTree(rootId);
  res.warnings.push(...tree.warnings);

  const local = new Map<string, TFile>();
  for (const f of vault.getFiles()) if (!isExcluded(f.path, rules)) local.set(f.path, f);
  const remote = tree.files;

  // ---- helpers ------------------------------------------------------------
  const record = async (path: string, r: RemoteFile) => {
    const st = await vault.adapter.stat(path);
    if (!st) return;
    state[path] = { remoteId: r.id, remoteRev: rev(r), localMtime: st.mtime, localSize: st.size };
  };

  const ensureRemoteParent = async (path: string): Promise<string> => {
    const parts = path.split("/").slice(0, -1);
    let cur = "";
    let parentId = tree.folders.get("") as string;
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

  const ensureLocalParent = async (path: string) => {
    const parts = path.split("/").slice(0, -1);
    let cur = "";
    for (const p of parts) {
      cur = cur ? `${cur}/${p}` : p;
      if (!vault.getAbstractFileByPath(cur)) await vault.createFolder(cur);
    }
  };

  const writeLocal = async (path: string, data: ArrayBuffer) => {
    const existing = vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) await vault.modifyBinary(existing, data);
    else {
      await ensureLocalParent(path);
      await vault.createBinary(path, data);
    }
  };

  const uploadNew = async (path: string, data: ArrayBuffer): Promise<RemoteFile> => {
    const parentId = await ensureRemoteParent(path);
    const name = path.split("/").pop() as string;
    return drive.createFile(name, parentId, data);
  };

  const localChangedSince = (f: TFile, s: SyncRecord) => f.stat.mtime !== s.localMtime || f.stat.size !== s.localSize;

  const resolveBothChanged = async (path: string, l: TFile, r: RemoteFile) => {
    const [ld, rd] = await Promise.all([vault.readBinary(l), drive.download(r.id)]);
    if (sameBytes(ld, rd)) {
      await record(path, r);
      return;
    }
    // Keep both: local wins the original name, Drive's version is saved beside it.
    const cPath = conflictPath(path);
    await writeLocal(cPath, rd);
    const cRemote = await uploadNew(cPath, rd);
    await record(cPath, cRemote);
    const updated = await drive.updateFile(r.id, ld);
    await record(path, updated);
    res.conflicts.push(path);
  };

  // ---- main pass ----------------------------------------------------------
  const paths = Array.from(new Set([...local.keys(), ...remote.keys(), ...Object.keys(state)])).sort();

  const work = () => res.uploaded + res.downloaded + res.deletedLocal + res.deletedRemote + res.conflicts.length;
  let lastCheckpointWork = 0;
  let lastCheckpointAt = Date.now();
  let done = 0;

  for (const path of paths) {
    done++;
    if (done % 10 === 0) hooks.progress(done, paths.length, work());
    // Save progress every 10 transfers or 5 seconds.
    if (work() - lastCheckpointWork >= 10 || (work() > lastCheckpointWork && Date.now() - lastCheckpointAt > 5000)) {
      await hooks.checkpoint();
      lastCheckpointWork = work();
      lastCheckpointAt = Date.now();
    }
    if (isExcluded(path, rules)) continue;
    try {
      const l = local.get(path);
      const r = remote.get(path);
      if (maxBytes > 0 && ((l && l.stat.size > maxBytes) || (r && Number(r.size ?? 0) > maxBytes))) {
        res.skipped.push(path);
        continue;
      }
      const s = state[path];

      if (l && r) {
        if (!s) {
          await resolveBothChanged(path, l, r); // first time we've seen both: compare contents
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
          await app.fileManager.trashFile(l); // deleted in Drive -> delete here
          delete state[path];
          res.deletedLocal++;
        } else {
          const created = await uploadNew(path, await vault.readBinary(l));
          await record(path, created);
          res.uploaded++;
        }
      } else if (!l && r) {
        if (s && settings.propagateDeletes && rev(r) === s.remoteRev) {
          await drive.trash(r.id); // deleted here -> move to Drive trash
          delete state[path];
          res.deletedRemote++;
        } else {
          await writeLocal(path, await drive.download(r.id));
          await record(path, r);
          res.downloaded++;
        }
      } else {
        delete state[path]; // gone on both sides
      }
    } catch (e) {
      res.errors.push(`${path}: ${(e as Error).message}`);
    }
  }
  hooks.progress(paths.length, paths.length, work());
  return res;
}
