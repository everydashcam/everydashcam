import { describe, expect, it } from "vitest";

import { packAccelColumns, packGpsRecordColumns } from "./gps-columns.js";
import { approxEntryBytes, buildCacheEntry, isCurrentCacheEntry, isQuotaFailure } from "./index-cache.js";
import {
    type CachedEmbeddedGps,
    type CachedRecordingMetadata,
    INDEX_CACHE_FORMAT,
    RECORDING_METADATA_CACHE_REVISION,
} from "./types.js";

const IDENTITY = "DASHCAM_SD/Normal/clip.mp4\u000016\u00001753900000000";

function metadata(repairBytes = 0): CachedRecordingMetadata {
    return {
        revision: RECORDING_METADATA_CACHE_REVISION,
        indexed: {
            durationSec: 60,
            createdUtc: new Date(1_753_900_000_000),
            codec: "avc",
            codecParam: "avc1",
            videoCodecString: null,
            rotation: 0,
            width: 1920,
            height: 1080,
            fps: 30,
            audio: { codec: "aac", channels: 1, sampleRate: 48_000 },
            needsHevcRemux: false,
            audioNeedsTranscode: false,
        },
        ...(repairBytes > 0
            ? {
                  repair: {
                      patchedMoov: new Uint8Array(repairBytes),
                      moovFileStart: 8,
                      moovFileEnd: 8 + repairBytes,
                      phantomNeutralized: [],
                      hvcc: null,
                  },
              }
            : {}),
    };
}

function embedded(recordCount = 1, accelCount = 0): CachedEmbeddedGps {
    return {
        status: "parsed",
        dispatchRevision: "revision",
        extractorId: "freegps",
        sourceIdentityKey: IDENTITY,
        recordColumns: packGpsRecordColumns(
            Array.from({ length: recordCount }, (_, i) => ({
                unixSeconds: 1_753_900_001 + i,
                active: true,
                lat: 52.1,
                lon: 13.4,
                bearingDeg: 90,
                speedMs: 13.9,
                accelXg: 0,
                accelYg: 0,
                accelZg: 0,
                mp4Filename: "clip.mp4",
            })),
        ),
        accelColumns: packAccelColumns(
            Array.from({ length: accelCount }, (_, i) => ({
                msSinceStart: i * 100,
                accelXg: 0,
                accelYg: 0,
                accelZg: 1,
            })),
        ),
    };
}

describe("buildCacheEntry", () => {
    it("stamps the storage format and keeps artifacts separate", () => {
        const meta = metadata();
        const gps = embedded();
        const entry = buildCacheEntry(IDENTITY, meta, gps);

        expect(entry.cacheFormat).toBe(INDEX_CACHE_FORMAT);
        expect(entry.identityKey).toBe(IDENTITY);
        expect(entry.metadata).toBe(meta);
        expect(entry.embeddedGps).toBe(gps);
        expect("candidate" in entry).toBe(false);
        expect("dependencyKey" in entry).toBe(false);
    });

    it("allows metadata-only entries when embedded parsing did not complete", () => {
        const entry = buildCacheEntry(IDENTITY, metadata(), undefined);
        expect(entry.embeddedGps).toBeUndefined();
    });
});

describe("isCurrentCacheEntry", () => {
    it("accepts the current artifact shape", () => {
        expect(isCurrentCacheEntry(buildCacheEntry(IDENTITY, metadata(), embedded()))).toBe(true);
    });

    it("rejects a legacy whole-candidate snapshot", () => {
        expect(
            isCurrentCacheEntry({
                identityKey: IDENTITY,
                version: 23,
                savedAt: 1,
                candidate: { records: [] },
            }),
        ).toBe(false);
    });
});

describe("approxEntryBytes", () => {
    it("grows with raw record and accel counts", () => {
        const sparse = approxEntryBytes(IDENTITY, metadata(), embedded(1));
        const dense = approxEntryBytes(IDENTITY, metadata(), embedded(200, 100));
        expect(dense).toBeGreaterThan(sparse * 10);
    });

    it("counts packed GPS by its column payload", () => {
        const empty = approxEntryBytes(IDENTITY, metadata(), embedded(0, 0));
        const dense = approxEntryBytes(IDENTITY, metadata(), embedded(1_000, 0));
        const perRecord = (dense - empty) / 1_000;
        // Eight Float64 columns plus the flag, speed-source and filename-index columns.
        expect(perRecord, "bytes per packed record").toBeGreaterThanOrEqual(70);
        expect(perRecord, "bytes per packed record").toBeLessThan(80);
    });

    it("counts the patched moov by raw length", () => {
        const withRepair = approxEntryBytes(IDENTITY, metadata(10_000), embedded());
        const without = approxEntryBytes(IDENTITY, metadata(), embedded());
        expect(withRepair - without).toBeGreaterThanOrEqual(10_000);
        expect(withRepair - without).toBeLessThan(15_000);
    });
});

describe("isQuotaFailure", () => {
    const quota = new DOMException("out of room", "QuotaExceededError");
    const abort = new DOMException("aborted", "AbortError");

    it("finds the quota rejection behind the abort that was actually thrown", () => {
        expect(isQuotaFailure([abort, quota, quota])).toBe(true);
    });

    it("finds it in the transaction error when the put rejection has not settled", () => {
        expect(isQuotaFailure([abort, undefined, quota])).toBe(true);
    });

    it("accepts the legacy numeric code", () => {
        expect(quota.code).toBe(22);
        expect(isQuotaFailure([quota])).toBe(true);
    });

    it("leaves a non-quota abort alone", () => {
        expect(isQuotaFailure([abort, undefined, abort])).toBe(false);
        expect(isQuotaFailure([new Error("QuotaExceededError")])).toBe(false);
        expect(isQuotaFailure([null, undefined])).toBe(false);
    });
});
