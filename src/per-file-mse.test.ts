// biome-ignore-all lint/complexity/useLiteralKeys: bracket access keeps private test setup type-checked without exposing internals publicly.
import { afterEach, describe, expect, it, vi } from "vitest";

import { PerFileMseBackend, resolveMediaSourceRuntime } from "./per-file-mse.js";
import {
    MSE_NOTIFY_MEDIA_SEGMENT,
    MSE_NOTIFY_SEEK,
    MSE_NOTIFY_SEEK_DONE,
    type SeekNotificationData,
} from "./workers/per-file-mse-protocol.js";

class FakeMediaSource {}
class FakeManagedMediaSource extends FakeMediaSource {}

describe("resolveMediaSourceRuntime", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("prefers classic MediaSource when both forms exist", () => {
        vi.stubGlobal("MediaSource", FakeMediaSource);
        vi.stubGlobal("ManagedMediaSource", FakeManagedMediaSource);
        const runtime = resolveMediaSourceRuntime();
        expect(runtime?.ctor).toBe(FakeMediaSource);
        expect(runtime?.managed).toBe(false);
    });

    it("falls back to ManagedMediaSource when classic MediaSource is absent", () => {
        vi.stubGlobal("MediaSource", undefined);
        vi.stubGlobal("ManagedMediaSource", FakeManagedMediaSource);
        const runtime = resolveMediaSourceRuntime();
        expect(runtime?.ctor).toBe(FakeManagedMediaSource);
        expect(runtime?.managed).toBe(true);
    });

    it("returns null when the browser has no MSE", () => {
        vi.stubGlobal("MediaSource", undefined);
        vi.stubGlobal("ManagedMediaSource", undefined);
        expect(resolveMediaSourceRuntime()).toBeNull();
    });
});

function timeRange(from: number, to: number): TimeRanges {
    return { length: 1, start: () => from, end: () => to };
}

/** Browser/worker boundaries are controlled separately: a worker reply need
 * not wait for the media element's asynchronous range removal. */
function managedSeekHarness() {
    const backend = new PerFileMseBackend({ file: new File([], "test.mkv"), durationSec: 30 });
    const seeks: SeekNotificationData[] = [];
    const sourceBuffer = {
        updating: false,
        buffered: timeRange(10, 20),
        remove() {
            this.updating = true;
        },
        abort() {
            // SourceBuffer.abort cannot interrupt an active range removal.
            throw new DOMException("range removal pending", "InvalidStateError");
        },
    };
    // Only platform objects are substituted; seek coalescing, append queues,
    // notifications and bufferedchange handling use the production class.
    backend["video"] = { currentTime: 15, paused: true, ended: false } as HTMLVideoElement;
    backend["mediaSource"] = { readyState: "open", duration: 30 } as MediaSource;
    backend["sourceBuffer"] = sourceBuffer as unknown as SourceBuffer;
    backend["client"] = {
        disposed: false,
        dispose() {},
        async request() {
            throw new Error("unexpected worker request");
        },
        notify(...args) {
            const [type, data] = args;
            if (type !== MSE_NOTIFY_SEEK) return;
            if (!data || !("startSec" in data) || data.startSec === undefined) {
                throw new Error("invalid seek notification");
            }
            const { cycleId, startSec } = data;
            seeks.push({ cycleId, startSec });
            queueMicrotask(() => {
                backend["onWorkerNotification"]({
                    type: MSE_NOTIFY_MEDIA_SEGMENT,
                    data: {
                        cycleId,
                        bytes: new Uint8Array([1]),
                        videoKeyframeTimestamps: [startSec],
                    },
                });
                backend["onWorkerNotification"]({ type: MSE_NOTIFY_SEEK_DONE, data: { cycleId } });
            });
        },
    };
    const removed = (from: number, to: number): void => {
        const event = Object.assign(new Event("bufferedchange"), { removedRanges: timeRange(from, to) });
        backend["onManagedBufferedChange"](event);
    };
    return { backend, sourceBuffer, seeks, removed };
}

describe("managed buffer removal", () => {
    it.each([true, false])("keeps a seek's new segments when its own remove reports updating=%s", async (updating) => {
        const { backend, sourceBuffer, seeks, removed } = managedSeekHarness();
        await backend.seekTo(3);
        expect(backend["pendingSeekPromise"]).toBeNull();
        expect(sourceBuffer.updating).toBe(true);
        expect(backend["appendQueue"]).toHaveLength(1);

        // WebKit queues bufferedchange before updateend. updating may already
        // be false, but the application has not consumed updateend yet.
        sourceBuffer.updating = updating;
        removed(10, 20);
        await backend["pendingSeekPromise"];

        expect(seeks).toEqual([{ startSec: 3, cycleId: 1 }]);
        expect(backend["appendQueue"]).toHaveLength(1);
        expect(backend.isFailed).toBe(false);
    });

    it.each([false, true])("refeeds an ahead eviction with a behind trim pending=%s", async (duringTrim) => {
        const { backend, seeks, removed } = managedSeekHarness();
        if (duringTrim) {
            backend["bufferedVideoKeyframes"] = [10, 12, 16];
            backend["tickTrim"]();
            expect(backend["lastSubmittedOp"]?.type).toBe("remove");
        }

        removed(16, 20);
        await backend["pendingSeekPromise"];

        expect(seeks).toEqual([{ startSec: 15, cycleId: 1 }]);
        expect(backend.isFailed).toBe(false);
    });
});
