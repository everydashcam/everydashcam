import { resolve } from "node:path";
import { rolldown } from "rolldown";
import type { compareTrackingFrameCrops } from "../helpers/tracking-frame-harness.js";
import { expect, REPO_ROOT, test } from "./_fixtures.js";

test.use({ viewerMap: "route-only" });

test("native tracking crops preserve displayed pixels through transforms, clipping and fractional scaling", async ({
    page,
}) => {
    const bundle = await rolldown({
        input: resolve(REPO_ROOT, "tests/helpers/tracking-frame-harness.ts"),
        platform: "browser",
        resolve: { extensionAlias: { ".js": [".ts", ".js"] } },
    });
    let code: string;
    try {
        const output = await bundle.generate({ format: "es", codeSplitting: false });
        const chunk = output.output.find((entry) => entry.type === "chunk");
        if (!chunk) throw new Error("tracking frame harness missing");
        code = chunk.code;
    } finally {
        await bundle.close();
    }
    await page.route("**/tracking-frame-harness.js", (route) =>
        route.fulfill({ contentType: "application/javascript", body: code }),
    );
    await page.route("**/tracking-frame-harness.html", (route) =>
        route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Native tracking crops</title>" }),
    );
    await page.goto("/tracking-frame-harness.html");
    const results = await page.evaluate(async () => {
        const url = "/tracking-frame-harness.js";
        const module: { compareTrackingFrameCrops: typeof compareTrackingFrameCrops } = await import(url);
        return module.compareTrackingFrameCrops();
    });
    expect(results).toHaveLength(37);
    for (const result of results) {
        const label = `${result.format}, rotation=${result.rotation}, flip=${result.flip}, PAR=${result.par}`;
        expect(result.width, label).toBe(result.expectedWidth);
        expect(result.height, label).toBe(result.expectedHeight);
        expect(result.comparisons, label).toBe(38);
        expect(result.differentBytes, label).toBe(0);
        expect(result.maxError, label).toBe(0);
    }
});
