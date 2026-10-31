import { describe, expect, it } from "vitest";

import type { AccelSample, GpsRecord } from "../parsers/types.js";
import {
    accelColumnsByteLength,
    gpsRecordColumnsByteLength,
    isValidAccelColumns,
    isValidGpsRecordColumns,
    packAccelColumns,
    packGpsRecordColumns,
    unpackAccelColumns,
    unpackGpsRecordColumns,
} from "./gps-columns.js";
import type { CachedAccelColumns, CachedEmbeddedGpsRecord, CachedGpsRecordColumns } from "./types.js";

const VIDEO_KEY = "restoring-session\u0000CARD/clip.mp4";

function baseRecord(index: number): GpsRecord {
    return {
        unixSeconds: 1_753_900_000 + index,
        active: index % 2 === 0,
        lat: 52.5 + index * 1e-5,
        lon: 13.4 - index * 1e-5,
        bearingDeg: (index * 7) % 360,
        speedMs: index * 0.25,
        accelXg: 0.01 * index,
        accelYg: -0.02 * index,
        accelZg: 0.5,
        mp4Filename: "clip.mp4",
    };
}

/** Every combination of the optional persisted fields, absent included. */
function optionalFieldCombinations(): GpsRecord[] {
    const speedSources = [undefined, "measured", "estimated", "unavailable"] as const;
    const trackSegments = [undefined, 0, 7];
    const timeUnsyncedValues = [undefined, false, true];
    const relStartValues = [undefined, 0, 12.5];
    const records: GpsRecord[] = [];
    for (const speedSource of speedSources) {
        for (const trackSegment of trackSegments) {
            for (const timeUnsynced of timeUnsyncedValues) {
                for (const relStartSeconds of relStartValues) {
                    const record = baseRecord(records.length);
                    if (speedSource !== undefined) record.speedSource = speedSource;
                    if (trackSegment !== undefined) record.trackSegment = trackSegment;
                    if (timeUnsynced !== undefined) record.timeUnsynced = timeUnsynced;
                    if (relStartSeconds !== undefined) record.relStartSeconds = relStartSeconds;
                    records.push(record);
                }
            }
        }
    }
    return records;
}

function withVideoKey(records: readonly GpsRecord[]): GpsRecord[] {
    return records.map((record) => ({ ...record, videoKey: VIDEO_KEY }));
}

