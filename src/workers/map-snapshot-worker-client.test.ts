import { transfer } from "comlink";
import { afterEach, expect, it, vi } from "vitest";
import type { MapSnapshotRequest } from "../transcode/map-snapshotter-types.js";
import { flushMicrotasks, makePairedEndpoints } from "./_protocol/test-helpers.js";
import { createWorkerClient, type WorkerClient } from "./_protocol/worker-client.js";
import { createWorkerServer } from "./_protocol/worker-server.js";
import { MapSnapshotWorkerClient } from "./map-snapshot-worker-client.js";
import { TRANSCODE_REQUEST_MAP_SNAPSHOT } from "./transcode-protocol.js";

const request: MapSnapshotRequest = { lat: 45, lon: 65, bearingDeg: 30, zoomKm: 1, speedMs: 12 };
const clients: WorkerClient[] = [];
const snapshotters: MapSnapshotWorkerClient[] = [];

afterEach(() => {
    for (const snapshotter of snapshotters.splice(0)) snapshotter.dispose("test cleanup");
    for (const client of clients.splice(0)) client.dispose();
    vi.useRealTimers();
});

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

function bitmap() {
    let closed = 0;
    const image: ImageBitmap = {
        width: 640,
        height: 480,
        close: () => {
            closed++;
        },
    };
    return { image, closed: () => closed };
}

function bridge(render: (type: string, data: unknown) => unknown | Promise<unknown>) {
    const pair = makePairedEndpoints();
    const server = createWorkerServer(pair.workerEndpoint, {});
    const client = createWorkerClient(pair.mainEndpoint, { name: "snapshot-test", onRequest: render });
    const snapshotter = new MapSnapshotWorkerClient(server);
    clients.push(client);
    snapshotters.push(snapshotter);
    return { pair, snapshotter };
}

it("requests map coordinates over reverse RPC and transfers the rendered bitmap", async () => {
    const image = bitmap();
    const { pair, snapshotter } = bridge((type, data) => {
        expect(type).toBe(TRANSCODE_REQUEST_MAP_SNAPSHOT);
        expect(data).toEqual(request);
        return transfer(image.image, [image.image]);
    });
    let transferred = false;
    const post = pair.mainEndpoint.postMessage;
    pair.mainEndpoint.postMessage = (message, transfers) => {
        if (transfers?.includes(image.image)) transferred = true;
        post(message, transfers);
    };
    expect(await snapshotter.snapshot(request)).toBe(image.image);
    expect(transferred).toBe(true);
    expect(image.closed()).toBe(0);
    image.image.close();
});

it("keeps the warmup budget for concurrent initial frames and shortens later requests", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const replies = [deferred<ImageBitmap>(), deferred<ImageBitmap>(), deferred<ImageBitmap>()];
    let next = 0;
    const { snapshotter } = bridge(() => replies[next++]!.promise);
    const first = snapshotter.snapshot(request);
    const second = snapshotter.snapshot(request);
    let secondSettled = false;
    void second.then(() => {
        secondSettled = true;
    });
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(30_001);
    const firstImage = bitmap();
    replies[0]!.resolve(firstImage.image);
    expect(await first).toBe(firstImage.image);
    const third = expect(snapshotter.snapshot(request)).rejects.toThrow("map snapshot timeout");
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(30_000);
    await third;
    expect(secondSettled).toBe(false);
    const secondImage = bitmap();
    const lateImage = bitmap();
    replies[1]!.resolve(secondImage.image);
    replies[2]!.resolve(lateImage.image);
    expect(await second).toBe(secondImage.image);
    await flushMicrotasks();
    expect(lateImage.closed()).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
});

it("closes a bitmap arriving after the first request times out", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const reply = deferred<ImageBitmap>();
    const { snapshotter } = bridge(() => reply.promise);
    const pending = expect(snapshotter.snapshot(request)).rejects.toThrow("map snapshot timeout");
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(120_000);
    await pending;
    const late = bitmap();
    reply.resolve(late.image);
    await flushMicrotasks();
    expect(late.closed()).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
});

it("cancels outstanding frames and closes their late replies", async () => {
    const replies = [deferred<ImageBitmap>(), deferred<ImageBitmap>()];
    let next = 0;
    const { snapshotter } = bridge(() => replies[next++]!.promise);
    const pending = [snapshotter.snapshot(request), snapshotter.snapshot(request)];
    const rejected = Promise.all(
        pending.map((promise) => expect(promise).rejects.toMatchObject({ name: "AbortError" })),
    );
    await flushMicrotasks();
    snapshotter.dispose("transcode cancelled");
    await rejected;
    const first = bitmap();
    const second = bitmap();
    replies[0]!.resolve(first.image);
    replies[1]!.resolve(second.image);
    await flushMicrotasks();
    expect([first.closed(), second.closed()]).toEqual([1, 1]);
});

it("propagates render failures and clears their timeout", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { snapshotter } = bridge(() => {
        throw new TypeError("map render failed");
    });
    await expect(snapshotter.snapshot(request)).rejects.toMatchObject({
        name: "TypeError",
        message: "map render failed",
    });
    expect(vi.getTimerCount()).toBe(0);
});
