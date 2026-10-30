# ASXT freeGPS records

The decoder in `src/parsers/internal/freegps-asxt.ts` reads ASXT-tagged
records through the shared freeGPS block registry. This iZEEKER layout is
separate from the iD300 KTRX `ssmd` format.

## Container and fields

The carrier uses 16 KiB `freeGPS ` blocks referenced by a
`moov/gps ` index with version 257 and big-endian offset/size pairs. Existing
freeGPS structural and streaming readers can provide these payloads.

All offsets below start at the `freeGPS ` literal, **four bytes after the box
size**. Multibyte numeric fields are little-endian.

| Offset | Type | Meaning |
| --- | --- | --- |
| 0 | ASCII[8] | `freeGPS ` |
| 8 | u32 | Layout discriminator 1008 |
| 12, 28 | ASCII[8] | `IZEEKER` followed by NUL |
| 44, 48, 52 | u32 | Receiver hour, minute, second; minute/second select coordinate factors |
| 68–71 | bytes | A/V status, N/S, E/W, NUL |
| 76, 84 | f64 | Encoded latitude/longitude in DDmm form |
| 92, 96 | f32 | Speed in knots, course in degrees |
| 100 | ASCII[16] | Uppercase hexadecimal identifier; omit from records and scrub from any future fixture |
| 116 | ASCII[4] | `ASXT` |
| 120, 124, 128 | i32 | Raw sensor readings with unknown physical scale |
| 132, 136, 140 | u32 | Recording hour, minute, second |
| 144, 148, 152 | u32 | Full recording year, month, day |

The coordinate transform subtracts a constant and divides by the 60-entry
factor table indexed by the receiver second for latitude and minute for
longitude. The table and constants live beside the decoder. The resulting
positive DDmm values pass through the usual minutes conversion and hemisphere
sign handling.

## Clock and sensor limits

The trailing recording clock has no established timezone. It must not
establish GPS UTC or camera timezone. The decoder marks
fixes `timeUnsynced`. File integration preserves clock intervals relative to
the first timed block, including leading no-fix records, before deduplication
or reanchoring. This gives relative pacing; it does not establish the exact
delay between recording start and the first telemetry block.

Raw sensor counts do not establish acceleration in g. The decoder emits zero
acceleration rather than feeding uncalibrated values into event detection.

The full identity header is recognized before checking the trailing clock, so
a truncated ASXT record can be rejected without falling through to the generic
float-coordinate layout. Detection uses payload bytes rather than a model
name or filename assumption.
