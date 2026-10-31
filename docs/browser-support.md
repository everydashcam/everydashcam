# Browser and OS support

## The short answer

Use a current desktop browser for the smoothest experience. Chrome and Edge
offer the broadest support, especially when editing a trip or saving a large
export directly to disk.

Safari and Firefox handle the core job — opening recordings, playing a trip,
and showing its route and charts — when the browser and operating system can
play the camera's video format. Some editing and export options may be limited.

On phones and tablets, the available features also depend on the operating
system. On iPhone and iPad, selecting the individual recordings you need is
safer than selecting an entire SD-card folder. The map requires WebGL2 and may
be unavailable when hardware acceleration is disabled or the graphics hardware
is too old.

everydashcam checks these capabilities when it opens. If something important is
missing, the app explains which feature is affected and what you can do. The
rest of this document records the exact boundary for maintainers and technical
troubleshooting.

## Capability model

Each capability is one of three severities:

- **blocking** - the core job is impossible and there is no graceful path. The
  UI shows a full blocking gate ("won't run here" + cause + what to do) and
  `app.ts` skips heavy init.
- **degraded** - a real, user-visible feature is gone but the core still works.
  The UI explains it proactively (a concise notice) and at the point of use.
- **info** - invisible to the user (a background feature already covers it) or
  only a diagnostic. Recorded for metrics, never surfaced on its own.

The blocking set is small and fixed (the `"blocking"` entries in `SEVERITY`),
and all of its members are universal on any browser modern enough to parse our
ES-module bundle, so the gate is a genuine safety net rather than an everyday
wall. The everyday value is in the **degraded** set (no map / no editor / iOS
load friction).

Per-capability severity assignment and the rationale behind each one: `SEVERITY`
in `src/capabilities.ts` - one map, one comment per capability, the single place
to revisit if a gap's classification should change.

### Implementation

- Detection and severity: `src/capabilities.ts`.
- Blocking and degraded-state notices: `src/ui/capability-gate.ts`, with copy
  in the `caps.*` keys under `src/i18n/`.
- Map degradation: `src/ui/map.ts`; `refreshMapless` keeps the chart working
  without a map.
- Export destination selection: `src/ui/export-flow.ts` and
  `src/ui/in-memory-file.ts`.

## Minimum versions (first stable, no flag)

Researched against MDN browser-compat-data, caniuse, and vendor release notes.
Numbers are the first stable release where the feature is on by default.
`n/a` = never shipped.

| Web API | Chrome | Edge | Firefox | Safari (macOS) | Safari (iOS) | Android Chrome |
|---|---|---|---|---|---|---|
| WebCodecs (VideoDecoder/Encoder) | 94 | 94 | 130 | 16.4 | 16.4 | 94 (Firefox Android: n/a) |
| WebGL2 | 56 | 79 | 51 | 15 | 15 | 58 |
| File System Access pickers | 86 | 86 | n/a | n/a | n/a | 132 |
| `<input webkitdirectory>` | 30 | 79 | 50 | 11.1 | 18.4 | 132 |
| DnD folder (`webkitGetAsEntry`) | 13 | 79 | 50 | 11.1 | n/a | n/a |
| Service Workers | 40 | 17 | 44 | 11.1 | 11.3 | 40 |
| Module Workers (`{type:"module"}`) | 80 | 80 | 114 | 15 | 15 | 80 |
| MediaSource | 31 | 12 | 42 | 8 | 13 (iPad only) | 31 |
| ManagedMediaSource (iPhone MSE) | n/a | n/a | n/a | 17.0 | 17.1 | n/a |
| OffscreenCanvas (2D) | 69 | 79 | 105 | 16.4 | 16.4 | 69 |
| `structuredClone` | 98 | 98 | 94 | 15.4 | 15.4 | 98 |
| `isSecureContext` | 47 | 15 | 49 | 11.1 | 11.3 | 47 |

**Practical floor for the full app** (editor + map + viewing): roughly
**Chrome/Edge 94, Firefox 130, Safari 16.4 (iOS 16.4)**, gated by WebCodecs.
**Viewing-only** works much lower (native `<video>` + Workers + WebGL): roughly
Safari 15 / Firefox 114 / Chrome 80.

**Service Workers** in the table above gate only the offline PWA precache
(`src/sw.ts`) - export-to-disk does not depend on it (see Library floors
below).

### OS-level codecs

Codec support comes from the OS/GPU + the browser distributor, not the engine
version. The API existing does not mean a codec decodes - always probe.

