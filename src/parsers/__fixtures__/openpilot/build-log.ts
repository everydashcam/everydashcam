// Test-only builder for synthetic openpilot logs: single-segment Cap'n Proto
// messages (https://capnproto.org/encoding.html) holding `Event` structs.
//
// The field layout is restated here from openpilot/cereal/log.capnp instead of
// imported from the decoder, so the decoder tests check it independently.
// Events carry only the members the decoder reads; real ones are larger, which
// the decoder must tolerate anyway (fields are read by offset).

import type { OpenpilotCameraStream } from "../../internal/openpilot-log.js";

export interface CapnpStructSpec {
    /** Data section; its length must be a multiple of 8. */
    data: Uint8Array;
    pointers?: ReadonlyArray<CapnpStructSpec | null>;
}

/** A data section of `words` words, filled through a little-endian view. */
export function structData(words: number, fill: (view: DataView) => void = () => {}): Uint8Array {
    const data = new Uint8Array(words * 8);
    fill(new DataView(data.buffer));
    return data;
}

function sizeWords(spec: CapnpStructSpec): number {
    const own = spec.data.byteLength / 8 + (spec.pointers?.length ?? 0);
    return own + (spec.pointers ?? []).reduce((sum, child) => sum + (child ? sizeWords(child) : 0), 0);
}

/** Writes a struct at `at` and the pointer to it at `pointerPos`; returns the next free byte. */
function writeStruct(bytes: Uint8Array, pointerPos: number, spec: CapnpStructSpec, at: number): number {
    if (spec.data.byteLength % 8 !== 0) throw new Error("capnp data section must be whole words");
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const dataWords = spec.data.byteLength / 8;
    const pointerCount = spec.pointers?.length ?? 0;
    view.setUint32(pointerPos, ((at - (pointerPos + 8)) / 8) << 2, true);
    view.setUint32(pointerPos + 4, dataWords | (pointerCount << 16), true);
    bytes.set(spec.data, at);
    let next = at + 8 * (dataWords + pointerCount);
    spec.pointers?.forEach((child, i) => {
        if (child) next = writeStruct(bytes, at + 8 * dataWords + 8 * i, child, next);
    });
    return next;
}

/** One single-segment message whose root is `root`. */
export function capnpMessage(root: CapnpStructSpec): Uint8Array {
    const words = 1 + sizeWords(root);
    const out = new Uint8Array(8 + 8 * words);
    const view = new DataView(out.buffer);
    view.setUint32(0, 0, true); // segment count - 1
    view.setUint32(4, words, true);
    writeStruct(out.subarray(8), 0, root, 8);
    return out;
}

export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
    const out = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
    let offset = 0;
    for (const part of parts) {
        out.set(part, offset);
        offset += part.byteLength;
    }
    return out;
}

// Event: logMonoTime u64 at byte 0, union discriminant u16 at byte 8, the
// union's pointer in slot 0. Discriminant = ordinal - 1 below @67, - 2 above.
const DISCRIMINANT = {
    gpsLocation: 20,
    gpsLocationExternal: 47,
    clocks: 34,
    fcamera: 14,
    dcamera: 74,
    ecamera: 75,
    qcamera: 88,
} as const;

/** An Event with the given union member. */
export function eventMessage(
    monoNs: number,
    discriminant: number,
    payload: CapnpStructSpec | null,
    isValid = true,
): Uint8Array {
    return capnpMessage({
        data: structData(2, (view) => {
            view.setBigUint64(0, BigInt(monoNs), true);
            view.setUint16(8, discriminant, true);
            // Event.valid (default true) is stored inverted at bit 80.
            if (!isValid) view.setUint8(10, 1);
        }),
        pointers: [payload],
    });
}

export interface GpsFixSpec {
    monoNs: number;
    unixMillis: number;
    lat: number;
    lon: number;
    altitudeM?: number;
    speedMs?: number;
    bearingDeg?: number;
    horizontalAccuracyM?: number;
    hasFix?: boolean;
    /** gpsLocationExternal (u-blox) rather than gpsLocation (Qualcomm). */
    external?: boolean;
}

/** GpsLocationData: speed f32 @4, lat/lon/alt f64 @8/16/24, bearing f32 @32,
 *  accuracy f32 @36, unixTimestampMillis i64 @40, hasFix at bit 480. */
export function gpsEvent(fix: GpsFixSpec): Uint8Array {
    const payload = structData(8, (view) => {
        view.setFloat32(4, fix.speedMs ?? 0, true);
        view.setFloat64(8, fix.lat, true);
        view.setFloat64(16, fix.lon, true);
        view.setFloat64(24, fix.altitudeM ?? 0, true);
        view.setFloat32(32, fix.bearingDeg ?? 0, true);
        view.setFloat32(36, fix.horizontalAccuracyM ?? 0, true);
        view.setBigInt64(40, BigInt(fix.unixMillis), true);
        if (fix.hasFix ?? true) view.setUint8(60, 1);
    });
    const discriminant = fix.external ? DISCRIMINANT.gpsLocationExternal : DISCRIMINANT.gpsLocation;
    return eventMessage(fix.monoNs, discriminant, { data: payload });
}

/** EncodeIndex: segmentNum i32 @12, segmentId u32 @16, timestampSof u64 @24. */
export function encodeIndexEvent(
    stream: OpenpilotCameraStream,
    entry: { segmentNum: number; segmentId: number; sofNs: number; monoNs?: number },
): Uint8Array {
    const payload = structData(6, (view) => {
        view.setInt32(12, entry.segmentNum, true);
        view.setUint32(16, entry.segmentId, true);
        view.setBigUint64(24, BigInt(entry.sofNs), true);
    });
    return eventMessage(entry.monoNs ?? entry.sofNs + 40_000_000, DISCRIMINANT[stream], { data: payload });
}

/** Clocks: wallTimeNanos u64 @24, after three deprecated words. */
export function clocksEvent(monoNs: number, wallTimeNanos: number, isValid = true): Uint8Array {
    const payload = structData(4, (view) => view.setBigUint64(24, BigInt(wallTimeNanos), true));
    return eventMessage(monoNs, DISCRIMINANT.clocks, { data: payload }, isValid);
}

/** Frame index entries of `frames` frames at 20 fps starting at `firstSofNs`. */
export function frameIndexEvents(
    stream: OpenpilotCameraStream,
    segmentNum: number,
    frames: number,
    firstSofNs: number,
): Uint8Array[] {
    return Array.from({ length: frames }, (_, segmentId) =>
        encodeIndexEvent(stream, { segmentNum, segmentId, sofNs: firstSofNs + segmentId * 50_000_000 }),
    );
}
