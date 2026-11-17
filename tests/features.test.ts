import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Platform, TFile } from 'obsidian';
import { runSync, SyncState } from '../src/sync';
import { configCategory, DEFAULT_CONFIG_SYNC, mergePluginLists, localPlugins, runConfigSync } from '../src/config-sync';
import { isSharedDrivePath, withAllDrives } from '../src/drive';

// These tests cover the desktop/iOS code path; Android transfers are covered in transfer.test.ts.
(Platform as { isAndroidApp: boolean }).isAndroidApp = false;

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array | ArrayBuffer) => new TextDecoder().decode(b);

/** In-memory vault with a config folder. */
function fakeVault(initial: Record<string, string>) {
  let clock = 1000;
  const data = new Map<string, { bytes: Uint8Array; mtime: number }>();
  const put = (p: string, bytes: Uint8Array) => data.set(p, { bytes, mtime: ++clock });
  for (const [k, v] of Object.entries(initial)) put(k, enc(v));
  const stat = (p: string) => {
    const f = data.get(p);
    return f ? { type: 'file' as const, mtime: f.mtime, size: f.bytes.length, ctime: 0 } : null;
  };
  const tfile = (p: string) => Object.assign(new TFile(), { path: p, stat: stat(p) });
  const isFolder = (p: string) => [...data.keys()].some((k) => k.startsWith(p + '/'));
  const adapter = {
    stat: async (p: string) => stat(p),
    exists: async (p: string) => data.has(p) || isFolder(p),
    copy: async (a: string, b: string) => { put(b, data.get(a)!.bytes.slice()); },
    readBinary: async (p: string) => data.get(p)!.bytes.slice().buffer,
    read: async (p: string) => dec(data.get(p)!.bytes),
    writeBinary: async (p: string, b: ArrayBuffer) => { put(p, new Uint8Array(b.slice(0))); },
    remove: async (p: string) => { data.delete(p); },
    mkdir: async () => {},
    list: async (dir: string) => {
      const files = new Set<string>(), folders = new Set<string>();
      for (const k of data.keys()) {
        if (!k.startsWith(dir + '/')) continue;
        const rest = k.slice(dir.length + 1).split('/');
        if (rest.length === 1) files.add(k);
        else folders.add(`${dir}/${rest[0]}`);
      }
      return { files: [...files], folders: [...folders] };
    },
  };
  const vault = {
    configDir: '.obsidian',
    adapter,
    getFiles: () => [...data.keys()].filter((k) => !k.startsWith('.obsidian/')).map(tfile),
    getAbstractFileByPath: (p: string) => (data.has(p) ? tfile(p) : isFolder(p) ? {} : null),
    readBinary: async (f: { path: string }) => adapter.readBinary(f.path),
    modifyBinary: async (f: { path: string }, b: ArrayBuffer) => adapter.writeBinary(f.path, b),
    createBinary: async (p: string, b: ArrayBuffer) => adapter.writeBinary(p, b),
    createFolder: async () => {},
  };
  const app = { vault, fileManager: { trashFile: async (f: { path: string }) => { data.delete(f.path); } } };
  const text = (p: string) => (data.has(p) ? dec(data.get(p)!.bytes) : undefined);
  return { app, data, text, put: (p: string, s: string) => put(p, enc(s)) };
}