- **H.264 / AVC** - treat as a baseline everywhere, with two real exceptions:
  open-source **Chromium without proprietary codecs** has no software H.264
  decoder, and **Linux Firefox** needs system codecs
  (gstreamer/ffmpeg/OpenH264). For the e2e browser, see
  [`tests/playwright.e2e.config.ts`](../tests/playwright.e2e.config.ts).
- **HEVC / H.265** - reliable on Apple platforms and macOS Chromium (OS
  software fallback) and Android with a hardware HEVC decoder. On Windows the
  two Chromium decode paths differ (per Microsoft's Edge video-playback
  troubleshooting doc and StaZhu/enable-chromium-hevc-hardware-decoding):
  **Chrome uses its own D3D11VA path - nothing to install, but hardware-only**
  (no software fallback, so a GPU/driver without HEVC decode means no HEVC at
  all); **Edge routes through Media Foundation and needs the Microsoft Store
  "HEVC Video Extensions"** (paid; the free "from Device Manufacturer" twin is
  OEM-preinstalled on many PCs and hidden from Settings > Apps -
  `Get-AppxPackage -AllUsers *HEVC*` is the reliable check). The MFT path
  software-falls-back, so Edge + the Store codec works even without HEVC
  hardware - the one Windows setup that always can. Opera's path is
  undocumented - do not promise it to users. Windows Firefox also needs the
  Store extension; Linux desktops are flaky-to-absent. This is why the
  codec-unsupported overlay and the export panel share the per-browser advice
  (`codecPlaybackAdviceHtml` in `src/ui/empty-state.ts`), we keep the MSE remux
  fallback (container-level only - there is no WASM software decoder, decode is
  always the platform's), and the `hevc` e2e test self-skips where decode is
  absent.

### Library floors

- **mediabunny** (pinned version: `package.json`) - targets "ECMAScript 2021 or
  later" (Chrome/Edge 85, FF 79, Safari 15). Container parse/demux and
  stream-copy mux do **not** need WebCodecs (they run even in Node); only
  decode/encode (re-encode export, previews) need it. So stream-copy export and
  metadata work on mobile Safari + Android Chrome where decode might not.
- **maplibre-gl** (pinned version: `package.json`) - **requires WebGL2**; the
  WebGL1 fallback is gone, so a WebGL1-only GPU gets no map at all. `new Map()`
  does not reliably throw on a context-less GPU, so we preflight the context
  ourselves in `ensureMap`. Ships ESM-only and cannot resolve its own worker
  through a bundler, so the consumer must hand it the worker URL before the
  first map is constructed.
- **native-file-system-adapter** (pinned version: `package.json`) - imported
  only for its native `showSaveFilePicker` binding and types; `nativeFsaAvailable()`
  (`src/ui/in-memory-file.ts`) gates entry, and the call to the package's
  `showSaveFilePicker` only ever fires on that already-native branch. We do
  **not** use the package's own ponyfill streaming-saver fallback: when native
  FSA is absent (Firefox, Safari, mobile Chromium) the export instead builds
  the whole MP4 in a resizable-`ArrayBuffer`-backed handle
  (`src/ui/in-memory-file.ts`) and hands the result to a Blob download - a
  streamed, write-once sink can't be re-read for the post-mux GPMF injection,
  which is a hard product requirement.

## Known limitations

- **Chromium file-handle persistence** - Chromium 153 can terminate the browser
  when in-memory IndexedDB restores a `FileSystemHandle` (the pinned
  [Chromium `CHECK`](https://github.com/chromium/chromium/blob/153.0.8010.12/content/browser/indexed_db/instance/sqlite/database_connection.cc#L2482)).
  A round-trip probe can itself crash, and storage APIs do not expose this
  backend. The temporary exception in
  [`canPersistFileHandles`](../src/persist/file-handle-support.ts) therefore
  disables remembered folders and saved notes-file connections in Chromium 153
  and unverified later versions, in all contexts; it does not detect private
  browsing. File opening, playback, export, live notes-file writes, and ordinary
  annotation and index-cache storage remain available. Existing saved connections
  stay untouched; newly selected connections last for the current tab. Before
  narrowing or removing the guard, verify an upstream fix and round-trip native
  file and directory handles through IndexedDB in regular and private contexts.
- **Pre-ES-module browsers** (no `<script type=module>`: IE11, old Edge, Chrome
  <61, Safari <11) never execute our bundle, so the in-bundle gate cannot run.
  They get the static prerendered landing + the splash watchdog and non-working
  CTAs. We deliberately do not add a `nomodule` inline fallback: it would be a
  new inline script that the CSP-hash build plugin (which hashes only
  `#dc-bootstrap`) does not cover, so it would need a build/CSP change for a
  near-zero, far-below-target-bar audience.
- **iOS `webkitdirectory`** - the attribute is *present* (so
  `'webkitdirectory' in input` returns true) on every iOS version, but the
  picker does nothing on iOS 11.3-18.3 and is a trap on 18.4+
  ([WebKit bug 271705](https://bugs.webkit.org/show_bug.cgi?id=271705)): WebKit
  copies the ENTIRE chosen folder into the browser's own temporary storage
  (`NSFileManager copyItemAtURL:`) before the page sees a single file - minutes
  to hours on a full SD card, no way for the page to filter or stream the
  selection (the `accept` filter is ignored in folder mode). Cleanup of those
  copies is registered only after ALL copies finish and runs at tab teardown
  (`_removeTemporaryDirectoriesWhenDeallocated` in WebKit's
  `WKFileUploadPanel.mm`, the copy-then-cleanup design from
  [WebKit bug 228683](https://bugs.webkit.org/show_bug.cgi?id=228683)) - so a
  process killed mid-copy strands the copies in the browser app's own
  container, where site-data clearing does not reach them; only reinstalling
  the browser does. Reading a folder in place
  is not coming: WebKit formally declined the directory part of File System
  Access ([standards-positions#28](https://github.com/WebKit/standards-positions/issues/28)).
  Feature-detection cannot see any of this. Mitigation: the iOS folder warning
  (`src/ui/ios-folder-warning-modal.ts`) shows before every folder pick and
  steers to selecting individual files - those are also copied, but only the
  selection, and a completed copy is scheduled for cleanup.
- **Firefox H.264 encode is broken in practice** -
  `VideoEncoder.isConfigSupported()` returns true for H.264 but
  `configure()`/`encode()` throw ([Bugzilla 1918769](https://bugzilla.mozilla.org/show_bug.cgi?id=1918769),
  FF 130-145). So `webCodecsEncode` being present is not enough; the export
  path probes real encodability before running - see
  `src/transcode/capabilities.ts`. Stream-copy is unaffected.
- **Firefox for Android** has no WebCodecs at all (no VideoDecoder/Encoder) - no
  editor/export/previews there regardless of version.
- **WebGL2 is also a hardware floor** - `getContext("webgl2")` can return null on
  an old/blocklisted GPU no matter how new the browser. The map degradation path
  covers this.
- **WASM + CSP** - the hosted tracker uses ONNX Runtime Web and needs
  `'wasm-unsafe-eval'` in `script-src`; JavaScript evaluation remains blocked.
  Runtime modules and weights are self-hosted. Portable omits tracking and
  that permission. Policies live in `public/_headers` and `vite-plugins/portable.ts`.

## Manual verification (not automated)

The e2e suite drives the export pipeline on a small synthetic sample under the
browser selected by [`tests/playwright.e2e.config.ts`](../tests/playwright.e2e.config.ts).
It validates *correctness* of the
in-memory (no-native-FSA) export - resizable-buffer growth, staged GPMF
injection, the Download button, byte-level container/`gpmd` markers - but it
**cannot** validate two engine- and size-dependent things. Check these by hand
before shipping a change that touches the export RAM path:

1. **Real RAM peak on live Safari/Firefox with a multi-GB clip.** The whole MP4
   is built in RAM (no streaming, no pre-cap - the cap is unmeasurable on Safari,
   so we warn instead of block). Export a ~3 GB+ clip in desktop Safari and watch
   memory: it should peak around 1x the output during mux+inject and ~2x briefly
   during download, then settle. If allocation fails it must surface the "too
   large, use desktop Chrome" message, not a silent tab crash.
2. **Safari "open in tab" vs Downloads.** The done-view Download button hands a
   `video/mp4` Blob to an `<a download>`. Confirm Safari actually files it in
   Downloads rather than opening the MP4 in a new tab (the `File{type}` carries
   the name without the `.html` artifact - verify the saved filename).
3. **iOS quota / eviction.** Mobile WebKit has tighter memory and storage limits;
   confirm a moderate clip exports without the tab being reclaimed mid-export.

The native (Chromium desktop, `showSaveFilePicker` -> disk) path streams at any
size and is not subject to these.
