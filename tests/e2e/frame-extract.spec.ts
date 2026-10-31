import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { rolldown } from "rolldown";
import type { runFrameExtractRegression } from "../helpers/frame-extract-harness.js";
import { expect, REPO_ROOT, test } from "./_fixtures.js";

const bundles = new Map<string, string>();
test.beforeAll(async () => {
    for (const name of ["frame-extract-harness", "frame-extract-worker-harness"]) {
        const bundle = await rolldown({
            input: resolve(REPO_ROOT, `tests/helpers/${name}.ts`),
            platform: "browser",
            resolve: { extensionAlias: { ".js": [".ts", ".js"] } },
            transform: { define: { "import.meta.env": "{}", __PORTABLE__: "false" } },
        });
        try {
            const output = await bundle.generate({ format: "es", codeSplitting: false });
            const chunk = output.output.find((entry) => entry.type === "chunk");
            if (!chunk) throw new Error("frame extraction harness bundle missing");
            bundles.set(name, chunk.code);
        } finally {
            await bundle.close();
        }
    }
});

for (const mode of ["ordered", "unordered", "failure", "cancel-bitmap"] as const) {
    test(`frame extraction ${mode} preserves slots and releases native resources`, async ({ page }) => {
        for (const [name, body] of bundles) {
            await page.route(`**/${name}.js`, (route) =>
                route.fulfill({ contentType: "application/javascript", body }),
            );
        }
        await page.route("**/frame-extract-harness.html", (route) =>
            route.fulfill({
                contentType: "text/html",
                body: "<!doctype html><title>Frame extraction regression</title>",
            }),
        );
        await page.goto("/frame-extract-harness.html");
        const bytes = Array.from(readFileSync(resolve(REPO_ROOT, "src/parsers/__fixtures__/generic/clip-h264.mkv")));
        const result = await page.evaluate(
            async ({ bytes, mode }) => {
                const url = "/frame-extract-harness.js";
                const harness: { runFrameExtractRegression: typeof runFrameExtractRegression } = await import(url);
                return harness.runFrameExtractRegression("/frame-extract-worker-harness.js", bytes, mode);
            },
            { bytes, mode },
        );
        test.skip(!result.supported, "H.264 decode is unavailable");
        if (!result.supported) throw new Error("decode capability check inconsistent");
        if (mode === "cancel-bitmap") expect(result.actual.every((bitmap) => bitmap === null)).toBe(true);
        else expect(result.actual).toEqual(result.expected);
        for (const stats of [result.settledStats, result.stats]) {
            expect(stats.injectedFailures).toBe(mode === "failure" ? 1 : 0);
            expect(stats.openDecoders).toBe(0);
            expect(stats.openFrames).toBe(0);
            expect(stats.ownedBitmaps).toBe(0);
        }
    });
}