describe("packGpsRecordColumns / unpackGpsRecordColumns", () => {
    it("round-trips every optional-field combination with absent fields left absent", () => {
        const records = optionalFieldCombinations();
        const columns = packGpsRecordColumns(records);

        expect(isValidGpsRecordColumns(columns)).toBe(true);
        // toStrictEqual fails on `key: undefined` where the source had no key.
        expect(unpackGpsRecordColumns(columns, VIDEO_KEY)).toStrictEqual(withVideoKey(records));
    });

    it("round-trips through structured clone, the IndexedDB storage path", () => {
        const records = optionalFieldCombinations();
        const stored = structuredClone(packGpsRecordColumns(records));

        expect(isValidGpsRecordColumns(stored)).toBe(true);
        expect(unpackGpsRecordColumns(stored, VIDEO_KEY)).toStrictEqual(withVideoKey(records));
    });

    it("restores every persisted field when all of them are set", () => {
        // Required<> makes a new GpsRecord field fail typecheck here until the
        // codec stores it or SessionOnlyGpsField declares it session-only.
        const record: Required<CachedEmbeddedGpsRecord> = {
            unixSeconds: 1_753_900_000.25,
            active: true,
            lat: -33.9,
            lon: 151.2,
            bearingDeg: 359.5,
            speedMs: 27.8,
            speedSource: "estimated",
            trackSegment: 3,
            accelXg: 0.1,
            accelYg: -0.2,
            accelZg: 0.3,
            mp4Filename: "FILE0001.MP4",
            timeUnsynced: true,
            relStartSeconds: 42.5,
        };

        expect(unpackGpsRecordColumns(packGpsRecordColumns([record]), VIDEO_KEY)).toStrictEqual([
            { ...record, videoKey: VIDEO_KEY },
        ]);
    });

    it("drops session-only fields and stores the parser's own time axis", () => {
        const record: Required<GpsRecord> = {
            unixSeconds: 1_753_882_000,
            active: true,
            lat: 1,
            lon: 2,
            bearingDeg: 3,
            speedMs: 4,
            speedSource: "measured",
            trackSegment: 0,
            trackSegmentSource: "gpsdata.txt",
            accelXg: 0,
            accelYg: 0,
            accelZg: 0,
            mp4Filename: "clip.mp4",
            videoKey: "previous-session",
            recordingAssociation: { startUtc: 90, extractorId: "session-log" },
            timeAssociation: { sourcePath: "GPSData.txt", extractorId: "csv-70mai" },
            timeUnsynced: false,
            relStartSeconds: 0,
            externalTrack: true,
            externalTrackKey: "manual-gpx",
            localClockOffsetAppliedSec: 18_000,
        };

        const [restored] = unpackGpsRecordColumns(packGpsRecordColumns([record]), VIDEO_KEY);

        expect(restored).toStrictEqual({
            unixSeconds: 1_753_900_000,
            active: true,
            lat: 1,
            lon: 2,
            bearingDeg: 3,
            speedMs: 4,
            speedSource: "measured",
            trackSegment: 0,
            accelXg: 0,
            accelYg: 0,
            accelZg: 0,
            mp4Filename: "clip.mp4",
            videoKey: VIDEO_KEY,
            timeUnsynced: false,
            relStartSeconds: 0,
        });
    });

    it("keeps negative zero and extreme finite values bit-exact", () => {
        const record: GpsRecord = {
            ...baseRecord(0),
            lat: -0,
            lon: Number.MIN_VALUE,
            speedMs: Number.MAX_VALUE,
            accelXg: -0,
            trackSegment: -0,
            relStartSeconds: -1e-300,
        };

        const [restored] = unpackGpsRecordColumns(packGpsRecordColumns([record]), VIDEO_KEY);

        expect(Object.is(restored?.lat, -0), "lat -0").toBe(true);
        expect(Object.is(restored?.accelXg, -0), "accelXg -0").toBe(true);
        expect(Object.is(restored?.trackSegment, -0), "trackSegment -0").toBe(true);
        expect(restored?.lon).toBe(Number.MIN_VALUE);
        expect(restored?.speedMs).toBe(Number.MAX_VALUE);
        expect(restored?.relStartSeconds).toBe(-1e-300);
    });

    it("stores each distinct filename once", () => {
        const records = ["a.mp4", "b.mp4", "a.mp4", "a.mp4", "b.mp4"].map((mp4Filename, index) => ({
            ...baseRecord(index),
            mp4Filename,
        }));

        const columns = packGpsRecordColumns(records);

        expect(columns.mp4Filenames).toEqual(["a.mp4", "b.mp4"]);
        expect([...columns.mp4FilenameIndex]).toEqual([0, 1, 0, 0, 1]);
        expect(unpackGpsRecordColumns(columns, VIDEO_KEY).map((record) => record.mp4Filename)).toEqual(
            records.map((record) => record.mp4Filename),
        );
    });

    it("allocates an optional numeric column only when some record has the field", () => {
        const plain = packGpsRecordColumns([baseRecord(0), baseRecord(1)]);
        expect(plain).not.toHaveProperty("trackSegment");
        expect(plain).not.toHaveProperty("relStartSeconds");

        const mixed = packGpsRecordColumns([baseRecord(0), { ...baseRecord(1), trackSegment: 2 }]);
        expect(mixed.trackSegment).toHaveLength(2);
        expect(mixed).not.toHaveProperty("relStartSeconds");
        const restored = unpackGpsRecordColumns(mixed, VIDEO_KEY);
        expect(restored[0]).not.toHaveProperty("trackSegment");
        expect(restored[1]?.trackSegment).toBe(2);
    });

    it("round-trips an empty record list", () => {
        const columns = packGpsRecordColumns([]);

        expect(isValidGpsRecordColumns(columns)).toBe(true);
        expect(unpackGpsRecordColumns(columns, VIDEO_KEY)).toEqual([]);
        expect(columns.mp4Filenames).toEqual([]);
    });

    it("copies values, so later session mutation cannot reach the columns", () => {
        const record = baseRecord(0);
        const columns = packGpsRecordColumns([record]);
        record.unixSeconds = 0;
        record.lat = 0;

        const [restored] = unpackGpsRecordColumns(columns, VIDEO_KEY);
        expect(restored?.unixSeconds).toBe(1_753_900_000);
        expect(restored?.lat).toBe(52.5);
    });
});

