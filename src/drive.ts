import { requestUrl, RequestUrlResponse } from "obsidian";

import { downloadChunks, uploadChunks, BinarySource, ByteProgress } from "./drive-transfer";
import { DRIVE_FILE_FIELDS as FIELDS } from "./remote-metadata";

const API = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3";
export const FOLDER_MIME = "application/vnd.google-apps.folder";

export interface RemoteFile {
  id: string;
  name: string;
  mimeType: string;
  md5Checksum?: string;
  sha256Checksum?: string;
  modifiedTime: string;
  size?: string;
  version?: string;
}

export interface RemoteTree {
  files: Map<string, RemoteFile>; // vault-relative path -> file
  folders: Map<string, string>; // vault-relative folder path -> folder id ("" = root)
  warnings: string[];
}

interface FileList {
  files: RemoteFile[];
  nextPageToken?: string;
}

function q(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

const sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms));

/** Folder name that marks a path as living in a Shared Drive: "Shared drives/<drive>/<path>". */
export const SHARED_DRIVES = "shared drives";

export function isSharedDrivePath(path: string): boolean {
  const first = path.split(/[/\\]/).map((s) => s.trim()).filter(Boolean)[0];
  return first?.toLowerCase() === SHARED_DRIVES;
}

/**
 * Every Drive "files" and "permissions" call must say it supports Shared Drives, or items in
 * Shared Drives are invisible (404). Resumable upload session URLs are left untouched.
 */
export function withAllDrives(url: string): string {
  if (!/googleapis\.com\/(upload\/)?drive\/v3\/files/.test(url) || url.includes("upload_id=") || url.includes("supportsAllDrives=")) return url;
  return url + (url.includes("?") ? "&" : "?") + "supportsAllDrives=true";
}

export interface FolderAccess {
  canEdit: boolean;
  inSharedDrive: boolean;
  canShare: boolean;
}

export class DriveClient {
  /** Folder id -> Shared Drive id, for listing Shared Drive folders. */
  private driveOf = new Map<string, string>();
  /** Resolved folder paths, valid for one sync. */
  private pathCache = new Map<string, string>();

  constructor(private getToken: () => Promise<string>) {}

  /** Forget resolved folder paths (call at the start of each sync). */
  resetCache(): void {
    this.pathCache.clear();
  }