/** In-memory Drive. Folder ids are their full paths; files live at full paths. */
function fakeDrive(initial: Record<string, string>) {
  let n = 0;
  const files = new Map<string, { id: string; bytes: Uint8Array; v: number }>();
  for (const [k, v] of Object.entries(initial)) files.set(k, { id: `f${++n}`, bytes: enc(v), v: 1 });
  const calls = { uploads: [] as string[], trashed: [] as string[] };
  const meta = (path: string) => {
    const f = files.get(path)!;
    return { id: f.id, name: path.split('/').pop()!, mimeType: 'text/plain', md5Checksum: `${f.id}v${f.v}`, modifiedTime: '', size: String(f.bytes.length) };
  };
  const byId = (id: string) => [...files.entries()].find(([, f]) => f.id === id)!;
  const drive = {
    resetCache: () => {},
    ensureFolderPath: async (p: string) => p,
    ensureChildFolder: async (parent: string, name: string) => `${parent}/${name}`,
    createFolder: async (name: string, parent: string) => `${parent}/${name}`,
    folderAccess: async () => ({ canEdit: true, inSharedDrive: false, canShare: true }),
    listTree: async (root: string) => {
      const out = new Map<string, ReturnType<typeof meta>>();
      const folders = new Map<string, string>([['', root]]);
      for (const path of files.keys()) {
        if (!path.startsWith(root + '/')) continue;
        const rel = path.slice(root.length + 1);
        if (rel.split('/').some((s) => s.startsWith('.'))) continue; // like the real client
        out.set(rel, meta(path));
        const parts = rel.split('/');
        for (let i = 1; i < parts.length; i++) folders.set(parts.slice(0, i).join('/'), `${root}/${parts.slice(0, i).join('/')}`);
      }
      return { files: out, folders, warnings: [] };
    },
    download: async (id: string) => byId(id)[1].bytes.slice().buffer,
    getFile: async (id: string) => meta(byId(id)[0]),
    createFile: async (name: string, parent: string, data: ArrayBuffer) => {
      const path = `${parent}/${name}`;
      files.set(path, { id: `f${++n}`, bytes: new Uint8Array(data.slice(0)), v: 1 });
      calls.uploads.push(path);
      return meta(path);
    },
    updateFile: async (id: string, data: ArrayBuffer) => {
      const [path, f] = byId(id);
      f.bytes = new Uint8Array(data.slice(0));
      f.v++;
      calls.uploads.push(path);
      return meta(path);
    },
    trash: async (id: string) => {
      const [path] = byId(id);
      files.delete(path);
      calls.trashed.push(path);
    },
  };
  const text = (p: string) => (files.has(p) ? dec(files.get(p)!.bytes) : undefined);
  const edit = (p: string, s: string) => { const f = files.get(p)!; f.bytes = enc(s); f.v++; };
  return { drive, files, calls, text, edit };
}

const settings = { remoteFolder: 'Notes', maxFileSizeMB: 0, excludes: '', propagateDeletes: true, transferChunkSizeMiB: 16 } as any;
const hooks = { checkpoint: async () => {}, progress: () => {} };

// ---- folder pairs ----------------------------------------------------------

test('whole-vault folder leaves other pairs\' vault folders alone, in both directions', async () => {
  const v = fakeVault({ 'a.md': 'A', 'Work/w.md': 'W' });
  const d = fakeDrive({ 'Notes/b.md': 'B', 'Notes/Work/stray.md': 'S' });
  const state: SyncState = {};
  const r = await runSync(v.app as any, d.drive as any, settings, state, hooks, { localPrefix: '', remotePath: 'Notes', otherPrefixes: ['Work'], readOnly: false });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(d.calls.uploads, ['Notes/a.md']);
  assert.equal(v.text('b.md'), 'B');
  assert.equal(v.text('Work/stray.md'), undefined, 'main pair must not write into another pair\'s folder');
  assert.deepEqual(Object.keys(state).sort(), ['a.md', 'b.md']);
});

test('an extra pair maps a vault folder to its own Drive folder', async () => {
  const v = fakeVault({ 'a.md': 'A', 'Work/w.md': 'W', 'Work/sub/x.md': 'X' });
  const d = fakeDrive({ 'Company/Shared/team.md': 'T' });
  const state: SyncState = {};
  const r = await runSync(v.app as any, d.drive as any, settings, state, hooks, { localPrefix: 'Work', remotePath: 'Company/Shared', otherPrefixes: [], readOnly: false });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(d.calls.uploads.sort(), ['Company/Shared/sub/x.md', 'Company/Shared/w.md']);
  assert.equal(v.text('Work/team.md'), 'T');
  assert.ok(!d.files.has('Company/Shared/a.md'), 'files outside the pair are not uploaded');
  assert.deepEqual(Object.keys(state).sort(), ['Work/sub/x.md', 'Work/team.md', 'Work/w.md']);
});

// ---- view-only folders -----------------------------------------------------

test('view-only folder: Drive wins, local edits are kept as copies, nothing is uploaded or trashed', async () => {
  const v = fakeVault({});
  const d = fakeDrive({ 'Company/Shared/team.md': 'v1', 'Company/Shared/gone.md': 'G' });
  const scope = { localPrefix: 'Work', remotePath: 'Company/Shared', otherPrefixes: [], readOnly: true };
  const state: SyncState = {};
  await runSync(v.app as any, d.drive as any, settings, state, hooks, scope);
  assert.equal(v.text('Work/team.md'), 'v1');

  v.put('Work/team.md', 'my edit');          // edit a view-only file
  v.put('Work/new.md', 'mine');               // add a file
  v.data.delete('Work/gone.md');              // delete a file
  const r = await runSync(v.app as any, d.drive as any, settings, state, hooks, scope);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(d.calls.uploads, []);
  assert.deepEqual(d.calls.trashed, []);
  assert.equal(v.text('Work/team.md'), 'v1', 'Drive version restored');
  const copy = [...v.data.keys()].find((k) => k.includes('(local edit'));
  assert.ok(copy && v.text(copy) === 'my edit', 'local edit kept as a copy');
  assert.equal(v.text('Work/gone.md'), 'G', 'deleted file restored from Drive');
  assert.equal(v.text('Work/new.md'), 'mine', 'new local file left alone');
  assert.ok(r.readOnlyKept.includes('Work/new.md') && r.readOnlyKept.includes(copy!));
});

