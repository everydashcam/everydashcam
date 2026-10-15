import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { addSentryConnectSource } from "../vite-plugins/csp-hash.js";

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
            ]),
        );
    });

    it.each([undefined, "", "   "])("omits reporting origins without a DSN (%s)", (dsn) => {
        const policy = extractHeaderCsp(readFileSync(HEADERS_PATH, "utf-8"));
        expect(addSentryConnectSource(policy, dsn)).toBe(policy);
    });

    it("allows the configured ingest origin without its credentials, path or query", () => {
        const policy = "default-src 'self'; connect-src 'self'; worker-src 'self' blob:";
        expect(
            addSentryConnectSource(policy, "https://public:secret@reports.example.test:8443/sentry/1?private=yes"),
        ).toBe("default-src 'self'; connect-src 'self' https://reports.example.test:8443; worker-src 'self' blob:");
        expect(addSentryConnectSource(policy, "http://public@localhost:9000/1")).toContain(
            "connect-src 'self' http://localhost:9000;",
        );
    });

    it("does not duplicate an origin already allowed by the deployment policy", () => {
        const policy = "connect-src 'self' https://reports.example.test";
        expect(addSentryConnectSource(policy, "https://public@reports.example.test/1")).toBe(policy);
    });

    it.each(["invalid", "data:text/plain,secret", "javascript:secret"])(
        "rejects invalid reporting origins (%s)",
        (dsn) => {
            expect(() => addSentryConnectSource("connect-src 'self'", dsn)).toThrow(
                "VITE_SENTRY_DSN must be an HTTP(S) URL",
            );
        },
    );
});
