// Decoder for the parts of an openpilot log (qlog/rlog after zstd) that a
// viewer needs: GPS fixes, the frame index of every camera stream, and the
// device's wall clock. The log is a stream of Cap'n Proto `Event` messages
// (openpilot/cereal/log.capnp). The byte offsets below are that schema's
// layout, worked out by hand from the field ordinals and checked against real
// logs: discriminant counts match the service rates (1200 frame-index events
// per camera per minute, 1 Hz GPS), and the frame index sums to each video
// file's size minus its leading parameter sets. Cap'n Proto only ever appends
// fields, so these offsets hold for every schema revision that has the fields.
// Full derivation: docs/format-openpilot.md.

import type { OpenpilotStream } from "../filename/_patterns.js";
import {
    type CapnpStruct,
    capnpBit,
    capnpF32,
    capnpF64,
    capnpI32,
    capnpI64,
    capnpStructAt,
    capnpU16,
    capnpU32,
    capnpU64,
    walkCapnpMessages,
} from "./capnp.js";

// Event: logMonoTime UInt64 @0 opens the data section; the union discriminant
// (allocated with the union's second member, @2) takes the next word. Every
// union member is a pointer, sharing pointer slot 0.
const EVENT_LOG_MONO_TIME = 0;
const EVENT_DISCRIMINANT = 8;
// Event.valid Bool @67 = true takes the first bit after the discriminant.
// Cap'n Proto stores a field XOR its default, so a set bit means invalid.
const EVENT_INVALID_BIT = 80;

// Discriminant = rank of the member's ordinal within the union. The union holds
// every ordinal from @1 upward except @67 (Event.valid), so the value is
// ordinal - 1 below @67 and ordinal - 2 above it.
const EVENT_GPS_LOCATION = 20; // gpsLocation @21 (Qualcomm receiver)
const EVENT_GPS_LOCATION_EXTERNAL = 47; // gpsLocationExternal @48 (u-blox receiver)
const EVENT_CLOCKS = 34; // clocks @35
const ENCODE_INDEX_STREAMS = new Map<number, OpenpilotCameraStream>([
    [14, "fcamera"], // narrowRoadEncodeIdx @15
    [74, "dcamera"], // cabinEncodeIdx @76
    [75, "ecamera"], // wideRoadEncodeIdx @77
    [88, "qcamera"], // qNarrowRoadEncodeIdx @90
]);

// GpsLocationData: flags u16 @0 [0,2), source u16 @8 [2,4), speed f32 @4 [4,8),
// latitude f64 @1 [8,16), longitude f64 @2 [16,24), altitude f64 @3 [24,32),
// bearingDeg f32 @5 [32,36), horizontalAccuracy f32 @6 [36,40),
// unixTimestampMillis i64 @7 [40,48), hasFix bool @13 at bit 480.
const GPS_SPEED = 4;
const GPS_LATITUDE = 8;
const GPS_LONGITUDE = 16;
const GPS_ALTITUDE = 24;
const GPS_BEARING = 32;
const GPS_HORIZONTAL_ACCURACY = 36;
const GPS_UNIX_MILLIS = 40;
const GPS_HAS_FIX_BIT = 480;

// EncodeIndex: frameId u32 @0 [0,4), type u16 @1 [4,6), encodeId u32 @2 [8,12),
// segmentNum i32 @3 [12,16), segmentId u32 @4 [16,20), segmentIdEncode u32 @5
// [20,24), timestampSof u64 @6 [24,32), timestampEof u64 @7 [32,40),
// flags u32 @8 [40,44), len u32 @9 [44,48).
const ENCODE_SEGMENT_NUM = 12;
const ENCODE_SEGMENT_ID = 16;
const ENCODE_TIMESTAMP_SOF = 24;

// Clocks: wallTimeNanos u64 @3 sits after the four deprecated u64 fields @0..@2.
const CLOCKS_WALL_TIME_NANOS = 24;

export type OpenpilotCameraStream = Extract<OpenpilotStream, "fcamera" | "ecamera" | "dcamera" | "qcamera">;

export interface OpenpilotGpsFix {
    /** Event.logMonoTime: when the fix was published, on the device's boot clock. */
    monoNs: number;
    unixMillis: number;
    lat: number;
    lon: number;
    altitudeM: number;
    speedMs: number;
    bearingDeg: number;
    horizontalAccuracyM: number;
    hasFix: boolean;
}

