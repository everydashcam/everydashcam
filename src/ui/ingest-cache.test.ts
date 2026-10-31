import { beforeEach, describe, expect, it, vi } from "vitest";

import { buildVideoAssociationIndex } from "../gps-association.js";
import { embeddedGpsDispatchRevision, noEmbeddedGpsDispatchRevision } from "../parsers/primitives/cache-revisions.js";
import type { ClassifiedFile } from "../parsers/registry-light.js";
import type { DispatchedEmbeddedGpsResult } from "../parsers/registry.js";
import type { VendorFile } from "../parsers/types.js";
import { fileIdentityKey, fileIdentityOf } from "../persist/identity.js";
import { buildCacheEntry } from "../persist/index-cache.js";
import { type CachedRecordingMetadata, RECORDING_METADATA_CACHE_REVISION } from "../persist/types.js";
import {
    _cacheMetadataForTests,
    _isIndexCacheWriteBlockedForTests,
    _resetForTests,
    bindIndexCacheWriteBlock,
    buildEmbeddedGpsCacheArtifactUpdates,
    cacheRetentionKeysForGpsWork,
    hasIndexCacheIdentityCollision,
    hydrateCandidate,
    indexCacheReuseKind,
    isIndexCacheEntryCompatible,
    isCurrentRecordingMetadata,
    isRecordingMetadataApplicableToFile,
    partitionByIndexCache,
    registerCandidateMetadata,
    releaseIndexCacheSnapshots,
    releaseIndexCacheWriteBlocks,
} from "./ingest-cache.js";
import { vendorFileKey } from "./ingest-candidate.js";

// IndexedDB is a browser-only store; partitionByIndexCache reads it through
// this one handle, so an in-memory entry map keeps the partition logic itself
// under test in Node.
const persistDb = vi.hoisted(() => ({ entries: new Map<string, unknown>() }));
vi.mock("../persist/db.js", () => ({
    openPersistDb: async () => ({
        transaction: () => ({
            store: {
                get: async (key: string) => persistDb.entries.get(key),
                index: () => ({ getAllKeys: async () => [] }),
            },
            done: Promise.resolve(),
        }),
    }),
}));

beforeEach(() => {
    _resetForTests();
    persistDb.entries.clear();
});

function classified(
    path: string,
    role: ClassifiedFile["role"],
    options: { size?: number; lastModified?: number } = {},
): ClassifiedFile {
    const name = path.split("/").pop()!;
    const file: VendorFile = {
        file: new File([new Uint8Array(options.size ?? 1)], name, { lastModified: options.lastModified ?? 1 }),
        relativePath: path,
    };
    return {
        file,
        role,
        sidecarId: role === "sidecar" || role === "accel-sidecar" ? "fixture" : null,
        sidecarMp4: role === "sidecar" || role === "accel-sidecar" ? "clip.mp4" : null,
        logExtractorId: role === "gps-log" ? "fixture-log" : null,
    };
}

function metadata(revision = RECORDING_METADATA_CACHE_REVISION): CachedRecordingMetadata {
    return {
        revision,
        indexed: {
            durationSec: 60,
            createdUtc: new Date(0),
            codec: "avc" as const,
            codecParam: "avc1",
            videoCodecString: null,
            rotation: 0 as const,
            width: 1920,
            height: 1080,
            fps: 30,
            audio: null,
            needsHevcRemux: false,
            audioNeedsTranscode: false,
        },
    };
}

function embeddedResult(overrides: Partial<DispatchedEmbeddedGpsResult> = {}): DispatchedEmbeddedGpsResult {
    return {
        appliedExtractors: [],
        records: [],
        skipped: [],
        errors: [],
        failedFileKeys: new Set(),
        winningExtractorByFileKey: new Map(),
        sourceFileKeyByFileKey: new Map(),
        videoStartUtcHintByFileKey: new Map(),
        localClockOffsetHintByFileKey: new Map(),
        accelByFileKey: new Map(),
        heavyFiles: [],
        ...overrides,
    };
}

