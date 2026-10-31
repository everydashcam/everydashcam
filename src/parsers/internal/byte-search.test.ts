import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { findByteSequence, matchesBytesAt } from "./byte-search.js";
import { findFreeGpsOffsets, hasFreeGpsMarker } from "./freegps.js";

const fixture = readFileSync(
    new URL("../../../tests/testdata/novatek-real-anonymized/2e-drive-730.mp4", import.meta.url),
);
const bytes = new Uint8Array(fixture);
const marker = new TextEncoder().encode("freeGPS ");
const expectedOffsets: number[] = [];
for (let offset = fixture.indexOf(marker); offset >= 0; offset = fixture.indexOf(marker, offset + marker.length)) {
    expectedOffsets.push(offset);
}

describe("byte marker search", () => {
    it("finds every real GPS block and respects the seed limit", () => {
        expect(expectedOffsets).toHaveLength(3);
        expect(findFreeGpsOffsets(bytes, 0, bytes.length, 8)).toEqual(expectedOffsets);
        expect(findFreeGpsOffsets(bytes, 0, bytes.length, 2)).toEqual(expectedOffsets.slice(0, 2));
        expect(findFreeGpsOffsets(bytes, 0, bytes.length, 0)).toEqual([]);
    });

    it("includes a marker ending exactly at the probe boundary", () => {
        const first = expectedOffsets[0]!;
        expect(hasFreeGpsMarker(bytes, first + marker.length)).toBe(true);
        expect(hasFreeGpsMarker(bytes, first + marker.length - 1)).toBe(false);
        expect(findByteSequence(bytes, marker, first + 1)).toBe(expectedOffsets[1]);
        expect(findFreeGpsOffsets(bytes, first + 1, bytes.length, 8)).toEqual(expectedOffsets.slice(1));
    });

    it("uses offsets relative to a subview and rejects partial markers", () => {
        const first = expectedOffsets[0]!;
        const view = bytes.subarray(first, expectedOffsets[1]!);
        expect(findByteSequence(view, marker)).toBe(0);
        expect(findByteSequence(view.subarray(1), marker)).toBe(-1);
        expect(findByteSequence(view.subarray(0, marker.length - 1), marker)).toBe(-1);
        expect(findByteSequence(view, marker, view.length)).toBe(-1);
        const dataView = new DataView(view.buffer, view.byteOffset, view.byteLength);
        expect(matchesBytesAt(view, 0, marker)).toBe(true);
        expect(matchesBytesAt(dataView, 0, marker)).toBe(true);
        expect(matchesBytesAt(dataView, 0, marker, marker.length - 1)).toBe(false);
        expect(matchesBytesAt(view, 0, marker, marker.length - 1)).toBe(false);
        expect(matchesBytesAt(view, -1, marker)).toBe(false);
    });

    it("continues after a matching prefix and finds adjacent markers", () => {
        const block = bytes.subarray(expectedOffsets[0]!, expectedOffsets[0]! + marker.length);
        const adjacent = new Uint8Array(block.length * 3);
        adjacent.set(block);
        adjacent[block.length - 1] = 0;
        adjacent.set(block, block.length);
        adjacent.set(block, block.length * 2);
        expect(findByteSequence(adjacent, marker)).toBe(block.length);
        expect(findFreeGpsOffsets(adjacent, 0, adjacent.length, 8)).toEqual([block.length, block.length * 2]);
    });
});
