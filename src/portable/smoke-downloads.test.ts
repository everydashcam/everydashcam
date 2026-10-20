import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { verifyPublishedPortableDownloads } from "../../scripts/smoke-portable-downloads.mjs";
import type { PortableManifest } from "./manifest.mjs";

const bytes = Buffer.from("<!doctype html><title>Portable viewer</title>");
const filename = "everydashcam-2026-09-25-en.html";
const path = `/downloads/portable/v2026.09.25/${filename.slice(0, -5)}`;
const manifest: PortableManifest = {
    schemaVersion: 1,
    distribution: "public",
    version: "v2026.09.25",
    files: {
        en: { path, filename, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") },
    },
};

function metadata(value: unknown = manifest): Response {
    return Response.json(value, {
        headers: { "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=0, must-revalidate" },
    });
}

function redirect(location = path, status = 302, cacheControl?: string): Response {
    return new Response(null, {
        status,
        headers: { Location: location, ...(cacheControl ? { "Cache-Control": cacheControl } : {}) },
    });
}

function download(body = bytes): Response {
    return new Response(body, {
        headers: {
            "Content-Disposition": `attachment; filename="${filename}"`,
            "Cache-Control": "public, max-age=31536000, immutable, no-transform",
            "X-Robots-Tag": "noindex",
        },
    });
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
});

describe("portable publication smoke check", () => {
    it("waits for stale metadata and missing assets to propagate before accepting the exact bytes", async () => {
        const stale = {
            ...manifest,
            version: "v2026.09.24",
            files: {
                en: {
                    ...manifest.files.en!,
                    filename: "dashcamigo-2026-09-24-en.html",
                    path: "/downloads/portable/v2026.09.24/dashcamigo-2026-09-24-en",
                },
            },
        };
        const responses = [
            metadata(stale),
            metadata(),
            redirect(),
            new Response(null, { status: 404 }),
            metadata(),
            redirect(),
            download(),
        ];
        const requests: string[] = [];
        vi.stubGlobal("fetch", async (url: URL) => {
            requests.push(url.pathname);
            return responses.shift()!;
        });
        const verification = verifyPublishedPortableDownloads(manifest, "https://example.test");
        await vi.runAllTimersAsync();
        await verification;
        expect(requests).toEqual([
            "/downloads/portable/latest.json",
            "/downloads/portable/latest.json",
            "/downloads/portable/en.html",
            path,
            "/downloads/portable/latest.json",
            "/downloads/portable/en.html",
            path,
        ]);
        expect(responses).toHaveLength(0);
    });

    it("fails after bounded retries when published bytes never match the tested artifact", async () => {
        let downloads = 0;
        vi.stubGlobal("fetch", async (url: URL) => {
            if (url.pathname.endsWith("latest.json")) return metadata();
            if (url.pathname.endsWith("en.html")) return redirect();
            downloads++;
            return download(Buffer.from("corrupted HTML"));
        });
        const verification = expect(verifyPublishedPortableDownloads(manifest, "https://example.test")).rejects.toThrow(
            "published portable bytes differ from the release",
        );
        await vi.runAllTimersAsync();
        await verification;
        expect(downloads).toBe(10);
    });

    it("finishes immediately once metadata, headers and bytes match", async () => {
        vi.stubGlobal("fetch", async (url: URL) => {
            if (url.pathname.endsWith("latest.json")) return metadata();
            if (url.pathname.endsWith("en.html")) return redirect(`https://example.test${path}`);
            return download();
        });
        await verifyPublishedPortableDownloads(manifest, "https://example.test");
        expect(vi.getTimerCount()).toBe(0);
    });

    it.each([
        { location: "/downloads/portable/old", status: 302 },
        { location: `https://unrelated.example${path}`, status: 302 },
        { location: path, status: 301 },
        { location: path, status: 302, cache: "public, max-age=86400" },
        { location: path, status: 302, cache: "immutable" },
    ])("rejects stale, external, permanent or cached stable redirects: %j", async ({ location, status, cache }) => {
        vi.stubGlobal("fetch", async (url: URL) => {
            if (url.pathname.endsWith("latest.json")) return metadata();
            if (url.pathname.endsWith("en.html")) return redirect(location, status, cache);
            return download();
        });
        const verification = expect(verifyPublishedPortableDownloads(manifest, "https://example.test")).rejects.toThrow(
            /portable stable link/,
        );
        await vi.runAllTimersAsync();
        await verification;
    });

    it("allows sequential downloads to exceed a single request timeout", async () => {
        vi.spyOn(AbortSignal, "timeout").mockImplementation((delay) => {
            const controller = new AbortController();
            setTimeout(() => controller.abort(new DOMException("timed out", "TimeoutError")), delay);
            return controller.signal;
        });
        let requests = 0;
        vi.stubGlobal("fetch", async (url: URL, options: RequestInit) => {
            requests++;
            await new Promise((resolve) => setTimeout(resolve, 20_000));
            options.signal?.throwIfAborted();
            if (url.pathname.endsWith("latest.json")) return metadata();
            if (url.pathname.endsWith("en.html")) return redirect();
            return download();
        });
        const verification = expect(
            verifyPublishedPortableDownloads(manifest, "https://example.test"),
        ).resolves.toBeUndefined();
        await vi.runAllTimersAsync();
        await verification;
        expect(requests).toBe(3);
    });
});
