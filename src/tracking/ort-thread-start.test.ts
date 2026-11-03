import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { startOrtThreadPool } from "./ort-thread-start.js";

// Child workers are the platform boundary here; EventTarget supplies real
// listener ordering and cancellation, including already queued error events.
class ChildWorker extends EventTarget {
    terminated = false;
    terminate(): void {
        this.terminated = true;
    }
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((done, fail) => {
        resolve = done;
        reject = fail;
    });
    return { promise, resolve, reject };
}

function startThread(name = "em-pthread"): Worker {
    return new Worker("https://example.test/ort.wasm.bundle.js", { type: "module", name });
}

function threadError(message = "thread blocked"): Event {
    return Object.assign(new Event("error", { cancelable: true }), { message, error: new Error(message) });
}

beforeEach(() => vi.stubGlobal("Worker", ChildWorker));
afterEach(() => vi.unstubAllGlobals());

it("rejects a failed pool and stops every child without leaking sibling errors", async () => {
    const startup = deferred<void>();
    const ready = deferred<Worker[]>();
    const vendorError = vi.fn();
    const pending = startOrtThreadPool(() => {
        const children = Array.from({ length: 3 }, () => startThread());
        for (const child of children) child.addEventListener("error", vendorError);
        ready.resolve(children);
        return startup.promise;
    });
    const children = await ready.promise;
    const failure = expect(pending).rejects.toThrow("thread blocked");
    const firstError = threadError();
    children[0]!.dispatchEvent(firstError);
    await failure;

    expect(firstError.defaultPrevented).toBe(true);
    expect(children.every((child) => (child as unknown as ChildWorker).terminated)).toBe(true);
    expect(globalThis.Worker).toBe(ChildWorker);
    for (const child of children) {
        const queuedError = threadError("already queued");
        child.dispatchEvent(queuedError);
        expect(queuedError.defaultPrevented).toBe(true);
    }
    expect(vendorError).not.toHaveBeenCalled();
    // A late native rejection remains observed after the race is settled.
    startup.reject(new Error("late native failure"));
    await Promise.resolve();
});

it.each(["em-pthread", "em-pthread-1"])("handles a plain script load error from %s", async (name) => {
    const ready = deferred<Worker>();
    const pending = startOrtThreadPool(() => {
        ready.resolve(startThread(name));
        return new Promise<never>(() => {});
    });
    const child = await ready.promise;
    const failure = expect(pending).rejects.toThrow("ort thread failed to start");
    child.dispatchEvent(new Event("error", { cancelable: true }));
    await failure;
});

it("removes startup handling after success so later inference errors propagate", async () => {
    let child!: Worker;
    const vendorError = vi.fn();
    await expect(
        startOrtThreadPool(async () => {
            child = startThread();
            child.addEventListener("error", vendorError);
            return "session";
        }),
    ).resolves.toBe("session");

    expect(globalThis.Worker).toBe(ChildWorker);
    expect(child.constructor, "live threads do not retain the temporary constructor").toBe(ChildWorker);
    expect((child as unknown as ChildWorker).terminated).toBe(false);
    const error = threadError("inference failed");
    child.dispatchEvent(error);
    expect(error.defaultPrevented).toBe(false);
    expect(vendorError).toHaveBeenCalledOnce();
});

it("leaves an unrelated child worker's errors and lifetime alone", async () => {
    let unrelated!: Worker;
    const vendorError = vi.fn();
    await expect(
        startOrtThreadPool(async () => {
            unrelated = new Worker("https://example.test/decoder.js", { name: "decoder" });
            unrelated.addEventListener("error", vendorError);
            const error = threadError();
            unrelated.dispatchEvent(error);
            expect(error.defaultPrevented).toBe(false);
            throw new Error("initialization failed");
        }),
    ).rejects.toThrow("initialization failed");
    expect(vendorError).toHaveBeenCalledOnce();
    expect((unrelated as unknown as ChildWorker).terminated).toBe(false);
    expect(globalThis.Worker).toBe(ChildWorker);
});

it.each([true, false])("cleans up a startup exception (synchronous: %s)", async (synchronous) => {
    let child!: Worker;
    const cause = new Error("initialization timed out");
    await expect(
        startOrtThreadPool(() => {
            child = startThread();
            if (synchronous) throw cause;
            return Promise.reject(cause);
        }),
    ).rejects.toBe(cause);
    expect((child as unknown as ChildWorker).terminated).toBe(true);
    expect(globalThis.Worker).toBe(ChildWorker);
});

it("serializes overlapping runtime startups without retaining a nested Worker wrapper", async () => {
    const first = deferred<string>();
    const entered = deferred<void>();
    let secondEntered = false;
    const one = startOrtThreadPool(() => {
        entered.resolve();
        return first.promise;
    });
    await entered.promise;
    const two = startOrtThreadPool(async () => {
        secondEntered = true;
        return "second session";
    });
    await Promise.resolve();
    expect(secondEntered).toBe(false);
    first.resolve("first session");
    expect(await one).toBe("first session");
    expect(await two).toBe("second session");
    expect(globalThis.Worker).toBe(ChildWorker);
});
