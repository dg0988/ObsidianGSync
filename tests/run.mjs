import { build } from 'esbuild';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const dir = await mkdtemp(join(tmpdir(), 'gsync-tests-'));
try {
  // Each test file is bundled on its own, so platform mocks don't leak between files.
  const files = (await readdir('tests')).filter((f) => f.endsWith('.test.ts')).sort();
  const outputs = [];
  for (const file of files) {
    const out = join(dir, file.replace(/\.ts$/, '.cjs'));
    await build({ entryPoints: [join('tests', file)], outfile: out, bundle: true, platform: 'node', format: 'cjs', alias: { obsidian: resolve('tests/obsidian.ts') } });
    outputs.push(out);
  }
  const result = spawnSync(process.execPath, ['--test', ...outputs], { stdio: 'inherit' });
  process.exitCode = result.status ?? 1;
} finally { await rm(dir, { recursive: true, force: true }); }
