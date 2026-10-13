# 360GPSINFO whole-session JSONL format

GPS is stored in one preallocated text log for a continuous recording session,
not inside each video. Verified on a Botslab G300H Pro card using G300HPro
firmware. The public product documentation confirms built-in GPS but does not
document the on-card format; the layout below comes from the real recording.

Parser: `src/parsers/primitives/360gps-jsonl.ts`. Anonymizer:
`scripts/anonymize-360gps-jsonl-log.mjs`.

## Card layout and binding

Normal video lives under `360CARDVR/REC/` and the log under
`360CARDVR/GPS/`:

```text
<YYYYMMDDhhmmss>_<sequence>A<channel><mode>.MP4
<YYYYMMDDhhmmss>_<sequence>GPS.TXT
```

The log name identifies the session's first clip, but its first GPS row may
arrive only after a satellite fix and can therefore belong to a later clip.
The stream then continues across every loop-recording file in the session.
The parser receives the video-name snapshot discovered during ingest, orders
those local filename clocks, and assigns each row to the containing clip. If
only part of a session is selected, rows outside the selected clip windows stay
unbound instead of extending the final selected clip.

When both channel suffixes share one recording start, channel `A` is the
canonical GPS owner. The trip-level record merge removes cross-channel
duplication, and filename clocks keep the sibling channel aligned.

## File envelope

The observed file is exactly 2 MiB:

- JSON objects separated by LF begin at byte zero.
- The meaningful stream ends at the first NUL byte; the remaining area is
  zero-filled.
- A 64-byte footer begins with ASCII `360GPSINFO`.
- A little-endian u32 at footer offset 16 equals the used JSONL byte length.

Parsing stops at the first NUL. The footer corroborates the preallocation
layout but is not required, so a copied or trimmed text log remains readable.

## JSON row

```json
{"a": 51.1, "o": 4.1, "s": 12.5, "d": 180, "t": "2026:01:02-03:04:05"}
```

| Key | Meaning |
|---|---|
| `a` | latitude in signed decimal degrees |
| `o` | longitude in signed decimal degrees |
| `s` | speed in knots |
| `d` | course in degrees |
| `t` | camera-local wall clock, present only on the first row |

Speed is knots: consecutive-position distance over the implicit five-second
interval tracks `s × 0.514444`; interpreting it as m/s or km/h produces much
larger error.

Rows after the first have no timestamp. Each physical row advances the clock
by five seconds, including malformed and no-fix rows, so discarding a row must
not collapse the time axis. The no-fix sentinel is `a=99`, `o=999`, `s=99`.

## Clock handling

The `t` clock matches the local filename clock, not UTC. Records are emitted
with `timeUnsynced` and a per-clip `relStartSeconds`; the shared time layer then
anchors them to the video's start. This preserves exact within-clip pacing
without feeding a local-as-UTC value into timezone estimation.

## Fixtures

Synthetic and real-anonymized fixtures live in
`src/parsers/__fixtures__/360gps-jsonl/`. The real fixture keeps 50 rows,
rounds coordinates to whole degrees, and preserves the 2-MiB envelope and
footer.
