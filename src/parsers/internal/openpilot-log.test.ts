import { describe, expect, it } from "vitest";

import {
    capnpMessage,
    clocksEvent,
    concatBytes,
    encodeIndexEvent,
    eventMessage,
    frameIndexEvents,
    gpsEvent,
    structData,
} from "../__fixtures__/openpilot/build-log.js";
import { decodeOpenpilotLog } from "./openpilot-log.js";

const BOOT_NS = 3_000_000_000_000; // 50 minutes after boot

describe("decodeOpenpilotLog", () => {
    it("decodes every field of both GPS receivers' fixes", () => {
        const log = decodeOpenpilotLog(
            concatBytes([
                gpsEvent({
                    monoNs: BOOT_NS,
                    unixMillis: 1_793_000_000_123,
                    lat: 39.5,
                    lon: -77.25,
                    altitudeM: 120.5,
                    speedMs: 13.5,
                    bearingDeg: 271.5,
                    horizontalAccuracyM: 3.5,
                }),
                gpsEvent({
                    monoNs: BOOT_NS + 1e9,
                    unixMillis: 1_793_000_001_123,
                    lat: 39.25,
                    lon: -77.5,
                    hasFix: false,
                    external: true,
                }),
            ]),
        );
        expect(log.messages).toBe(2);
        expect(log.gps).toEqual([
            {
                monoNs: BOOT_NS,
                unixMillis: 1_793_000_000_123,
                lat: 39.5,
                lon: -77.25,
                altitudeM: 120.5,
                speedMs: 13.5,
                bearingDeg: 271.5,
                horizontalAccuracyM: 3.5,
                hasFix: true,
            },
            {
                monoNs: BOOT_NS + 1e9,
                unixMillis: 1_793_000_001_123,
                lat: 39.25,
                lon: -77.5,
                altitudeM: 0,
                speedMs: 0,
                bearingDeg: 0,
                horizontalAccuracyM: 0,
                hasFix: false,
            },
        ]);
    });

    it("counts each camera's frames and takes frame 0's start-of-frame time", () => {
        const log = decodeOpenpilotLog(
            concatBytes([
                ...frameIndexEvents("fcamera", 19, 40, BOOT_NS),
                ...frameIndexEvents("ecamera", 19, 39, BOOT_NS + 1_000_000),
                ...frameIndexEvents("dcamera", 19, 20, BOOT_NS + 2_000_000),
                ...frameIndexEvents("qcamera", 19, 40, BOOT_NS),
            ]),
        );
        expect(Object.fromEntries(log.frames)).toEqual({
            fcamera: { segment: 19, frameCount: 40, firstFrameSofNs: BOOT_NS },
            ecamera: { segment: 19, frameCount: 39, firstFrameSofNs: BOOT_NS + 1_000_000 },
            dcamera: { segment: 19, frameCount: 20, firstFrameSofNs: BOOT_NS + 2_000_000 },
            qcamera: { segment: 19, frameCount: 40, firstFrameSofNs: BOOT_NS },
        });
    });

    it("keeps the majority segment of a stream and counts a repeated frame once", () => {
        const log = decodeOpenpilotLog(
            concatBytes([
                encodeIndexEvent("fcamera", { segmentNum: 18, segmentId: 1199, sofNs: BOOT_NS - 50_000_000 }),
                ...frameIndexEvents("fcamera", 19, 5, BOOT_NS),
                encodeIndexEvent("fcamera", { segmentNum: 19, segmentId: 4, sofNs: BOOT_NS + 200_000_000 }),
            ]),
        );
        expect(log.frames.get("fcamera")).toEqual({ segment: 19, frameCount: 5, firstFrameSofNs: BOOT_NS });
    });

    it("leaves the first frame time unknown when frame 0 is missing from the log", () => {
        const log = decodeOpenpilotLog(concatBytes(frameIndexEvents("fcamera", 3, 5, BOOT_NS).slice(1)));
        expect(log.frames.get("fcamera")).toEqual({ segment: 3, frameCount: 4, firstFrameSofNs: null });
    });

    it("reads the system clock samples", () => {
        const log = decodeOpenpilotLog(clocksEvent(BOOT_NS, 1_793_000_000_000_000_000));
        expect(log.wallClock).toEqual([{ monoNs: BOOT_NS, unixNanos: 1_793_000_000_000_000_000 }]);
    });

    it("skips other events and events without a payload, counting them as messages", () => {
        const log = decodeOpenpilotLog(
            concatBytes([
                eventMessage(BOOT_NS, 0, { data: structData(1) }), // initData
                eventMessage(BOOT_NS, 20, null), // gpsLocation without payload
                capnpMessage({ data: structData(1) }), // an Event without its union word
                gpsEvent({ monoNs: BOOT_NS, unixMillis: 1_793_000_000_000, lat: 1, lon: 2 }),
            ]),
        );
        expect(log.messages).toBe(4);
        expect(log.gps).toHaveLength(1);
        expect(log.frames.size).toBe(0);
        expect(log.malformedAt).toBeNull();
    });

    it("keeps what precedes a corrupt tail and reports its offset", () => {
        const good = gpsEvent({ monoNs: BOOT_NS, unixMillis: 1_793_000_000_000, lat: 1, lon: 2 });
        const log = decodeOpenpilotLog(concatBytes([good, good.subarray(0, 20)]));
        expect(log.gps).toHaveLength(1);
        expect(log.malformedAt).toBe(good.byteLength);
    });
});
