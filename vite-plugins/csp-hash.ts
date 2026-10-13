// Computes SHA-256 of the inline <script id="dc-bootstrap"> in
// dist/index.html and delivers the CSP two ways:
//
//   - always: splices 'sha256-...' into the script-src directive of
//     dist/_headers (the header CSP Cloudflare Pages serves). Required
//     because our CSP disallows 'unsafe-inline' (see public/_headers) and
//     the bootstrap script must run synchronously in <head> before any
//     paint - moving it to an external /bootstrap.js would add a
//     render-blocking round-trip we explicitly want to avoid.
//
//   - with META_CSP=1: additionally injects the same policy as a
//     <meta http-equiv="Content-Security-Policy"> into every dist HTML,
//     for hosts that cannot send response headers at all (the GitHub Pages
//     mirror, `npx serve`, `python -m http.server`). The self-host artifact
//     build sets the flag (release.yml, docker/Dockerfile); the Cloudflare
//     builds do NOT - there the header already enforces, and a second,
//     meta-delivered copy would keep enforcing even after the documented
//     rollback of the header to Report-Only (public/_headers), killing that
//     escape hatch.
//
// The meta policy is derived from the _headers policy - one source of
// truth, no drift - minus `frame-ancestors`: the CSP spec ignores it in
// <meta> delivery, and browsers log a console error for it on every page.
//
// Why hash and not nonce: nonce requires per-request HTML rewriting
// (CF Pages Function / Worker generating a fresh value per response).
// Our bootstrap script is byte-identical across builds - a static hash
// fits this perfectly without new infrastructure.
//
// Hashing happens AFTER html-minifier-terser ran (minifyJS: true in
// minifyHtmlPlugin runs terser over the inline body) - the bytes the
// browser will hash on load are exactly what we read from disk here.
//
// One hash covers all prerendered HTMLs: i18nPrerenderPlugin and
// vendorPagesPlugin only touch data-i18n nodes, og:* / canonical
// metas, FAQ JSON-LD and href="/cameras/" links - never our bootstrap
// script. Confirmed by reading both plugins.
//
// ORDERING (critical): closeBundle must run AFTER every plugin that writes
// HTML (prerender, vendor/alternative/feature pages, rootStub) and BEFORE
// swPrecachePlugin - the precache manifest hashes the locale shells, so an
// HTML edit after that point would break offline reconciliation. The
// registration sits between rootStubPlugin and swPrecachePlugin in
// vite.config.ts. _headers is copied from public/ by Vite during build
// (public/* assets pass through unchanged), so it exists at closeBundle
// time.

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Plugin } from "vite";

const BOOTSTRAP_SCRIPT_RE = /<script\b[^>]*\bid="dc-bootstrap"[^>]*>([\s\S]*?)<\/script>/;

// Anchors on "script-src 'self'" - the first allowlist token, present
// regardless of which external origins follow. Splicing the hash right
// after 'self' keeps the directive readable in the rendered _headers.
const CSP_SCRIPT_SRC_RE = /(Content-Security-Policy:[^\n]*?script-src 'self')(\s)/;

// The full header line, to lift the policy value for the meta variant.
const CSP_HEADER_LINE_RE = /Content-Security-Policy: ([^\n]+)/;

// Derives the meta-deliverable policy from the header policy: the identical
// string minus the directives the CSP spec ignores in <meta> delivery
// (of those, this project only uses frame-ancestors).
export interface MetaCspOptions {
    stripCloudflareAnalytics?: boolean;
}

export function metaCspFromHeaderPolicy(headerPolicy: string, options: MetaCspOptions = {}): string {
    const policy = headerPolicy
        .split(/;\s*/)
        .filter((directive) => !directive.startsWith("frame-ancestors"))
        .map((directive) => {
            if (!options.stripCloudflareAnalytics) return directive;
            if (!directive.startsWith("script-src ") && !directive.startsWith("connect-src ")) return directive;
            return directive
                .split(/\s+/)
                .filter(
                    (token) =>
                        token !== "https://static.cloudflareinsights.com" &&
                        token !== "https://cloudflareinsights.com",
                )
                .join(" ");
        });
    return policy.join("; ");
}

