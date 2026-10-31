// Snapshot immutable binary bytes once, before either dev serving or emission.
// ONNX's official bundled ESM supplies its matching JS glue; only binary data
// needs separate delivery. Large WASM remains below the Pages 25 MiB file cap.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Plugin } from "vite";
import type { AssetPart, TrackerAssetManifest } from "../src/tracking/ort-assets.js";

const MAX_ASSET_BYTES = 25 * 1024 * 1024;
const PART_BYTES = 16 * 1024 * 1024;
const RUNTIMES = { wasm: "ort-wasm-simd-threaded", webgpu: "ort-wasm-simd-threaded.asyncify" } as const;
const MODELS = {
    tracker: "models/vittrack/object_tracking_vittrack_2023sep.onnx",
    plate: "models/plate/yolo26n-plate-640-fp16.onnx",
    face: "models/face/yolo26n-face-640-fp16.onnx",
} as const;

export interface TrackerAssets {
    app: TrackerAssetManifest;
    files: Map<string, Buffer>;
    urls: string[];
    build: boolean;
    assertRuntimeUnchanged(): void;
}

export function computeTrackerAssets(command: "serve" | "build", root = process.cwd()): TrackerAssets {
    const sources = new Map<string, string>();
    const snapshot = (path: string) => {
        const bytes = readFileSync(path);
        if (bytes.length === 0) throw new Error(`empty tracker runtime source: ${path}`);
        sources.set(path, createHash("sha256").update(bytes).digest("hex"));
        return bytes;
    };
    const files = new Map<string, Buffer>();
    const part = (path: string, bytes: Buffer): AssetPart => {
        const sha256 = createHash("sha256").update(bytes).digest("hex");
        const url = path.replace(/(\.[^.]+)$/, `.${sha256}$1`);
        files.set(url, bytes);
        return { url, bytes: bytes.length, sha256 };
    };
    const ort = {} as TrackerAssetManifest["ort"];
    for (const runtime of ["wasm", "webgpu"] as const) {
        const name = RUNTIMES[runtime];
        const binary = snapshot(resolve(root, "node_modules/onnxruntime-web/dist", `${name}.wasm`));
        snapshot(resolve(root, "node_modules/onnxruntime-web/dist", `ort.${runtime}.bundle.min.mjs`));
        const parts: AssetPart[] = [];
        const step = binary.length > MAX_ASSET_BYTES ? PART_BYTES : binary.length;
        for (let offset = 0; offset < binary.length; offset += step) {
            const path = step === binary.length ? `/ort/${name}.wasm` : `/ort/${name}.part-${parts.length}.bin`;
            parts.push(part(path, binary.subarray(offset, offset + step)));
        }
        ort[runtime] = { wasm: { bytes: binary.length, parts } };
    }
    const models = {} as TrackerAssetManifest["models"];
    for (const key of ["tracker", "plate", "face"] as const) {
        const bytes = readFileSync(resolve(root, "public", MODELS[key]));
        if (bytes.length === 0) throw new Error(`empty tracker model: ${key}`);
        if (bytes.length > MAX_ASSET_BYTES) throw new Error(`tracker model ${key} exceeds hosting file limit`);
        models[key] = part(`/${MODELS[key]}`, bytes);
    }
    return {
        app: { ort, models },
        files,
        urls: [...files.keys()],
        build: command === "build",
        assertRuntimeUnchanged() {
            for (const [path, hash] of sources) {
                if (createHash("sha256").update(readFileSync(path)).digest("hex") !== hash) {
                    throw new Error("onnxruntime changed during this build; restart the development server or rebuild");
                }
            }
        },
    };
}

const SW_PLACEHOLDER = /const TRACKER_ASSET_URLS = \[\];\s*\/\/ __DC_TRACKER_ASSET_URLS__/;

export function trackerAssetsPlugin(assets: TrackerAssets): Plugin {
    let outDir = resolve("dist");
    return {
        name: "everydashcam-tracker-assets",
        configResolved(config) {
            outDir = resolve(config.root, config.build.outDir);
        },
        configureServer(server) {
            server.middlewares.use((req, res, next) => {
                const url = (req.url ?? "").split("?")[0]!;
                const bytes = assets.files.get(url);
                if (!bytes) return next();
                try {
                    assets.assertRuntimeUnchanged();
                } catch (error) {
                    return next(error);
                }
                res.setHeader("content-type", url.endsWith(".wasm") ? "application/wasm" : "application/octet-stream");
                res.setHeader("content-length", bytes.length);
                res.setHeader("cache-control", "no-store");
                res.end(bytes);
            });
        },
        closeBundle() {
            // Vitest runs serve-mode closeBundle too: never mutate a build there.
            if (!assets.build) return;
            assets.assertRuntimeUnchanged();
            for (const [url, bytes] of assets.files) {
                const path = resolve(outDir, url.slice(1));
                mkdirSync(dirname(path), { recursive: true });
                writeFileSync(path, bytes);
            }
            for (const rel of Object.values(MODELS)) rmSync(resolve(outDir, rel), { force: true });
            const assetsDir = resolve(outDir, "assets");
            if (existsSync(assetsDir)) {
                for (const name of readdirSync(assetsDir)) {
                    if (/^ort-wasm.*\.wasm$/.test(name)) rmSync(resolve(assetsDir, name));
                }
            }
            const swPath = resolve(outDir, "sw.js");
            if (existsSync(swPath)) {
                const sw = readFileSync(swPath, "utf8");
                if (!SW_PLACEHOLDER.test(sw)) throw new Error("tracker-assets: missing service worker placeholder");
                writeFileSync(
                    swPath,
                    sw.replace(SW_PLACEHOLDER, `const TRACKER_ASSET_URLS = ${JSON.stringify(assets.urls)};`),
                );
            }
        },
    };
}
