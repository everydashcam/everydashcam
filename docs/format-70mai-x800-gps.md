# 70mai x800 GPS log format

Source: reverse-engineered from real `GPSData000001.txt` files off two cards (a 70mai x800 and an A810). The `$V02` log is shared across 70mai models; this doc keeps the x800 name for continuity.
Every interpretation is tagged with a confidence level.

## Where it lives

At the SD card root, next to the video folders. Hidden files:

- `GPSData{NNNNNN}.txt` - the log itself. Numbering clearly rotates (a single card can have `000001`, `000002`, ...).
- `.used.file.{MODEL}` - a service file with a cursor/counter (content: `000795` in the observed file). Ignored by the parser.

In the sample, one ~2.5 MB file with 29,351 lines covers 3 days of recording and 744 distinct MP4s. That is, **the log is shared across all videos**, not one per file. Binding to a specific MP4 goes through the filename in one of the columns.

## Structure

Text, ASCII, `\n` line endings, comma-separated fields.

The first line is a **header signature**:

```
$V02
```

Looks like NMEA-style `$XXXX`. The alphanumeric suffix is likely a format version (V02 = version 2). Behavior on a signature other than `$V02` is defined in `parseSingleLog` (`src/parsers/primitives/csv-70mai.ts`, `SUPPORTED_VERSION`).

The remaining lines are records of 13 fields each.

## Fields

| # | Name | Type/units | Confidence | Example |
|---|-----|-------------|------------------|--------|
| 0 | `unix_timestamp` | int, seconds, **8 h behind real UTC** - see below | high (sanity-checked via mtime + MP4 filename) | `1704063606` |
| 1 | `validity` | char `A` or `V` | high (NMEA convention, 99.5% of lines are `A`) | `A` |
| 2 | `lat_deg` | float, degrees (decimal) | high | `44.000000` (example anonymized to whole degrees) |
| 3 | `lon_deg` | float, degrees (decimal) | high | `78.000000` (example anonymized to whole degrees) |
| 4 | `bearing_x100` | int, degrees × 100, 0..35900 | medium (from range: max=35900) | `24000` = 240.00° |
| 5 | `speed_x100` | int, m/s × 100 (i.e. cm/s) | medium (from range: max=3194 → 31.94 m/s ≈ 115 km/h; 0 when stopped) | `333` = 3.33 m/s ≈ 12 km/h |
| 6 | `accel_x_x100` | int, g × 100 - **gravity axis on A810** | see "Accelerometer axes" | `100` = 1.00 g (A810) |
| 7 | `accel_y_x100` | int, g × 100 - **gravity axis on x800** | see "Accelerometer axes" | `101` = 1.01 g (x800) |
| 8 | `accel_z_x100` | int, g × 100 | low | `12` = 0.12 g |
| 9 | `mp4_filename` | string or `0` | high | `NO20240101-120000-000001F.MP4` |
| 10-12 | reserved | always `0` in the observed sample | assumption | `0,0,0` |

### Notes

- **Duplicate timestamps.** Up to 3 identical timestamps per second can appear, with different acceleration values. Looks like a buffered flush triggered by G-sensor changes. The parser must not deduplicate by timestamp unconditionally - the extra points can be useful for shock events. For drawing the track it's enough to take the first record of each second.

- **`filename = '0'`.** Occurs 176 times (0.6%) in the X800 sample. Means GPS is being written but no video is recording at that moment (between files, on startup, etc). The parser binds such orphan rows to the file that was recording around them - see the anchor/orphan handling in `src/parsers/primitives/csv-70mai.ts`. The Dash Cam Pro Plus A500S never fills this field: every row of every session is `0`. A wholly unnamed session keeps its UTC rows and is matched to recordings by time window inside the log's directory instead (`src/gps-time-association.ts`); such rows never calibrate the recording clock they were selected with.

