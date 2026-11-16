import type { RemoteFile } from './drive';

export const DRIVE_FILE_FIELDS = 'id,name,mimeType,md5Checksum,sha256Checksum,modifiedTime,size,version';
export function fileSize(file: RemoteFile): number {
  if (!/^\d+$/.test(file.size ?? '')) throw new Error('Missing remote file size');
  const size = Number(file.size);
  if (!Number.isSafeInteger(size)) throw new Error('Invalid remote file size');
  return size;
}
export function sameRemoteVersion(a: RemoteFile, b: RemoteFile): boolean {
  return a.id === b.id && a.size === b.size && a.modifiedTime === b.modifiedTime &&
    a.md5Checksum === b.md5Checksum && a.sha256Checksum === b.sha256Checksum && a.version === b.version;
}
