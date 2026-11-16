# Configurable Android transfer size

Android previously made one Drive request per MiB. A 50 MiB file therefore
required 50 media requests, even on a fast connection. The new **Transfer chunk
size (MiB)** setting offers 1, 2, 4, 8 and 16 MiB, with 8 MiB as the default.
Missing or invalid saved values fall back to 8 MiB. This is a request ceiling,
not a minimum file size: a small note uses one request and the final request
contains only the remaining bytes. A 50 MiB download at 8 MiB uses seven media
requests, plus the existing metadata checks.

The same selection applies to Android downloads and resumable uploads. It is
captured when each transfer starts, so changing settings cannot change an active
transfer's boundaries. Desktop and iOS keep their existing transfer path.
Local byte comparisons still use 1 MiB buffers.

Download buffers go directly to `appendBinary` without another GSync splitting
or copying pass. Staging rejects buffers larger than 16 MiB. The installed
Obsidian 1.15.1 Android adapter was observed to split writes of at least 5 MiB
internally; this is an implementation detail, not a public adapter guarantee.
Uploads reuse the original buffer on the first attempt and copy only a suffix
when Drive acknowledges part of a block. Offset queries, bounded retry counts,
range validation, progress reporting and recovery journals are preserved.

## Validation

Automated tests cover every option with empty, small, exact-boundary and
partial-final-block files; local streaming, staging and upload reconstruction;
lost responses and partial acknowledgements; invalid sizes; settings changes
during upload; and passing the selected download limit through the sync engine.
Run `npm test`, `npm run build` and `npm run lint`.

The new default and larger options have not yet been tested on a device.
Existing successful Android runs used 1 MiB. The cap bounds each request, not
the total memory footprint of the native bridge/WebView. Device validation
should include downloads, uploads, repeated sync and memory monitoring before
claiming performance or stability improvements.
