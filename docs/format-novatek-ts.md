# Novatek GPS in MPEG-TS private PES ("novatek-ts")

Novatek freeGPS record geometry carried in MPEG-TS private PES instead of MP4.
Verified models are listed in [GPS format coverage](gps-format-coverage.md).

Parser: `src/parsers/primitives/novatek-ts.ts` +
`src/parsers/internal/novatek-ts-extract.ts`.

## Container layout

- MPEG-TS, 188-byte packets. PMT advertises video (AVC/HEVC) and audio (AAC).
- **The GPS PES is NOT in the PMT.** It rides an unadvertised PID (0x300 on
  the verified recordings; `ffprobe` shows it as a codec-less "unknown" stream). PSI
  parsing therefore cannot find it - both the marker and the extractor detect
  the stream by content and auto-lock the PID, so a firmware with a different
  PMT/PID layout parses without code changes.
- GPS PES: stream_id `0xbf` (private_stream_2 - fixed 6-byte PES header, **no
  PTS**), `PES_packet_length` = 1008. The 1014 PES bytes span 6 TS packets:
  1 PUSI + 5 continuations, the last one padded with adaptation-field
  stuffing.
- Cadence: one PES per second, one record per PES; clock deltas preserve gaps.
- Before the optional receiver gets its first fix, some firmware writes
  `V00\0`, zero coordinates/speed/course, and an unset or invalid clock. These
  rows still lock the GPS PID and preserve the delay before the first fixed
  point; they do not emit positions.
- Bytes `[44..1008)` of the PES body are zero padding on the A119 V3 samples.
  EG-1 has three varying float32 values at `[44..56)` and zeros after them;
  the extra fields' sensor axes and scale are unverified and are not decoded.
  The GPS record fits in the PUSI packet on both variants.

## The B4K prefix dialect (foreign source, no sample)

Blueskysea B4K (Novatek NT96670) writes the SAME record behind a **fixed
164-byte prefix** - ExifTool matches the PES body with
`^(.{164})?(.{24})A[NS][EW]` (M2TS.pm:353-375, v13.55), where the optional
group is that prefix and the A119 V3 above is the case where it is absent. Two
consequences worth knowing before touching this code:

- 164 + 44 overruns what a PES-start packet has left, so this dialect - and
  only this one - forces the extractor to reassemble the PES across TS
  packets. A single-packet probe is *permanently* blind to it.
- The prefix is fixed-size, so there is nothing to hunt for. Do not "scan for
  the `A[NS][EW]` anchor and rebase" (the nvtk_mp42gpx recipe): a fixed offset
  cannot land on a false anchor inside video bytes. Reassembly is gated on a
  cheap pre-filter over the record's hour/minute/second u32 triple, which sits
  far enough ahead of the anchor to often be readable in the PES-start packet -
  but only by 2 bytes on a bare PES header, so an adaptation field or an
  extended header pushes it out of reach. The pre-filter is an optimization,
  never a gate: an unreadable triple must fall through to reassembly, or the
  whole dialect goes silently undetectable on any mux that stuffs the packet.

`RX_NOVATEK_VIOFO` stays `.mp4`-only. Viofo in TS mode writes the 14-digit
`<timestamp>_<counter>.TS` shape, which already has its own
filename techniques - extending the Viofo regex to `.ts` would claim names no
observed camera writes.

## Record struct

PES body offset 0, all fields little-endian. Identical to the freeGPS Type-3
record geometry (`src/parsers/internal/freegps.ts`) rebased to 0:

| Offset | Type | Field | Notes |
|---|---|---|---|
| 0 | u32 | hour | camera-LOCAL clock, see below |
| 4 | u32 | minute | |
| 8 | u32 | second | |
| 12 | u32 | year | 2-digit (21 = 2021) or full year (2026) |
| 16 | u32 | month | 1..12 |
| 20 | u32 | day | 1..31 |
| 24 | char | fix | `'A'` valid / `'V'` void (skipped) |
| 25 | char | lat hemisphere | `'N'`/`'S'` |
| 26 | char | lon hemisphere | `'E'`/`'W'` |
| 27 | u8 | pad | always 0 |
| 28 | f32 | latitude | `DDmm.mmmm` (NMEA degrees*100+minutes) |
| 32 | f32 | longitude | `DDDmm.mmmm` |
| 36 | f32 | speed | **knots** on A119 V3 / Avylet A1; **km/h** on COMTEC EG-1; no unit flag, see quantization below |
| 40 | f32 | course | degrees |

