import type { PrecacheEntry } from "workbox-precaching";

export function isHtmlResponse(response: Response): boolean {
    return /(?:text\/html|application\/xhtml\+xml)/i.test(response.headers.get("content-type") ?? "");
}

export function isCacheableResponse(response: Response): boolean {
    return response.status === 200 && !response.redirected;
}

export function isCacheableAssetResponse(response: Response): boolean {
    return isCacheableResponse(response) && !isHtmlResponse(response);
}

/** The isolation pair of the global rule in public/_headers. */
export const CROSS_ORIGIN_ISOLATION_HEADERS = {
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-embedder-policy": "require-corp",
} as const;

/**
 * Gives a response handed to the page the hosted isolation headers. Cache
 * Storage keeps the headers of the deployment that stored an entry, and Workbox
 * reuses unchanged precache entries across updates. An isolated document
 * refuses a worker script without COEP (ERR_BLOCKED_BY_RESPONSE), and a shell
 * served from cache needs both headers to stay isolated.
 *
 * Status-0 responses pass through: `new Response` cannot recreate them. Routes
 * only handle same-origin requests, so these are a navigation's opaqueredirect,
 * which the browser follows with a new request that this worker handles again,
 * and `Response.error()`, which isolation cannot affect. Redirected responses
 * pass through as well, because a copy loses the final URL that scripts and
 * workers resolve against. The worker never caches them, so they come straight
 * from the network with the server's headers. The body streams into the copy
 * without being read.
 */
export function withCrossOriginIsolation(response: Response): Response {
    if (response.status === 0 || response.redirected) return response;
    const required = Object.entries(CROSS_ORIGIN_ISOLATION_HEADERS);
    if (required.every(([name, value]) => response.headers.get(name) === value)) return response;
    const headers = new Headers(response.headers);
    for (const [name, value] of required) headers.set(name, value);
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export function trackerCacheUrl(input: string): string {
    const url = new URL(input);
    url.searchParams.delete("__dc_repair");
    return url.href;
}

export function precacheRequest(request: Request, entry: PrecacheEntry): Request {
    // Same-origin CSS and classic scripts may arrive as no-cors requests.
    // Fetch only verifies SRI in cors mode; the manifest owns their exact bytes.
    return entry.integrity ? new Request(request, { mode: "cors", integrity: entry.integrity }) : request;
}

function htmlAttribute(tag: string, name: string): string | undefined {
    const match = tag.match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
    return match?.[1] ?? match?.[2] ?? match?.[3];
}

export async function validatePrecacheResponse(
    response: Response,
    entry: PrecacheEntry,
    shouldAllowUpdatedShell = false,
): Promise<Response> {
    if (!isCacheableResponse(response)) throw new Error(`precache ${entry.url}: invalid response`);
    if (entry.integrity) {
        // Fetch owns the SHA-256 check; never read binary bodies again on a hit.
        if (isHtmlResponse(response)) throw new Error(`precache ${entry.url}: html fallback`);
    } else {
        const html = await response.clone().text();
        const marker = [...html.matchAll(/<meta\s[^>]*>/gi)]
            .map(([tag]) =>
                htmlAttribute(tag, "name") === "dc-precache-revision" ? htmlAttribute(tag, "content") : undefined,
            )
            .find((value) => value !== undefined);
        if (!marker || (!shouldAllowUpdatedShell && (!entry.revision || marker !== entry.revision)))
            throw new Error(`precache ${entry.url}: shell revision mismatch`);
    }
    return response;
}
