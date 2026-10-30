import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { hasAsxtFreeGpsSignature, parseAsxtFreeGps, readAsxtWallClock } from "./freegps-asxt.js";

// Synthetic records use receiver 10:15:59 and a separate recording clock.
function block(): DataView {
    const bytes = new Uint8Array(156);
    const view = new DataView(bytes.buffer);
    const encoder = new TextEncoder();
    bytes.set(encoder.encode("freeGPS "), 0);
    view.setUint32(8, 1008, true);
    bytes.set(encoder.encode("IZEEKER\0"), 12);
    bytes.set(encoder.encode("IZEEKER\0"), 28);
    bytes.set(encoder.encode("0123456789ABCDEFASXT"), 100);
    view.setUint32(44, 10, true);
    view.setUint32(48, 15, true);
    view.setUint32(52, 59, true);
    bytes.set(encoder.encode("ANE\0"), 68);
    view.setFloat64(76, 6435.251, true); // DDmm 5123.45; factor[59] = 12.
    view.setFloat64(84, 93952.946, true); // DDDmm 12345.67; factor[15] = 76.
    view.setFloat32(92, 20, true);
    view.setFloat32(96, 270, true);
    view.setInt32(120, 1000, true);
    view.setInt32(124, -2000, true);
    view.setInt32(128, 3000, true);
    view.setUint32(132, 18, true);
    view.setUint32(136, 2, true);
    view.setUint32(140, 7, true);
    view.setUint32(144, 2026, true);
    view.setUint32(148, 10, true);
    view.setUint32(152, 30, true);
    return view;
}

describe("ASXT freeGPS identity", () => {
    it("recognizes the complete header before the recording clock arrives", () => {
        const view = block();
        expect(hasAsxtFreeGpsSignature(new DataView(view.buffer, 0, 120))).toBe(true);
        expect(parseAsxtFreeGps(new DataView(view.buffer, 0, 120), "clip.mp4")).toEqual([]);
        expect(hasAsxtFreeGpsSignature(new DataView(view.buffer, 0, 119))).toBe(false);
    });

    it.each([0, 7, 8, 12, 19, 28, 35, 100, 115, 116, 119])("rejects a damaged identity byte at %i", (offset) => {
        const view = block();
        view.setUint8(offset, 0xff);
        expect(hasAsxtFreeGpsSignature(view)).toBe(false);
        expect(parseAsxtFreeGps(view, "clip.mp4")).toEqual([]);
    });

    it("rejects lowercase identifier text", () => {
        const view = block();
        view.setUint8(110, 0x61);
        expect(hasAsxtFreeGpsSignature(view)).toBe(false);
    });

    it("rejects KTRX ssmd records and plain freeGPS blocks", () => {
        const ktrx = new Uint8Array(56);
        ktrx.set(new TextEncoder().encode("KTRX"), 48);
        expect(hasAsxtFreeGpsSignature(new DataView(ktrx.buffer))).toBe(false);
        const plain = new Uint8Array(156);
        plain.set(new TextEncoder().encode("freeGPS "));
        expect(hasAsxtFreeGpsSignature(new DataView(plain.buffer))).toBe(false);
    });

    it("does not claim the existing synthetic VIOFO freeGPS payloads", () => {
        const bytes = readFileSync(new URL("../__fixtures__/novatek/synthetic-viofo.mp4", import.meta.url));
        let checked = 0;
        for (let offset = bytes.indexOf("freeGPS "); offset >= 0; offset = bytes.indexOf("freeGPS ", offset + 8)) {
            const view = new DataView(bytes.buffer, bytes.byteOffset + offset, Math.min(156, bytes.length - offset));
            expect(hasAsxtFreeGpsSignature(view)).toBe(false);
            checked++;
        }
        expect(checked).toBeGreaterThan(0);
    });
});