describe("isIndexCacheEntryCompatible", () => {
    const identity = "CARD/clip.mp4\u00001\u00001";
    const available = new Set([identity]);

    it("accepts metadata-only when current external records suppress embedded parsing", () => {
        const entry = buildCacheEntry(identity, metadata(), undefined);
        expect(isIndexCacheEntryCompatible(entry, false, available)).toBe(true);
    });

    it("requires embedded evidence when the current pipeline would probe", () => {
        const entry = buildCacheEntry(identity, metadata(), undefined);
        expect(isIndexCacheEntryCompatible(entry, true, available)).toBe(false);
    });

    it("accepts a current positive artifact and rejects a stale one", () => {
        const current = embeddedGpsDispatchRevision("freegps")!;
        const entry = buildCacheEntry(identity, metadata(), {
            status: "parsed",
            dispatchRevision: current,
            extractorId: "freegps",
            sourceIdentityKey: identity,
            records: [],
        });
        expect(isIndexCacheEntryCompatible(entry, true, available)).toBe(true);

        entry.embeddedGps!.dispatchRevision = "stale";
        expect(isIndexCacheEntryCompatible(entry, true, available)).toBe(false);
    });

    it("degrades corrupt embedded facts to metadata-only reuse", () => {
        const entry = buildCacheEntry(identity, metadata(), {
            status: "parsed",
            dispatchRevision: embeddedGpsDispatchRevision("freegps")!,
            extractorId: "freegps",
            sourceIdentityKey: identity,
            records: [
                {
                    unixSeconds: Number.NaN,
                    active: true,
                    lat: 52,
                    lon: 13,
                    bearingDeg: 90,
                    speedMs: 10,
                    accelXg: 0,
                    accelYg: 0,
                    accelZg: 0,
                    mp4Filename: "clip.mp4",
                },
            ],
            videoStartUtcHint: Number.POSITIVE_INFINITY,
            accelSamples: [{ msSinceStart: 0, accelXg: 0, accelYg: 0, accelZg: Number.NaN }],
        });

        expect(isIndexCacheEntryCompatible(entry, true, available)).toBe(false);
        expect(indexCacheReuseKind(entry, true, available)).toBe("metadata");
    });

    it("rejects a clone when its parsed source file is no longer present", () => {
        const entry = buildCacheEntry(identity, metadata(), {
            status: "parsed",
            dispatchRevision: embeddedGpsDispatchRevision("juscar-ts")!,
            extractorId: "juscar-ts",
            sourceIdentityKey: "CARD/front.ts\u00001\u00001",
            records: [],
        });
        expect(isIndexCacheEntryCompatible(entry, true, available)).toBe(false);
    });

    it("ties a verified negative to the complete registry", () => {
        const entry = buildCacheEntry(identity, metadata(), {
            status: "none",
            dispatchRevision: noEmbeddedGpsDispatchRevision(),
        });
        expect(isIndexCacheEntryCompatible(entry, true, available)).toBe(true);

        entry.embeddedGps!.dispatchRevision = "stale";
        expect(isIndexCacheEntryCompatible(entry, true, available)).toBe(false);
    });

    it("rejects stale metadata even when an external sidecar is current", () => {
        const entry = buildCacheEntry(identity, metadata(`${RECORDING_METADATA_CACHE_REVISION}-stale`), undefined);
        expect(isIndexCacheEntryCompatible(entry, false, available)).toBe(false);
    });

    it("degrades corrupt current-format metadata to a miss", () => {
        const corrupt = metadata();
        corrupt.indexed.createdUtc = "not a Date" as unknown as Date;
        expect(isCurrentRecordingMetadata(corrupt)).toBe(false);
        expect(indexCacheReuseKind(buildCacheEntry(identity, corrupt, undefined), false, available)).toBe("none");

        const incomplete = metadata();
        delete (incomplete.indexed as Partial<typeof incomplete.indexed>).audioNeedsTranscode;
        expect(isCurrentRecordingMetadata(incomplete)).toBe(false);
    });

    it("rejects a repair outside the concrete file", () => {
        const repaired = metadata();
        repaired.repair = {
            patchedMoov: new Uint8Array(1),
            moovFileStart: 100,
            moovFileEnd: 101,
            phantomNeutralized: [],
            hvcc: null,
        };
        expect(isCurrentRecordingMetadata(repaired)).toBe(true);
        expect(isRecordingMetadataApplicableToFile(repaired, 1)).toBe(false);
        expect(isRecordingMetadataApplicableToFile(repaired, 101)).toBe(true);

        repaired.repair.moovFileStart = Number.MAX_SAFE_INTEGER + 1;
        repaired.repair.moovFileEnd = Number.MAX_SAFE_INTEGER + 2;
        expect(isCurrentRecordingMetadata(repaired)).toBe(false);
    });
});

