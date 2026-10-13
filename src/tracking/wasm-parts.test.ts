import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import type { WasmPart } from "./ort-assets.js";
import { loadWasmParts } from "./wasm-parts.js";

const bodies = [new Uint8Array([0, 97, 115, 109]), new Uint8Array([1, 0, 0, 0])];
const parts: WasmPart[] = bodies.map((body, index) => ({
    url: `/ort/test/part-${index}.bin`,
    bytes: body.length,
    sha256: createHash("sha256").update(body).digest("hex"),
}));

afterEach(() => vi.unstubAllGlobals());

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
    const bytes = await loadWasmParts(parts);
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
    expect(await loadWasmParts(parts.slice(0, 1))).toEqual(bodies[0]);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenLastCalledWith(
        parts[0]!.url,
        expect.objectContaining({ cache: "reload", headers: { "x-everydashcam-wasm-repair": "1" } }),
    );
});

it("rejects persistently corrupt bytes without looping or returning a partial binary", async () => {
    vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(new Uint8Array(4))),
    );
    await expect(loadWasmParts(parts)).rejects.toThrow("wasm part integrity mismatch");
    expect(fetch).toHaveBeenCalledTimes(2);
});

it("fails on a missing part without accepting the successfully downloaded prefix", async () => {
    vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) =>
            url === parts[0]!.url ? new Response(bodies[0]) : new Response(null, { status: 404 }),
        ),
    );
    await expect(loadWasmParts(parts)).rejects.toThrow("wasm part request failed: 404");
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
    await expect(loadWasmParts(parts, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(fetch).toHaveBeenCalledTimes(1);
});

it("does not start an already cancelled download", async () => {
    vi.stubGlobal("fetch", vi.fn());
    await expect(loadWasmParts(parts, AbortSignal.abort())).rejects.toMatchObject({ name: "AbortError" });
    expect(fetch).not.toHaveBeenCalled();
});
