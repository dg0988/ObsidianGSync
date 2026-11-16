export interface TransferProgress {
  phase: 'download' | 'upload' | 'compare' | 'install' | 'hash';
  path: string;
  bytes?: number;
  total?: number;
}
const mib = (bytes: number) => (bytes / (1024 * 1024)).toFixed(1);

/** UI state only: it never retains file contents. Speed is the current transfer's average. */
export class SyncProgress {
  private done = 0;
  private total = 0;
  private current: TransferProgress | null = null;
  private started = 0;
  constructor(private now: () => number = () => performance.now()) {}
  files(done: number, total: number): void {
    if (done !== this.done) this.current = null;
    this.done = done;
    this.total = total;
  }
  transfer(progress: TransferProgress): boolean {
    const changed = this.current?.path !== progress.path || this.current?.phase !== progress.phase;
    if (changed || progress.bytes === 0) this.started = this.now();
    this.current = progress;
    return changed;
  }
  text(): string {
    const lines = [this.total ? `GSync: ${this.done}/${this.total} files checked` : 'GSync: preparing sync…'];
    const p = this.current;
    if (!p) return lines[0];
    const label = { download: '↓ Downloading', upload: '↑ Uploading', compare: 'Comparing', install: 'Saving', hash: 'Hashing' }[p.phase];
    lines.push(`${label}: ${p.path}`);
    if ((p.phase === 'download' || p.phase === 'upload' || p.phase === 'hash') && p.bytes !== undefined && p.total !== undefined && Number.isFinite(p.bytes) && Number.isFinite(p.total) && p.total >= 0) {
      const percent = p.total ? Math.min(100, Math.floor(p.bytes * 100 / p.total)) : 100;
      let detail = `${mib(p.bytes)} / ${mib(p.total)} MiB · ${percent}%`;
      const seconds = (this.now() - this.started) / 1000;
      if (seconds >= 1 && p.bytes > 0) detail += ` · ${(p.bytes / 1048576 / seconds).toFixed(2)} MiB/s`;
      lines.push(detail);
    }
    return lines.join('\n');
  }
}
