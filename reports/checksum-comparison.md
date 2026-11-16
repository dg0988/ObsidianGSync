# Avoid redundant downloads during content comparison

First sync previously downloaded the Drive copy even when the same file was
already present locally. Simultaneous edits also required a download merely to
find out that both sides had identical contents. Content comparison now uses
Drive's optional SHA-256 metadata when available.

Files still match by their full vault-relative path. Existing records whose
local size/mtime and remote revision are unchanged are skipped without reading
or hashing contents. This patch does not add rename detection or a new sync
scheduler.

When comparison is required:

1. Different known sizes establish a difference immediately, without hashing.
2. Otherwise, a valid Drive SHA-256 is compared with the incremental local hash.
   Local reads use 1 MiB buffers regardless of the transfer-size setting. The
   UI shows a separate Hashing phase with byte progress.
3. A match records the sync without a media download or staging file. Before
   recording, re-read remote metadata and verify identity, size, modification
   time, version and checksums, then check the local size/mtime/type again.
   State recording itself checks the expected local snapshot.
4. Missing or malformed SHA-256 uses the existing exact byte comparison.
5. A mismatch retains the existing conflict policy: keep the Drive version in
   a separate conflict file and upload the local version at the original path.
   This still downloads the remote contents to preserve that version, but does
   not compare the staged copy again when a difference is already established.

`sha256Checksum` is requested consistently in Drive listings, metadata and
transfer responses. Existing `remoteRev` values still use MD5 or modification
time. No state migration, reset, or persistent checksum cache is introduced.
The extracted local resource reader supports hashing on Android, desktop and
iOS; recovery/staging remains Android-specific.

## Implementation and validation

- [Sync decision and guarded state recording](../src/sync.ts)
- [Incremental hash](../src/checksum.ts), using pinned, bundled
  `@noble/hashes@2.4.0`; no full-file `crypto.subtle.digest` buffer
- [Local streaming and snapshot validation](../src/local-files.ts)
- [Shared Drive metadata fields and version checks](../src/remote-metadata.ts)
- [Regression tests](../tests/transfer.test.ts)

Tests include empty files and a known SHA vector; binary streams crossing block
boundaries; equality without any media request; differing contents and sizes;
missing/malformed/uppercase checksums; unchanged and both-changed records;
different paths; desktop/iOS hash, byte-fallback and conflict branches; failed streams;
metadata errors; and local/remote edits during comparison and state recording.
Run `npm test`, `npm run build` and `npm run lint`.

These are automated tests with mocked Obsidian/Drive adapters. Live Drive and
physical-device testing of this optimization remains outstanding. Snapshot
checks detect ordinary concurrent changes but do not lock either file; edits
that preserve both size and mtime are outside the existing change detector's
guarantees. Cloud changes after the final metadata check are handled by the
next sync's remote revision check.

References:
- [Google Drive file metadata](https://developers.google.com/workspace/drive/api/reference/rest/v3/files)
- [noble-hashes incremental hashing API](https://github.com/paulmillr/noble-hashes)
