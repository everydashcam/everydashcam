import { describe, expect, it } from "vitest";
import { dedupRecords } from "../../parser.js";
import { reanchorUnsyncedTimes } from "../../trips.js";
import { dispatchParseVideoEmbeddedGps } from "../registry.js";
import { splitVideosByExtension } from "../registry-light.js";
import {
    _internal,
    createFreeGpsBlockParser,
    parseFreeGpsBlock,
    streamScanFreeGps,
    tryStructuralPath,
} from "./freegps.js";
import { buildMp4Index } from "./mp4-index.js";

interface AsxtSample {
    second: number;
    active?: boolean;
}

// Synthetic ASXT bytes: the receiver clock chooses the coordinate factors;
// the separate wall clock below drives relative recording time.
function block({ second, active = true }: AsxtSample): Uint8Array<ArrayBuffer> {
    const bytes = new Uint8Array(16384);
    const box = new DataView(bytes.buffer);
    box.setUint32(0, bytes.length);
    const payload = new DataView(bytes.buffer, 4);
    const ascii = (offset: number, text: string): void => bytes.set(new TextEncoder().encode(text), offset + 4);
    ascii(0, "freeGPS ");
    payload.setUint32(8, 1008, true);
    ascii(12, "IZEEKER\0");
    ascii(28, "IZEEKER\0");
    payload.setUint32(44, 10, true);
    payload.setUint32(48, 15, true);
    payload.setUint32(52, 59, true);
    // This also makes the receiver geometry plausible to generic Type 3.
    payload.setUint32(56, 2026, true);
    payload.setUint32(60, 10, true);
    payload.setUint32(64, 30, true);
    ascii(68, active ? "ANE\0" : "VNE\0");
    payload.setFloat64(76, 6435.251, true); // 5123.45 DDmm, factor[59] = 12.
    payload.setFloat64(84, 93952.946, true); // 12345.67 DDDmm, factor[15] = 76.
    payload.setFloat32(92, 20, true);
    payload.setFloat32(96, 270, true);
    ascii(100, "0123456789ABCDEFASXT");
    payload.setUint32(132, 18, true);
    payload.setUint32(136, 2, true);
    payload.setUint32(140, second, true);
    payload.setUint32(144, 2026, true);
    payload.setUint32(148, 10, true);
    payload.setUint32(152, 30, true);
    return bytes;
}

function view(bytes: Uint8Array): DataView {
    return new DataView(bytes.buffer, bytes.byteOffset + 4, bytes.byteLength - 4);
}

function box(type: string, ...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
    const bytes = new Uint8Array(8 + parts.reduce((sum, part) => sum + part.length, 0));
    new DataView(bytes.buffer).setUint32(0, bytes.length);
    bytes.set(new TextEncoder().encode(type), 4);
    let offset = 8;
    for (const part of parts) {
        bytes.set(part, offset);
        offset += part.length;
    }
    return bytes;
}

function recording(samples: AsxtSample[], indexed = true, name = "renamed.mp4"): File {
    const ftyp = box("ftyp", new TextEncoder().encode("isom\0\0\0\0isommp42"));
    const blocks = samples.map(block);
    const table = new Uint8Array(8 + 8 * blocks.length);
    const tableView = new DataView(table.buffer);
    tableView.setUint32(0, 257);
    tableView.setUint32(4, blocks.length);
    let offset = ftyp.length + 8; // mdat header
    for (const [i, bytes] of blocks.entries()) {
        tableView.setUint32(8 + i * 8, offset);
        tableView.setUint32(12 + i * 8, bytes.length);
        offset += bytes.length;
    }
    return new File([ftyp, box("mdat", ...blocks), indexed ? box("moov", box("gps ", table)) : box("moov")], name);
}

const SAMPLES: AsxtSample[] = [
    { second: 0, active: false },
    { second: 2 },
    { second: 4, active: false },
    { second: 7 },
    { second: 7 },
];

