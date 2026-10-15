import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { build, type UserConfig } from "vite";
import { afterEach, describe, expect, it } from "vitest";
import { lazyBoundariesPlugin } from "../vite-plugins/lazy-boundaries.js";

const directories: string[] = [];
afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function bundleFixture(
    files: Record<string, string>,
    output: NonNullable<UserConfig["build"]>["rolldownOptions"] = {},
) {
    const root = mkdtempSync(join(tmpdir(), "dc-lazy-boundaries-"));
    directories.push(root);
    for (const [name, content] of Object.entries({
        "index.html": '<script type="module" src="/entry.js"></script>',
        ...files,
    })) {
        const path = join(root, name);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, content);
    }
    return build({
        configFile: false,
        envFile: false,
        root,
        publicDir: false,
        logLevel: "silent",
        plugins: [lazyBoundariesPlugin()],
        build: {
            write: false,
            minify: true,
            modulePreload: { polyfill: false },
            rolldownOptions: output,
        },
    });
}

describe("landing lazy boundaries in bundled output", () => {
    it("allows large eager application code while keeping libraries lazy", async () => {
        const result = await bundleFixture({
            "entry.js": `import { copy } from './copy.js'; window.copy = copy; window.openViewer = () => import('./viewer.js');`,
            "copy.js": `export const copy = ${JSON.stringify("application copy ".repeat(70_000))};`,
            "viewer.js": `export { viewer } from './node_modules/chart.js/index.js';`,
            "node_modules/chart.js/index.js": `export const viewer = 'chart';`,
        });
        if (!("output" in result)) throw new Error("expected a single build output");
        const entry = result.output.find((item) => item.type === "chunk" && item.isEntry);
        expect(entry?.type).toBe("chunk");
        if (entry?.type !== "chunk") throw new Error("missing entry");
        expect(Buffer.byteLength(entry.code)).toBeGreaterThan(1024 * 1024);
        expect(entry.dynamicImports.length).toBeGreaterThan(0);
    });

    it.each([
        "maplibre-gl",
        "chart.js",
        "chartjs-plugin-zoom",
        "mediabunny",
        "onnxruntime-web",
        "@sentry/browser",
        "@sentry/core",
    ])("rejects %s even when it adds only a few bytes to the entry", async (packageName) => {
        await expect(
            bundleFixture({
                "entry.js": `import { viewer } from './node_modules/${packageName}/index.js'; window.viewer = viewer;`,
                [`node_modules/${packageName}/index.js`]: `export const viewer = 'heavy capability';`,
            }),
        ).rejects.toThrow(`contains node_modules/${packageName}/index.js`);
    });

    it("follows transitive static chunk imports and reports the eager path", async () => {
        await expect(
            bundleFixture(
                {
                    "entry.js": `import { open } from './bridge.js'; window.openViewer = open;`,
                    "bridge.js": `import { viewer } from './node_modules/chart.js/index.js'; export function open() { return viewer; }`,
                    "node_modules/chart.js/index.js": `export const viewer = 'chart';`,
                },
                {
                    output: {
                        entryFileNames: "entry.js",
                        chunkFileNames: "[name].js",
                        codeSplitting: {
                            groups: [
                                { name: "heavy", test: /node_modules/, priority: 20 },
                                { name: "bridge", test: /bridge\.js$/, priority: 10 },
                            ],
                        },
                    },
                },
            ),
        ).rejects.toThrow("chart.js: entry.js -> bridge.js -> heavy.js");
    });

    it("rejects a lazy library co-located with an eager helper by chunk grouping", async () => {
        await expect(
            bundleFixture(
                {
                    "entry.js": `import { label } from './shared.js'; window.label = label; window.openViewer = () => import('./viewer.js');`,
                    "shared.js": `export const label = 'shared';`,
                    "viewer.js": `export { viewer } from './node_modules/chart.js/index.js';`,
                    "node_modules/chart.js/index.js": `export const viewer = 'chart';`,
                },
                {
                    output: {
                        chunkFileNames: "[name].js",
                        codeSplitting: {
                            groups: [{ name: "mixed", test: /(?:node_modules\/chart\.js\/|shared\.js$)/ }],
                        },
                    },
                },
            ),
        ).rejects.toThrow(/chart\.js: .* -> mixed\.js/);
    });

    it("allows tree-shaken library imports", async () => {
        await expect(
            bundleFixture({
                "entry.js": `import { viewer } from './node_modules/chart.js/index.js'; window.label = 'landing';`,
                "node_modules/chart.js/index.js": `export const viewer = 'chart';`,
            }),
        ).resolves.toBeDefined();
    });

    it("allows media code inside a separately built worker", async () => {
        await expect(
            bundleFixture({
                "entry.js": `window.openViewer = () => new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });`,
                "worker.js": `import { viewer } from './node_modules/mediabunny/index.js'; self.postMessage(viewer);`,
                "node_modules/mediabunny/index.js": `export const viewer = 'media';`,
            }),
        ).resolves.toBeDefined();
    });

    it("allows an eager worker URL proxy without treating its payload as eager", async () => {
        await expect(
            bundleFixture({
                "entry.js": `import workerUrl from './node_modules/maplibre-gl/worker.js?worker&url'; window.workerUrl = workerUrl;`,
                "node_modules/maplibre-gl/worker.js": `self.postMessage('map worker');`,
            }),
        ).resolves.toBeDefined();
    });

    it("rejects a protected worker payload inlined into the eager graph", async () => {
        await expect(
            bundleFixture({
                "entry.js": `import MapWorker from './node_modules/maplibre-gl/worker.js?worker&inline'; window.MapWorker = MapWorker;`,
                "node_modules/maplibre-gl/worker.js": `self.postMessage('map worker');`,
            }),
        ).rejects.toThrow("contains node_modules/maplibre-gl/worker.js?worker&inline");
    });

    it("rejects parser implementations while allowing shared cache metadata", async () => {
        const files = {
            "entry.js": `import { revision } from './src/parsers/primitives/cache-revisions.ts'; window.revision = revision;`,
            "src/parsers/primitives/cache-revisions.ts": `export { revision } from './cache-revisions.generated.ts';`,
            "src/parsers/primitives/cache-revisions.generated.ts": `export const revision = 'cache';`,
            "src/parsers/primitives/sample.ts": `export const parse = () => 'gps';`,
        };
        await expect(bundleFixture(files)).resolves.toBeDefined();
        await expect(
            bundleFixture({
                ...files,
                "entry.js": `${files["entry.js"]} import { parse } from './src/parsers/primitives/sample.ts'; window.parse = parse;`,
            }),
        ).rejects.toThrow("contains src/parsers/primitives/sample.ts");
    });

    it("fails closed when an eager import is externalized", async () => {
        await expect(
            bundleFixture(
                { "entry.js": `import { Chart } from 'chart.js'; window.Chart = Chart;` },
                { external: ["chart.js"] },
            ),
        ).rejects.toThrow(/unbundled eager import: .* -> chart\.js/);
    });
});
