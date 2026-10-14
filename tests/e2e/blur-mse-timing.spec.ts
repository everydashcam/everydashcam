import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { rolldown } from "rolldown";
import type { checkMseBlurPreview } from "../helpers/mse-blur-harness.js";
import type motionFixture from "../testdata/mse-blur/motion.json";
import { expect, REPO_ROOT, test } from "./_fixtures.js";

const motion = JSON.parse(
    readFileSync(resolve(REPO_ROOT, "tests/testdata/mse-blur/motion.json"), "utf8"),
) as typeof motionFixture;

test("MSE paused frames keep held privacy pixels on the displayed target after timestamp rounding", async ({
    page,
}, testInfo) => {
    const workers = readdirSync(resolve(REPO_ROOT, "dist/assets")).filter((name) =>
        /^per-file-mse-worker-.*\.js$/.test(name),
    );
    expect(workers, "one fresh production MSE worker").toHaveLength(1);
    const bundle = await rolldown({
        input: resolve(REPO_ROOT, "tests/helpers/mse-blur-harness.ts"),
        platform: "browser",
        resolve: { extensionAlias: { ".js": [".ts", ".js"] } },
        transform: { define: { "import.meta.env": JSON.stringify({ PROD: false, VITE_SENTRY_DSN: "" }) } },
        plugins: [
            {
                name: "built-mse-worker-url",
                transform(code, id) {
                    if (!id.endsWith("/src/per-file-mse.ts")) return null;
                    // Mirror Vite's worker URL rewrite while using the real built
                    // worker. No playback, frame timing or blur behavior is replaced.
                    return code.replace('"./workers/per-file-mse-worker.ts"', JSON.stringify(`/assets/${workers[0]}`));
                },
            },
        ],
    });
    let code: string;
    try {
        const output = await bundle.generate({ format: "es", codeSplitting: false });
        const chunk = output.output.find((entry) => entry.type === "chunk");
        if (!chunk) throw new Error("mse blur harness missing");
        code = chunk.code;
    } finally {
        await bundle.close();
    }
    await page.route("**/mse-blur-harness.js", (route) =>
        route.fulfill({ contentType: "application/javascript", body: code }),
    );
    await page.route("**/mse-blur-harness.html", (route) =>
        route.fulfill({ contentType: "text/html", body: "<!doctype html><title>MSE privacy timing</title>" }),
    );
    await page.goto("/mse-blur-harness.html");
    const bytes = Array.from(readFileSync(resolve(REPO_ROOT, "tests/testdata/mse-blur/moving-card.mpegts")));
    const results = await page.evaluate(
        async ({ bytes, motion }) => {
            const url = "/mse-blur-harness.js";
            const harness: { checkMseBlurPreview: typeof checkMseBlurPreview } = await import(url);
            return harness.checkMseBlurPreview(bytes, motion);
        },
        { bytes, motion },
    );
    await testInfo.attach("mse-held-mask-timing", {
        body: JSON.stringify(results, null, 2),
        contentType: "application/json",
    });
    expect(results).toHaveLength(2);
    for (const result of results) {
        const label = `source frame ${result.sourceTime}`;
        expect(result.paused, label).toBe(true);
        // This proves the fixture exercises the original one-microsecond
        // tolerance failure, rather than accidentally landing on the mux grid.
        expect(result.sourceTime - result.mediaTime, label).toBeGreaterThan(1e-6);
        expect(result.sourceTime - result.mediaTime, label).toBeLessThan(20e-6);
        expect(result.rawLeadingPixel[0], `decoded moving card, ${label}`).toBeGreaterThan(150);
        for (const axis of ["x", "y", "w", "h"] as const)
            expect(result.selectedBox[axis], `${label}, ${axis}`).toBeCloseTo(result.expectedBox[axis], 8);
        expect(result.coveredFraction, `actual painted target coverage, ${label}`).toBe(1);
        expect(result.paintedPreviousPixel, `old position stays uncovered, ${label}`).toEqual(result.rawPreviousPixel);
        expect(result.rawPreviousPixel[0], `visible background control, ${label}`).toBeGreaterThan(30);
    }
});