test('view-only folder still downloads Drive changes', async () => {
  const v = fakeVault({});
  const d = fakeDrive({ 'S/t.md': 'v1' });
  const scope = { localPrefix: 'Work', remotePath: 'S', otherPrefixes: [], readOnly: true };
  const state: SyncState = {};
  await runSync(v.app as any, d.drive as any, settings, state, hooks, scope);
  d.edit('S/t.md', 'v2');
  const r = await runSync(v.app as any, d.drive as any, settings, state, hooks, scope);
  assert.equal(r.downloaded, 1);
  assert.equal(v.text('Work/t.md'), 'v2');
  assert.deepEqual(r.readOnlyKept, []);
});

// ---- settings sync ---------------------------------------------------------

test('config categories: never GSync, window layout, hidden or unknown files', () => {
  const cfg = { ...DEFAULT_CONFIG_SYNC, enabled: true, excludedPlugins: 'obsidian-git\n# comment\nplugins/excalidraw/' };
  assert.equal(configCategory('app.json', cfg), 'core');
  assert.equal(configCategory('hotkeys.json', cfg), 'core');
  assert.equal(configCategory('appearance.json', cfg), 'appearance');
  assert.equal(configCategory('themes/Minimal/theme.css', cfg), 'appearance');
  assert.equal(configCategory('snippets/my.css', cfg), 'appearance');
  assert.equal(configCategory('community-plugins.json', cfg), 'pluginList');
  assert.equal(configCategory('plugins/dataview/main.js', cfg), 'plugins');
  for (const never of ['plugins/gsync/data.json', 'plugins/gsync/transfers/x/data', 'plugins/gdrive-vault-sync/data.json',
    'workspace.json', 'workspace-mobile.json', 'plugins/obsidian-git/data.json', 'plugins/excalidraw/main.js',
    'plugins/x/.git/HEAD', 'plugins/x/node_modules/a.js', 'notes.txt', 'plugins/manifest.json']) {
    assert.equal(configCategory(never, cfg), null, never);
  }
  assert.equal(configCategory('app.json', { ...cfg, core: false }), null);
  assert.equal(configCategory('plugins/dataview/main.js', { ...cfg, plugins: false }), null);
});

test('plugin list merge keeps locally-kept plugins per device', () => {
  const keep = localPlugins({ ...DEFAULT_CONFIG_SYNC, excludedPlugins: 'obsidian-git' });
  assert.deepEqual(mergePluginLists(['dataview', 'obsidian-git'], ['gsync', 'calendar'], keep).sort(), ['dataview', 'gsync']);
  assert.deepEqual(mergePluginLists(['dataview'], ['obsidian-git'], keep).sort(), ['dataview', 'obsidian-git']);
});

