// Workbox lifecycle/routing runs in the browser upgrade tests. These checks
// exercise only our edge-HTML, verified tracker-download and isolation policy.
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { offlineResponse } from "./sw-offline.js";
import {
    CROSS_ORIGIN_EMBEDDER_POLICY,
    isHtmlResponse,
    precacheRequest,
    trackerCacheUrl,
    validatePrecacheResponse,
    withEmbedderPolicy,
} from "./sw-policy.js";

const marker = "0123456789abcdef";
const shell = { url: "/en/", revision: marker };
const asset = { url: "/assets/app.js", revision: "code", integrity: "sha256-bXktY29kZQ==" };

describe("service worker integrity policy", () => {
    it("sets native SRI even when a same-origin stylesheet is requested as no-cors", () => {
        const request = new Request("https://example.test/assets/app.js", { mode: "no-cors" });
        const verified = precacheRequest(request, asset);
        expect(verified.url).toBe(request.url);
        expect(verified.mode).toBe("cors");
        expect(verified.integrity).toBe(asset.integrity);
        expect(precacheRequest(request, shell)).toBe(request);
    });

    it("does not buffer binary responses already verified by Fetch SRI", async () => {
        const response = new Response("code", { headers: { "content-type": "text/javascript" } });
        const clone = vi.spyOn(response, "clone");
        expect(await validatePrecacheResponse(response, asset)).toBe(response);
        expect(clone).not.toHaveBeenCalled();
    });

    it.each([
        `<meta name="dc-precache-revision" content="${marker}">`,
        `<meta content='${marker}' name='dc-precache-revision'>`,
        `<meta content=${marker} name=dc-precache-revision>`,
    ])("accepts hosting HTML transforms that preserve the shell marker: %s", async (meta) => {
        const response = new Response(`<html><head>${meta}<script>/* edge analytics */</script></head></html>`);
        expect(await validatePrecacheResponse(response, shell)).toBe(response);
    });

    it.each(["", '<meta name="dc-precache-revision" content="fedcba9876543210">'])(
        "rejects missing or mismatched shell identity: %s",
        async (meta) => {
            await expect(validatePrecacheResponse(new Response(`<html>${meta}</html>`), shell)).rejects.toThrow(
                "shell revision mismatch",
            );
        },
    );

    it("rejects unsuccessful downloads and successful HTML asset fallbacks", async () => {
        await expect(validatePrecacheResponse(new Response("missing", { status: 404 }), asset)).rejects.toThrow(
            "invalid response",
        );
        const fallback = new Response("<html>fallback</html>", { headers: { "content-type": "text/html" } });
        expect(isHtmlResponse(fallback)).toBe(true);
        await expect(validatePrecacheResponse(fallback, asset)).rejects.toThrow("html fallback");
    });

    it("allows a newer marked shell only for online navigation without relaxing asset checks", async () => {
        const newer = new Response('<html><meta name="dc-precache-revision" content="newer"></html>');
        expect(await validatePrecacheResponse(newer, shell, true)).toBe(newer);
        await expect(validatePrecacheResponse(newer, shell)).rejects.toThrow("shell revision mismatch");
        await expect(
            validatePrecacheResponse(new Response("<html>missing marker</html>"), shell, true),
        ).rejects.toThrow("shell revision mismatch");
        await expect(
            validatePrecacheResponse(new Response("unavailable", { status: 503 }), shell, true),
        ).rejects.toThrow("invalid response");
        await expect(
            validatePrecacheResponse(
                new Response("<html></html>", { headers: { "content-type": "text/html" } }),
                asset,
                true,
            ),
        ).rejects.toThrow("html fallback");
    });

    it("stores repeated tracker repairs under the canonical URL", () => {
        const url = "https://example.test/ort/runtime.12345678.wasm";
        expect(trackerCacheUrl(`${url}?__dc_repair=one`)).toBe(url);
        expect(trackerCacheUrl(`${url}?__dc_repair=two`)).toBe(url);
        expect(trackerCacheUrl(`${url}?mode=test&__dc_repair=three`)).toBe(`${url}?mode=test`);
    });
});

