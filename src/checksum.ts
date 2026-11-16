import type { DataAdapter } from 'obsidian';
import { sha256 } from '@noble/hashes/sha2.js';
import { readLocalChunks } from './local-files';

export function validSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
}

/** Incremental hashing: never materialize the whole file or call readBinary. */
export async function hashLocalFile(adapter: DataAdapter, path: string, onProgress?: (bytes: number) => void): Promise<string> {
  const hash = sha256.create();
  let bytes = 0;
  onProgress?.(0);
  try {
    for await (const chunk of readLocalChunks(adapter, path)) {
      hash.update(new Uint8Array(chunk));
      bytes += chunk.byteLength;
      onProgress?.(bytes);
    }
    return Array.from(hash.digest(), byte => byte.toString(16).padStart(2, '0')).join('');
  } finally {
    hash.destroy();
  }
}
