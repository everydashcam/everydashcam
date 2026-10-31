import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ACCEL_SIDECARS, SIDECARS, classifyOneNonVideo } from "../parsers/registry.js";
import { dailyCsvGpsPrimitive } from "../parsers/primitives/daily-csv-gps.js";
import { vendorFileKey } from "../vendor-file-key.js";
import type { VendorFile } from "../parsers/types.js";
import type { ClassifyBatchRequestData, ParseLogRequestData } from "../workers/ingest-protocol.js";
import { makePairedEndpoints, type PairedEndpoints } from "../workers/_protocol/test-helpers.js";
import { createWorkerServer } from "../workers/_protocol/worker-server.js";
import { _resetForTests, classifyFilesViaPool, dispatchParseLogsViaPool } from "./ingest-shim.js";

function file(name: string, content = ""): VendorFile {
    return { file: new File([content], name), relativePath: name };
}

function installWorkers(onSpawn: (pair: PairedEndpoints, index: number) => void): void {
    let spawned = 0;
    vi.stubGlobal("Worker", function Worker() {
        const pair = makePairedEndpoints();
        onSpawn(pair, spawned++);
        return pair.mainEndpoint;
    });
}

function classifyInWorker(pair: PairedEndpoints): void {
    createWorkerServer(pair.workerEndpoint, {
        onRequest: async (_type, data) => {
            const request = data as ClassifyBatchRequestData;
            const knownVideos = new Set(request.knownVideoNames);
            return await Promise.all(
                request.files.map((entry) =>
                    classifyOneNonVideo(
                        entry,
                        knownVideos,
                        SIDECARS.filter((handler) => handler.id !== "gpx"),
                        ACCEL_SIDECARS,
                    ),
                ),
            );
        },
    });
}

beforeEach(() => {
    _resetForTests();
    vi.stubGlobal("navigator", { hardwareConcurrency: 4 });
});

afterEach(() => {
    _resetForTests();
    vi.unstubAllGlobals();
});

it("keeps a daily log's preserved card owner across the worker boundary", async () => {
    installWorkers((pair) => {
        createWorkerServer(pair.workerEndpoint, {
            onRequest: async (_type, data) => {
                const request = data as ParseLogRequestData;
                return dailyCsvGpsPrimitive.parse(request.file, undefined, undefined, {
                    knownVideos: request.knownVideos,
                });
            },
        });
    });
    const name = "20240112181400_10.MP4";
    const own = { ...file(name), relativePath: `card-a/DCIM/100video/${name}`, sourceKey: "old-pick" };
    const other = { ...file(name, "other"), relativePath: `card-b/DCIM/100video/${name}`, sourceKey: "new-pick" };
    const log = {
        ...file("20240112.dat", "#\n20240112181400,2512.6,N,1234.5,E,10,2\n"),
        relativePath: "card-a/gps/20240112.dat",
        sourceKey: "new-pick",
    };
    const classified = await classifyOneNonVideo(log, new Set([name]), SIDECARS, ACCEL_SIDECARS);
    const result = await dispatchParseLogsViaPool([classified], [own, other]);
    expect(result.errors).toEqual([]);
    expect(result.records.map((record) => record.videoKey)).toEqual([vendorFileKey(own)]);
    expect([...result.extractorByFileKey]).toEqual([[vendorFileKey(own), "daily-csv-gps"]]);
});

describe("classifyFilesViaPool", () => {
    it("keeps videos and healthy auxiliary shards when a classifier worker fails to load", async () => {
        installWorkers((pair, index) => {
            if (index === 0) queueMicrotask(() => pair.fireMainError({}));
            else classifyInWorker(pair);
        });
        const video = file("trip.mp4");
        const unread = file("metadata.txt");
        const log = file("GPSData.txt", "$V02,1700000000,1,40.0,N,-74.0,W,0,0,trip.mp4,0,0,0\n");

        const result = await classifyFilesViaPool([video, unread, log]);

        expect(result.classified.find((entry) => entry.file === video)?.role).toBe("video");
        expect(result.classified.find((entry) => entry.file === unread)?.role).toBe("unknown");
        expect(result.classified.find((entry) => entry.file === log)).toMatchObject({
            role: "gps-log",
            logExtractorId: "csv-70mai",
        });
        expect(result.errors).toEqual([
            expect.objectContaining({ file: unread.file.name, extractor: "ingest-worker" }),
        ]);
    });

    it("still recognizes a paired GPX when its worker is unavailable", async () => {
        installWorkers((pair) => queueMicrotask(() => pair.fireMainError({})));
        const video = file("trip.mp4");
        const gpx = file("trip.gpx", '<?xml version="1.0"?><gpx version="1.1"/>');

        const result = await classifyFilesViaPool([video, gpx]);

        expect(result.classified).toHaveLength(2);
        expect(result.classified.find((entry) => entry.file === gpx)).toMatchObject({
            role: "sidecar",
            sidecarId: "gpx",
            sidecarMp4: video.file.name,
        });
        expect(result.errors).toHaveLength(1);
    });

    it("keeps videos when worker construction is blocked", async () => {
        vi.stubGlobal("Worker", function Worker() {
            throw new DOMException("worker blocked", "SecurityError");
        });
        const result = await classifyFilesViaPool([file("trip.mp4"), file("metadata.txt")]);

        expect(result.classified.map((entry) => entry.role)).toEqual(["video", "unknown"]);
        expect(result.errors).toHaveLength(1);
    });

    it("propagates a classifier invariant error", async () => {
        installWorkers((pair) => {
            createWorkerServer(pair.workerEndpoint, {
                onRequest: async () => {
                    throw new Error("invalid classifier registry");
                },
            });
        });

        await expect(classifyFilesViaPool([file("trip.mp4"), file("metadata.txt")])).rejects.toThrow(
            "invalid classifier registry",
        );
    });

    it("propagates cancellation while auxiliary files are being classified", async () => {
        const controller = new AbortController();
        installWorkers((pair) => {
            createWorkerServer(pair.workerEndpoint, {
                onRequest: async () => {
                    controller.abort();
                    return [];
                },
            });
        });

        await expect(
            classifyFilesViaPool([file("trip.mp4"), file("metadata.txt")], [], controller.signal),
        ).rejects.toMatchObject({ name: "AbortError" });
    });

    it("honors an already cancelled video-only batch without creating a worker", async () => {
        installWorkers(() => {
            throw new Error("unexpected worker spawn");
        });
        const controller = new AbortController();
        controller.abort();

        await expect(classifyFilesViaPool([file("trip.mp4")], [], controller.signal)).rejects.toMatchObject({
            name: "AbortError",
        });
    });
});
