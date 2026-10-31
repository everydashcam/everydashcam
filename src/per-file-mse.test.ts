import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveMediaSourceRuntime } from "./per-file-mse.js";

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
