# Daily DDmm CSV GPS logs

The `daily-csv-gps` primitive reads daily `gps/YYYYMMDD.dat` files with rows
containing a compact local timestamp, DDmm coordinates, separate hemisphere
letters, speed in knots, and optional altitude. A `#` line starts a new recording
session. The parser requires both the dated DAT name and this content signature;
unrelated DAT files are not claimed.

The real evidence is the [Kaiser Baas R50 owner's public viewer](https://github.com/jgOhYeah/dashcam-viewer/tree/492240a16766bc68755b11b2e9af5fb1699b6169).
Its README identifies the camera as “Kaiser Bass R50” and documents the log
layout. The accompanying demo videos are explicitly downscaled. The two published
daily logs validate parsing and filename association, not an untouched native
video container or frame-level synchronization.

## Clock and video association

`YYYYMMDDhhmmss_duration.MP4` supplies a camera-local recording start and a
duration in seconds without zero padding. Padded counters such as `_0060` keep
the DDPai filename rules; that family shares the `100video` directory and can
have a paired `_A` rear clip. The duration is not a sequence counter. The observed card
layout is:

```text
gps/YYYYMMDD.dat
DCIM/100video/YYYYMMDDhhmmss_duration.MP4   normal recording
DCIM/101video/YYYYMMDDhhmmss_duration.MP4   event recording
```

Each row belongs to every selected clip whose `[start, start + duration)` window
contains it. This preserves overlapping normal/event clips without extending a
short event or the last selected video across the rest of the day. Clips crossing
midnight can consume rows from both daily logs. Segment counters are scoped to
their daily file; consecutive fixes across a file rollover remain connected,
while restart markers within either file preserve their cuts. The first `#` is
still required: native rollover behavior without that marker needs a sample.
Zero-coordinate no-fix rows remain inactive samples with unavailable speed. They
break route continuity and bearing inference, including at clip or daily-file
boundaries, so the viewer does not interpolate across a reported signal loss.

The format has no explicit timezone. Records use `timeUnsynced` with a precise
`relStartSeconds` offset so the video timeline anchors them; their displayed
calendar fields must not calibrate satellite UTC or the camera timezone.
Speed uses the shared knots-to-m/s conversion. Bearing is inferred from positions
within each clip/session; there is no measured heading or acceleration column.
Altitude has no corresponding `GpsRecord` field and is discarded.

Nonempty preserved card roots take precedence over a common folder-picker source
and allow partial imports of the same tree. The selected video's exact owner is
retained through ingest, including when another card has the same basename.
Conflicting copies of a named tree require an unambiguous picker scope; known
byte-identical recording copies retain their canonical owner.

Selecting `100video` and then `gps` also works without the `DCIM` level when
only one card is eligible. Empty roots cannot distinguish different cards, so
multiple anonymous sources remain ambiguous. Flat selections and later sidecar
drops work when the loaded video set is unambiguous. Select the logs
with their videos, or add them after the videos: this whole-card parser needs the
known video list during parsing and does not retain a log-only import for future
videos. Renamed video basenames cannot be associated by this format.

Filename-only classification cannot distinguish every DDPai counter from a
duration. Channel-suffixed names retain their counter semantics; the shared
normal/event folders still group sibling channels consistently. A flat name
without card-layout evidence retains the generic counter interpretation.

## Evidence and fixtures

The original daily logs contain 2,475 rows. The four published clip windows
receive 180, 180, 163 and 10 records, respectively: 533 associated points.
Rows outside the selected windows remain unmatched, rather than being attached
to the nearest clip. Published speeds are moving and nonzero; no physical clock
or motion calibration was performed against native footage.

The [anonymizer](../scripts/anonymize-daily-csv-gps-log.mjs) selects short windows,
preserves timestamps and speed, and rounds both coordinates to whole degrees.
The [real regression](../src/parsers/__fixtures__/daily-csv-gps/real-anonymized.test.ts)
uses 50 and 36 rows spanning both normal-to-normal and normal-to-event boundaries.
It checks all four associations, strict clock ordering, relative offsets,
anonymization, and a known nonzero source speed. No original footage is published.

The decoder and path rules live in
[`daily-csv-gps.ts`](../src/parsers/primitives/daily-csv-gps.ts) and
[`daily-csv-path.ts`](../src/parsers/internal/daily-csv-path.ts).