describe("indexCacheReuseKind", () => {
    const identity = "CARD/clip.mp4\u00001\u00001";
    const available = new Set([identity]);

    it("reuses metadata when only embedded GPS is absent or stale", () => {
        const absent = buildCacheEntry(identity, metadata(), undefined);
        expect(indexCacheReuseKind(absent, true, available)).toBe("metadata");

        const stale = buildCacheEntry(identity, metadata(), {
            status: "parsed",
            dispatchRevision: "stale",
            extractorId: "freegps",
            sourceIdentityKey: identity,
            records: [],
        });
        expect(indexCacheReuseKind(stale, true, available)).toBe("metadata");
    });

    it("takes the metadata-only path while loose GPX assignment is pending", () => {
        const entry = buildCacheEntry(identity, metadata(), {
            status: "parsed",
            dispatchRevision: embeddedGpsDispatchRevision("freegps")!,
            extractorId: "freegps",
            sourceIdentityKey: identity,
            records: [],
        });
        expect(indexCacheReuseKind(entry, true, available, true)).toBe("metadata");
        expect(indexCacheReuseKind(entry, false, available, true)).toBe("metadata");
    });
});

describe("cacheRetentionKeysForGpsWork", () => {
    it("retains pending and foreign inflight work but releases the completed light owner", () => {
        const retained = cacheRetentionKeysForGpsWork(
            ["pending"],
            new Map([
                ["light-only", 1],
                ["light-plus-deferred", 2],
                ["foreign", 1],
            ]),
            new Set(["light-only", "light-plus-deferred"]),
        );

        expect([...retained].sort()).toEqual(["foreign", "light-plus-deferred", "pending"]);
    });
});

describe("abort-safe cache snapshot ownership", () => {
    it("releases an aborted owner without deleting a newer replacement", () => {
        const fileIdentity = { relativePath: "CARD/clip.mp4", size: 1, lastModified: 1 };
        const identityKey = fileIdentityKey(fileIdentity);
        const firstMetadata = metadata();
        const first = registerCandidateMetadata(fileIdentity, firstMetadata.indexed, undefined);
        const secondMetadata = metadata();
        secondMetadata.indexed.durationSec = 61;
        const second = registerCandidateMetadata(fileIdentity, secondMetadata.indexed, undefined);

        releaseIndexCacheSnapshots([first]);
        expect(_cacheMetadataForTests(identityKey)?.indexed.durationSec).toBe(61);

        releaseIndexCacheSnapshots([second]);
        expect(_cacheMetadataForTests(identityKey)).toBeUndefined();
    });
});

describe("scoped cache-write blocks", () => {
    it("keeps a collision blocked until every candidate owner releases", () => {
        const firstFile = classified("CARD/clip.mp4", "video");
        firstFile.file.sourceKey = "one";
        const secondFile = classified("CARD/clip.mp4", "video");
        secondFile.file.sourceKey = "two";
        const first = hydrateCandidate(
            firstFile,
            buildCacheEntry(
                fileIdentityKey(fileIdentityOf(firstFile.file.file, firstFile.file.relativePath)),
                metadata(),
                undefined,
            ),
            [],
            [],
        ).candidate;
        const second = hydrateCandidate(
            secondFile,
            buildCacheEntry(
                fileIdentityKey(fileIdentityOf(secondFile.file.file, secondFile.file.relativePath)),
                metadata(),
                undefined,
            ),
            [],
            [],
        ).candidate;

        bindIndexCacheWriteBlock(first, Symbol("first"));
        bindIndexCacheWriteBlock(second, Symbol("second"));
        expect(_isIndexCacheWriteBlockedForTests(first)).toBe(true);

        releaseIndexCacheWriteBlocks([first]);
        expect(_isIndexCacheWriteBlockedForTests(second)).toBe(true);

        releaseIndexCacheWriteBlocks([second]);
        expect(_isIndexCacheWriteBlockedForTests(second)).toBe(false);
    });
});