describe("isValidGpsRecordColumns", () => {
    function validColumns(): CachedGpsRecordColumns {
        return packGpsRecordColumns([
            { ...baseRecord(0), trackSegment: 1, relStartSeconds: 0.5, timeUnsynced: true, speedSource: "measured" },
            { ...baseRecord(1), mp4Filename: "other.mp4" },
        ]);
    }

    it("accepts what the packer writes", () => {
        expect(isValidGpsRecordColumns(validColumns())).toBe(true);
    });

    it("rejects malformed column sets", () => {
        const corruptions: Record<string, (columns: CachedGpsRecordColumns) => unknown> = {
            "missing required column": (columns) => {
                const { lat: _lat, ...rest } = columns;
                return rest;
            },
            "plain array column": (columns) => ({ ...columns, lon: [...columns.lon] }),
            "float32 column": (columns) => ({ ...columns, speedMs: Float32Array.from(columns.speedMs) }),
            "short column": (columns) => ({ ...columns, bearingDeg: columns.bearingDeg.subarray(1) }),
            "short flags": (columns) => ({ ...columns, flags: columns.flags.subarray(1) }),
            "signed flags": (columns) => ({ ...columns, flags: Int8Array.from(columns.flags) }),
            "short speed sources": (columns) => ({ ...columns, speedSource: new Uint8Array(1) }),
            "uint16 filename index": (columns) => ({
                ...columns,
                mp4FilenameIndex: Uint16Array.from(columns.mp4FilenameIndex),
            }),
            "short optional column": (columns) => ({ ...columns, trackSegment: new Float64Array(1) }),
            "array optional column": (columns) => ({ ...columns, relStartSeconds: [0.5, 0] }),
            "NaN time": (columns) => {
                columns.unixSeconds[1] = Number.NaN;
                return columns;
            },
            "infinite accel": (columns) => {
                columns.accelZg[0] = Number.NEGATIVE_INFINITY;
                return columns;
            },
            "unknown flag bit": (columns) => {
                columns.flags[1] = columns.flags[1]! | 0x80;
                return columns;
            },
            "timeUnsynced value without presence": (columns) => {
                // Record 1 carries no timeUnsynced, so only the value bit is set.
                columns.flags[1] = columns.flags[1]! | (1 << 2);
                return columns;
            },
            "unknown speed-source code": (columns) => {
                columns.speedSource[0] = 4;
                return columns;
            },
            "filename index past the dictionary": (columns) => {
                columns.mp4FilenameIndex[1] = 2;
                return columns;
            },
            "non-string filename": (columns) => ({ ...columns, mp4Filenames: ["clip.mp4", 7] }),
            "dictionary not an array": (columns) => ({ ...columns, mp4Filenames: "clip.mp4" }),
            "trackSegment presence without its column": (columns) => {
                const { trackSegment: _trackSegment, ...rest } = columns;
                return rest;
            },
            "fractional trackSegment": (columns) => {
                columns.trackSegment![0] = 1.5;
                return columns;
            },
            "negative trackSegment": (columns) => {
                columns.trackSegment![0] = -1;
                return columns;
            },
            "relStartSeconds presence without its column": (columns) => {
                const { relStartSeconds: _relStartSeconds, ...rest } = columns;
                return rest;
            },
            "infinite relStartSeconds": (columns) => {
                columns.relStartSeconds![0] = Number.POSITIVE_INFINITY;
                return columns;
            },
        };
        for (const [label, corrupt] of Object.entries(corruptions)) {
            expect(isValidGpsRecordColumns(corrupt(validColumns())), label).toBe(false);
        }
        expect(isValidGpsRecordColumns(null), "null").toBe(false);
        expect(isValidGpsRecordColumns([baseRecord(0)]), "legacy record array").toBe(false);
    });

    it("keeps a NaN optional value from a parser rejected instead of reading it back as absent", () => {
        const nanTrackSegment = packGpsRecordColumns([{ ...baseRecord(0), trackSegment: Number.NaN }]);
        const nanRelStart = packGpsRecordColumns([{ ...baseRecord(0), relStartSeconds: Number.NaN }]);

        expect(isValidGpsRecordColumns(nanTrackSegment), "trackSegment").toBe(false);
        expect(isValidGpsRecordColumns(nanRelStart), "relStartSeconds").toBe(false);
    });
});