The datetime field order (H M S Y Mo D) and the `'A' N/S E/W \0 lat lon speed
course` tail are exactly freeGPS `LAYOUT_DEFAULT`/`LEGACY`/`ALT` geometry -
only the `freeGPS ` magic and the vendor preamble are absent. Decoding reuses
the shared helpers (`utcSecondsFromYmdhms`, `ddmmToDegrees`, `KNOTS_TO_MS`),
so calendar gates and unit conversions cannot drift from the MP4 freeGPS path.

## Speed units

The speed field has no unit flag. EG-1 values retain the conversion step
`0.01 × 1.852 = 0.01852`; VIOFO and Avylet store decimal knots. `resolveSpeedUnit`
recognizes the converted grid with float32 tolerance and requires distinct
values outside the knots grid. Coordinates, movement and zero values are not
needed. Filenames and the sensor tail do not identify the unit.

Mixed encodings or insufficient distinct evidence retain knots. Values shared
by both grids cannot distinguish units; all-zero recordings remain zero.

## Clock is camera-local, not UTC

The struct time equals the filename's local time rather than the satellite
clock. The extractor flags every record `timeUnsynced`, mirroring the Kenwood
local-clock quarantine in `freegps.ts`: the time layer re-anchors the records
onto the video window instead of poisoning per-fingerprint TZ estimation with
local-as-UTC stamps. Leading no-fix rows preserve the receiver warm-up delay at
the format's one-record-per-second cadence, while clock deltas preserve later
gaps. Private_stream_2 has no PTS, so a delay before the first PES is not
recoverable.

## Marker

Gate order, the probe input and the fallback's cheap "starts like MPEG-TS"
test live in `novatekTsPrimitive.marker` (`src/parsers/primitives/novatek-ts.ts`);
the record signature itself is `isNovatekTsRecordAt` in
`novatek-ts-extract.ts`. What the code does not say: the GPS PES is claimed by
content, not by PSI, so renamed files still parse - and the first GPS PES sits
~1 s of video into the stream (3-4 MB at the observed bitrate), so a
higher-bitrate firmware can push it past the probe window. That single case is
the only reason the filename fallback exists; `parse()` self-rejects with
`WrongFormatError` when it fires on a foreign TS.

Disjoint from the other TS formats by construction: juscar-ts requires the
`LIGOGPSINFO` literal (absent here), and this marker requires the binary
record signature (absent in Juscar's ASCII payload and in the GPS-less generic
HEVC sticks). Negative tests pin both directions.

## Fixture provenance

- `src/parsers/__fixtures__/novatek-ts/synthetic-*.TS` - built by
  `build-synthetic.mjs` in the same folder (packet-level TS writer mirroring
  the real 6-packet PES split; PMT deliberately omits the GPS PID, like the
  real camera).
- `real-anonymized.TS` and `real-no-fix-anonymized.TS` are produced by
  `scripts/anonymize-novatek-ts.mjs` over real samples. GPS PES packet groups
  stay byte-exact (PES header, continuation split and AF stuffing are the
  container quirks the fixtures preserve) with fixed coordinates patched to a
  moving sentinel, interleaved into a freshly generated HEVC+AAC base. The
  second fixture keeps the transition from no-fix rows to fixed rows. Record
  count, sentinel coordinates and the base-clip recipe are the script's own
  parameters. Timestamps and speed/course are original; no original video/audio
  bytes reach either fixture.
- `real-kmh-anonymized.TS` covers the EG-1 km/h variant, including a stopped
  interval. The same anonymizer preserves raw speeds and replaces coordinates,
  video and audio; speed recognition is independent of the synthetic route.
  Its `h264` option keeps browser speed checks independent of OS-specific HEVC
  decoding; the other fixtures retain HEVC coverage.