// Injects the CSP <meta> right after <meta charset> - the charset
// declaration must stay within the first 1024 bytes, and the policy still
// precedes the first <script> in <head>. Falls back to right after <head>
// for HTML without a charset meta; throws on neither (such a page is
// malformed and must fail the build, not ship unprotected).
export function injectMetaCsp(html: string, policy: string): string {
    const tag = `<meta http-equiv="Content-Security-Policy" content="${policy}">`;
    const anchor = /<meta charset=[^>]*>/i.exec(html) ?? /<head[^>]*>/i.exec(html);
    if (!anchor) {
        throw new Error("csp-hash: neither <meta charset> nor <head> found in HTML");
    }
    const at = anchor.index + anchor[0].length;
    return html.slice(0, at) + tag + html.slice(at);
}

function findHtmlFiles(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
        // Portable files carry their own final inline-script hashes.
        if (entry === "downloads") continue;
        const full = resolve(dir, entry);
        if (statSync(full).isDirectory()) {
            findHtmlFiles(full, out);
        } else if (entry.endsWith(".html")) {
            out.push(full);
        }
    }
    return out;
}

export interface CspHashPluginOptions extends MetaCspOptions {
    metaCsp?: boolean;
}

export function cspHashPlugin(options: CspHashPluginOptions = {}): Plugin {
    return {
        name: "everydashcam-csp-hash",
        apply: "build",
        closeBundle() {
            const distDir = resolve(process.cwd(), "dist");
            const indexPath = resolve(distDir, "index.html");
            const html = readFileSync(indexPath, "utf-8");
            const match = BOOTSTRAP_SCRIPT_RE.exec(html);
            if (!match) {
                throw new Error('csp-hash: <script id="dc-bootstrap"> not found in dist/index.html');
            }
            const scriptBody = match[1] ?? "";
            const hash = createHash("sha256").update(scriptBody, "utf-8").digest("base64");
            const directive = `'sha256-${hash}'`;

            const headersPath = resolve(distDir, "_headers");
            const headers = readFileSync(headersPath, "utf-8");
            if (!CSP_SCRIPT_SRC_RE.test(headers)) {
                throw new Error("csp-hash: script-src 'self' anchor not found in dist/_headers");
            }
            const updated = headers.replace(CSP_SCRIPT_SRC_RE, `$1 ${directive}$2`);
            writeFileSync(headersPath, updated);

            if (!(options.metaCsp ?? Boolean(process.env.META_CSP))) return;

            const headerLine = CSP_HEADER_LINE_RE.exec(updated);
            if (!headerLine?.[1]) {
                throw new Error("csp-hash: Content-Security-Policy line not found in dist/_headers");
            }
            const metaPolicy = metaCspFromHeaderPolicy(headerLine[1], options);
            for (const file of findHtmlFiles(distDir)) {
                const pageHtml = readFileSync(file, "utf-8");
                if (file === resolve(distDir, "migrate/index.html")) {
                    const recoveryPolicy = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(
                        pageHtml,
                    )?.[1];
                    const expected = [
                        "default-src 'none'",
                        "script-src 'self'",
                        "style-src 'self' 'unsafe-inline'",
                        "font-src 'self'",
                        "connect-src 'none'",
                        "base-uri 'none'",
                        "form-action 'none'",
                    ];
                    const directives = recoveryPolicy?.split(/;\s*/);
                    if (
                        !directives ||
                        directives.length !== expected.length ||
                        !expected.every((directive) => directives.includes(directive))
                    ) {
                        throw new Error("csp-hash: recovery page must keep its isolated content policy");
                    }
                    // Recovery must not inherit the viewer's external allowlists.
                    continue;
                }
                if (pageHtml.includes('http-equiv="Content-Security-Policy"')) {
                    throw new Error(`csp-hash: ${file} already carries a CSP meta - double injection`);
                }
                writeFileSync(file, injectMetaCsp(pageHtml, metaPolicy));
            }
        },
    };
}
