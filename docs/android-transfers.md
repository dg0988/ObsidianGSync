# Android transfers (experimental 1.0.5)

Android now uses bounded transfers instead of sending whole files through
Obsidian's native HTTP bridge. Requires Obsidian 1.12.3+ (`appendBinary`).
Desktop and iOS retain the existing transfer path.

- Drive downloads request sequential 1 MiB byte ranges and check status, range,
  length and metadata version before/after downloading.
- Local reads stream the adapter's resource URL; writes append bounded binary
  chunks to an excluded staging directory under the vault config directory.
- First-time equality checks compare two streams, without two whole-file buffers.
- Uploads use resumable sessions and 1 MiB bodies; an uncertain response triggers
  a server-offset query. Sessions are not persisted across application restarts.
- A completed download is installed using native adapter.copy. This preserves
  Obsidian's file index; moving visible files into hidden backup locations does not.
  Replacement is **not atomic**: a backup and recovery journal protect interrupted
  copying. Native copy lengths are checked. A retry restores the old original
  before normal sync resumes and retains the interrupted destination for recovery.
- State is recorded only after successful transfer. Existing state is not reset.

Staging needs free disk space for the downloaded file and, for replacements, an
original backup. Interrupted replacements retain recovery copies under
`<configDir>/plugins/gsync/transfers/`. Recovery warnings include their location.
Do not remove that directory before reviewing a recovery warning. A malformed
journal is preserved; a known target with failed recovery is skipped.

The size limit setting is retained; `0` disables it. The patch does not claim
unlimited file sizes or a fixed total WebView footprint. RequestUrl buffers a
response before JavaScript can inspect it, so a server ignoring Range could still
consume too much native memory. Google Drive documents support for byte ranges.
There is no fallback to an unbounded Android media request.

The local resource fetch is intentional (ESLint warns against network fetch):
this is a local file stream, not an authenticated cloud request.

## Validation

Run `npm test`, `npm run build`, and `npm run lint`.
Tests cover transport ranges, metadata changes, truncated responses, resumable
acknowledgements, streamed comparison, interrupted staging, state recording,
conflicts and recovery failures. Mocked adapter tests do not replace device tests.

Before a release/PR, test on Android with logging: the originally failing file,
a larger test file in a separate vault, repeated unchanged sync, upload, conflict,
interruption/restart and a subsequent sync with deletion propagation. Check file
hashes, Vault visibility and retained backups. Do not enable deletion propagation
in a working vault just to test it.

References:
- https://developers.google.com/workspace/drive/api/guides/manage-downloads
- https://developers.google.com/workspace/drive/api/guides/manage-uploads