- **Timezone is a firmware bug.** Field[0] is written by 70mai firmware NOT as UTC but 8 hours behind real UTC. Independent of the camera's install region, season, or DST - a constant offset. The root cause is the firmware's UTC+8 (China) default clock, not a US "PST" timezone. Without correction everything drifts 8 hours back.

  Confirmed on the DashCamTalk forum and verified on our samples:
  - https://dashcamtalk.com/forum/threads/unix-time-code-in-gps-txt-file-is-8-hours-out.51107/
  - https://dashcamtalk.com/forum/threads/date-and-time-reset.36547/
  - https://dashcamtalk.com/forum/threads/a810-clock-sync-with-gps.49529/
  - https://forum.lowyat.net/topic/5267069

  The same workaround exists in the commercial Dashcam Viewer app - a bias of 28800 seconds (8h).

  Cross-check on a sample `NO20240101-120000-000001F.MP4` (camera installed in a UTC+5 region; the stamp is anonymized, the arithmetic is the real cross-check):
  - filename as local time → 12:00:00 → real UTC = 07:00:00
  - file mtime after closing → 07:00:16 UTC ≈ real UTC ✓
  - `unix_timestamp` field[0] = `1704063606` = **2023-12-31 23:00:06 UTC** (8h below real UTC)
  - after adding 28800 sec → 07:00:06 UTC ✓

  The MP4 filename (`NO{YYYYMMDD}-{hhmmss}-...`) is the camera's local time from its RTC.

  In code the offset is applied in `parseRow` (`src/parsers/primitives/csv-70mai.ts`, constant `GPS_TIMESTAMP_FIRMWARE_OFFSET_SEC`). After that, `GpsRecord.unixSeconds` is honest UTC, and the rest of the code never sees the bug.

- **Accelerometer axes are model-dependent.** The gravity-bearing (vertical) axis - the one clustering near 1.00 g at rest - is `accel_y` (field 7) on the x800 but `accel_x` (field 6) on the A810 (both confirmed on real cards). A hard-coded axis is therefore wrong on the other model. The parser does not assume one: it subtracts the per-axis mean over the whole log (a DC block) so gravity leaves whichever axis holds it - see `csv-70mai.ts`. Which of the two horizontal axes is longitudinal vs lateral is still unconfirmed (needs a drive with a known maneuver).

- **Coordinate precision.** 6 decimal digits = ~11 cm at this latitude. That's the field's technical precision; actual GPS accuracy is much worse, typically meters.

## How the app consumes this format

The live implementation is `src/parsers/primitives/csv-70mai.ts` (parsing,
version check, the +8h fix, orphan-row binding) plus the sidecar registration
in `src/parsers/registry.ts` (matching records to MP4s by `mp4_filename`).
This doc records the byte-level findings; the code is the source of truth for
the consumption flow.

## Observed quirks of the 70mai x800

- **MP4 metadata is empty**: `mvhd.creation_time = 0`, all `*CreateDate/ModifyDate` fields are zero. The recording date is not stored inside the container.
- **Filesystem mtime is correct real UTC.** In both observed samples, mtime ≈ the file's real-UTC close time (to within seconds). The 8-hour offset is on the GPS timestamp, not on mtime (see the firmware bug in "Timezone" above). Still, mtime is mutable FS metadata (touch / cp / trimming in an editor all overwrite it), so relying on it as the primary source is unreliable.
- **GPS log as a time source** - the densest one (record per second), but needs the +8h fix due to the firmware bug. Once fixed in the parser, it's a reliable absolute UTC source.
- **Filename** (`NO20240101-120000`) - the camera's local time from its RTC, with no TZ indicator. Durable (the camera stamps it on close-out, users rarely rename it). If the log has filename-to-GPS-timestamp bindings, the camera's TZ offset can be derived (see `estimateTzByFingerprint` in `src/trips.ts`) - after the GPS fix it should match the actual install TZ.

## What this document does NOT cover - open questions

- What `$V01` means (if such a version exists). The field set may differ.
- Which of the two horizontal G-sensor axes is longitudinal vs lateral (the vertical/gravity axis is model-dependent - see "Accelerometer axes").
- Behavior when the fix is lost (`V`): whether old coordinates are kept or zeros are written. The sample has 149 lines with `V` - needs a separate look.
- Whether records with a different field count exist (e.g. extensions for other models).
- What the `.used.file.{MODEL}` file stores besides the counter.
- Whether the +8h GPS-timestamp bias appears on other 70mai models/firmware.
