import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import type { AssetPart } from "./ort-assets.js";
import { loadAssetParts } from "./asset-loader.js";

const bodies = [new Uint8Array([0, 97, 115, 109]), new Uint8Array([1, 0, 0, 0])];
const parts: AssetPart[] = bodies.map((body, index) => ({
    url: `/ort/test/part-${index}.bin`,
    bytes: body.length,
    sha256: createHash("sha256").update(body).digest("hex"),
}));

afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

it("assembles verified parts across arbitrary response chunk boundaries", async () => {
    vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => {
            const body = bodies[parts.findIndex((part) => part.url === url)]!;
            return new Response(
                new ReadableStream({
                    start(controller) {
                        controller.enqueue(body.subarray(0, 1));
                        controller.enqueue(body.subarray(1));
                        controller.close();
                    },
                }),
            );
        }),
    );
    const bytes = await loadAssetParts(parts);
    expect(Array.from(bytes)).toEqual([0, 97, 115, 109, 1, 0, 0, 0]);
    expect(await WebAssembly.compile(bytes)).toBeInstanceOf(WebAssembly.Module);
    expect(fetch).toHaveBeenCalledTimes(2);
});

it.each([
    ["truncated", new Uint8Array([0, 97])],
    ["oversized", new Uint8Array(5)],
    ["wrong checksum", new Uint8Array(4)],
])("repairs a %s cached part once through a reload request", async (_label, corrupt) => {
    vi.stubGlobal(
        "fetch",
        vi.fn(
            async (_url: string, options: RequestInit) =>
                new Response(options.cache === "reload" ? bodies[0] : corrupt),
        ),
    );
    expect(await loadAssetParts(parts.slice(0, 1))).toEqual(bodies[0]);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenLastCalledWith(
        expect.stringContaining(`${parts[0]!.url}?__dc_repair=`),
        expect.objectContaining({ cache: "reload", headers: { "x-everydashcam-wasm-repair": "1" } }),
    );
});

it("rejects persistently corrupt bytes without looping or returning a partial binary", async () => {
    vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(new Uint8Array(4))),
    );
    await expect(loadAssetParts(parts)).rejects.toThrow("asset integrity mismatch");
    expect(fetch).toHaveBeenCalledTimes(2);
});

it("fails on a missing part without accepting the successfully downloaded prefix", async () => {
    vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) =>
            url === parts[0]!.url ? new Response(bodies[0]) : new Response(null, { status: 404 }),
        ),
    );
    await expect(loadAssetParts(parts)).rejects.toThrow("asset version unavailable");
    expect(fetch).toHaveBeenCalledTimes(2);
});

it("propagates cancellation without a repair request", async () => {
    const controller = new AbortController();
    vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
            controller.abort();
            return new Response(bodies[0]);
        }),
    );
    await expect(loadAssetParts(parts, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(fetch).toHaveBeenCalledTimes(1);
});

it.each([
    [200, "AssetUnavailableError"],
    [404, "AssetUnavailableError"],
    [410, "AssetUnavailableError"],
    [503, "AssetDownloadError"],
])("classifies HTML status %s after at most one cache repair", async (status, name) => {
    vi.stubGlobal(
        "fetch",
        vi.fn(
            async () =>
                new Response("<html>fallback</html>", {
                    status,
                    headers: { "content-type": "text/html" },
                }),
        ),
    );
    await expect(loadAssetParts(parts)).rejects.toMatchObject({ name });
    expect(fetch).toHaveBeenCalledTimes(status === 200 ? 2 : 1);
});

it("repairs a successful HTML fallback cached by an older worker", async () => {
    vi.stubGlobal(
        "fetch",
        vi.fn(async (_url: string, options: RequestInit) =>
            options.cache === "reload"
                ? new Response(bodies[0])
                : new Response("<html>old fallback</html>", { headers: { "content-type": "text/html" } }),
        ),
    );
    expect(await loadAssetParts(parts.slice(0, 1))).toEqual(bodies[0]);
    expect(fetch).toHaveBeenCalledTimes(2);
});

it("does not start an already cancelled download", async () => {
    vi.stubGlobal("fetch", vi.fn());
    await expect(loadAssetParts(parts, AbortSignal.abort())).rejects.toMatchObject({ name: "AbortError" });
    expect(fetch).not.toHaveBeenCalled();
});

it("aborts a stalled response body and never retries it as corruption", async () => {
    vi.useFakeTimers();
    const cancelled = vi.fn();
    vi.stubGlobal(
        "fetch",
        vi.fn(
            async () =>
                new Response(
                    new ReadableStream({
                        start(controller) {
                            controller.enqueue(bodies[0]!.subarray(0, 1));
                        },
                        cancel: cancelled,
                    }),
                ),
        ),
    );
    const result = expect(loadAssetParts(parts.slice(0, 1))).rejects.toMatchObject({ name: "TimeoutError" });
    await vi.advanceTimersByTimeAsync(30_001);
    await result;
    expect(cancelled).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
});

it("allows slow downloads while bytes continue arriving", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
        "fetch",
        vi.fn(
            async () =>
                new Response(
                    new ReadableStream({
                        start(controller) {
                            bodies[0]!.forEach((byte, index) => {
                                setTimeout(() => {
                                    controller.enqueue(new Uint8Array([byte]));
                                    if (index === bodies[0]!.length - 1) controller.close();
                                }, index * 20_000);
                            });
                        },
                    }),
                ),
        ),
    );
    const pending = loadAssetParts(parts.slice(0, 1));
    await vi.advanceTimersByTimeAsync(60_001);
    expect(await pending).toEqual(bodies[0]);
    expect(fetch).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
});

it("does not wait for a rejected oversized producer to finish cancelling", async () => {
    let calls = 0;
    vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
            ++calls === 1
                ? new Response(
                      new ReadableStream({
                          start(controller) {
                              controller.enqueue(new Uint8Array(5));
                          },
                          cancel() {
                              return new Promise(() => {});
                          },
                      }),
                  )
                : new Response(bodies[0]),
        ),
    );
    expect(await loadAssetParts(parts.slice(0, 1))).toEqual(bodies[0]);
    expect(calls).toBe(2);
});