describe("buildEmbeddedGpsCacheArtifactUpdates", () => {
    it("captures raw parser output without session ownership or clock mutations", () => {
        const target = classified("CARD/clip.mp4", "video");
        target.file.sourceKey = "session";
        const key = vendorFileKey(target.file);
        const updates = buildEmbeddedGpsCacheArtifactUpdates(
            [target],
            embeddedResult({
                winningExtractorByFileKey: new Map([[key, "freegps"]]),
                sourceFileKeyByFileKey: new Map([[key, key]]),
                records: [
                    {
                        unixSeconds: 100,
                        active: true,
                        lat: 1,
                        lon: 2,
                        bearingDeg: 3,
                        speedMs: 4,
                        accelXg: 0,
                        accelYg: 0,
                        accelZg: 0,
                        mp4Filename: "clip.mp4",
                        videoKey: key,
                        recordingAssociation: { startUtc: 90, extractorId: "session-log" },
                        timeAssociation: { sourcePath: "GPSData.txt", extractorId: "csv-70mai" },
                        externalTrack: true,
                        externalTrackKey: "manual-gpx",
                        localClockOffsetAppliedSec: 18_000,
                    },
                ],
                videoStartUtcHintByFileKey: new Map([[key, 90]]),
                localClockOffsetHintByFileKey: new Map([[key, 18_000]]),
                accelByFileKey: new Map([[key, [{ msSinceStart: 0, accelXg: 0, accelYg: 0, accelZg: 1 }]]]),
            }),
        );
        const artifact = [...updates.values()][0];

        expect(artifact?.status).toBe("parsed");
        if (artifact?.status !== "parsed") throw new Error("expected parsed artifact");
        expect(artifact.extractorId).toBe("freegps");
        expect(artifact.records[0]!.unixSeconds).toBe(18_100);
        expect(artifact.records[0]).not.toHaveProperty("videoKey");
        expect(artifact.records[0]).not.toHaveProperty("recordingAssociation");
        expect(artifact.records[0]).not.toHaveProperty("timeAssociation");
        expect(artifact.records[0]).not.toHaveProperty("externalTrack");
        expect(artifact.records[0]).not.toHaveProperty("externalTrackKey");
        expect(artifact.records[0]).not.toHaveProperty("localClockOffsetAppliedSec");
        expect(artifact.videoStartUtcHint).toBe(90);
        expect(artifact.localClockOffsetHintSec).toBe(18_000);
        expect(artifact.accelSamples).toHaveLength(1);
    });

    it("distinguishes verified negatives from failed parses", () => {
        const clean = classified("CARD/clean.mp4", "video");
        const broken = classified("CARD/broken.mp4", "video");
        const updates = buildEmbeddedGpsCacheArtifactUpdates(
            [clean, broken],
            embeddedResult({ errors: [{ file: "broken.mp4", extractor: "freegps", message: "bad block" }] }),
        );

        expect([...updates.values()].map((artifact) => artifact?.status ?? null)).toEqual(["none", null]);
    });

    it("records the parsed primary identity for clone followers", () => {
        const primary = classified("CARD/F/clip.ts", "video");
        const follower = classified("CARD/R/clip.ts", "video");
        const primaryKey = vendorFileKey(primary.file);
        const followerKey = vendorFileKey(follower.file);
        const updates = buildEmbeddedGpsCacheArtifactUpdates(
            [primary, follower],
            embeddedResult({
                winningExtractorByFileKey: new Map([
                    [primaryKey, "juscar-ts"],
                    [followerKey, "juscar-ts"],
                ]),
                sourceFileKeyByFileKey: new Map([
                    [primaryKey, primaryKey],
                    [followerKey, primaryKey],
                ]),
            }),
        );
        const artifacts = [...updates.values()];
        const parsed = artifacts.filter((artifact) => artifact?.status === "parsed");

        expect(parsed).toHaveLength(2);
        expect(parsed[0]!.sourceIdentityKey).toBe(parsed[1]!.sourceIdentityKey);
    });

    it("does not guess self-provenance when a winning result omitted its source", () => {
        const target = classified("CARD/clip.mp4", "video");
        const key = vendorFileKey(target.file);
        const updates = buildEmbeddedGpsCacheArtifactUpdates(
            [target],
            embeddedResult({ winningExtractorByFileKey: new Map([[key, "freegps"]]) }),
        );
        expect([...updates.values()]).toEqual([null]);
    });
});

