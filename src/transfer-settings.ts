/** Supported Android request sizes; local comparison keeps its own 1 MiB blocks. */
export const TRANSFER_CHUNK_OPTIONS_MIB = [1, 2, 4, 8, 16] as const;
export const DEFAULT_TRANSFER_CHUNK_MIB = 16; // the size validated on an Android device
export const MAX_TRANSFER_CHUNK_BYTES = 16 * 1024 * 1024;
export function normalizeTransferChunkSizeMiB(value: unknown): number {
  return typeof value === 'number' && TRANSFER_CHUNK_OPTIONS_MIB.some(size => size === value)
    ? value : DEFAULT_TRANSFER_CHUNK_MIB;
}
export function transferChunkBytes(value: unknown): number {
  return normalizeTransferChunkSizeMiB(value) * 1024 * 1024;
}
export function assertTransferChunkBytes(bytes: number): void {
  if (!TRANSFER_CHUNK_OPTIONS_MIB.some(size => size * 1024 * 1024 === bytes)) {
    throw new Error('Unsupported transfer chunk size');
  }
}
