# SStar ssmd GPS formats

GPS embedded as a dedicated `ssmd` meta track of constant samples at ~1 Hz,
written by the SigmaStar ("SStar") firmware family. Supported dialects and
their byte layouts: `src/parsers/internal/sstar-ssmd-extract.ts`.

Neoline files use handler names `SStar Video` / `SStar Audio` / `SStarMeta`
and filenames `INF<YYYYMMDD>-<hhmmss>-<seq>-<F|R>.mp4`. iZEEKER files use
`REC<YYYYMMDD>-<hhmmss>-<seq>.mp4` in per-channel `A` / `B` folders.

The 40-byte layout was reverse-engineered and validated against 3 real
mirror-cam clips (528 GPS samples) plus one 4K-cam day-drive clip (301
samples). The KTRX transform was independently recovered from one 180-row
real clip and checked against 18 burned-in OSD coordinate/speed observations.
That clip covers all 60 latitude-factor indices and four longitude-factor
indices; using the same table for the remaining longitude minute values is
an inference. Median haversine-vs-recorded speed error was 1.1 km/h (95th
percentile 3.9 km/h). Extractor:
`src/parsers/internal/sstar-ssmd-extract.ts` (constants live there, not here).

## Container shape

Each Neoline MP4 carries THREE `ssmd` meta tracks (all handler `meta`, sample
format `ssmd`):

1. **JPEG thumbnail** - a single sample, starts `ff d8 ff e0 ... JFIF`.
2. **GPS** - constant 40-byte samples, ~1 Hz (media timescale 90000, stts
   deltas jitter around 90000). This is the parsed track.
3. **Telemetry** - constant 12-byte samples at ~15 Hz: three little-endian
   u32-sized fields, ranges consistent with an accelerometer/G-sensor but
   the axis convention, scale and zero offset could not be verified against
   ground truth. **Unparsed** - do not decode without a calibration capture
   (a clip with known maneuvers).

The `ssmd` sample-description name is multi-vendor (LigoGPS 64..1024-byte
chunks, Chigee JPEG previews, Rove 32-byte GPS + 12-byte accel). The
constant-size gate plus a first-sample dialect probe keep this extractor
disjoint from all of them. The iZEEKER file carries one constant-56 `ssmd`
meta track; its `KTRX` tag is required. See the marker in
`src/parsers/primitives/sstar-ssmd.ts`.

## GPS sample layout (40 bytes, little-endian)

| Offset | Type | Meaning | Verification |
|---|---|---|---|
| 0 | f64 | latitude, decimal degrees (NOT NMEA DDmm) | high: matches the known recording region; consecutive-fix haversine agrees with the speed field |
| 8 | f64 | longitude, same convention | high (same checks) |
| 16 | i32 | altitude-like: smooth small values on good-signal rows, drifts wildly (even negative) on poor-signal rows; -1 on no-fix | low: meters is the best fit; ruled out course and speed. Not extracted (GpsRecord has no altitude) |
| 20 | u16 | speed, km/h integer; 0xFFFF on no-fix | high: mean error 4.4 km/h vs haversine over 179 adjacent-fix pairs on the good-signal clip (raw/10 and knots candidates were off by 80+ km/h) |
| 22 | u16 | flags: a constant per-camera base + the 0x0100 fix bit. Observed bases: 0x047E (mirror cam), 0x067E (4K front cam); the 0x0200 delta is undeciphered and never varied within a clip | high: agreement between the fix bit and the coordinate sentinel was exact across all samples of both cameras |
| 24 | u8 x4 | day-of-month, hour, minute, second - **no year/month anywhere in the record** | high: 1 s steps between adjacent fixes; hour matches the filename clock (see the UTC-vs-RTC quirk) |
| 28 | u8 | course over ground / 2 (2-degree units, 0..179); 0 also appears on clearly-moving rows = "not updated" (the extractor forward-fills it from the previous record) | high: mean circular error 1.8 deg vs movement bearing over 142 clean moving pairs |
| 29 | u8 x3 | constant `01 01 00` on fix rows; on no-fix rows bytes 28..31 are `ff 00 ff ff` | observed constant, not decoded |
| 32 | u32 | 0 before the first fix after boot, 1 from the first-fix sample onward | verified exactly (flip index == first-fix index); not decoded |
| 36 | u32 | always 0 | observed constant |