describe("service worker embedder policy", () => {
    const embedderOf = (response: Response) => response.headers.get("cross-origin-embedder-policy");

    it("matches the global rule in public/_headers, which also sends the opener policy", () => {
        const source = readFileSync(new URL("../public/_headers", import.meta.url), "utf8");
        const global = source.split(/^\/\*$/m)[1]!.split(/^\/\S/m)[0]!;
        const declared = (name: string) => global.match(new RegExp(`^[ \\t]+${name}:[ \\t]*(\\S+)[ \\t]*$`, "m"))?.[1];
        expect(declared("Cross-Origin-Embedder-Policy")).toBe(CROSS_ORIGIN_EMBEDDER_POLICY);
        // The worker leaves COOP to the server; isolation needs both.
        expect(declared("Cross-Origin-Opener-Policy")).toBe("same-origin");
    });

    it("adds the embedder policy to a stored response and keeps its status, headers and body", async () => {
        // A precache entry stored before the app sent COEP, or with a weaker policy.
        const stored = new Response("postMessage('ready')", {
            status: 200,
            statusText: "OK",
            headers: {
                "content-type": "text/javascript",
                "x-content-type-options": "nosniff",
                "cross-origin-opener-policy": "same-origin",
                "cross-origin-embedder-policy": "unsafe-none",
            },
        });
        const served = withEmbedderPolicy(stored);
        expect(embedderOf(served)).toBe("require-corp");
        expect(served.headers.get("cross-origin-opener-policy")).toBe("same-origin");
        expect(served.status).toBe(200);
        expect(served.statusText).toBe("OK");
        expect(served.headers.get("content-type")).toBe("text/javascript");
        expect(served.headers.get("x-content-type-options")).toBe("nosniff");
        expect(await served.text()).toBe("postMessage('ready')");
    });

    it("never adds an opener policy the server did not send", () => {
        const served = withEmbedderPolicy(new Response("<html></html>", { headers: { "content-type": "text/html" } }));
        expect(embedderOf(served)).toBe("require-corp");
        expect(served.headers.has("cross-origin-opener-policy")).toBe(false);
    });

    it("adds the embedder policy to the offline fallback page", async () => {
        const served = withEmbedderPolicy(offlineResponse());
        expect(embedderOf(served)).toBe("require-corp");
        expect(served.status).toBe(503);
        expect(served.headers.get("content-type")).toBe("text/html; charset=utf-8");
        expect(await served.text()).toMatch(/^<!doctype html>/);
    });

    it("streams the body into the copy without reading it", () => {
        // This stream never produces data: reading or buffering it would hang.
        const stored = new Response(new ReadableStream<Uint8Array>({ pull() {} }), {
            headers: { "content-type": "application/wasm" },
        });
        const served = withEmbedderPolicy(stored);
        expect(served, "a copy carries the added header").not.toBe(stored);
        expect(served.body, "the copy owns the original stream").toBe(stored.body);
        expect(stored.bodyUsed).toBe(false);
        expect(embedderOf(served)).toBe("require-corp");
    });

    it("keeps statuses that have no body", () => {
        const served = withEmbedderPolicy(new Response(null, { status: 304, statusText: "Not Modified" }));
        expect(served.status).toBe(304);
        expect(served.statusText).toBe("Not Modified");
        expect(served.body).toBeNull();
        expect(embedderOf(served)).toBe("require-corp");
    });

    it("passes status-0 responses through unchanged", () => {
        // Response.error() stands in for every status-0 type: opaque and
        // opaqueredirect responses cannot be constructed outside a fetch.
        const failure = Response.error();
        expect(failure.status).toBe(0);
        expect(withEmbedderPolicy(failure)).toBe(failure);
    });

    it("passes a response that already carries the embedder policy through unchanged", () => {
        const network = new Response("<html></html>", {
            headers: { "content-type": "text/html", "cross-origin-embedder-policy": "require-corp" },
        });
        expect(withEmbedderPolicy(network)).toBe(network);
    });
});
