# Browser and OS support

## Choosing a browser

Use a current browser. Chrome and Edge offer the broadest editing and
export support, including saving large exports directly to disk. Safari and
Firefox can open recordings and show video, routes and charts when the
browser and operating system can play the recording's format.

On iPhone and iPad, prefer selecting individual recordings over an entire
SD-card folder. The map needs a usable WebGL2 context; other viewer features
remain available when the graphics hardware cannot provide one.

For portable HTML, see [self-hosting](self-hosting.md#open-the-portable-html).

## Capability model

Target current and previous major browser engines. Enable features by actual
capability, not a browser-version floor. API introduction dates do not establish
whole-app compatibility; test a browser before claiming a minimum version.
Build syntax targets live in [the hosted config](../vite.config.ts) and
[the portable config](../vite.portable.config.ts).

[Capabilities and their severity](../src/capabilities.ts) are the source of
truth: blocking gaps prevent startup, degraded gaps explain an unavailable
feature, and informational gaps are handled at the point of use.
[Capability notices](../src/ui/capability-gate.ts) use localized `caps.*` copy.

| Capability | Boundary |
| --- | --- |
| Native video and container parsing | Do not require WebCodecs; codec availability still depends on the browser, OS and GPU. |
| Edited export and previews | Require the relevant decode/encode and canvas capabilities. Original-quality stream-copy export does not require WebCodecs. |
| H.264 encoding | Probe a real encode in [transcode capabilities](../src/transcode/capabilities.ts); API presence and `isConfigSupported()` alone are insufficient. |
| HEVC playback | Uses platform decoders, with container remux when needed. There is no WASM software-decoder fallback. Shared browser advice lives in [empty-state.ts](../src/ui/empty-state.ts). |
| Saving exports | [Export flow](../src/ui/export-flow.ts) uses a native file picker when available, otherwise an [in-memory download](../src/ui/in-memory-file.ts). Service workers are not required. |
| Offline reopening | Uses the hosted [service worker](../src/sw.ts); its absence does not disable local playback or export. |
| Secure context | Some editing, file-access and offline features require HTTPS or localhost. See [local-network hosting](self-hosting.md#https-and-local-networks). |

## Compatibility fallbacks

Keep fallbacks at their call sites:

- [Abort signals](../src/abort-signals.ts): native `AbortSignal.any` or a
  fallback that preserves the first reason and releases subscriptions.
- [MSE runtime](../src/per-file-mse.ts): `MediaSource` or
  `ManagedMediaSource`, with the required remote-playback handling.
- [Camera menu](../src/ui/player-camera-flip.ts): native Popover API or a
  menu with keyboard/outside-pointer dismissal and fullscreen support.
- [Browser identification](../src/capabilities.ts): preserve branded WebKit
  names while applying engine-specific file-read workarounds. Feature
  availability still comes from probes.

Tests that omit an API in a current browser verify the fallback, not complete
compatibility with historical browsers or their media codecs.

## Known limitations

- **File-handle persistence:** the [Chromium crash guard](../src/persist/file-handle-support.ts)
  disables durable folder and notes-file connections for affected or unverified
  versions. A round-trip probe can itself crash; this is not private-browsing
  detection. Existing connections and ordinary notes/index-cache data stay
  untouched; new connections last for the tab. Before narrowing the guard,
  verify the [upstream failure](https://github.com/chromium/chromium/blob/153.0.8010.12/content/browser/indexed_db/instance/sqlite/database_connection.cc#L2482)
  is fixed and test native file and directory handles in regular and private
  contexts.
- **iOS folder selection:** WebKit can copy the entire folder before exposing
  any files to the page; feature detection cannot reveal this cost. The
  [folder warning](../src/ui/ios-folder-warning-modal.ts) steers users to
  individual files. Keep the warning until the copy/cleanup behavior is
  verified on devices; see [WebKit 271705](https://bugs.webkit.org/show_bug.cgi?id=271705)
  and [228683](https://bugs.webkit.org/show_bug.cgi?id=228683). Interrupted
  copies can outlive the tab, and the page cannot filter the folder first.
- **Codec probes:** Firefox H.264 encoding has returned false-positive support
  reports ([1918769](https://bugzilla.mozilla.org/show_bug.cgi?id=1918769)).
  Preserve the real-encode probe rather than a version-based promise. Browsers
  without WebCodecs retain native playback and stream-copy where supported.
- **Map hardware:** preflight WebGL2 in [map.ts](../src/ui/map.ts); a current
  browser on a blocked GPU may still have no usable context. Keep the chart
  and video usable when map initialization fails.
- **Tracking and hosting headers:** ONNX Runtime requires the hosted
  `'wasm-unsafe-eval'` permission; threaded WASM also needs cross-origin
  isolation. Third-party resources must satisfy CORS/CORP. The worker's
  response headers and the fallback to one thread matter as well. See
  [headers](../public/_headers), [service worker](../src/sw.ts) and
  `threadCount` in [ORT runtime](../src/tracking/ort-runtime.ts). Portable
  excludes tracking and that CSP permission.
- **Damaged recordings:** runtime decode faults do not establish codec
  incompatibility. [Playback recovery](../src/ui/player.ts) distinguishes
  retries, source rejection and a [damaged clip tail](../src/ui/playback-tail.ts).
  An MP4 sample table can reference bytes beyond EOF; current ingest repairs
  do not generally repair such tables, and native-to-MSE recovery is not a
  general corruption repair. Export tolerates only a bounded damaged source
  tail via `nextTolerant` in [pipeline-common.ts](../src/transcode/pipeline-common.ts),
  reports loss, and must not discard later intact files. Further repair work
  needs a reproducible real sample.

## Manual verification

Use the [e2e guide](../tests/e2e/README.md) for automated coverage. When changing
export memory or download behavior, also check:

1. A multi-GB in-memory export in real Safari/Firefox: allocation failure must
   produce an actionable message rather than a silent tab crash. Measure peak
   memory through both muxing and download.
2. Safari saves the MP4 in Downloads with the intended filename, rather than
   opening a new tab.
3. A representative mobile export survives memory pressure and storage eviction.

Native file-picker exports stream to disk. Automated small-fixture tests do
not establish native-dialog behavior, large-file memory limits or physical
mobile-device compatibility.
