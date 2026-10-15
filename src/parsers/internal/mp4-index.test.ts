// Tests for the buildMp4Index top-level captures added for the udta-pack
// formats: topLevelUdtaAtom/topLevelUdtaHead (Kenwood / LigoJSON / GKU),
// lastTopLevelBoxEnd (Kenwood CCCC-trailer probe anchor), kodakVersion
// (Rexing affine gate, read from the top-level frea/'ver ' child WITHOUT
// touching the thumbnail children).

import { describe, expect, it } from "vitest";
import { buildMp4Index, DEFAULT_PROBE_BYTES, MAX_PROBE_BYTES, probeMarkers, UDTA_HEAD_BYTES } from "./mp4-index.js";

const ascii = (text: string): Uint8Array => Uint8Array.from(text, (ch) => ch.charCodeAt(0) & 0xff);

/** [u32 BE size]['type'][payload] - a standard MP4 box. */
function box(type: string, payload: Uint8Array): Uint8Array<ArrayBuffer> {
    const out = new Uint8Array(8 + payload.length);
    new DataView(out.buffer).setUint32(0, out.length, false);
    out.set(ascii(type), 4);
    out.set(payload, 8);
    return out;
}

function concatBytes(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
    const total = parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(total);
    let pos = 0;
    for (const p of parts) {
        out.set(p, pos);
        pos += p.length;
    }
    return out;
}

const FTYP = box("ftyp", ascii("mp42\0\0\0\0mp42isom"));

/** File subclass that records every slice() range - lets a test assert that
 *  certain byte regions (thumbnail payloads) are never read. */
class TrackingFile extends File {
    public readRanges: Array<[number, number]> = [];
    override slice(start?: number, end?: number, contentType?: string): Blob {
        this.readRanges.push([start ?? 0, end ?? this.size]);
        return super.slice(start, end, contentType);
    }
}

describe("buildMp4Index: top-level udta capture", () => {
    it("records the atom, reads the payload head, and computes lastTopLevelBoxEnd", async () => {
        const udtaPayload = ascii(`VIDEO${"U".repeat(22)}\xfe\xfe20230107111914.rest-of-records`);
        const bytes = concatBytes([FTYP, box("mdat", new Uint8Array(64)), box("udta", udtaPayload)]);
        const index = await buildMp4Index(new File([bytes], "k.mp4"), { probeBytes: 0 });

        expect(index.topLevelUdtaAtoms).toHaveLength(1);
        const udta = index.topLevelUdtaAtoms[0]!;
        expect(udta.offset).toBe(FTYP.length + 64 + 8);
        expect(udta.size).toBe(udtaPayload.length + 8);
        expect(udta.headerSize).toBe(8);
        // Head = the first UDTA_HEAD_BYTES of the payload.
        expect(udta.head).not.toBeNull();
        expect(udta.head!.length).toBe(UDTA_HEAD_BYTES);
        expect(Array.from(udta.head!)).toEqual(Array.from(udtaPayload.subarray(0, UDTA_HEAD_BYTES)));
        // No trailing junk - the box structure covers the whole file.
        expect(index.lastTopLevelBoxEnd).toBe(bytes.length);
    });

    it("captures EVERY top-level udta - a generic one first does not hide the carrier", async () => {
        // Mux order is firmware whim: a generic/empty udta written before the
        // GPS-bearing one must not shadow it (ExifTool tests every file-level
        // udta; first-only capture was a divergence).
        const genericPayload = ascii("plain metadata long enough to fill the head window....");
        const carrierPayload = ascii(`VIDEO${"U".repeat(22)}\xfe\xfe20230107111914.rest`);
        const bytes = concatBytes([
            FTYP,
            box("udta", genericPayload),
            box("mdat", new Uint8Array(64)),
            box("udta", carrierPayload),
        ]);
        const index = await buildMp4Index(new File([bytes], "k.mp4"), { probeBytes: 0 });
        expect(index.topLevelUdtaAtoms).toHaveLength(2);
        expect(Array.from(index.topLevelUdtaAtoms[0]!.head!)).toEqual(
            Array.from(genericPayload.subarray(0, UDTA_HEAD_BYTES)),
        );
        expect(Array.from(index.topLevelUdtaAtoms[1]!.head!)).toEqual(
            Array.from(carrierPayload.subarray(0, UDTA_HEAD_BYTES)),
        );
    });

    it("a short udta yields a short head (no over-read)", async () => {
        const udtaPayload = ascii("tiny");
        const bytes = concatBytes([FTYP, box("udta", udtaPayload)]);
        const index = await buildMp4Index(new File([bytes], "k.mp4"), { probeBytes: 0 });
        expect(index.topLevelUdtaAtoms[0]!.head!.length).toBe(4);
    });

    it("no top-level udta -> empty array (moov/udta does NOT count)", async () => {
        const moov = box("moov", box("udta", ascii("nested udta payload")));
        const bytes = concatBytes([FTYP, moov]);
        const index = await buildMp4Index(new File([bytes], "n.mp4"), { probeBytes: 0 });
        expect(index.topLevelUdtaAtoms).toEqual([]);
    });

    it("lastTopLevelBoxEnd stops where trailing non-ISOBMFF junk begins", async () => {
        const valid = concatBytes([FTYP, box("mdat", new Uint8Array(32))]);
        const trailer = ascii(`${"C".repeat(14)}GPSDATA--20240711120412...`);
        const bytes = concatBytes([valid, trailer]);
        const index = await buildMp4Index(new File([bytes], "t.mp4"), { probeBytes: 0 });
        // The bogus 'CCCCCCCC' header (size 0x43434343 overshoots the file)
        // terminates the walk exactly at the trailer start.
        expect(index.lastTopLevelBoxEnd).toBe(valid.length);
    });
});

