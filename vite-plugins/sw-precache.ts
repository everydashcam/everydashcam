// Workbox owns precache collection and injection. This adapter supplies the
// application's shell URLs and integrity metadata after prerendering finishes.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { PluginOption } from "vite";
import { VitePWA } from "vite-plugin-pwa";
import { getManifest, type ManifestTransform } from "workbox-build";
import { SEO_LOCALES } from "../src/i18n/seo-config.js";

export interface PrecacheEntry {
    url: string;
    revision: string;
    integrity?: string;
}

const HTML_REVISION = /<meta name="dc-precache-revision" content="([0-9a-f]{16})">/;
const MAX_ASSET_BYTES = 25 * 1024 * 1024;
const shellFiles = (segments: readonly string[]) => [
    "index.html",
    ...segments.map((segment) => `${segment}/index.html`),
];

function sha16(bytes: Buffer): string {
    return createHash("sha256").update(bytes).digest("hex").slice(0, 16);
}

/** Edge-injected analytics may change HTML bytes, but preserve this build marker. */
export function stampPrecacheShells(distDir: string, localeSegments: readonly string[]): void {
    for (const rel of shellFiles(localeSegments)) {
        const path = resolve(distDir, rel);
        const original = readFileSync(path, "utf8");
        const html = original.replace(HTML_REVISION, "");
        if (!html.includes("</head>")) throw new Error(`sw-precache: shell ${rel} has no closing head tag`);
        const marker = `<meta name="dc-precache-revision" content="${sha16(Buffer.from(html))}">`;
        const stamped = html.replace("</head>", `${marker}</head>`);
        if (stamped !== original) writeFileSync(path, stamped);
    }
}

function manifestTransform(
    distDir: () => string,
    localeSegments: readonly string[],
    shouldStampShells: boolean,
): ManifestTransform {
    return async (entries) => {
        if (shouldStampShells) stampPrecacheShells(distDir(), localeSegments);
        const urls = new Set(entries.map((entry) => entry.url));
        for (const file of shellFiles(localeSegments)) {
            if (!urls.has(file)) throw new Error(`sw-precache: ${file} missing in dist`);
        }
        if (!entries.some((entry) => /^assets\/.+\.m?js$/.test(entry.url))) {
            throw new Error("sw-precache: no JavaScript in dist/assets");
        }
        const manifest = entries.map((entry) => {
            // Workbox provides an MD5 revision, so SRI needs the file bytes again.
            const bytes = readFileSync(resolve(distDir(), entry.url));
            if (entry.url.endsWith(".html")) {
                const revision = HTML_REVISION.exec(bytes.toString("utf8"))?.[1];
                if (!revision) throw new Error(`sw-precache: shell ${entry.url} has no build marker`);
                return { ...entry, url: `/${entry.url.replace(/index\.html$/, "")}`, revision };
            }
            const digest = createHash("sha256").update(bytes).digest();
            return {
                ...entry,
                url: `/${entry.url}`,
                revision: digest.toString("hex").slice(0, 16),
                integrity: `sha256-${digest.toString("base64")}`,
            };
        });
        manifest.sort((a, b) => a.url.localeCompare(b.url, "en"));
        return { manifest, warnings: [] };
    };
}

function manifestOptions(distDir: () => string, localeSegments: readonly string[], shouldStampShells = false) {
    return {
        globPatterns: ["assets/**/*.{js,mjs,css}", "styles/**/*.{json,png}", ...shellFiles(localeSegments)],
        maximumFileSizeToCacheInBytes: MAX_ASSET_BYTES,
        manifestTransforms: [manifestTransform(distDir, localeSegments, shouldStampShells)],
    };
}

/** Uses the same Workbox collector as the production injection pipeline. */
export async function collectPrecacheEntries(
    distDir: string,
    localeSegments: readonly string[],
): Promise<PrecacheEntry[]> {
    const result = await getManifest({ globDirectory: distDir, ...manifestOptions(() => distDir, localeSegments) });
    return result.manifestEntries as PrecacheEntry[];
}

export function swPrecachePlugin(): PluginOption[] {
    let distDir = resolve("dist");
    const localeSegments = SEO_LOCALES.map((locale) => locale.urlSegment);
    return [
        {
            name: "everydashcam-precache-shells",
            apply: "build",
            configResolved(config) {
                distDir = resolve(config.root, config.build.outDir);
            },
        },
        ...VitePWA({
            strategies: "injectManifest",
            srcDir: "src",
            filename: "sw.ts",
            injectRegister: null,
            manifest: false,
            includeManifestIcons: false,
            integration: { closeBundleOrder: "post" },
            devOptions: { enabled: false },
            injectManifest: manifestOptions(() => distDir, localeSegments, true),
        }),
    ];
}
