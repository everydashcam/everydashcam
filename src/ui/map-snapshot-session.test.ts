import { describe, expect, it } from "vitest";
import type { ExportMapSnapshotter, SnapshotRequest } from "./export-map-snapshot.js";
import { MapSnapshotSession } from "./map-snapshot-session.js";

const request: SnapshotRequest = {
    lat: 45,
    lon: 65,
    bearingDeg: 0,
    zoomKm: 1,
    headingUp: false,
    pitchDeg: 0,
    adaptiveZoom: false,
    buildings3d: false,
};

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

function snapshotter(snapshot: ExportMapSnapshotter["snapshot"], dispose: () => void): ExportMapSnapshotter {
    return { snapshot, dispose, prewarm: async () => {}, setMarkerAppearance: () => {} };
}

describe("MapSnapshotSession", () => {
    it("allocates nothing when disposed before the first queued request starts", async () => {
        let allocations = 0;
        const session = new MapSnapshotSession(async () => {
            allocations++;
            throw new Error("disposed session reached initialization");
        });
        const pending = session.snapshot(request);
        const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
        await session.dispose();
        await rejected;
        await expect(session.preload()).rejects.toMatchObject({ name: "AbortError" });
        expect(allocations).toBe(0);
    });

    it("preserves initialization errors and completes cleanup after they reject", async () => {
        const error = new Error("map context unavailable");
        const session = new MapSnapshotSession(async () => {
            throw error;
        });
        await expect(session.preload()).rejects.toBe(error);
        await expect(session.snapshot(request)).rejects.toBe(error);
        await session.dispose();
    });

    it("disposes delayed initialization and skips every queued render after cancellation", async () => {
        const init = deferred<ExportMapSnapshotter>();
        let allocations = 0;
        let renders = 0;
        let disposals = 0;
        const session = new MapSnapshotSession(() => {
            allocations++;
            return init.promise;
        });
        const preload = session.preload();
        const first = session.snapshot(request);
        const second = session.snapshot(request);
        const rejected = Promise.all([
            expect(first).rejects.toMatchObject({ name: "AbortError" }),
            expect(second).rejects.toMatchObject({ name: "AbortError" }),
        ]);
        await Promise.resolve();
        const disposed = session.dispose();
        init.resolve(
            snapshotter(
                async () => {
                    renders++;
                    throw new Error("cancelled render reached the map");
                },
                () => disposals++,
            ),
        );
        await Promise.all([preload, rejected, disposed]);
        await expect(session.snapshot(request)).rejects.toMatchObject({ name: "AbortError" });
        await session.dispose();
        expect({ allocations, renders, disposals }).toEqual({ allocations: 1, renders: 0, disposals: 1 });
    });

    it("waits for an active compositor before removing its map", async () => {
        const started = deferred<void>();
        const finish = deferred<ImageBitmap>();
        const events: string[] = [];
        const session = new MapSnapshotSession(async () =>
            snapshotter(
                async () => {
                    events.push("render");
                    started.resolve();
                    return finish.promise;
                },
                () => events.push("dispose"),
            ),
        );
        const rendered = session.snapshot(request);
        await started.promise;
        const disposed = session.dispose();
        expect(events).toEqual(["render"]);
        const bitmap = { width: 640, height: 480, close() {} } satisfies ImageBitmap;
        finish.resolve(bitmap);
        expect(await rendered).toBe(bitmap);
        await disposed;
        expect(events).toEqual(["render", "dispose"]);
    });

    it("serializes requests and keeps the queue usable after a snapshot failure", async () => {
        const started = deferred<void>();
        const finish = deferred<void>();
        const seen: number[] = [];
        const session = new MapSnapshotSession(async () =>
            snapshotter(
                async (req) => {
                    seen.push(req.lon);
                    if (seen.length === 1) {
                        started.resolve();
                        await finish.promise;
                        throw new Error("render failed");
                    }
                    return { width: 640, height: 480, close() {} };
                },
                () => {},
            ),
        );
        const first = session.snapshot(request);
        const rejected = expect(first).rejects.toThrow("render failed");
        const second = session.snapshot({ ...request, lon: 66 });
        await started.promise;
        expect(seen).toEqual([65]);
        finish.resolve();
        await rejected;
        (await second).close();
        expect(seen).toEqual([65, 66]);
        await session.dispose();
    });
});
