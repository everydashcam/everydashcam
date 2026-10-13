# LigoGPS trailers on MPEG-TS

Real recordings verify this family for Aspiring Expert 9, Blackview X5S PRO
and INNOVV K3, plus an unidentified dual-camera sample. K3 uses the paired
enciphered/plaintext dialect; N2 instead uses [Viidure PES records](format-viidure-ts.md).

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

Firmware interprets the little-endian field differently. LCAI with hashes
can store either byte length or the exact written slot count; classic LIGO
with ampersands stores capacity, which can exceed the written count on partial
clips. Do not infer the field's meaning from the terminator alone.
The accepted combinations and bounds live in `src/ts-trailer.ts`.

The lowercase `skip` dialect pairs an enciphered `LIGOGPSINFO` block with
a plaintext block carrying a firmware label, followed by preallocated zero
bytes. Validate both blocks and the adjacent TS packet grid before clamping. The first
block's length copies cover the pair; the second block's copies cover only
itself. Their slot counts use little-endian and big-endian order respectively.
Plaintext slots start with the timestamp, without a record index. Read only
the plaintext twin; erase the enciphered slots when anonymizing fixtures.
Keep preallocation scans bounded and verify every skipped byte is zero.
Zero padding is independent of GPS: ordinary TS packets and other recognized
tables can precede it too. Preserve zero-valued bytes inside the final TS packet.

Blackview X5S PRO recordings without GPS can end in an empty table. Parking
clips use a `SKIP` block with zero magic, flags and count. Time-lapse clips
retain the LCAI magic and a nominal slot capacity even though no slots were
written. Accept these shapes only with an empty slot region and the hash
terminator. They need the same AV clamp even though they supply no GPS.

Plaintext speed is km/h. Timestamps are camera-local; preserve gaps in the
record cadence. Course can appear as `A:` or, in the LCAI count dialect,
as a bare number after the x/y/z fields. Zero acceleration components do
not establish that the hardware supplies usable acceleration.

See `scripts/anonymize-ligogps-trailer-ts.mjs` for fixture preparation and
`src/parsers/__fixtures__/ligogps-trailer-ts/real-anonymized.test.ts` for
real-byte regression coverage.
