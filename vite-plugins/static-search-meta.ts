// Search directives for HTML documents copied verbatim from public/. Locale
// pages receive the same policy in their prerender plugins; this pass closes
// the gap for standalone documents on hosts without response-header rules.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Plugin } from "vite";
import { LARGE_IMAGE_PREVIEW_META, type SeoDeploymentContext } from "./deployment-profile.js";

const STANDALONE_DOCUMENTS = ["privacy.html", "terms.html", "add-my-camera.html"] as const;
const ROBOTS_NOINDEX = '<meta name="robots" content="noindex, nofollow">';

function injectHeadMeta(html: string, tag: string): string {
    if (!/<head[^>]*>/i.test(html)) throw new Error("static-search-meta: HTML has no <head>");
    return html.replace(/<head[^>]*>/i, (head) => `${head}${tag}`);
}

export function applyStaticSearchMeta(
    distDir: string,
    options: { noIndex: boolean; deployment: SeoDeploymentContext },
): void {
    const tag = options.noIndex ? ROBOTS_NOINDEX : LARGE_IMAGE_PREVIEW_META;

    for (const name of STANDALONE_DOCUMENTS) {
        const path = resolve(distDir, name);
        if (!existsSync(path)) throw new Error(`static-search-meta: missing ${name}`);
        const html = readFileSync(path, "utf-8");
        // Redirect stubs consolidate at their fallback document; production
        // does not add an indexing directive alongside the redirect.
        if ((!options.noIndex && /http-equiv="refresh"/i.test(html)) || html.includes(tag)) continue;
        writeFileSync(path, injectHeadMeta(html, tag));
    }
}

export function staticSearchMetaPlugin(options: { noIndex: boolean; deployment: SeoDeploymentContext }): Plugin {
    return {
        name: "everydashcam-static-search-meta",
        apply: "build",
        closeBundle() {
            applyStaticSearchMeta(resolve(process.cwd(), "dist"), options);
        },
    };
}