test('settings sync: a new device adopts Drive\'s setup without leaking GSync\'s own data', async () => {
  const v = fakeVault({
    '.obsidian/app.json': '{"a":1}',
    '.obsidian/community-plugins.json': '["gsync","calendar"]',
    '.obsidian/plugins/gsync/data.json': '{"refreshToken":"SECRET"}',
    '.obsidian/plugins/calendar/main.js': 'cal',
    '.obsidian/workspace-mobile.json': 'phone layout',
  });
  const d = fakeDrive({
    'Notes/.obsidian/app.json': '{"a":2}',
    'Notes/.obsidian/community-plugins.json': '["dataview","obsidian-git"]',
    'Notes/.obsidian/plugins/dataview/main.js': 'dv',
    'Notes/.obsidian/workspace.json': 'pc layout',
  });
  const cfg = { ...DEFAULT_CONFIG_SYNC, enabled: true, excludedPlugins: 'obsidian-git' };
  const state: SyncState = {};
  const r = await runConfigSync(v.app as any, d.drive as any, cfg, 'Notes', state, { propagateDeletes: true, maxBytes: 0 });
  assert.deepEqual(r.errors, []);
  assert.ok(r.needsRestart);
  assert.equal(v.text('.obsidian/app.json'), '{"a":2}', 'first run adopts Drive\'s settings');
  assert.deepEqual(JSON.parse(v.text('.obsidian/community-plugins.json')!).sort(), ['dataview', 'gsync'], 'GSync stays on; excluded plugin keeps local state');
  assert.equal(v.text('.obsidian/plugins/dataview/main.js'), 'dv');
  assert.equal(v.text('.obsidian/workspace-mobile.json'), 'phone layout');
  assert.equal(d.text('Notes/.obsidian/workspace.json'), 'pc layout');
  assert.ok(![...d.files.keys()].some((k) => k.includes('plugins/gsync')), 'GSync data never uploaded');
  assert.deepEqual(JSON.parse(d.text('Notes/.obsidian/community-plugins.json')!).sort(), ['dataview', 'obsidian-git'], 'Drive list untouched');
  assert.equal(d.text('Notes/.obsidian/plugins/calendar/main.js'), 'cal', 'device-only plugin files are shared (but stay off)');

  // Turn on a plugin on this device: Drive's list gets it, but never "gsync".
  v.put('.obsidian/community-plugins.json', '["dataview","gsync","templater"]');
  const r2 = await runConfigSync(v.app as any, d.drive as any, cfg, 'Notes', state, { propagateDeletes: true, maxBytes: 0 });
  assert.deepEqual(r2.errors, []);
  assert.deepEqual(JSON.parse(d.text('Notes/.obsidian/community-plugins.json')!).sort(), ['dataview', 'obsidian-git', 'templater']);

  // Another device changes a setting: it arrives here.
  d.edit('Notes/.obsidian/app.json', '{"a":3}');
  const r3 = await runConfigSync(v.app as any, d.drive as any, cfg, 'Notes', state, { propagateDeletes: true, maxBytes: 0 });
  assert.equal(r3.downloaded, 1);
  assert.equal(v.text('.obsidian/app.json'), '{"a":3}');

  // Nothing changed: nothing moves.
  const before = d.calls.uploads.length;
  const r4 = await runConfigSync(v.app as any, d.drive as any, cfg, 'Notes', state, { propagateDeletes: true, maxBytes: 0 });
  assert.equal(r4.uploaded + r4.downloaded + r4.deleted, 0);
  assert.equal(d.calls.uploads.length, before);
  assert.equal(r4.needsRestart, false);
});

// ---- Shared Drives ---------------------------------------------------------

test('Shared Drive support is added to Drive file calls only', () => {
  assert.equal(withAllDrives('https://www.googleapis.com/drive/v3/files/abc?alt=media'), 'https://www.googleapis.com/drive/v3/files/abc?alt=media&supportsAllDrives=true');
  assert.equal(withAllDrives('https://www.googleapis.com/drive/v3/files'), 'https://www.googleapis.com/drive/v3/files?supportsAllDrives=true');
  assert.equal(withAllDrives('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable'), 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true');
  const session = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=XYZ';
  assert.equal(withAllDrives(session), session, 'resumable session URLs are used as given');
  assert.equal(withAllDrives('https://www.googleapis.com/drive/v3/drives?q=x'), 'https://www.googleapis.com/drive/v3/drives?q=x');
  const already = 'https://www.googleapis.com/drive/v3/files/a/permissions?supportsAllDrives=true';
  assert.equal(withAllDrives(already), already);
  assert.ok(isSharedDrivePath('Shared drives/Company/Notes'));
  assert.ok(isSharedDrivePath('shared drives\\Company'));
  assert.ok(!isSharedDrivePath('Obsidian/Shared drives'));
});

test('Shared Drive folders work only when the Teams add-on supplies a resolver', async () => {
  const { DriveClient } = await import('../src/drive');
  const drive = new DriveClient(async () => 'token');
  await assert.rejects(drive.ensureFolderPath('Shared drives/Acme'), /GSync Teams add-on/);
  const asked: string[] = [];
  drive.sharedDriveResolver = async (name) => { asked.push(name); return 'drive-123'; };
  assert.equal(await drive.ensureFolderPath('Shared drives/Acme'), 'drive-123');
  assert.deepEqual(asked, ['Acme']);
  assert.equal(await drive.ensureFolderPath('Shared drives/Acme'), 'drive-123');
  assert.deepEqual(asked, ['Acme'], 'resolved once per sync');
});
