import type { RequestUrlResponse } from 'obsidian';
import type { RemoteFile } from './drive';

export const TRANSFER_CHUNK_SIZE = 1024 * 1024;
export type ByteProgress = (bytes: number, total: number) => void;
export type BinarySource = AsyncIterable<ArrayBuffer>;
export type TransferRequest = (url: string, options?: {
  method?: string; body?: string | ArrayBuffer; contentType?: string;
  headers?: Record<string, string>; retry?: boolean;
}) => Promise<RequestUrlResponse>;
const API = 'https://www.googleapis.com/drive/v3/files';
const FIELDS = 'id,name,mimeType,md5Checksum,modifiedTime,size,version';
export const header = (r: RequestUrlResponse, name: string): string | undefined =>
  Object.entries(r.headers).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];
export function fileSize(file: RemoteFile): number {
  if (!/^\d+$/.test(file.size ?? '')) throw new Error('Missing remote file size');
  const size = Number(file.size);
  if (!Number.isSafeInteger(size)) throw new Error('Invalid remote file size');
  return size;
}
function unchanged(a: RemoteFile, b: RemoteFile): boolean {
  return a.id === b.id && a.size === b.size && a.modifiedTime === b.modifiedTime &&
    a.md5Checksum === b.md5Checksum && a.version === b.version;
}
export async function* downloadChunks(req: TransferRequest, expected: RemoteFile, onProgress?: ByteProgress): AsyncGenerator<ArrayBuffer> {
  const url = `${API}/${encodeURIComponent(expected.id)}`;
  const current = async () => (await req(`${url}?fields=${FIELDS}`)).json as RemoteFile;
  if (!unchanged(expected, await current())) throw new Error('Remote file changed before download; retry sync');
  const size = fileSize(expected);
  onProgress?.(0, size);
  for (let start = 0; start < size; start += TRANSFER_CHUNK_SIZE) {
    const end = Math.min(size - 1, start + TRANSFER_CHUNK_SIZE - 1);
    const r = await req(`${url}?alt=media`, { headers: { Range: `bytes=${start}-${end}`, 'Accept-Encoding': 'identity' } });
    if (r.status !== 206 || header(r, 'Content-Range') !== `bytes ${start}-${end}/${size}`) {
      throw new Error('Drive did not honor the requested byte range');
    }
    if (r.arrayBuffer.byteLength !== end - start + 1) throw new Error('Incomplete download range');
    yield r.arrayBuffer;
    onProgress?.(end + 1, size);
  }
  if (!unchanged(expected, await current())) throw new Error('Remote file changed during download; retry sync');
}

/** A session URL is a credential: never include it or response bodies in errors. */
export async function uploadChunks(req: TransferRequest, size: number, chunks: BinarySource,
  target: { name: string; parentId: string } | { id: string }, onProgress?: ByteProgress): Promise<RemoteFile> {
  if (!Number.isSafeInteger(size) || size < 0) throw new Error('Invalid upload size');
  onProgress?.(0, size);
  const updating = 'id' in target;
  const start = await req(`https://www.googleapis.com/upload/drive/v3/files${updating ? '/' + encodeURIComponent(target.id) : ''}?uploadType=resumable&fields=${FIELDS}`, {
    method: updating ? 'PATCH' : 'POST', contentType: 'application/json',
    headers: { 'X-Upload-Content-Type': 'application/octet-stream', 'X-Upload-Content-Length': String(size) },
    body: JSON.stringify(updating ? {} : { name: target.name, parents: [target.parentId] }), retry: false,
  });
  const location = header(start, 'Location');
  if (!location) throw new Error('Drive did not return an upload session');
  const url = new URL(location);
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.googleapis.com') || url.username || url.password) {
    throw new Error('Invalid Drive upload session');
  }
  let offset = 0;
  let completed: RemoteFile | undefined;
  const send = async (data: ArrayBuffer) => {
    const end = offset + data.byteLength;
    let acknowledged = offset;
    let failures = 0;
    while (!completed && (acknowledged < end || size === 0)) {
      let r: RequestUrlResponse;
      try {
        r = await req(location, { method: 'PUT', contentType: 'application/octet-stream',
          headers: { 'Content-Range': size === 0 ? 'bytes */0' : `bytes ${acknowledged}-${end - 1}/${size}` },
          body: data.slice(acknowledged - offset), retry: false });
      } catch {
        if (++failures > 4) throw new Error('Upload interrupted; retry sync');
        // A failed response does not mean the server rejected the bytes.
        r = await req(location, { method: 'PUT', headers: { 'Content-Range': `bytes */${size}` }, body: new ArrayBuffer(0) });
      }
      if (r.status === 200 || r.status === 201) {
        if (end !== size) throw new Error('Drive completed upload before all bytes were sent');
        completed = r.json as RemoteFile;
        if (Number(completed.size) !== size) throw new Error('Uploaded size does not match local file');
        onProgress?.(size, size);
        break;
      }
      if (r.status !== 308) throw new Error(`Unexpected upload status ${r.status}`);
      const range = header(r, 'Range');
      const match = range?.match(/^bytes=0-(\d+)$/);
      const next = range === undefined ? 0 : match ? Number(match[1]) + 1 : NaN;
      if (!Number.isSafeInteger(next) || next < acknowledged || next > end) throw new Error('Invalid upload acknowledgement');
      if (next === acknowledged && ++failures > 4) throw new Error('Upload made no progress');
      if (next > acknowledged) onProgress?.(next, size);
      acknowledged = next;
      if (acknowledged === size) throw new Error('Drive did not finalize upload');
    }
    offset = end;
  };
  for await (const chunk of chunks) {
    if (!chunk.byteLength || chunk.byteLength > TRANSFER_CHUNK_SIZE || offset + chunk.byteLength > size ||
      (offset + chunk.byteLength < size && chunk.byteLength % (256 * 1024) !== 0)) throw new Error('Invalid upload chunk');
    await send(chunk);
  }
  if (size === 0) await send(new ArrayBuffer(0));
  if (offset !== size || !completed) throw new Error('Incomplete local upload stream');
  return completed;
}
