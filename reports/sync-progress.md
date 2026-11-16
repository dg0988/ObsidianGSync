# Sync progress (experimental 1.0.6)

On Android, an in-app notice displays the checked-file count, current path,
transfer direction, transferred/total MiB, percentage, and average MiB/s for the
current transfer. Comparison and saving have separate phase labels. The desktop
status bar shows the same phases; byte progress is available for the Android
chunked transport. Other platforms report transfer phases without byte counters.

Use the command **GSync: Show sync progress** to reopen a dismissed notice.
Progress is shown inside Obsidian, not as an Android system notification.
The notice closes when sync finishes or fails; the usual result notice follows.

File counts reflect checked paths (including already synchronized files), not
remaining downloads. Speed includes request and write latency. No remaining-time
estimate is displayed. Byte accounting follows written download chunks and
acknowledged upload offsets; retries do not inflate the counter. UI painting is
throttled to 250 ms within transfers, with immediate phase changes. No binary
buffers are retained by the progress model.

This change is on a separate branch from the Android OOM fix. Device UI validation
is pending; automated tests cover formatting, speed resets, file boundaries and
transfer byte accounting as well as the previous transport/recovery cases.