  private async req(
    url: string,
    opts: { method?: string; body?: string | ArrayBuffer; contentType?: string; headers?: Record<string, string>; retry?: boolean } = {}
  ): Promise<RequestUrlResponse> {
    url = withAllDrives(url);
    for (let attempt = 0; ; attempt++) {
      const token = await this.getToken();
      const r = await requestUrl({
        url,
        method: opts.method ?? "GET",
        body: opts.body,
        contentType: opts.contentType,
        headers: { ...opts.headers, Authorization: `Bearer ${token}` },
        throw: false,
      });
      if ((r.status === 429 || r.status >= 500) && opts.retry !== false && attempt < 4) {
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      if (r.status >= 400) {
        let detail = "";
        try {
          detail = r.text.slice(0, 300);
        } catch {
          /* binary body */
        }
        throw new Error(`Drive API ${r.status}: ${detail}`);
      }
      return r;
    }
  }

  private listParams(query: string, fields: string, parentId: string): URLSearchParams {
    const params = new URLSearchParams({ q: query, fields, pageSize: "1000", includeItemsFromAllDrives: "true" });
    const driveId = this.driveOf.get(parentId);
    if (driveId) {
      params.set("corpora", "drive");
      params.set("driveId", driveId);
    } else {
      params.set("spaces", "drive");
    }
    return params;
  }

  async listChildren(folderId: string): Promise<RemoteFile[]> {
    const out: RemoteFile[] = [];
    let pageToken = "";
    do {
      const params = this.listParams(`'${q(folderId)}' in parents and trashed = false`, `nextPageToken, files(${FIELDS})`, folderId);
      if (pageToken) params.set("pageToken", pageToken);
      const r = await this.req(`${API}/files?${params.toString()}`);
      const body = r.json as FileList;
      out.push(...body.files);
      pageToken = body.nextPageToken ?? "";
    } while (pageToken);
    return out;
  }

  async createFolder(name: string, parentId: string): Promise<string> {
    const r = await this.req(`${API}/files?fields=id`, {
      method: "POST",
      contentType: "application/json",
      body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] }),
    });
    const id = (r.json as RemoteFile).id;
    const driveId = this.driveOf.get(parentId);
    if (driveId) this.driveOf.set(id, driveId);
    return id;
  }

  /** Find (or create) a direct child folder by name. */
  async ensureChildFolder(parentId: string, name: string): Promise<string> {
    const params = this.listParams(
      `'${q(parentId)}' in parents and name = '${q(name)}' and mimeType = '${FOLDER_MIME}' and trashed = false`,
      "files(id)",
      parentId
    );
    const r = await this.req(`${API}/files?${params.toString()}`);
    const found = (r.json as FileList).files;
    if (found.length) {
      const driveId = this.driveOf.get(parentId);
      if (driveId) this.driveOf.set(found[0].id, driveId);
      return found[0].id;
    }
    return this.createFolder(name, parentId);
  }

  /**
   * Set by the GSync Teams add-on: turns a Shared Drive's name into its id.
   * Without it, folders under "Shared drives/" can't be synced.
   */
  sharedDriveResolver: ((name: string) => Promise<string>) | null = null;

  /** Note that a folder belongs to a Shared Drive, so listings ask that drive. */
  registerSharedDrive(folderId: string, driveId: string): void {
    this.driveOf.set(folderId, driveId);
  }

  /** Authorized Google Drive API request, with GSync's retries. For add-ons. */
  request(
    url: string,
    opts: { method?: string; body?: string | ArrayBuffer; contentType?: string; headers?: Record<string, string>; retry?: boolean } = {}
  ): Promise<RequestUrlResponse> {
    return this.req(url, opts);
  }

  /**
   * Resolve a folder path, creating missing folders. "Obsidian/My Vault" is under My Drive;
   * "Shared drives/Company/Notes" is inside the Shared Drive named "Company".
   */
  async ensureFolderPath(path: string): Promise<string> {
    const segments = path.split(/[/\\]/).map((s) => s.trim()).filter(Boolean);
    const key = segments.join("/");
    const cached = this.pathCache.get(key);
    if (cached) return cached;
    let parent = "root";
    let rest = segments;
    if (segments[0]?.toLowerCase() === SHARED_DRIVES) {
      if (!segments[1]) throw new Error('Add the Shared Drive\'s name after "Shared drives/".');
      if (!this.sharedDriveResolver) throw new Error("Folders in Shared Drives need the GSync Teams add-on.");
      parent = await this.sharedDriveResolver(segments[1]);
      this.driveOf.set(parent, parent);
      rest = segments.slice(2);
    }
    for (const name of rest) parent = await this.ensureChildFolder(parent, name);
    this.pathCache.set(key, parent);
    return parent;
  }

  /** What the signed-in user may do in a folder. */
  async folderAccess(folderId: string): Promise<FolderAccess> {
    const r = await this.req(`${API}/files/${encodeURIComponent(folderId)}?fields=driveId,capabilities(canAddChildren,canEdit,canShare)`);
    const f = r.json as { driveId?: string; capabilities?: { canAddChildren?: boolean; canEdit?: boolean; canShare?: boolean } };
    const c = f.capabilities ?? {};
    return { canEdit: c.canAddChildren !== false && c.canEdit !== false, inSharedDrive: !!f.driveId, canShare: !!c.canShare };
  }

  async listTree(rootId: string): Promise<RemoteTree> {
    const files = new Map<string, RemoteFile>();
    const folders = new Map<string, string>([["", rootId]]);
    const warnings: string[] = [];
    const queue: [string, string][] = [["", rootId]];
    while (queue.length) {
      const [prefix, id] = queue.shift() as [string, string];
      for (const f of await this.listChildren(id)) {
        // Hidden files and folders (.obsidian, .git, .trash ...) are never part of note sync,
        // so don't spend requests walking them. Settings sync lists the config folder itself.
        if (f.name.startsWith(".")) continue;
        const path = prefix ? `${prefix}/${f.name}` : f.name;
        if (f.mimeType === FOLDER_MIME) {
          const driveId = this.driveOf.get(id);
          if (driveId) this.driveOf.set(f.id, driveId);
          if (!folders.has(path)) {
            folders.set(path, f.id);
            queue.push([path, f.id]);
          }
        } else if (f.mimeType.startsWith("application/vnd.google-apps.")) {
          continue; // Google Docs/Sheets etc. can't be downloaded as files
        } else if (files.has(path)) {
          warnings.push(`Duplicate name in Drive, ignoring extra copy: ${path}`);
        } else {
          files.set(path, f);
        }
      }
    }
    return { files, folders, warnings };
  }

  downloadChunks(file: RemoteFile, onProgress?: ByteProgress, chunkSize?: number): AsyncGenerator<ArrayBuffer> {
    return downloadChunks((url, options) => this.req(url, options), file, onProgress, chunkSize);
  }

  uploadChunks(size: number, chunks: BinarySource, target: { name: string; parentId: string } | { id: string }, onProgress?: ByteProgress, chunkSize?: number): Promise<RemoteFile> {
    return uploadChunks((url, options) => this.req(url, options), size, chunks, target, onProgress, chunkSize);
  }

  async getFile(id: string): Promise<RemoteFile> {
    return (await this.req(`${API}/files/${encodeURIComponent(id)}?fields=${FIELDS}`)).json as RemoteFile;
  }

  async download(id: string): Promise<ArrayBuffer> {
    const r = await this.req(`${API}/files/${id}?alt=media`);
    return r.arrayBuffer;
  }

  async createFile(name: string, parentId: string, data: ArrayBuffer): Promise<RemoteFile> {
    const boundary = "gsync-" + Math.random().toString(36).slice(2);
    const enc = new TextEncoder();
    const head = enc.encode(
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
        JSON.stringify({ name, parents: [parentId] }) +
        `\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`
    );
    const tail = enc.encode(`\r\n--${boundary}--`);
    const body = new Uint8Array(head.length + data.byteLength + tail.length);
    body.set(head, 0);
    body.set(new Uint8Array(data), head.length);
    body.set(tail, head.length + data.byteLength);
    const r = await this.req(`${UPLOAD}/files?uploadType=multipart&fields=${FIELDS}`, {
      method: "POST",
      contentType: `multipart/related; boundary=${boundary}`,
      body: body.buffer,
    });
    return r.json as RemoteFile;
  }

  async updateFile(id: string, data: ArrayBuffer): Promise<RemoteFile> {
    const r = await this.req(`${UPLOAD}/files/${id}?uploadType=media&fields=${FIELDS}`, {
      method: "PATCH",
      contentType: "application/octet-stream",
      body: data,
    });
    return r.json as RemoteFile;
  }

  /** Moves to Drive's trash (recoverable for 30 days), never hard-deletes. */
  async trash(id: string): Promise<void> {
    await this.req(`${API}/files/${id}`, {
      method: "PATCH",
      contentType: "application/json",
      body: JSON.stringify({ trashed: true }),
    });
  }
}
