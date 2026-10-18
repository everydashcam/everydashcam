import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "vite";
import { expect, it } from "vitest";
import { DOCUMENT_SLUGS, documentPagesPlugin } from "../../vite-plugins/document-pages.js";
import { getIndexableSeoLocales } from "./seo-config.js";

it("pairs every built document and transition with the emitted runtime revision", async () => {
    const root = mkdtempSync(join(tmpdir(), "dc-document-runtime-"));
    try {
        mkdirSync(join(root, "public"));
        writeFileSync(join(root, "index.html"), "<!doctype html><html><body>Build fixture</body></html>");
        for (const slug of DOCUMENT_SLUGS) copyFileSync(`public/${slug}.html`, join(root, `public/${slug}.html`));
        const runtime = readFileSync("public/doc-lang.js", "utf8");
        const revisions: string[] = [];
        for (const code of [runtime, `${runtime}\n// Changed runtime revision.\n`]) {
            writeFileSync(join(root, "public/doc-lang.js"), code);
            await build({ configFile: false, envFile: false, root, logLevel: "silent", plugins: [documentPagesPlugin()] });
            const scriptUrls = new Set<string>();
            for (const slug of DOCUMENT_SLUGS) {
                const paths = [`${slug}.html`, ...getIndexableSeoLocales().map((locale) => `${locale.urlSegment}/${slug}/index.html`)];
                for (const path of paths) {
                    const html = readFileSync(join(root, "dist", path), "utf8");
                    const script = html.match(/<script src="(\/doc-lang\.[a-f0-9]+\.js)"><\/script>/)?.[1];
                    expect(script, path).toBeDefined();
                    scriptUrls.add(script!);
                    expect(html, path).not.toContain('src="/doc-lang.js"');
                }
            }
            expect(scriptUrls.size).toBe(1);
            const url = [...scriptUrls][0]!;
            expect(readFileSync(join(root, "dist", url.slice(1)), "utf8")).toBe(code);
            revisions.push(url);
        }
        expect(revisions[0]).not.toBe(revisions[1]);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