No-fix rows write the LE double 4294967295.0 (`00 00 e0 ff ff ff ef 41`)
into BOTH coordinate slots - the same sentinel value the Rove 32-byte ssmd
dialect uses for latitude only. No-fix rows are skipped silently by the
extractor (routine satellite acquisition).

Hemisphere: no N/S/E/W field in the 40 bytes; signed doubles assumed (all
real samples are N/E) - same caveat as rove-ssmd/navitel-gps0.

## KTRX GPS sample layout (56 bytes, little-endian)

The iZEEKER layout reuses bytes 16..31 of the 40-byte family for the
altitude-like value, speed, flags, day/time, course and `01 01 00` tail. Its
coordinate slots and appended 24 bytes differ:

| Offset | Type | Meaning | Verification |
|---|---|---|---|
| 0 | f64 | encoded latitude: `lat * factor[second] / 10 + 114.712` | high: 18 independent OSD checkpoints and movement/speed cross-check |
| 8 | f64 | encoded longitude: `lon * factor[minute] / 10 + 224.222` | high for the four minute indices in the real clip; remaining indices inferred from the shared table |
| 16 | i32 | altitude-like value | not extracted |
| 20 | u16 | speed in integer km/h | high: matches OSD and trajectory |
| 22 | u16 | `0x087E` on every observed row | observed constant; no no-fix row available |
| 24 | u8 x4 | day-of-month, hour, minute, second | high: 1 Hz clock; UTC but stale in the sample |
| 28 | u8 | course / 2 | high: movement-bearing check |
| 29 | u8 x3 | `01 01 00` | observed constant |
| 32 | ASCII[16] | uppercase-hex stable identifier, likely device or session scoped | observed; always scrubbed from public fixtures |
| 48 | ASCII[4] | literal `KTRX` | strong dialect marker |
| 52 | ASCII[4] | `HHMM`, exactly repeating bytes 25..26 | exact across all 180 rows; part of the marker |

The 60-entry factor table is `SSTAR_KTRX_FACTORS` in
`src/parsers/internal/sstar-ssmd-extract.ts`; keeping the values beside the
decoder avoids a second source of truth. Direct Big-Endian (`>dd`) decoding
does not produce plausible coordinates for this sample.

## DDmm coordinate dialect

