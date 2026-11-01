# LigoGPS trailers on MPEG-TS

Real recordings verify this family for Aspiring Expert 9, Blackview X5S PRO,
GKU 600 Pro and INNOVV K3, plus an unidentified dual-camera sample. K3 uses
the paired enciphered/plaintext dialect; N2 instead uses [Viidure PES records](format-viidure-ts.md).

The GPS table follows the last complete TS packet. It is not packetized:
demuxers must stop before it, while telemetry extraction reads the original
file. Keep GPS-trailer detection shared between these consumers in
`src/ts-trailer.ts`. The AV clamp can also cut an unknown suffix when packet
sync establishes the last complete packet.

The trailer contains a big-endian total length, `SKIP` plus GPS magic,
five flag bytes, a little-endian header field, indexed NUL-padded ASCII
slots, then a terminator and another big-endian total length. Both length
copies include the entire trailer. Reject unknown combinations and prefixes
that do not end on the TS packet grid.

Firmware interprets the little-endian field differently: LCAI with hashes
stores the byte length or the written slot count, classic LIGO with ampersands
a capacity that can exceed the written count on partial clips, and classic
LIGO with hashes (GKU) zero. Detection and parsing ignore it, because the
length copies and the slot grid already bound the table; strict checks of
this field only ever rejected real recordings. The accepted magic/terminator
pairs live in `src/ts-trailer.ts`.

The lowercase `skip` dialect pairs an enciphered `LIGOGPSINFO` block with
a plaintext block carrying a firmware label, followed by preallocated zero
bytes. Validate both blocks and the adjacent TS packet grid before clamping. The first
block's length copies cover the pair; the second block's copies cover only
itself. Their slot-count fields (little-endian and big-endian respectively)
are ignored for the same reason as the standard header field.
Plaintext slots start with the timestamp, without a record index. Read only
the plaintext twin; erase the enciphered slots when anonymizing fixtures.
Locate a table in front of preallocation by bisecting the 188-byte packet
grid for the last complete packet, read the table's own leading length, and
verify the table with the same end-anchored checks as at EOF; read only a
bounded window of the padding behind it, and reject any non-zero byte there.
The exhaustive backward scan stays as the fallback, bounded, verifying every
skipped byte is zero. Zero padding is independent of GPS: ordinary TS packets
and other recognized tables can precede it too. Preserve zero-valued bytes
inside the final TS packet.

Blackview X5S PRO recordings without GPS can end in an empty table. Parking
clips use a `SKIP` block with zero magic, flags and count; without a magic,
accept it only at the minimum size, all-zero, with the hash terminator.
Time-lapse clips keep the LCAI magic and a nominal slot capacity with no
slots. Both need the same AV clamp even though they supply no GPS.

Plaintext speed is km/h. Timestamps are camera-local on most firmwares and
UTC on GKU; both parse as UTC and the per-camera offset estimate absorbs the
difference. Preserve gaps in the record cadence. Course can appear as `A:`
or, in the LCAI count dialect, as a bare number after the x/y/z fields. Zero acceleration components do
not establish that the hardware supplies usable acceleration.

See `scripts/anonymize-ligogps-trailer-ts.mjs` for fixture preparation and
`src/parsers/__fixtures__/ligogps-trailer-ts/real-anonymized.test.ts` for
real-byte regression coverage.
