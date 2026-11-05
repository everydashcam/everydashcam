# openpilot route files

comma.ai devices running openpilot record every drive as a route of one-minute
segments. Verified on a comma four running stock openpilot 0.11.2: two segments
downloaded from comma connect, with every camera stream and both logs. The
layouts below come from those files and openpilot's own sources:
[`openpilot/system/loggerd/`](https://github.com/commaai/openpilot/tree/4c7439c59809106aaa4919083173bff50d0b9da2/openpilot/system/loggerd)
and [`openpilot/cereal/log.capnp`](https://github.com/commaai/openpilot/blob/4c7439c59809106aaa4919083173bff50d0b9da2/openpilot/cereal/log.capnp)
at commit `4c7439c` (2026-11-04).

Parser: `src/parsers/primitives/openpilot-log.ts` (qlog), decoders
`src/parsers/internal/openpilot-log.ts` and `src/parsers/internal/capnp.ts`,
raw video: `src/raw-hevc-view.ts`. Anonymizer:
`scripts/anonymize-openpilot-segment.mjs`.

## Files and layouts

A route is named `%08x--<10 hex>`: a boot counter and a random id. It has no
date, because the device has no trustworthy clock when it starts recording.
Each segment `--<n>` holds a fixed set of files:

| File | Content |
| --- | --- |
| `fcamera.hevc` | road camera, raw Annex-B H.265, 1344x768 coded (760 displayed), 20 fps |
| `ecamera.hevc` | wide road camera, same encoding |
| `dcamera.hevc` | driver camera, same encoding |
| `qcamera.ts` | low-resolution road preview, H.264 in MPEG-TS |
| `qlog.zst` | decimated log: zstd-compressed Cap'n Proto `Event` messages |
| `rlog.zst` | full log, same encoding, about 20 times larger |

Two layouts reach the viewer:

- comma connect download, flat:
  `<16-hex dongle id>_<route>--<n>--<file>`. Browsers append ` (N)` before
  the extension to repeated downloads.
- device or SSH copy: `<route>--<n>/<file>`, one folder per segment.

Older routes named by date and logs compressed with bzip2 are not recognized.

## Channels and recordings

`fcamera` is the front channel and `dcamera` the interior one. `ecamera` takes
the spare `side` slot with a positional label, because it films the road, not a
side. `qcamera` shows the road camera's view, so it is front as well. When one
drop holds both road views of a segment, only one is loaded: the full-res
`fcamera` if the browser's MSE accepts HEVC, otherwise the H.264 preview, which
plays everywhere. comma connect uploads the preview by default and the
full-resolution files only on request. A browser's repeated download
(`name (1).ts`) of a file already in the drop is folded into it as a copy when
the bytes match. A preview loaded in a separate drop is not deduplicated
against a later `fcamera`, and a damaged `fcamera` is not replaced by its
preview.

Every file of a segment shares one recording key and sequence number (the
segment). One camera key covers all routes in a folder; the dongle id is left
out because it would travel into logs and reports.

A qlog binds only to videos of its own segment. In the device layout every
segment folder holds the same file names, so a log whose segment's videos are
missing must not fall back to a sibling folder's `fcamera.hevc`. GPS the log
names after `fcamera.hevc` goes to the segment's preview when only the preview
is loaded; frame counts and start times stay with the stream they describe,
whatever its letter case or download suffix.

## Timing from the qlog

Neither video format carries a wall clock: raw HEVC has no container, and the
preview's MPEG-TS timestamps start at an arbitrary value. The qlog dates both.
For every camera it holds an encode index entry per frame, with the frame's
start-of-frame time on the device's boot clock. GPS fixes pair that boot clock
(`Event.logMonoTime`, publish time) with UTC (`unixTimestampMillis`).

- Boot-to-UTC offset: median of `unixTimestampMillis * 1e6 - logMonoTime` over
  fixes with `hasFix` and a date after 2020. A fix is published tens of
  milliseconds after it is taken, so the result runs early by that latency.
- Without a fix, the `clocks` events' system time stands in if it is after 2020.
  On the sample it agrees with the GPS offset within 10 ms.
- Frame 0 of each camera: start-of-frame time of the entry with
  `segmentId == 0`, plus the offset. On the sample, consecutive segments start
  60.001 s apart.
- Duration of each raw HEVC stream: distinct `segmentId` values / 20. The
  preview keeps its own timestamps, so a truncated download keeps the duration
  its bytes support.
- A log cut short is read up to the cut. loggerd streams one zstd frame and
  closes it only on exit, so a crash, a power loss or an interrupted download
  leaves it without its last blocks. The GPS and frame-0 times before the cut
  stay; raw streams keep the nominal 60 s, since their frame counts stop early.
  Decompression stops at 64 MiB (a real qlog is about 2.5 MB).

GPS records come from `gpsLocation` (1 Hz in the qlog) and
`gpsLocationExternal` (decimated to 1 Hz) and belong to the segment's front
video. Only the qlog is read: the rlog holds the same events undecimated, and
reading both would double the track. Timing is recomputed from the logs on
every ingest and never stored in the index cache.

## Cap'n Proto layout

Messages use the unpacked stream framing: a segment table (`u32` count - 1,
`u32` words per segment, padded to 8 bytes) followed by the segments, with the
next message directly after. Offsets below are byte offsets in each struct's
data section, derived from the schema's field order and checked against the
sample: frame-index counts match the service rates (1200 entries per camera
per minute, 1 Hz GPS), and the index sums to each video's size minus its
leading parameter sets. Cap'n Proto only appends fields, so the offsets hold
for every schema revision that has them.

`Event`: `logMonoTime` `u64` at 0; the union discriminant `u16` at 8; every
union member is a pointer in slot 0. The discriminant is the member's rank in
the union, which holds every ordinal from `@1` except `@67`
(`Event.valid`): ordinal - 1 below `@67`, ordinal - 2 above.

| Member | Ordinal | Discriminant |
| --- | --- | --- |
| `narrowRoadEncodeIdx` (fcamera) | `@15` | 14 |
| `gpsLocation` | `@21` | 20 |
| `clocks` | `@35` | 34 |
| `gpsLocationExternal` | `@48` | 47 |
| `cabinEncodeIdx` (dcamera) | `@76` | 74 |
| `wideRoadEncodeIdx` (ecamera) | `@77` | 75 |
| `qNarrowRoadEncodeIdx` (qcamera) | `@90` | 88 |

`GpsLocationData`: `speed` `f32` at 4, `latitude`/`longitude`/`altitude` `f64`
at 8/16/24, `bearingDeg` `f32` at 32, `horizontalAccuracy` `f32` at 36,
`unixTimestampMillis` `i64` at 40, `hasFix` at bit 480.

`EncodeIndex`: `segmentNum` `i32` at 12, `segmentId` `u32` at 16,
`timestampSof` `u64` at 24.

`Clocks`: `wallTimeNanos` `u64` at 24.

## Raw HEVC playback

The road and driver streams are bare H.265 without B-frames
(`EncoderSettings` in `loggerd.h`). On the comma four sample each file starts
with one VPS/SPS/PPS set, followed by an IDR picture every 20 frames and two
slices per picture; wider cameras use a 30-frame GOP.
Neither `<video>` nor mediabunny opens such a stream. Rewriting it into an MP4
would copy the recording, so the first demux of a file builds a Blob that is an
MP4 whose samples reference the original bytes: a small `ftyp`+`moov` from one
scan of the stream, then for each NAL unit a four-byte length followed by a
`file.slice()` of that unit. Only the NAL index and the `moov` (tens of KB per
minute) stay in memory. Ingest reads only the first 256 KiB for the codec and
frame size; the duration comes from the qlog, or 60 s when the log is absent.
Playback always goes through the MSE path. Building the view reads the whole
file once per worker, about 37 MB per camera-minute, so the player's and frame
strip's open timeouts grow with the file size at a slow-source read rate
(`demuxPreparationBudgetMs`).

Parameter sets that repeat inside a stream switch the sample entry from `hvc1`
to `hev1`; openpilot does not write them, but other encoders do.

## Anonymized fixtures

`src/parsers/__fixtures__/openpilot/` keeps the encode-index events of each
segment's first three seconds and the GPS and clock events of its first ten,
byte for byte, with coordinates rounded to whole degrees and altitude zeroed.
The result is compressed as one streamed zstd frame without a content size, as
loggerd writes it. `initData`, which carries the
dongle id, device parameters and git remotes, and every other event are
dropped. Videos are ffmpeg test patterns, one per camera, encoded like
openpilot's streams with the frame count the log indexes.
