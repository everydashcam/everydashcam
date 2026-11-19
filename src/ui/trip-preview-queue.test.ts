import { describe, expect, it } from "vitest";
import { createPreviewQueue } from "./trip-preview-queue.js";

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason: Error) => void } {
    let resolve!: (value: T) => void;
    let reject!: (reason: Error) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

function file(name: string): File {
    return new File([], name);
}

describe("preview queue", () => {
    it("drains a progressive ingest burst with one extraction during playback", async () => {
        const queue = createPreviewQueue(2);
        queue.setPlaybackActive(true);
        const gates = Array.from({ length: 50 }, () => deferred<string | null>());
        let active = 0;
        let peak = 0;
        let started = 0;
        const requests = gates.map((gate, index) =>
            queue.run(file(`${index}.mp4`), async () => {
                started++;
                peak = Math.max(peak, ++active);
                try {
                    return await gate.promise;
                } finally {
                    active--;
                }
            }),
        );
        expect(started).toBe(1);
        for (let i = 0; i < gates.length; i++) {
            gates[i]!.resolve(`frame-${i}`);
            expect(await requests[i]).toBe(`frame-${i}`);
        }
        expect(started).toBe(50);
        expect(peak).toBe(1);
    });

    it("lets active work finish when playback starts and opens a second slot on pause", async () => {
        const queue = createPreviewQueue(2);
        const gates = Array.from({ length: 4 }, () => deferred<string | null>());
        const started: number[] = [];
        const requests = gates.map((gate, index) =>
            queue.run(file(`${index}.mp4`), () => {
                started.push(index);
                return gate.promise;
            }),
        );
        expect(started).toEqual([0, 1]);
        queue.setPlaybackActive(true);
        gates[0]!.resolve("first");
        await requests[0];
        expect(started).toEqual([0, 1]);
        gates[1]!.resolve("second");
        await requests[1];
        expect(started).toEqual([0, 1, 2]);
        queue.setPlaybackActive(false);
        expect(started).toEqual([0, 1, 2, 3]);
        gates[2]!.resolve("third");
        gates[3]!.resolve("fourth");
        expect(await Promise.all(requests)).toEqual(["first", "second", "third", "fourth"]);
    });

    it("shares a queued extraction by File identity without merging equal filenames", async () => {
        const queue = createPreviewQueue(2);
        queue.setPlaybackActive(true);
        const gate = deferred<string | null>();
        const busy = queue.run(file("busy.mp4"), () => gate.promise);
        const sharedFile = file("front.mp4");
        const otherFile = file("front.mp4");
        let extractions = 0;
        const extract = async (): Promise<string> => `frame-${++extractions}`;
        const first = queue.run(sharedFile, extract);
        const joined = queue.run(sharedFile, extract);
        const different = queue.run(otherFile, extract);
        expect(first).toBe(joined);
        expect(extractions).toBe(0);
        gate.resolve(null);
        await busy;
        expect(await Promise.all([first, joined, different])).toEqual(["frame-1", "frame-1", "frame-2"]);
        expect(extractions).toBe(2);
    });

    it("drops an obsolete queued preview without treating its File as failed", async () => {
        const queue = createPreviewQueue(2);
        queue.setPlaybackActive(true);
        const gate = deferred<string | null>();
        const busy = queue.run(file("busy.mp4"), () => gate.promise);
        const source = file("queued.mp4");
        const ctrl = new AbortController();
        let extractions = 0;
        const extract = async (): Promise<string> => `frame-${++extractions}`;
        const obsolete = queue.run(source, extract, ctrl.signal);
        const cancelled = expect(obsolete).rejects.toMatchObject({ name: "AbortError" });
        ctrl.abort();
        await cancelled;
        const retry = queue.run(source, extract);
        gate.resolve(null);
        await busy;
        expect(await retry).toBe("frame-1");
        expect(extractions).toBe(1);
    });

    it("keeps a queued preview owned by the opened trip when the population pass is cancelled", async () => {
        const queue = createPreviewQueue(2);
        queue.setPlaybackActive(true);
        const gate = deferred<string | null>();
        const busy = queue.run(file("busy.mp4"), () => gate.promise);
        const source = file("shared.mp4");
        const ctrl = new AbortController();
        let extractions = 0;
        const extract = async (): Promise<string> => `frame-${++extractions}`;
        const population = queue.run(source, extract, ctrl.signal);
        const openedTrip = queue.run(source, extract);
        ctrl.abort();
        gate.resolve(null);
        await busy;
        expect(await Promise.all([population, openedTrip])).toEqual(["frame-1", "frame-1"]);
        expect(extractions).toBe(1);
    });

    it("preserves a queued request joined by a newer population pass", async () => {
        const queue = createPreviewQueue(2);
        queue.setPlaybackActive(true);
        const gate = deferred<string | null>();
        const busy = queue.run(file("busy.mp4"), () => gate.promise);
        const source = file("shared.mp4");
        const first = new AbortController();
        const second = new AbortController();
        const obsolete = queue.run(source, async () => "frame", first.signal);
        const current = queue.run(source, async () => "unexpected", second.signal);
        first.abort();
        gate.resolve(null);
        await busy;
        expect(await Promise.all([obsolete, current])).toEqual(["frame", "frame"]);
    });

    it("clears a cancelled folder backlog while preserving the opened trip and new work", async () => {
        const queue = createPreviewQueue(2);
        queue.setPlaybackActive(true);
        const gate = deferred<string | null>();
        const busy = queue.run(file("busy.mp4"), () => gate.promise);
        const oldFolder = new AbortController();
        const sources = Array.from({ length: 20 }, (_unused, i) => file(`old-${i}.mp4`));
        const started: string[] = [];
        const oldRequests = sources.map((source) =>
            queue.run(
                source,
                async () => {
                    started.push(source.name);
                    return source.name;
                },
                oldFolder.signal,
            ),
        );
        const oldSettled = Promise.allSettled(oldRequests);
        const opened = queue.run(sources[10]!, async () => "unexpected");
        oldFolder.abort();
        const fresh = queue.run(file("new.mp4"), async () => {
            started.push("new.mp4");
            return "new.mp4";
        });
        gate.resolve(null);
        await busy;
        expect(await opened).toBe("old-10.mp4");
        expect(await fresh).toBe("new.mp4");
        expect(started).toEqual(["old-10.mp4", "new.mp4"]);
        const settled = await oldSettled;
        expect(settled.filter((result) => result.status === "rejected")).toHaveLength(19);
        expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    });

    it("releases failed extractions and rejects already cancelled work before admission", async () => {
        const queue = createPreviewQueue(2);
        queue.setPlaybackActive(true);
        const gate = deferred<string | null>();
        const failed = queue.run(file("bad.mp4"), () => gate.promise);
        const rejection = expect(failed).rejects.toThrow("decode failed");
        const next = queue.run(file("good.mp4"), async () => "frame");
        const ctrl = new AbortController();
        ctrl.abort();
        await expect(queue.run(file("cancelled.mp4"), async () => "unexpected", ctrl.signal)).rejects.toMatchObject({
            name: "AbortError",
        });
        gate.reject(new Error("decode failed"));
        await rejection;
        expect(await next).toBe("frame");
    });

    it("admits nothing while held, lets running work finish and resumes after the last release", async () => {
        const queue = createPreviewQueue(2);
        const gates = Array.from({ length: 3 }, () => deferred<string | null>());
        const started: number[] = [];
        const requests = gates.map((gate, index) =>
            queue.run(file(`${index}.mp4`), () => {
                started.push(index);
                return gate.promise;
            }),
        );
        expect(started, "two slots fill before the hold").toEqual([0, 1]);
        const releaseOpen = queue.hold();
        const releaseFirstFrame = queue.hold();
        gates[0]!.resolve("first");
        expect(await requests[0], "a running extraction finishes under the hold").toBe("first");
        expect(started, "a freed slot stays empty while held").toEqual([0, 1]);
        releaseOpen();
        releaseOpen();
        expect(started, "a repeated release does not end another hold").toEqual([0, 1]);
        releaseFirstFrame();
        expect(started, "the last release admits queued work").toEqual([0, 1, 2]);
        gates[1]!.resolve("second");
        gates[2]!.resolve("third");
        expect(await Promise.all(requests)).toEqual(["first", "second", "third"]);
    });
});