The iBOX RoadScan 2K carries DDmm coordinates with the SStar day/time and
course conventions. It cannot use the equally sized Rove decoder: Rove
interprets the flags as a year/month and the speed as knots. Compare
[ExifTool's RoveGPS decoder](https://github.com/exiftool/exiftool/blob/master/lib/Image/ExifTool/QuickTimeStream.pl).
The size-specific flags gate and shared DDmm conversion live beside
`SSTAR_DDMM_FLAGS_FIX` and `decodeSstarSsmdRow`.

The dual-camera RoadScan carries camera identity only in its `F`/`R`
folders. Preserve that hierarchy when importing; a flat file drop cannot
recover the camera from the name. Counters advance independently per camera,
so pair by recording time, not basename or counter equality. Event clips
replace normal loop segments within the same run. Filename/path
classification lives in `src/parsers/filename/`.

Validation against the real clip's 60 fixes gives a mean speed error of
0.72 km/h against successive positions; interpreting the speed as knots
raises it to 33.10 km/h. The doubled course byte agrees with movement
bearing to about 1.7 degrees on moving pairs. The GPS clock advances once
per second and agrees with the filename's local clock at UTC+3 within a
second. The shared REC date anchor therefore applies.

The samples establish active fixes in the northern/eastern hemispheres and
dual-coordinate no-fix sentinels. On loss of fix, the DDmm clock switches to
the local RTC; omit those rows from the UTC track. Signed DDmm for
southern/western positions remains defensive, without real sample validation;
unknown flags remain rejected. The sibling `SS GSNR` track contains integer
triples, but their units and mounting axes are unverified. Do not decode it
without a calibration capture.

## The UTC-vs-RTC clock quirk

The day/hour/minute/second quartet changes meaning with the fix bit:

- **Fix rows**: the GPS clock in **UTC** (verified on all mirror-cam clips:
  fix-row hours run exactly the camera's TZ offset behind the filename clock).
- **No-fix rows**: the camera RTC in **local time** (verified on the
  mirror-cam clips and the 4K-cam clip: no-fix-row hours match the filename
  clock exactly, confirming the fix/no-fix split holds across both cameras).

The extractor therefore only ever reads time from fix rows.
The iZEEKER sample also carries a UTC-like fix clock, but it ran 51 seconds
ahead of the filename/OSD clock. The stale-clock gate therefore keeps its
positions and media offsets while withholding absolute GPS timestamps.

## Year/month derivation

Records carry no year/month, so the extractor anchors the record's
day-of-month + time-of-day to the calendar date found in the filename
(`INF<YYYYMMDD>-...` or `REC<YYYYMMDD>-...`, camera-local; each strict name
shape is preferred over a generic YYYYMMDD scan so a renamed file with a
foreign date run cannot poison the anchor). A clip is minutes long and |TZ| <= 14 h,
so the true UTC date is within one day of the anchor - that invariant is what
makes the day-of-month match unambiguous. The matching itself (and its
rollover handling) lives in `utcMsFromAnchoredDayTime`,
`src/parsers/internal/sstar-ssmd-extract.ts`. An anchor that no fix row matches is
treated as untrusted (foreign date run) rather than dropping the records.
Fallback chain and the no-anchor path (timeUnsynced + media-time pacing):
`extractFromSstarSsmdTrack` in `src/parsers/internal/sstar-ssmd-extract.ts`.
The real firmware writes mvhd creation_time = 0, so the mvhd fallback is
untested in the wild.

## Cold-start caveat

The firmware can flag rows as "fix" while the GPS clock is not yet synced:
on the cold-start clip the first fixes ran ~90-105 s ahead, then jumped
backward once the clock locked, and the pre-sync positions were off by tens
of km. Another real clip carried fixes ~104 s BEHIND real time with correct
positions/speeds and no resync inside the clip at all. No in-record field
distinguishes such rows (the +32 flag flips at the first fix, i.e. before
the clock locks). Two defenses, both in `extractFromSstarSsmdTrack`
(`src/parsers/internal/sstar-ssmd-extract.ts`):

- A synced GPS clock advances WITH media time, so any clock step deviating
  from the elapsed media time beyond jitter is the sync moment (backward =
  clock ran ahead, forward excess = clock ran behind); fixes before the last
  such step are dropped into the skipped diagnostics.
- A whole-file stale clock (never resyncs) is invisible to the scan above, so
  the clip-start UTC implied by the last fix is cross-checked against the
  filename time: the difference must sit on the 15-min TZ grid within an RTC
  drift tolerance. Off-grid demotes every fix to timeUnsynced (positions and
  media offsets kept, absolute times and videoStartUtcHint dropped) - the
  time layer re-anchors the file via the filename/run-offset machinery.

## Phantom-track caveat

Under weak signal (urban canyon, night parking between high-rises) the
receiver emits fully-flagged fixes carrying a self-consistent FICTIONAL
trajectory: a parked car (verified frame-by-frame against the video) gets a
smooth 113-137 km/h track with a slowly rotating course, positions gliding
~35 m/s in agreement with the speed field, and a CORRECT GPS clock. The
firmware knows - its OSD hides the speed readout on such stretches while
still printing the (equally fictional) coordinates - but the ssmd rows are
bit-for-bit indistinguishable from good fixes, and the fabricated track is
internally consistent, so no per-row filter can catch it.

Defense is a whole-file quality gate in `extractFromSstarSsmdTrack`
(`PHANTOM_*` constants and the threshold rationale live there): a high
no-fix share plus a high share of adjacent-fix pairs whose haversine-implied
speed contradicts the recorded speed field condemns every fix in the file.
Positions and speeds are dropped; the frame-0 clock hint survives (the clock
is the one honest field - the stale-clock gate owns clock trust). The
registry treats "zero records + hint" as a positive claim, so the file does
not fall through to other extractors and the skip diagnostics survive.
Known cost: a weak-signal clip whose sparse fixes are genuine is condemned
with the same verdict. Known limitation: a phantom under a clean sky (no
no-fix rows) would pass.

## Fixtures

- Synthetic: `src/parsers/__fixtures__/sstar-ssmd/` (builder:
  `build-synthetic.mjs` next to them).
- Real-anonymized: `tests/testdata/sstar-ssmd-real-anonymized/` (builder:
  `scripts/anonymize-sstar-ssmd-mp4.mjs`).