describe("hydrateCandidate", () => {
    it("restores raw embedded facts onto the current File identity", () => {
        const target = classified("CARD/20260828_120000F.mp4", "video", { size: 3, lastModified: 7 });
        target.file.sourceKey = "fresh-session";
        const identity = fileIdentityKey(fileIdentityOf(target.file.file, target.file.relativePath));
        const entry = buildCacheEntry(identity, metadata(), {
            status: "parsed",
            dispatchRevision: embeddedGpsDispatchRevision("freegps")!,
            extractorId: "freegps",
            sourceIdentityKey: identity,
            records: [
                {
                    unixSeconds: 100,
                    active: true,
                    lat: 1,
                    lon: 2,
                    bearingDeg: 3,
                    speedMs: 4,
                    accelXg: 0,
                    accelYg: 0,
                    accelZg: 0,
                    mp4Filename: target.file.file.name,
                },
            ],
            videoStartUtcHint: 90,
            localClockOffsetHintSec: 18_000,
            accelSamples: [{ msSinceStart: 0, accelXg: 0, accelYg: 0, accelZg: 1 }],
        });

        const restored = hydrateCandidate(target, entry, [], []);
        const key = vendorFileKey(target.file);
        expect(restored.candidate.file).toBe(target.file.file);
        expect(restored.candidate.sourceKey).toBe("fresh-session");
        expect(restored.candidate.metadataReady).toBe(true);
        expect(restored.candidate.appliedExtractors).toContain("freegps");
        expect(restored.candidate.records[0]!.videoKey).toBe(key);
        expect(restored.candidate.embeddedStartUtcHint).toBe(90);
        expect(restored.candidate.localClockOffsetHintSec).toBe(18_000);
        expect(restored.accel).toEqual([{ msSinceStart: 0, accelXg: 0, accelYg: 0, accelZg: 1 }]);
    });

    it("lets fresh external records suppress a cached embedded artifact", () => {
        const target = classified("CARD/clip.mp4", "video");
        const identity = fileIdentityKey(fileIdentityOf(target.file.file, target.file.relativePath));
        const entry = buildCacheEntry(identity, metadata(), {
            status: "parsed",
            dispatchRevision: embeddedGpsDispatchRevision("freegps")!,
            extractorId: "freegps",
            sourceIdentityKey: identity,
            records: [],
            videoStartUtcHint: 90,
        });
        const external = {
            unixSeconds: 200,
            active: true,
            lat: 1,
            lon: 2,
            bearingDeg: 3,
            speedMs: 4,
            accelXg: 0,
            accelYg: 0,
            accelZg: 0,
            mp4Filename: "clip.mp4",
        };

        const restored = hydrateCandidate(target, entry, [external], [new Map([[vendorFileKey(target.file), "gpx"]])]);
        expect(restored.candidate.records).toEqual([external]);
        expect(restored.candidate.appliedExtractors).toEqual(["gpx"]);
        expect(restored.candidate.embeddedStartUtcHint).toBeNull();
        expect(restored.embeddedRecords).toEqual([]);
    });
});

describe("partitionByIndexCache", () => {
    it("restores a whole-card hit past the spread-argument ceiling without also queueing it", async () => {
        // Above V8's ~125k spread-argument limit, where `push(...records)` throws.
        const recordCount = 200_000;
        const target = classified("CARD/clip.mp4", "video");
        const identity = fileIdentityKey(fileIdentityOf(target.file.file, target.file.relativePath));
        persistDb.entries.set(
            identity,
            buildCacheEntry(identity, metadata(), {
                status: "parsed",
                dispatchRevision: embeddedGpsDispatchRevision("freegps")!,
                extractorId: "freegps",
                sourceIdentityKey: identity,
                records: Array.from({ length: recordCount }, (_, index) => ({
                    unixSeconds: 100 + index,
                    active: true,
                    lat: 1,
                    lon: 2,
                    bearingDeg: 3,
                    speedMs: 4,
                    accelXg: 0,
                    accelYg: 0,
                    accelZg: 0,
                    mp4Filename: "clip.mp4",
                })),
            }),
        );

        const partition = await partitionByIndexCache([target], [target], buildVideoAssociationIndex([target.file]), {
            gpsLog: null,
            extractorByFileKey: [],
            areValid: true,
        });

        expect(partition.misses).toEqual([]);
        expect(partition.cachedCandidates).toHaveLength(1);
        expect(partition.restoredEmbeddedRecords).toHaveLength(recordCount);
    });
});

describe("hasIndexCacheIdentityCollision", () => {
    it("detects equal persistent metadata belonging to distinct session sources", () => {
        const a = classified("CARD/clip.mp4", "video");
        const b = classified("CARD/clip.mp4", "video");
        a.file.sourceKey = "card-a";
        b.file.sourceKey = "card-b";
        const index = buildVideoAssociationIndex([a.file, b.file]);

        expect(hasIndexCacheIdentityCollision(a, index)).toBe(true);
        expect(hasIndexCacheIdentityCollision(b, index)).toBe(true);
    });

    it("allows an overwritten path when metadata gives it a distinct persistent key", () => {
        const old = classified("CARD/clip.mp4", "video", { lastModified: 1 });
        const next = classified("CARD/clip.mp4", "video", { lastModified: 2 });
        old.file.sourceKey = "card-a";
        next.file.sourceKey = "card-b";
        const index = buildVideoAssociationIndex([old.file, next.file]);

        expect(hasIndexCacheIdentityCollision(next, index)).toBe(false);
    });
});