describe("buildMp4Index: kodakVersion from frea/'ver '", () => {
    function freaBox(children: Uint8Array[]): Uint8Array {
        return box("frea", concatBytes(children));
    }

    it("captures and trims the version string without reading thumbnail payloads", async () => {
        const thmaPayload = new Uint8Array(0x4000).fill(0xee); // stand-in JPEG
        const children = [
            box("tima", new Uint8Array(4)),
            box("ver ", ascii("3.01.054\0\0\0")),
            box("thma", thmaPayload),
        ];
        const bytes = concatBytes([FTYP, freaBox(children), box("mdat", new Uint8Array(16))]);
        const file = new TrackingFile([bytes], "rexing.mp4");
        const index = await buildMp4Index(file, { probeBytes: 0 });
        expect(index.kodakVersion).toBe("3.01.054");

        // The thma PAYLOAD must never be read - only its 8-byte header may
        // fall into a read. (probeBytes: 0 keeps the marker probe, which
        // legitimately reads the file head, out of this assertion.)
        const freaStart = FTYP.length;
        const thmaPayloadStart = freaStart + 8 + children[0]!.length + children[1]!.length + 8;
        const thmaPayloadEnd = thmaPayloadStart + thmaPayload.length;
        for (const [start, end] of file.readRanges) {
            const overlaps = start < thmaPayloadEnd && end > thmaPayloadStart;
            expect(overlaps, `read [${start}, ${end}) must not touch thma payload`).toBe(false);
        }
    });

    it("ver after thma is still found (header-walk skips, does not stop)", async () => {
        const children = [box("thma", new Uint8Array(0x1000).fill(0xee)), box("ver ", ascii("2.00.001"))];
        const bytes = concatBytes([FTYP, freaBox(children)]);
        const index = await buildMp4Index(new File([bytes], "k.mp4"), { probeBytes: 0 });
        expect(index.kodakVersion).toBe("2.00.001");
    });

    it("no frea, frea without ver, or corrupt child header -> null", async () => {
        const noFrea = await buildMp4Index(new File([concatBytes([FTYP])], "a.mp4"), { probeBytes: 0 });
        expect(noFrea.kodakVersion).toBeNull();

        const noVer = concatBytes([FTYP, freaBox([box("thma", new Uint8Array(16))])]);
        const noVerIdx = await buildMp4Index(new File([noVer], "b.mp4"), { probeBytes: 0 });
        expect(noVerIdx.kodakVersion).toBeNull();

        // Child header with size 0 - the walk must stop, not loop.
        const corrupt = concatBytes([FTYP, freaBox([new Uint8Array(16)])]);
        const corruptIdx = await buildMp4Index(new File([corrupt], "c.mp4"), { probeBytes: 0 });
        expect(corruptIdx.kodakVersion).toBeNull();
    });

    it("whitespace-padded version trims to the bare string", async () => {
        const bytes = concatBytes([FTYP, freaBox([box("ver ", ascii("3.01.054  \0"))])]);
        const index = await buildMp4Index(new File([bytes], "k.mp4"), { probeBytes: 0 });
        expect(index.kodakVersion).toBe("3.01.054");
    });
});

