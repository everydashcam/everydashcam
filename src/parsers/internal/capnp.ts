// Minimal Cap'n Proto reader for unpacked message streams: each message is a
// segment table followed by its segments (the "flat array" encoding,
// https://capnproto.org/encoding.html), and messages follow each other back to
// back. It covers what a log decoder needs and nothing more: walk the messages,
// follow struct pointers, read primitive fields at their byte offsets.
//
// Field offsets come from the schema's layout, worked out by the caller and
// documented at its call site. A field past the end of a struct's data section
// reads as zero - the encoding's rule for data written by an older schema.
// Far pointers (only needed by multi-segment messages) and non-struct
// pointers read as null.

export interface CapnpStruct {
    view: DataView;
    /** Byte offset of the data section within view. */
    dataOffset: number;
    dataBytes: number;
    /** Byte offset of the pointer section within view. */
    pointerOffset: number;
    pointerCount: number;
}

export interface CapnpWalkResult {
    messages: number;
    /** Byte offset where the framing stopped making sense (a truncated or
     *  corrupt tail), or null when every byte belonged to a message. */
    malformedAt: number | null;
}

// A real segment table is tiny; a huge count means the bytes are not framing.
const MAX_SEGMENTS = 512;

/**
 * Walks every message of the stream and hands its root struct to visit.
 * A message whose root is not a readable struct is counted but not visited.
 * Stops at the first framing that overruns the bytes.
 */
export function walkCapnpMessages(bytes: Uint8Array, visit: (root: CapnpStruct) => void): CapnpWalkResult {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let pos = 0;
    let messages = 0;
    while (pos < bytes.byteLength) {
        if (pos + 8 > bytes.byteLength) return { messages, malformedAt: pos };
        const segmentCount = view.getUint32(pos, true) + 1;
        if (segmentCount > MAX_SEGMENTS) return { messages, malformedAt: pos };
        const tableBytes = Math.ceil((4 + 4 * segmentCount) / 8) * 8;
        if (pos + tableBytes > bytes.byteLength) return { messages, malformedAt: pos };
        let totalWords = 0;
        for (let i = 0; i < segmentCount; i++) totalWords += view.getUint32(pos + 4 + 4 * i, true);
        const firstSegmentWords = view.getUint32(pos + 4, true);
        const segmentStart = pos + tableBytes;
        const end = segmentStart + 8 * totalWords;
        if (end > bytes.byteLength || firstSegmentWords === 0) return { messages, malformedAt: pos };
        const segment = new DataView(bytes.buffer, bytes.byteOffset + segmentStart, 8 * firstSegmentWords);
        const root = structFromPointer(segment, 0);
        if (root) visit(root);
        messages++;
        pos = end;
    }
    return { messages, malformedAt: null };
}

/** Follows the struct pointer in slot `index` of s's pointer section. */
export function capnpStructAt(s: CapnpStruct, index: number): CapnpStruct | null {
    if (index >= s.pointerCount) return null;
    return structFromPointer(s.view, s.pointerOffset + 8 * index);
}

export function capnpU8(s: CapnpStruct, byteOffset: number): number {
    return inData(s, byteOffset, 1) ? s.view.getUint8(s.dataOffset + byteOffset) : 0;
}

export function capnpI8(s: CapnpStruct, byteOffset: number): number {
    return inData(s, byteOffset, 1) ? s.view.getInt8(s.dataOffset + byteOffset) : 0;
}

export function capnpU16(s: CapnpStruct, byteOffset: number): number {
    return inData(s, byteOffset, 2) ? s.view.getUint16(s.dataOffset + byteOffset, true) : 0;
}

export function capnpU32(s: CapnpStruct, byteOffset: number): number {
    return inData(s, byteOffset, 4) ? s.view.getUint32(s.dataOffset + byteOffset, true) : 0;
}

export function capnpI32(s: CapnpStruct, byteOffset: number): number {
    return inData(s, byteOffset, 4) ? s.view.getInt32(s.dataOffset + byteOffset, true) : 0;
}

/** UInt64 as a number: exact below 2^53, which holds for nanosecond clocks
 *  until year 2255 and for boot-relative nanoseconds for 104 days. */
export function capnpU64(s: CapnpStruct, byteOffset: number): number {
    return inData(s, byteOffset, 8) ? Number(s.view.getBigUint64(s.dataOffset + byteOffset, true)) : 0;
}

export function capnpI64(s: CapnpStruct, byteOffset: number): number {
    return inData(s, byteOffset, 8) ? Number(s.view.getBigInt64(s.dataOffset + byteOffset, true)) : 0;
}

export function capnpF32(s: CapnpStruct, byteOffset: number): number {
    return inData(s, byteOffset, 4) ? s.view.getFloat32(s.dataOffset + byteOffset, true) : 0;
}

export function capnpF64(s: CapnpStruct, byteOffset: number): number {
    return inData(s, byteOffset, 8) ? s.view.getFloat64(s.dataOffset + byteOffset, true) : 0;
}

/** Bool stored at bit `bit` of the data section (no default XOR applied). */
export function capnpBit(s: CapnpStruct, bit: number): boolean {
    const byteOffset = bit >> 3;
    return inData(s, byteOffset, 1) && ((s.view.getUint8(s.dataOffset + byteOffset) >> (bit & 7)) & 1) === 1;
}

function inData(s: CapnpStruct, byteOffset: number, size: number): boolean {
    return byteOffset + size <= s.dataBytes;
}

function structFromPointer(view: DataView, pointerPos: number): CapnpStruct | null {
    if (pointerPos + 8 > view.byteLength) return null;
    const lo = view.getUint32(pointerPos, true);
    const hi = view.getUint32(pointerPos + 4, true);
    // Kind 0 = struct; a zero word is the null pointer.
    if ((lo & 3) !== 0 || (lo === 0 && hi === 0)) return null;
    const offsetWords = lo >> 2; // arithmetic shift keeps the 30-bit sign
    const dataWords = hi & 0xffff;
    const pointerCount = hi >>> 16;
    const dataOffset = pointerPos + 8 + 8 * offsetWords;
    const pointerOffset = dataOffset + 8 * dataWords;
    if (dataOffset < 0 || pointerOffset + 8 * pointerCount > view.byteLength) return null;
    return { view, dataOffset, dataBytes: 8 * dataWords, pointerOffset, pointerCount };
}
