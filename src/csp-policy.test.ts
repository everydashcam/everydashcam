import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const HEADERS_PATH = resolve(process.cwd(), "public/_headers");

function extractHeaderCsp(headers: string): string {
    const match = headers.match(/^[ \t]+Content-Security-Policy:[ \t]*(.+)$/m);
    if (!match?.[1]) throw new Error("Content-Security-Policy not found in public/_headers");
    return match[1].trim();
}

function directiveSources(csp: string, name: string): string[] {
    const directive = csp
        .split(";")
        .map((part) => part.trim())
        .find((part) => part === name || part.startsWith(`${name} `));
    if (!directive) throw new Error(`${name} directive not found in CSP`);
    return directive.slice(name.length).trim().split(/\s+/).filter(Boolean);
}

describe("CSP policy", () => {
    it("keeps connect-src within the no-backend app boundary", () => {
        const csp = extractHeaderCsp(readFileSync(HEADERS_PATH, "utf-8"));
        const connect = new Set(directiveSources(csp, "connect-src"));
        expect(connect).toEqual(
            new Set([
                "'self'",
                "https://tiles.openfreemap.org",
                "https://vector.openstreetmap.org",
                "https://tile.openstreetmap.org",
                "https://tiles.api-maps.yandex.ru",
                "https://cloudflareinsights.com",
                "https://o4511528520843264.ingest.de.sentry.io",
            ]),
        );
    });
});