describe("buildMp4Index: top-level free box", () => {
    // 8 MB of zero padding: DDPAI, 70mai and Thinkware reserve a `free` box of
    // this shape and never put telemetry in it.
    const PADDING = 8 * 1024 ** 2;

    it("leaves a padding free box unread", async () => {
        const bytes = concatBytes([FTYP, box("free", new Uint8Array(PADDING)), box("mdat", new Uint8Array(64))]);
        const file = new TrackingFile([bytes], "pad.mp4");
        const index = await buildMp4Index(file, { probeBytes: 0 });
        expect(index.topLevelFreeBox).toBeNull();
        expect(index.freeBoxView).toBeNull();
        expect(index.freeGpsBoxInsideFree).toBeNull();
        const widest = Math.max(...file.readRanges.map(([start, end]) => end - start));
        expect(widest, "largest single read").toBeLessThan(1024);
    });

    it("loads a free box whose children carry the BlackVue gps/3gf boxes", async () => {
        const gpsPayload = ascii("$GPRMC,120000.000,A,5540.0000,N,03730.0000,E,0.0,0.0,010124,,,A*00\r\n");
        const free = box(
            "free",
            concatBytes([box("cprt", ascii("Pittasoft")), box("gps ", gpsPayload), box("3gf ", new Uint8Array(24))]),
        );
        const bytes = concatBytes([FTYP, free, box("mdat", new Uint8Array(64))]);
        const index = await buildMp4Index(new TrackingFile([bytes], "bv.mp4"), { probeBytes: 0 });
        expect(index.freeBoxView).not.toBeNull();
        expect(index.freeGpsBoxInsideFree).not.toBeNull();
        expect(index.free3gfBoxInsideFree).not.toBeNull();
        const gps = index.freeGpsBoxInsideFree!;
        expect(gps.end - gps.payloadStart).toBe(gpsPayload.length);
    });
});

describe("probeMarkers: window extension", () => {
    it("extends an existing probe window instead of re-reading it", async () => {
        // Literals at 5 MB and 7 MB: invisible to the default window, both
        // inside the maximum one. The escalation read must start where the
        // first probe ended.
        const mdat = new Uint8Array(MAX_PROBE_BYTES);
        mdat.set(ascii("freeGPS "), 5 * 1024 ** 2);
        mdat.set(ascii("freeGPS "), 7 * 1024 ** 2);
        const bytes = concatBytes([FTYP, box("mdat", mdat)]);
        const file = new TrackingFile([bytes], "probe.mp4");
        const index = await buildMp4Index(file, { probeBytes: 0 });
        file.readRanges.length = 0;

        await probeMarkers(file, index, DEFAULT_PROBE_BYTES);
        expect(index.freeGpsSeedOffsets).toEqual([]);
        expect(index.hasFreeGpsMarker).toBe(false);
        expect(file.readRanges).toEqual([[0, DEFAULT_PROBE_BYTES]]);

        await probeMarkers(file, index, MAX_PROBE_BYTES);
        expect(file.readRanges).toEqual([
            [0, DEFAULT_PROBE_BYTES],
            [DEFAULT_PROBE_BYTES, MAX_PROBE_BYTES],
        ]);
        expect(index.headerBytes!.byteLength).toBe(MAX_PROBE_BYTES);
        expect(index.hasFreeGpsMarker).toBe(true);
        expect(index.freeGpsSeedOffsets).toEqual([FTYP.length + 8 + 5 * 1024 ** 2, FTYP.length + 8 + 7 * 1024 ** 2]);
        // The stitched window is one contiguous view of the file head.
        expect(index.headerView!.getUint32(0, false)).toBe(FTYP.length);
    });
});
