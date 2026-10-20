# Enciphered LigoGPS PES on MPEG-TS, with a TXT twin

One real recording verifies this dialect: an unidentified camera writing 4K
HEVC + 16 kHz AAC `.TS` clips named `YYYY_MM_DD_HHMMSS_00.TS`, each with a
same-name `.TXT` log.

The cipher and unfuzz formulas follow ExifTool's
[LigoGPS.pm](https://github.com/exiftool/exiftool/blob/master/lib/Image/ExifTool/LigoGPS.pm);
its MP4-specific scale selection lives in
[QuickTimeStream.pl](https://github.com/exiftool/exiftool/blob/master/lib/Image/ExifTool/QuickTimeStream.pl).
The scale and field meanings for this TS dialect are verified against the
recording's TXT twin below.

## Container

The PMT lists four streams: HEVC, AAC, the GPS PID with stream_type `0x82`,
and a JPEG thumbnail PID with stream_type `0x80`. ATSC assigns `0x82` to
DTS, and mediabunny follows that: it fails the whole Input when the PID's
first PES carries no DTS sync word. The AV read path therefore rewrites
DTS-typed PMT entries to private data only when the PID's first PES opens
with `LIGOGPSINFO` (`demuxView` in `src/blob-source.ts`,
`src/ts-program-map.ts`). Actual DTS audio remains available for playback
and stream-copy export.

## GPS PES

One PES per second, one TS packet each. The body is the `LIGOGPSINFO`
literal, nine header bytes (`00 00 00 00 05 01 00 00 00` on every record of
the sample), then a `####` chunk that deciphers with the ExifTool
`DecryptLigoGPS` algorithm into:

```
<u32 LE counter>YYYY/MM/DD hh:mm:ss N:<lat> E:<lon> <speed> km/h <course> <altitude> <sats> x:<x> y:<y> z:<z>
```

- The coordinates are fuzzed. ExifTool's `UnfuzzLigoGPS` with scale entry 3
  (1.15368) puts all 180 records of the sample within 12 m of the TXT twin;
  the unscaled default misses by 104 km, entries 1 and 2 by 252 and 205 km.
  ExifTool selects entry 3 only from an MP4-specific header pattern
  (`QuickTimeStream.pl`) and otherwise unfuzzes unscaled, so its result
  cannot be followed here.
- Speed is km/h without the ExifTool fuzzed-speed factor; it equals the TXT
  value and the trajectory.
- The untagged token after `km/h` is the course (median 0.6 degrees from the
  trajectory bearing). Altitude and satellite count have no record field.
- The time is the camera's local clock, parsed as UTC like the other LigoGPS
  carriers.

`src/parsers/internal/ligogps-ts-pes.ts` claims the PES only when the PMT
types the PID `0x82` and the first PES carries exactly this header. A wrong
fuzz scale produces a plausible track far from the route, so a different
header stays unclaimed until a sample settles it.

## TXT twin

The `.TXT` holds the same records one per line, without the counter and
without fuzzing. It is read first (`src/parsers/sidecars/ligogps-txt.ts`); the
embedded PES is the fallback for clips copied without their log.

## Accelerometer

The `x/y/z` triple includes gravity in an undocumented unit (about 4.7 at
rest). Both carriers divide by the clip's median magnitude and remove the
per-axis mean (`removeGravityBaselineInUnknownUnits`). On the sample the
resulting peaks match the deceleration of the speed track (p95 0.14 g against
0.16 g).

## Fixtures

`scripts/anonymize-ligogps-ts-pes.mjs` keeps the camera's PMT packet and
re-enciphers six PES with whole-degree coordinates over regenerated video;
`scripts/anonymize-ligogps-txt-log.mjs` zeroes coordinate fractions and
altitude in the log. Both keep the camera's timestamps, speed, course and
accelerometer values, so the fixtures cross-check each other. Both reject
unrecognized record fields rather than copying potentially private content.