describe("accel columns", () => {
    const samples: AccelSample[] = [
        { msSinceStart: 0, accelXg: -0, accelYg: 0.01, accelZg: 1 },
        { msSinceStart: 10, accelXg: 0.2, accelYg: -0.3, accelZg: 0.98 },
        { msSinceStart: 20.5, accelXg: 0, accelYg: 0, accelZg: 1.02 },
    ];

    it("round-trips samples, including through structured clone", () => {
        const stored = structuredClone(packAccelColumns(samples));

        expect(isValidAccelColumns(stored)).toBe(true);
        const restored = unpackAccelColumns(stored);
        expect(restored).toStrictEqual(samples);
        expect(Object.is(restored[0]?.accelXg, -0), "accelXg -0").toBe(true);
    });

    it("round-trips an empty sample list", () => {
        const columns = packAccelColumns([]);
        expect(isValidAccelColumns(columns)).toBe(true);
        expect(unpackAccelColumns(columns)).toEqual([]);
    });

    it("rejects malformed accel columns", () => {
        const corruptions: Record<string, (columns: CachedAccelColumns) => unknown> = {
            "missing column": (columns) => {
                const { accelYg: _accelYg, ...rest } = columns;
                return rest;
            },
            "short column": (columns) => ({ ...columns, accelZg: columns.accelZg.subarray(1) }),
            "plain array column": (columns) => ({ ...columns, msSinceStart: [...columns.msSinceStart] }),
            "NaN sample": (columns) => {
                columns.accelXg[2] = Number.NaN;
                return columns;
            },
        };
        for (const [label, corrupt] of Object.entries(corruptions)) {
            expect(isValidAccelColumns(corrupt(packAccelColumns(samples))), label).toBe(false);
        }
        expect(isValidAccelColumns(samples), "legacy sample array").toBe(false);
    });
});

describe("column byte lengths", () => {
    it("counts typed-array payload and the filename dictionary", () => {
        const records = [baseRecord(0), { ...baseRecord(1), trackSegment: 4 }];
        // Eight required Float64 columns, the trackSegment column, two byte
        // columns, a Uint32 index, and "clip.mp4" in UTF-16.
        expect(gpsRecordColumnsByteLength(packGpsRecordColumns(records))).toBe(2 * (9 * 8 + 1 + 1 + 4) + 8 * 2);
        expect(
            accelColumnsByteLength(packAccelColumns([{ msSinceStart: 0, accelXg: 0, accelYg: 0, accelZg: 1 }])),
        ).toBe(4 * 8);
    });
});
