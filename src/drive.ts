import { requestUrl, RequestUrlResponse } from "obsidian";

const API = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3";
export const FOLDER_MIME = "application/vnd.google-apps.folder";
const FIELDS = "id,name,mimeType,md5Checksum,modifiedTime,size";

export interface RemoteFile {
  id: string;
  name: string;
  mimeType: string;
  md5Checksum?: string;
  modifiedTime: string;
  size?: string;
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

export class DriveClient {
  constructor(private getToken: () => Promise<string>) {}

  private async req(
    url: string,
    opts: { method?: string; body?: string | ArrayBuffer; contentType?: string } = {}
  ): Promise<RequestUrlResponse> {
    for (let attempt = 0; ; attempt++) {
      const token = await this.getToken();
      const r = await requestUrl({
        url,
        method: opts.method ?? "GET",
        body: opts.body,
        contentType: opts.contentType,
        headers: { Authorization: `Bearer ${token}` },
        throw: false,
      });
      if ((r.status === 429 || r.status >= 500) && attempt < 4) {
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

  async listChildren(folderId: string): Promise<RemoteFile[]> {
    const out: RemoteFile[] = [];
    let pageToken = "";
    do {
      const params = new URLSearchParams({
        q: `'${q(folderId)}' in parents and trashed = false`,
        fields: `nextPageToken, files(${FIELDS})`,
        pageSize: "1000",
        spaces: "drive",
      });
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
    return (r.json as RemoteFile).id;
  }

  /** Resolve a path like "Obsidian/My Vault" under My Drive, creating missing folders. */
  async ensureFolderPath(path: string): Promise<string> {
    let parent = "root";
    for (const name of path.split(/[/\\]/).map((s) => s.trim()).filter(Boolean)) {
      const params = new URLSearchParams({
        q: `'${q(parent)}' in parents and name = '${q(name)}' and mimeType = '${FOLDER_MIME}' and trashed = false`,
        fields: "files(id)",
        spaces: "drive",
      });
      const r = await this.req(`${API}/files?${params.toString()}`);
      const found = (r.json as FileList).files;
      parent = found.length ? found[0].id : await this.createFolder(name, parent);
    }
    return parent;
  }

  async listTree(rootId: string): Promise<RemoteTree> {
    const files = new Map<string, RemoteFile>();
    const folders = new Map<string, string>([["", rootId]]);
    const warnings: string[] = [];
    const queue: [string, string][] = [["", rootId]];
    while (queue.length) {
      const [prefix, id] = queue.shift() as [string, string];
      for (const f of await this.listChildren(id)) {
        const path = prefix ? `${prefix}/${f.name}` : f.name;
        if (f.mimeType === FOLDER_MIME) {
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