/** Frames of one camera stream within one segment, from its encode index. */
export interface OpenpilotFrameIndex {
    segment: number;
    frameCount: number;
    /** Start-of-frame time of the segment's first frame, on the boot clock.
     *  null when that frame's index entry is missing from the log. */
    firstFrameSofNs: number | null;
}

export interface OpenpilotLog {
    gps: OpenpilotGpsFix[];
    frames: Map<OpenpilotCameraStream, OpenpilotFrameIndex>;
    /** Clocks events: the device's system clock against its boot clock.
     *  isValid is openpilot's own verdict on whether that clock was set. */
    wallClock: Array<{ monoNs: number; unixNanos: number; isValid: boolean }>;
    messages: number;
    /** See CapnpWalkResult.malformedAt. */
    malformedAt: number | null;
}

/**
 * Decodes the events this viewer uses from a decompressed openpilot log. Other
 * events are skipped. Frame indexes from a different segment number than the
 * majority (none were observed) are ignored rather than mixed in.
 */
export function decodeOpenpilotLog(bytes: Uint8Array): OpenpilotLog {
    const gps: OpenpilotGpsFix[] = [];
    const wallClock: OpenpilotLog["wallClock"] = [];
    const frameEntries = new Map<OpenpilotCameraStream, Array<{ segment: number; id: number; sofNs: number }>>();
    const walk = walkCapnpMessages(bytes, (event) => {
        const discriminant = capnpU16(event, EVENT_DISCRIMINANT);
        const monoNs = capnpU64(event, EVENT_LOG_MONO_TIME);
        if (discriminant === EVENT_GPS_LOCATION || discriminant === EVENT_GPS_LOCATION_EXTERNAL) {
            const fix = capnpStructAt(event, 0);
            if (fix) gps.push(readGpsFix(fix, monoNs));
            return;
        }
        if (discriminant === EVENT_CLOCKS) {
            const clocks = capnpStructAt(event, 0);
            if (clocks) {
                wallClock.push({
                    monoNs,
                    unixNanos: capnpU64(clocks, CLOCKS_WALL_TIME_NANOS),
                    isValid: !capnpBit(event, EVENT_INVALID_BIT),
                });
            }
            return;
        }
        const stream = ENCODE_INDEX_STREAMS.get(discriminant);
        if (stream === undefined) return;
        const entry = capnpStructAt(event, 0);
        if (!entry) return;
        let entries = frameEntries.get(stream);
        if (!entries) {
            entries = [];
            frameEntries.set(stream, entries);
        }
        entries.push({
            segment: capnpI32(entry, ENCODE_SEGMENT_NUM),
            id: capnpU32(entry, ENCODE_SEGMENT_ID),
            sofNs: capnpU64(entry, ENCODE_TIMESTAMP_SOF),
        });
    });

    const frames = new Map<OpenpilotCameraStream, OpenpilotFrameIndex>();
    for (const [stream, entries] of frameEntries) {
        const bySegment = new Map<number, number>();
        for (const entry of entries) bySegment.set(entry.segment, (bySegment.get(entry.segment) ?? 0) + 1);
        const segment = [...bySegment].sort((a, b) => b[1] - a[1])[0]![0];
        const ids = new Set<number>();
        let firstFrameSofNs: number | null = null;
        for (const entry of entries) {
            if (entry.segment !== segment) continue;
            ids.add(entry.id);
            if (entry.id === 0) firstFrameSofNs = entry.sofNs;
        }
        frames.set(stream, { segment, frameCount: ids.size, firstFrameSofNs });
    }
    return { gps, frames, wallClock, messages: walk.messages, malformedAt: walk.malformedAt };
}

function readGpsFix(fix: CapnpStruct, monoNs: number): OpenpilotGpsFix {
    return {
        monoNs,
        unixMillis: capnpI64(fix, GPS_UNIX_MILLIS),
        lat: capnpF64(fix, GPS_LATITUDE),
        lon: capnpF64(fix, GPS_LONGITUDE),
        altitudeM: capnpF64(fix, GPS_ALTITUDE),
        speedMs: capnpF32(fix, GPS_SPEED),
        bearingDeg: capnpF32(fix, GPS_BEARING),
        horizontalAccuracyM: capnpF32(fix, GPS_HORIZONTAL_ACCURACY),
        hasFix: capnpBit(fix, GPS_HAS_FIX_BIT),
    };
}
