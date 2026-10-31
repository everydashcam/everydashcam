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
