import type { DataAdapter } from 'obsidian';
import type { BinarySource } from './drive-transfer';
import { assertLocalUnchanged, LOCAL_READ_CHUNK_SIZE, readLocalChunks, Snapshot } from './local-files';
import { MAX_TRANSFER_CHUNK_BYTES } from './transfer-settings';

export interface StagedFile {
  path: string;
  install(target: string, expected: Snapshot): Promise<void>;
  dispose(): Promise<void>;
}

/** Only public adapter APIs. Staging files stay under the excluded config directory. */
export class AndroidFiles {
  private root: string;
  readonly blockedPaths = new Set<string>();
  constructor(private adapter: DataAdapter, configDir: string) {
    this.root = `${configDir}/plugins/gsync/transfers`;
    if (typeof adapter.appendBinary !== 'function') throw new Error('Android streaming requires Obsidian 1.12.3 or later');
  }
  assertUnchanged(path: string, expected: Snapshot): Promise<void> {
    return assertLocalUnchanged(this.adapter, path, expected);
  }
  private async mkdir(path: string): Promise<void> {
    const parts = path.split('/');
    for (let i = 1; i <= parts.length; i++) {
      const prefix = parts.slice(0, i).join('/');
      if (!await this.adapter.exists(prefix)) await this.adapter.mkdir(prefix);
    }
  }
  private async checkedCopy(source: string, target: string): Promise<void> {
    const before = await this.adapter.stat(source);
    if (!before || before.type !== 'file') throw new Error('Copy source missing');
    await this.adapter.copy(source, target);
    if ((await this.adapter.stat(target))?.size !== before.size) throw new Error('Incomplete native file copy');
    await this.assertUnchanged(source, before);
  }
  readChunks(path: string, chunkSize = LOCAL_READ_CHUNK_SIZE): AsyncGenerator<ArrayBuffer> {
    return readLocalChunks(this.adapter, path, chunkSize);
  }
  async equal(a: string, b: string): Promise<boolean> {
    const sa = await this.adapter.stat(a), sb = await this.adapter.stat(b);
    if (!sa || !sb) throw new Error('File missing during comparison');
    if (sa.size !== sb.size) return false;
    const right = this.readChunks(b)[Symbol.asyncIterator]();
    try {
      for await (const left of this.readChunks(a)) {
        const next = await right.next();
        if (next.done || left.byteLength !== next.value.byteLength) return false;
        const x = new Uint8Array(left), y = new Uint8Array(next.value);
        for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
      }
      return (await right.next()).done === true;
    } finally {
      await right.return?.(undefined);
    }
  }
  async stage(chunks: BinarySource): Promise<StagedFile> {
    const dir = `${this.root}/transfer-${crypto.randomUUID()}`;
    await this.mkdir(dir);
    const path = `${dir}/data`, backup = `${dir}/original`, journal = `${dir}/journal.json`;
    try {
      let size = 0;
      await this.adapter.writeBinary(path, new ArrayBuffer(0));
      for await (const chunk of chunks) {
        if (chunk.byteLength > MAX_TRANSFER_CHUNK_BYTES) throw new Error('Oversized download chunk');
        await this.adapter.appendBinary(path, chunk);
        size += chunk.byteLength;
      }
      if ((await this.adapter.stat(path))?.size !== size) throw new Error('Incomplete staged file');
    } catch (e) {
      await this.adapter.rmdir(dir, true).catch(() => undefined);
      throw e;
    }
    return {
      path,
      dispose: async () => {
        // A journal belongs to recovery, not routine temporary-file cleanup.
        if (await this.adapter.exists(dir) && !await this.adapter.exists(journal) && !await this.adapter.exists(`${dir}/recovered.json`)) await this.adapter.rmdir(dir, true);
      },
      install: async (target, expected) => {
        await this.assertUnchanged(target, expected);
        const parent = target.split('/').slice(0, -1).join('/');
        if (parent) await this.mkdir(parent);
        // Copying preserves the visible TFile identity; renaming it into a hidden
        // directory would emit a user-visible rename and break Vault's cache.
        if (expected) {
          await this.checkedCopy(target, backup);
          if ((await this.adapter.stat(backup))?.size !== expected.size) throw new Error('Incomplete backup');
          await this.assertUnchanged(target, expected);
        }
        const pending = `${dir}/journal.pending`;
        await this.adapter.write(pending, JSON.stringify({ target, hadOriginal: expected !== null }));
        await this.adapter.rename(pending, journal);
        try { await this.assertUnchanged(target, expected); }
        catch (e) { await this.adapter.remove(journal); throw e; }
        // On Android adapter.copy is native and reconciles the target after copying.
        // It is not atomic: the journal allows recovery of an interrupted copy.
        try {
          await this.checkedCopy(path, target);
          if ((await this.adapter.stat(target))?.size !== (await this.adapter.stat(path))?.size) throw new Error('Incomplete installed file');
          await this.adapter.remove(journal);
        } catch (e) {
          // Best-effort immediate rollback; a failed rollback keeps the journal.
          await this.recover();
          throw e;
        }
        // A complete replacement is durable; failed cleanup is handled on next run.
        await this.adapter.rmdir(dir, true).catch(() => undefined);
      },
    };
  }
  async recover(): Promise<string[]> {
    const warnings: string[] = [];
    if (!await this.adapter.exists(this.root)) return warnings;
    for (const dir of (await this.adapter.list(this.root)).folders) {
      if (!dir.startsWith(`${this.root}/transfer-`) || dir.slice(this.root.length + 1).includes('/')) continue;
      const journal = `${dir}/journal.json`, backup = `${dir}/original`;
      if (await this.adapter.exists(journal)) {
        let recoveryTarget: string | undefined;
        try {
          const entry: unknown = JSON.parse(await this.adapter.read(journal));
          if (!entry || typeof entry !== 'object' || !('target' in entry) || typeof entry.target !== 'string' ||
            !('hadOriginal' in entry) || typeof entry.hadOriginal !== 'boolean') throw new Error('Invalid recovery journal');
          const target = entry.target;
          recoveryTarget = target;
          if (!target || target.includes("\\") || target.split('/').some(p => !p || p.startsWith('.'))) throw new Error('Invalid recovery path');
          if (entry.hadOriginal && !await this.adapter.exists(backup)) throw new Error('Recovery backup missing');
          // Preserve even an incomplete destination: it may contain edits made
          // after the crash, including edits between repeated recovery attempts.
          let retained = `${dir}/retained-target`;
          if (await this.adapter.exists(retained)) retained += `-${crypto.randomUUID()}`;
          if (await this.adapter.exists(target)) {
            const pending = `${dir}/retained-${crypto.randomUUID()}.pending`;
            await this.checkedCopy(target, pending);
            await this.adapter.rename(pending, retained);
          }
          if (entry.hadOriginal) await this.checkedCopy(backup, target);
          else if (await this.adapter.exists(target)) await this.adapter.remove(target);
          await this.adapter.write(`${dir}/recovered.json`, JSON.stringify({ target }));
          await this.adapter.remove(journal);
          this.blockedPaths.delete(target);
          warnings.push(`Interrupted transfer recovered; copies retained at ${dir}`);
          continue;
        } catch {
          if (recoveryTarget) this.blockedPaths.add(recoveryTarget);
          // Never delete a directory whose journal cannot be interpreted.
          warnings.push(`Transfer recovery needs attention; copies preserved at ${dir}`);
          continue;
        }
      }
      if (!await this.adapter.exists(`${dir}/recovered.json`)) await this.adapter.rmdir(dir, true);
    }
    return warnings;
  }
}