describe("ASXT freeGPS records", () => {
    it("decodes clock-indexed coordinates and knots without asserting UTC or sensor units", () => {
        const records = parseAsxtFreeGps(block(), "clip.mp4");
        expect(records).toHaveLength(1);
        const record = records[0]!;
        expect(record.lat).toBeCloseTo(51 + 23.45 / 60, 8);
        expect(record.lon).toBeCloseTo(123 + 45.67 / 60, 8);
        expect(record.speedMs).toBeCloseTo(10.28888, 5);
        expect(record).toMatchObject({
            unixSeconds: Date.UTC(2026, 9, 30, 18, 2, 7) / 1000,
            timeUnsynced: true,
            active: true,
            bearingDeg: 270,
            accelXg: 0,
            accelYg: 0,
            accelZg: 0,
            mp4Filename: "clip.mp4",
        });
    });

    it("applies southern and western signs using the supplied view bounds", () => {
        const original = block();
        const backing = new Uint8Array(190);
        backing.set(new Uint8Array(original.buffer), 17);
        const view = new DataView(backing.buffer, 17, original.byteLength);
        view.setUint8(69, 0x53);
        view.setUint8(70, 0x57);
        const record = parseAsxtFreeGps(view, "clip.mp4")[0]!;
        expect(record.lat).toBeCloseTo(-(51 + 23.45 / 60), 8);
        expect(record.lon).toBeCloseTo(-(123 + 45.67 / 60), 8);
    });

    it("retains the clock of a void fix without decoding its coordinates", () => {
        const view = block();
        view.setUint8(68, 0x56);
        view.setFloat64(76, Number.NaN, true);
        expect(readAsxtWallClock(view)).toBe(Date.UTC(2026, 9, 30, 18, 2, 7) / 1000);
        expect(parseAsxtFreeGps(view, "clip.mp4")).toEqual([]);
    });

    it.each([0, 119, 120, 155])("returns no clock or fix from a %i-byte prefix", (length) => {
        const view = new DataView(block().buffer, 0, length);
        expect(readAsxtWallClock(view)).toBeNull();
        expect(parseAsxtFreeGps(view, "clip.mp4")).toEqual([]);
    });

    it.each([
        [68, 0x58],
        [69, 0x45],
        [70, 0x4e],
        [71, 1],
    ])("rejects invalid status or hemisphere byte %i", (offset, value) => {
        const view = block();
        view.setUint8(offset, value);
        expect(parseAsxtFreeGps(view, "clip.mp4")).toEqual([]);
    });

    it.each([
        [44, 24],
        [48, 60],
        [52, 60],
        [52, 0xffffffff],
    ])("rejects an invalid receiver clock at %i", (offset, value) => {
        const view = block();
        view.setUint32(offset, value, true);
        expect(parseAsxtFreeGps(view, "clip.mp4")).toEqual([]);
    });

    it.each([
        [132, 24],
        [136, 60],
        [140, 60],
        [144, 26],
        [148, 13],
        [152, 0],
        [152, 32],
    ])("rejects an invalid recording clock at %i", (offset, value) => {
        const view = block();
        view.setUint32(offset, value, true);
        expect(readAsxtWallClock(view)).toBeNull();
        expect(parseAsxtFreeGps(view, "clip.mp4")).toEqual([]);
    });

    it("rejects calendar rollover and preserves a valid leap day", () => {
        const view = block();
        view.setUint32(148, 2, true);
        view.setUint32(152, 29, true);
        expect(readAsxtWallClock(view)).toBeNull();
        view.setUint32(144, 2024, true);
        expect(readAsxtWallClock(view)).toBe(Date.UTC(2024, 1, 29, 18, 2, 7) / 1000);
    });

    it.each([
        [76, Number.NaN],
        [84, Number.POSITIVE_INFINITY],
        [76, 287.111 - 1],
        [84, 125.854 - 1],
        [76, 287.111 + 5170 * 1.2],
        [84, 125.854 + 12370 * 7.6],
        [76, 287.111 + 9100 * 1.2],
        [84, 125.854 + 18100 * 7.6],
    ])("rejects invalid coordinates encoded at %i", (offset, value) => {
        const view = block();
        view.setFloat64(offset, value, true);
        expect(parseAsxtFreeGps(view, "clip.mp4")).toEqual([]);
    });

    it.each([
        [92, -1],
        [92, 1001],
        [92, Number.NaN],
        [92, Number.POSITIVE_INFINITY],
        [96, -1],
        [96, 360],
        [96, Number.NaN],
    ])("rejects invalid motion at %i", (offset, value) => {
        const view = block();
        view.setFloat32(offset, value, true);
        expect(parseAsxtFreeGps(view, "clip.mp4")).toEqual([]);
    });
});
