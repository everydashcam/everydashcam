import { describe, expect, it } from "vitest";
import { createSerialQueue } from "./serial-queue.js";

describe("serial resource queue", () => {
    it("waits for an operation and preserves its failure without poisoning later work", async () => {
        const enqueue = createSerialQueue();
        const order: string[] = [];
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const failure = new Error("first operation failed");
        const first = enqueue(async () => {
            order.push("first start");
            await gate;
            order.push("first end");
            throw failure;
        });
        const second = enqueue(() => {
            order.push("second");
            return 2;
        });
        const rejected = expect(first).rejects.toBe(failure);
        await Promise.resolve();
        expect(order).toEqual(["first start"]);
        release();
        await rejected;
        await expect(second).resolves.toBe(2);
        expect(order).toEqual(["first start", "first end", "second"]);
    });

    it("checks a queued operation's cancellation only when it reaches the resource", async () => {
        const enqueue = createSerialQueue();
        const controller = new AbortController();
        const first = enqueue(() => controller.abort());
        const cancelled = enqueue(() => {
            controller.signal.throwIfAborted();
            return "unreachable";
        });
        const after = enqueue(() => "recovered");
        await first;
        await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
        await expect(after).resolves.toBe("recovered");
    });
});
