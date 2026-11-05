import { describe, expect, it } from "vitest";

import { capnpMessage, concatBytes, structData } from "../__fixtures__/openpilot/build-log.js";
import {
    type CapnpStruct,
    capnpBit,
    capnpF32,
    capnpF64,
    capnpI8,
    capnpI32,
    capnpI64,
    capnpStructAt,
    capnpU8,
    capnpU16,
    capnpU32,
    capnpU64,
    walkCapnpMessages,
} from "./capnp.js";

function roots(bytes: Uint8Array): { roots: CapnpStruct[]; messages: number; malformedAt: number | null } {
    const found: CapnpStruct[] = [];
    const walk = walkCapnpMessages(bytes, (root) => found.push(root));
    return { roots: found, ...walk };
}

describe("walkCapnpMessages", () => {
    it("visits back-to-back messages and reads primitive fields at their offsets", () => {
        const first = capnpMessage({
            data: structData(3, (view) => {
                view.setUint8(0, 0xfe);
                view.setUint16(2, 0xbeef, true);
                view.setInt32(4, -7, true);
                view.setBigUint64(8, 2n ** 52n + 3n, true);
                view.setFloat64(16, -77.25, true);
            }),
        });
        const second = capnpMessage({
            data: structData(2, (view) => {
                view.setUint32(0, 0xdeadbeef, true);
                view.setFloat32(4, 1.5, true);
                view.setBigInt64(8, -1234567890123n, true);
            }),
        });
        const walk = roots(concatBytes([first, second]));
        expect(walk.messages).toBe(2);
        expect(walk.malformedAt).toBeNull();
        const [a, b] = walk.roots;
        expect(capnpU8(a!, 0)).toBe(0xfe);
        expect(capnpI8(a!, 0)).toBe(-2);
        expect(capnpU16(a!, 2)).toBe(0xbeef);
        expect(capnpI32(a!, 4)).toBe(-7);
        expect(capnpU64(a!, 8)).toBe(2 ** 52 + 3);
        expect(capnpF64(a!, 16)).toBe(-77.25);
        expect(capnpU32(b!, 0)).toBe(0xdeadbeef);
        expect(capnpF32(b!, 4)).toBe(1.5);
        expect(capnpI64(b!, 8)).toBe(-1234567890123);
    });

    it("reads fields past the data section as zero, as written by an older schema", () => {
        const [root] = roots(capnpMessage({ data: structData(1, (view) => view.setUint32(0, 9, true)) })).roots;
        expect(capnpU32(root!, 0)).toBe(9);
        expect(capnpU32(root!, 8)).toBe(0);
        expect(capnpU64(root!, 4)).toBe(0);
        expect(capnpF64(root!, 64)).toBe(0);
        expect(capnpBit(root!, 64)).toBe(false);
    });

    it("reads single bits of the data section", () => {
        const [root] = roots(capnpMessage({ data: structData(8, (view) => view.setUint8(60, 0b0000_0101)) })).roots;
        expect(capnpBit(root!, 480)).toBe(true);
        expect(capnpBit(root!, 481)).toBe(false);
        expect(capnpBit(root!, 482)).toBe(true);
    });

    it("follows struct pointers and returns null for null, missing and non-struct pointers", () => {
        const child = { data: structData(1, (view) => view.setUint16(0, 42, true)) };
        const bytes = capnpMessage({ data: structData(1), pointers: [child, null] });
        const [root] = roots(bytes).roots;
        expect(capnpU16(capnpStructAt(root!, 0)!, 0)).toBe(42);
        expect(capnpStructAt(root!, 1)).toBeNull();
        expect(capnpStructAt(root!, 2)).toBeNull();

        // Turn the child pointer into a list pointer (kind 1).
        const listBytes = bytes.slice();
        const view = new DataView(listBytes.buffer);
        const pointerPos = 8 + 8 + 8; // segment table, root pointer, root data word
        view.setUint32(pointerPos, view.getUint32(pointerPos, true) | 1, true);
        expect(capnpStructAt(roots(listBytes).roots[0]!, 0)).toBeNull();
    });

    it("rejects a struct pointer whose target overruns its segment", () => {
        const bytes = capnpMessage({ data: structData(1), pointers: [{ data: structData(1) }] });
        const view = new DataView(bytes.buffer);
        const pointerPos = 8 + 8 + 8;
        view.setUint32(pointerPos + 4, 100, true); // 100 data words
        expect(capnpStructAt(roots(bytes).roots[0]!, 0)).toBeNull();
    });

    it("reads the root of a multi-segment message from its first segment and walks past it", () => {
        // Two segments: [root pointer, root data] and one unrelated word.
        const multi = new Uint8Array(16 + 8 * 3);
        const view = new DataView(multi.buffer);
        view.setUint32(0, 1, true); // two segments
        view.setUint32(4, 2, true);
        view.setUint32(8, 1, true);
        view.setUint32(16 + 4, 1, true); // root: offset 0, one data word
        view.setUint32(24, 77, true);
        view.setUint32(32, 0xffffffff, true);
        const after = capnpMessage({ data: structData(1, (v) => v.setUint32(0, 5, true)) });
        const walk = roots(concatBytes([multi, after]));
        expect(walk.messages).toBe(2);
        expect(walk.malformedAt).toBeNull();
        expect(walk.roots.map((root) => capnpU32(root, 0))).toEqual([77, 5]);
    });

    it("stops at a truncated tail and reports where the framing broke", () => {
        const whole = capnpMessage({ data: structData(2) });
        const bytes = concatBytes([whole, whole.subarray(0, whole.byteLength - 8)]);
        expect(roots(bytes)).toMatchObject({ messages: 1, malformedAt: whole.byteLength });
        expect(roots(concatBytes([whole, whole.subarray(0, 4)]))).toMatchObject({
            messages: 1,
            malformedAt: whole.byteLength,
        });
    });

    it("treats an implausible segment count as broken framing, not as a message", () => {
        const bytes = new Uint8Array(64);
        new DataView(bytes.buffer).setUint32(0, 100_000, true);
        expect(roots(bytes)).toMatchObject({ messages: 0, malformedAt: 0 });
    });

    it("counts a message whose root is not a struct without visiting it", () => {
        const bytes = capnpMessage({ data: structData(1) });
        new DataView(bytes.buffer).setUint32(8, 1, true); // root pointer kind 1 (list)
        expect(roots(bytes)).toMatchObject({ roots: [], messages: 1, malformedAt: null });
    });
});
