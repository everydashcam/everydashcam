import { resolve } from "node:path";
import { rolldown } from "rolldown";
import { computeTrackerAssets } from "../../vite-plugins/tracker-assets.js";
import type { trackDisplacements } from "../helpers/tracker-displacement-harness.js";
import { expect, REPO_ROOT, test } from "./_fixtures.js";

test("real tracker verifies a displaced target against its frozen appearance", async ({ page }) => {
    const assets = computeTrackerAssets("build").app;
    const bundle = await rolldown({
        transform: { define: { __DC_TRACKER_ASSETS__: JSON.stringify(assets) } },
        input: resolve(REPO_ROOT, "tests/helpers/tracker-displacement-harness.ts"),
        platform: "browser",
        resolve: { extensionAlias: { ".js": [".ts", ".js"] } },
    });
    let code: string;
    try {
        const output = await bundle.generate({ format: "es", codeSplitting: false });
        const chunk = output.output.find((entry) => entry.type === "chunk");
        if (!chunk) throw new Error("tracker harness missing");
        code = chunk.code;
    } finally {
        await bundle.close();
    }
    await page.route("**/tracker-displacement.js", (route) =>
        route.fulfill({ contentType: "application/javascript", body: code }),
    );
    await page.route("**/tracker-displacement.html", (route) =>
        route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Tracker displacement</title>" }),
    );
    await page.goto("/tracker-displacement.html");
    const results = await page.evaluate(async (assets) => {
        const url = "/tracker-displacement.js";
        const module: { trackDisplacements: typeof trackDisplacements } = await import(url);
        return module.trackDisplacements(new URL(assets.models.tracker.url, location.origin).href, assets.ort.wasm);
    }, assets);
    expect(results.results).toHaveLength(3);
    for (const { dx, changed, result } of results.results) {
        expect(result.lost).toBe(false);
        if (changed) {
            expect(result.rejected, JSON.stringify({ dx, changed, result })).toBe(true);
            expect(result.diagnostics.reason).toBe("low-score");
            expect(result.box).toEqual(results.seed);
        } else {
            expect(result.rejected).toBe(false);
            expect(result.diagnostics.reason).toBeNull();
            expect(result.score).toBeGreaterThan(0.2);
            const { box } = result;
            const target = { ...results.seed, x: results.seed.x + dx };
            const width = Math.max(0, Math.min(box.x + box.w, target.x + target.w) - Math.max(box.x, target.x));
            const height = Math.max(0, Math.min(box.y + box.h, target.y + target.h) - Math.max(box.y, target.y));
            expect((width * height) / (target.w * target.h)).toBeGreaterThan(0.8);
        }
    }
});
