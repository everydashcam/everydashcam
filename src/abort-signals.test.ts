import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { combineAbortSignals } from "./abort-signals.js";

const nativeAny = Object.getOwnPropertyDescriptor(AbortSignal, "any")!;

afterEach(() => {
    Object.defineProperty(AbortSignal, "any", nativeAny);
    vi.restoreAllMocks();
});

describe.each(["native", "fallback"])("combined abort signal (%s)", (implementation) => {
    beforeEach(() => {
        if (implementation === "fallback") Object.defineProperty(AbortSignal, "any", { value: undefined });
    });

    it("uses the first already-aborted input's reason in input order", () => {
        const first = new AbortController();
        const second = new AbortController();
        second.abort(new DOMException("timed out", "TimeoutError"));
        first.abort(new DOMException("cancelled", "AbortError"));
        const combined = combineAbortSignals([new AbortController().signal, first.signal, second.signal]);
        expect(combined.signal.aborted).toBe(true);
        expect(combined.signal.reason).toBe(first.signal.reason);
        combined.dispose();
    });

    it("preserves TimeoutError and ignores later cancellation", () => {
        const user = new AbortController();
        const timeout = new AbortController();
        const combined = combineAbortSignals([user.signal, timeout.signal]);
        const reason = new DOMException("download stalled", "TimeoutError");
        timeout.abort(reason);
        user.abort();
        expect(combined.signal.reason).toBe(reason);
        expect(() => combined.signal.throwIfAborted()).toThrow(reason);
        combined.dispose();
    });

    it("propagates a caller abort without aborting its other inputs", () => {
        const user = new AbortController();
        const lifetime = new AbortController();
        const combined = combineAbortSignals([user.signal, lifetime.signal]);
        user.abort();
        expect(combined.signal.aborted).toBe(true);
        expect(combined.signal.reason).toBe(user.signal.reason);
        expect(lifetime.signal.aborted).toBe(false);
        combined.dispose();
    });
});

describe("fallback subscriptions", () => {
    beforeEach(() => {
        Object.defineProperty(AbortSignal, "any", { value: undefined });
    });

    it("releases all inputs when the first source aborts", () => {
        const user = new AbortController();
        const timeout = new AbortController();
        const userRemove = vi.spyOn(user.signal, "removeEventListener");
        const timeoutRemove = vi.spyOn(timeout.signal, "removeEventListener");
        const combined = combineAbortSignals([user.signal, timeout.signal, user.signal]);
        timeout.abort();
        expect(userRemove).toHaveBeenCalledTimes(1);
        expect(timeoutRemove).toHaveBeenCalledTimes(1);
        combined.dispose();
        expect(userRemove).toHaveBeenCalledTimes(1);
    });

    it("detaches a successful operation without aborting any signal", () => {
        const user = new AbortController();
        const lifetime = new AbortController();
        const userRemove = vi.spyOn(user.signal, "removeEventListener");
        const lifetimeRemove = vi.spyOn(lifetime.signal, "removeEventListener");
        const combined = combineAbortSignals([user.signal, lifetime.signal]);
        combined.dispose();
        combined.dispose();
        expect(userRemove).toHaveBeenCalledTimes(1);
        expect(lifetimeRemove).toHaveBeenCalledTimes(1);
        expect(user.signal.aborted).toBe(false);
        expect(lifetime.signal.aborted).toBe(false);
        user.abort();
        expect(combined.signal.aborted).toBe(false);
    });
});