describe("ASXT freeGPS dispatch", () => {
    it("owns encoded doubles even when generic Type 3 would emit plausible wrong coordinates", () => {
        const payload = view(block({ second: 0 }));
        // Low halves of the encoded doubles can also spell plausible floats.
        // Their small changes retain valid ASXT coordinates while Type 3 sees
        // the wrong position at its overlapping float32 offsets.
        payload.setFloat32(72, 5030, true);
        payload.setFloat32(76, 12345, true);
        payload.setFloat32(84, 270, true);
        const type3 = _internal.FREE_GPS_VARIANTS.find((variant) => variant.name === "VIOFO Type 3")!;
        expect(type3.matches(payload)).toBe(true);
        const wrong = type3.parse(payload, "clip.mp4");
        expect(wrong).toHaveLength(1);
        expect(wrong[0]!.lat).toBeCloseTo(50.5, 5);
        const decoded = parseFreeGpsBlock(payload, "clip.mp4");
        expect(decoded).toHaveLength(1);
        expect(decoded[0]!.lat).toBeCloseTo(51 + 23.45 / 60, 4);
        expect(decoded[0]!.timeUnsynced).toBe(true);

        const truncated = new DataView(payload.buffer, payload.byteOffset, 120);
        expect(type3.parse(truncated, "clip.mp4")).toHaveLength(1);
        expect(parseFreeGpsBlock(truncated, "clip.mp4")).toEqual([]);
        expect(createFreeGpsBlockParser()(truncated, "clip.mp4")).toEqual([]);
    });

    it("keeps no-fix delays and stationary fixes through structural parsing and deduplication", async () => {
        const file = recording(SAMPLES);
        const index = await buildMp4Index(file, { probeBytes: 0 });
        expect(index.novatekGpsAtom).not.toBeNull();
        const parser = createFreeGpsBlockParser();
        const parsed = await tryStructuralPath(file, index, parser);
        expect(parsed).not.toBeNull();
        expect(parsed!.records.map((record) => record.relStartSeconds)).toEqual([2, 7, 7]);
        expect(parsed!.skipped).toHaveLength(2);
        expect(parser.claimedVariantName()).toBe("ASXT freeGPS");
        expect(parser.coldStartClockJumpSec()).toBeNull();
        const deduped = dedupRecords(parsed!.records);
        expect(deduped.map((record) => record.relStartSeconds)).toEqual([2, 7]);
        reanchorUnsyncedTimes(deduped, 1700000000, 10);
        expect(deduped.map((record) => record.unixSeconds)).toEqual([1700000002, 1700000007]);
    });

    it("gives structural and streaming scans the same relative timeline", async () => {
        const file = recording(SAMPLES);
        const index = await buildMp4Index(file, { probeBytes: 0 });
        const structural = await tryStructuralPath(file, index, createFreeGpsBlockParser());
        const streamed = await streamScanFreeGps(file, undefined, undefined, createFreeGpsBlockParser());
        expect(streamed.records).toEqual(structural!.records);
        expect(streamed.records.map((record) => record.relStartSeconds)).toEqual([2, 7, 7]);
    });

    it.each([true, false])("reaches the freegps extractor through registry dispatch (indexed=%s)", async (indexed) => {
        const file = recording(SAMPLES, indexed);
        const { videoEntries } = splitVideosByExtension([{ file, relativePath: file.name }]);
        const parsed = await dispatchParseVideoEmbeddedGps(videoEntries);
        expect(parsed.errors).toEqual([]);
        expect(parsed.records.map((record) => record.relStartSeconds)).toEqual([2, 7, 7]);
        expect([...parsed.winningExtractorByFileKey.values()]).toEqual(["freegps"]);
        for (const record of parsed.records) {
            expect(record.lat).toBeCloseTo(51 + 23.45 / 60, 8);
            expect(record.lon).toBeCloseTo(123 + 45.67 / 60, 8);
            expect(record.speedMs).toBeCloseTo(10.28888, 5);
            expect(record.timeUnsynced).toBe(true);
            expect([record.accelXg, record.accelYg, record.accelZg]).toEqual([0, 0, 0]);
        }
    });

    it("does not share the ASXT clock origin across concurrently dispatched files", async () => {
        const first = recording([{ second: 50, active: false }, { second: 52 }], true, "first.mp4");
        const second = recording([{ second: 0, active: false }, { second: 1 }], false, "second.mp4");
        const { videoEntries } = splitVideosByExtension(
            [first, second].map((file) => ({ file, relativePath: file.name })),
        );
        const parsed = await dispatchParseVideoEmbeddedGps(videoEntries);
        expect(parsed.errors).toEqual([]);
        expect(parsed.records.find((record) => record.mp4Filename === "first.mp4")?.relStartSeconds).toBe(2);
        expect(parsed.records.find((record) => record.mp4Filename === "second.mp4")?.relStartSeconds).toBe(1);
    });

    it("rejects clocks before the origin without resetting later offsets", () => {
        const parse = createFreeGpsBlockParser();
        expect(parse(view(block({ second: 5, active: false })), "clip.mp4")).toEqual([]);
        expect(parse(view(block({ second: 7 })), "clip.mp4")[0]!.relStartSeconds).toBe(2);
        expect(parse(view(block({ second: 4 })), "clip.mp4")).toEqual([]);
        expect(parse(view(block({ second: 8 })), "clip.mp4")[0]!.relStartSeconds).toBe(3);
    });

    it("rejects a clock regression above the origin while allowing repeated fixes", () => {
        const parse = createFreeGpsBlockParser();
        expect(parse(view(block({ second: 0, active: false })), "clip.mp4")).toEqual([]);
        expect(parse(view(block({ second: 10 })), "clip.mp4")[0]!.relStartSeconds).toBe(10);
        expect(parse(view(block({ second: 10 })), "clip.mp4")[0]!.relStartSeconds).toBe(10);
        expect(parse(view(block({ second: 5 })), "clip.mp4")).toEqual([]);
        expect(parse(view(block({ second: 11 })), "clip.mp4")[0]!.relStartSeconds).toBe(11);
    });

    it("does not advance the monotonic guard on a later corrupt no-fix clock", () => {
        const parse = createFreeGpsBlockParser();
        expect(parse(view(block({ second: 0, active: false })), "clip.mp4")).toEqual([]);
        expect(parse(view(block({ second: 10 })), "clip.mp4")[0]!.relStartSeconds).toBe(10);
        expect(parse(view(block({ second: 50, active: false })), "clip.mp4")).toEqual([]);
        expect(parse(view(block({ second: 11 })), "clip.mp4")[0]!.relStartSeconds).toBe(11);
    });
});
