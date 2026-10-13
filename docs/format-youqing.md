# YOUQINGGPS in Novatek `freeGPS`

## Carrier and ownership

REDTIGER F7NP-4K and F17 recordings carry one telemetry record per second in fixed-size
MP4 `free` atoms. The `moov/gps ` table points to those atoms, so the existing
structural freeGPS path reads only the indexed blocks instead of scanning the
video payload. The literal visible to the parser starts with `freeGPS ` and has
the `YOUQINGGPS` banner at literal offset 12.

The banner is the ownership gate. The clock/status region also satisfies both
the older encrypted Type-8 shape and the generic Type-3 layout. The YOUQING
variant must therefore run before both in the freeGPS registry; recognizing it
from status bytes alone would either discard valid plaintext data or decode the
wrong coordinate fields.

## Record semantics

The fields decoded by `variantYouqing` in
`src/parsers/internal/freegps.ts` are:

- latitude and longitude: little-endian float32, NMEA `DDmm.mmmm`, with
  separate N/S and E/W bytes;
- timestamp: six little-endian u32 values in H/M/S/Y/M/D order;
- speed: little-endian float32 in knots;
- course: little-endian float32 degrees.

The timestamp is satellite UTC. A later H/M/S/Y/M/D tuple is the camera-local
clock used by the burned-in OSD and filename. The two clocks differ by the
camera timezone, so the local tuple must not replace the UTC record clock. The
first sample's UTC second, local OSD second, coordinate overlay and speed overlay
were checked against the same decoded video frame; the speed conversion from
knots matched the displayed km/h.

## Evidence and fixture

The F7NP-4K corpus is two synchronized front/rear pairs. The F17 corpus adds
two front/interior/rear sets; all six files decode with the same YOUQING variant. Each file has a working
`gps ` table with one record per second; both channels produce the same clock
window and plausible motion. A public MIT implementation independently
identifies the `freeGPS ` carrier and `YOUQINGGPS` banner, but its published
field offsets do not match this firmware, so the decoder layout is derived from
the real corpus rather than copied from that implementation:
[`oldhero5/dashcam-telemetry@448b35e`](https://github.com/oldhero5/dashcam-telemetry/blob/448b35e99e81ae48526cd8563e15c63695366fbe/src/dashcam_telemetry/parsers/youqing.py).

`scripts/anonymize-youqing-mp4.mjs` builds the committed fixture. It rounds the
known coordinate fields to whole degrees and zeroes every opaque field,
including coordinate-like doubles and identifier-shaped bytes. It preserves
the real clocks, status, speed, course, atom geometry and structural `gps `
table needed by the regression test.
