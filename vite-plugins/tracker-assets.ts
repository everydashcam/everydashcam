// Self-hosts the blur-zone auto-tracker's runtime assets under cache-busted,
// same-origin URLs (no CDN: nothing external at runtime), and keeps them OUT of
// the PWA precache - the wasm+models are a lazy TRACKER-cached download, not
// part of the offline boot shell.
//
// WHY cache-busted URLs: these files change bytes when the dependency upgrades,
// but their paths are otherwise stable. onnxruntime-web keeps the same wasm
// filename across versions, and a re-exported ONNX model can reuse its name - so
// an offline PWA could serve a stale copy against freshly-precached glue (an ORT
// ABI mismatch, a hard init crash) or run stale model weights (silent-wrong
// output). Fingerprinting the URL is the same immutable-asset defense the
// bundler already gives /assets/:
//   - ORT: module, WASM and any binary parts live under /ort/<ort-version>/.
//     The loader assembles oversized WASM through the official wasmBinary API;
//     versioned part URLs and SHA-256 checks keep glue and binary bytes paired.
//   - models: we own the fetch URL fully, so we content-hash the FILENAME
//     -> <name>.<hash>.onnx. This catches even a re-export with identical
//     arch/size (different bytes -> different URL).
// A new URL is a new TRACKER cache entry, a new localStorage "downloaded" flag,
// and no way to serve old bytes as new; the SW drops superseded entries on
// activate (see TRACKER_ASSET_URLS in public/sw.js).
//
// Dev keeps the original unbusted URLs (offline is a production concern); the
// build emits the busted layout. `vite preview` / e2e serve the built dist, so
// they exercise the real busted URLs.

import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Plugin } from "vite";
import type { OrtAssets, WasmPart } from "../src/tracking/ort-assets.js";

const ORT_DIST = resolve("node_modules/onnxruntime-web/dist");
const ORT_PKG = resolve("node_modules/onnxruntime-web/package.json");

// Plain pair: the WASM EP used by Follow. Asyncify pair: what
// ort's WebGPU EP actually loads (the detection pass on WebGPU machines) - NOT
// the jsep build, which this ort release keeps for other backends.
const ORT_RUNTIMES = {
    wasm: "ort-wasm-simd-threaded",
    webgpu: "ort-wasm-simd-threaded.asyncify",
} as const;
// Cloudflare Pages limits each published file to 25 MiB. Leave headroom in
// each piece so future runtime growth only adds pieces, not infrastructure.
const MAX_ASSET_BYTES = 25 * 1024 * 1024;
const WASM_PART_BYTES = 16 * 1024 * 1024;

interface OrtEmit {
    name: string;
    source: string;
    offset: number;
    bytes: number;
}

function prepareOrtAssets(ortDir: string): { ort: TrackerAssetsApp["ort"]; emit: OrtEmit[] } {
    const emit: OrtEmit[] = [];
    const ort = {} as TrackerAssetsApp["ort"];
    for (const runtime of ["wasm", "webgpu"] as const) {
        const base = ORT_RUNTIMES[runtime];
        const source = join(ORT_DIST, `${base}.wasm`);
        const binary = readFileSync(source);
        let wasm: OrtAssets["wasm"];
        if (binary.length > MAX_ASSET_BYTES) {
            const parts: WasmPart[] = [];
            for (let offset = 0; offset < binary.length; offset += WASM_PART_BYTES) {
                const bytes = binary.subarray(offset, offset + WASM_PART_BYTES);
                const name = `${base}.wasm.part-${parts.length}.bin`;
                parts.push({
                    url: `${ortDir}${name}`,
                    bytes: bytes.length,
                    sha256: createHash("sha256").update(bytes).digest("hex"),
                });
                emit.push({ name, source, offset, bytes: bytes.length });
            }
            wasm = { bytes: binary.length, parts };
        } else {
            const name = `${base}.wasm`;
            wasm = { url: `${ortDir}${name}`, bytes: binary.length };
            emit.push({ name, source, offset: 0, bytes: binary.length });
        }
        const name = `${base}.mjs`;
        const moduleSource = join(ORT_DIST, name);
        const bytes = readFileSync(moduleSource).length;
        if (bytes > MAX_ASSET_BYTES) throw new Error("tracker runtime module exceeds hosting file limit");
        emit.push({ name, source: moduleSource, offset: 0, bytes });
        ort[runtime] = { moduleUrl: `${ortDir}${name}`, wasm };
    }
    return { ort, emit };
}

// The tracker's ONNX models, public-relative, keyed by the logical name the app
// requests (blur-assets.ts). Their bytes decide detection quality, so a stale
// copy is silent-wrong-output rather than a crash - hence the content hash.
const MODELS = [
    { key: "tracker", rel: "models/vittrack/object_tracking_vittrack_2023sep.onnx" },
    { key: "plate", rel: "models/plate/yolo26n-plate-640-fp16.onnx" },
    { key: "face", rel: "models/face/yolo26n-face-640-fp16.onnx" },
] as const;

const MIME: Record<string, string> = {
    ".wasm": "application/wasm",
    ".mjs": "text/javascript",
    ".bin": "application/octet-stream",
};

/** App-facing asset URLs consumed by src/ui/blur-assets.ts via the
 *  __DC_TRACKER_ASSETS__ define. */
export interface TrackerAssetsApp {
    ort: { wasm: OrtAssets; webgpu: OrtAssets };
    /** Content-hashed same-origin model URLs, by logical name. */
    models: { tracker: string; plate: string; face: string };
}

export interface TrackerAssets {
    app: TrackerAssetsApp;
    ortEmit: OrtEmit[];
    /** Flat set of the build's cache-busted URLs, injected into public/sw.js so
     *  the activate handler drops superseded TRACKER entries. Empty in dev. */
    urls: string[];
    /** onnxruntime-web version stamped into the /ort/ dir; null in dev. */
    ortVersion: string | null;
    /** Per-model emit plan for the build (public-relative source -> hashed dist
     *  path + url). Empty in dev. */
    modelEmit: Array<{ rel: string; distRel: string; url: string }>;
}

function sha8(buf: Buffer): string {
    return createHash("sha256").update(buf).digest("hex").slice(0, 8);
}

function readOrtVersion(): string {
    const pkg = JSON.parse(readFileSync(ORT_PKG, "utf-8")) as { version?: string };
    if (!pkg.version) throw new Error("tracker-assets: onnxruntime-web has no version in package.json");
    return pkg.version;
}

// Insert `.<hash>` before the extension: models/x/name.onnx -> models/x/name.<hash>.onnx.
function bustModelRel(rel: string, hash: string): string {
    return rel.replace(/\.onnx$/, `.${hash}.onnx`);
}

/**
 * Computes the cache-busted (build) or original (dev) tracker asset URLs plus
 * the build's emit plan. Pure over the source files (node_modules ort +
 * public/models), so it runs at vite-config time to feed both the
 * __DC_TRACKER_ASSETS__ define and trackerAssetsPlugin from one hash pass.
 *
 * Dev uses unversioned URLs but the same part layout and integrity checks.
 * Models come from public/ through Vite's normal development server.
 */
export function computeTrackerAssets(command: "serve" | "build", root = process.cwd()): TrackerAssets {
    const ortVersion = command === "build" ? readOrtVersion() : null;
    const ortDir = ortVersion ? `/ort/${ortVersion}/` : "/ort/";
    const { ort, emit: ortEmit } = prepareOrtAssets(ortDir);
    if (command !== "build") {
        return {
            ortEmit,
            app: {
                ort,
                models: {
                    tracker: `/${MODELS[0].rel}`,
                    plate: `/${MODELS[1].rel}`,
                    face: `/${MODELS[2].rel}`,
                },
            },
            urls: [],
            ortVersion: null,
            modelEmit: [],
        };
    }
    const models: Record<string, string> = {};
    const modelEmit: TrackerAssets["modelEmit"] = [];
    for (const m of MODELS) {
        const bytes = readFileSync(resolve(root, "public", m.rel));
        if (bytes.length > MAX_ASSET_BYTES) throw new Error(`tracker model ${m.key} exceeds hosting file limit`);
        const hash = sha8(bytes);
        const distRel = bustModelRel(m.rel, hash);
        const url = `/${distRel}`;
        models[m.key] = url;
        modelEmit.push({ rel: m.rel, distRel, url });
    }
    const urls = [...ortEmit.map((file) => `${ortDir}${file.name}`), ...Object.values(models)];
    return { app: { ort, models: models as TrackerAssetsApp["models"] }, urls, ortVersion, ortEmit, modelEmit };
}

const SW_PLACEHOLDER = /const TRACKER_ASSET_URLS = \[\];\s*\/\/ __DC_TRACKER_ASSET_URLS__/;

/**
 * Emits the busted asset layout at build time and serves unversioned /ort/
 * files and parts in dev. The precomputed manifest lets this plugin and the
 * config's define share one hash pass over the runtime and model files.
 */
export function trackerAssetsPlugin(assets: TrackerAssets): Plugin {
    return {
        name: "everydashcam-tracker-assets",
        configureServer(server) {
            // Serve the same part layout in development so local detection exercises
            // assembly too. Models retain Vite's public-directory handling.
            server.middlewares.use("/ort", (req, res, next) => {
                const name = (req.url ?? "").split("?")[0]?.replace(/^\//, "") ?? "";
                const file = assets.ortEmit.find((entry) => entry.name === name);
                if (!file || !existsSync(file.source)) return next();
                const ext = name.slice(name.lastIndexOf("."));
                res.setHeader("content-type", MIME[ext] ?? "application/octet-stream");
                res.setHeader("content-length", file.bytes);
                res.end(readFileSync(file.source).subarray(file.offset, file.offset + file.bytes));
            });
        },
        closeBundle() {
            // Vitest loads the shared Vite config with command="serve" and
            // still runs closeBundle when its module graph shuts down. The dev
            // plugin is needed for configureServer above, but it must never
            // rewrite an existing dist/ (or race a build running alongside the
            // unit suite). A non-null version is the build-only invariant from
            // computeTrackerAssets().
            if (assets.ortVersion === null) return;

            // 1) ORT wasm/glue -> dist/ort/<version>/ (the version-stamped dir the
            // loader points wasmPaths at - see computeTrackerAssets for why ORT is
            // busted by directory, not filename).
            const outDir = resolve("dist/ort", assets.ortVersion ?? "");
            mkdirSync(outDir, { recursive: true });
            for (const file of assets.ortEmit) {
                const bytes = readFileSync(file.source).subarray(file.offset, file.offset + file.bytes);
                if (bytes.length !== file.bytes) throw new Error("tracker runtime changed during build");
                writeFileSync(join(outDir, file.name), bytes);
            }
            // Drop the bundler-emitted duplicate of the wasm under /assets/. The
            // tracker worker bundles onnxruntime-web, so Rolldown emits the wasm as
            // a hashed /assets/ asset, but the runtime NEVER fetches it: loadOrt
            // sets wasmPaths to /ort/<version>/ before any session init. Removing
            // it keeps /assets/ (and the self-host zip) lean; sw-precache also
            // skips *.wasm, so the offline shell is unaffected either way.
            const assetsDir = resolve("dist/assets");
            if (existsSync(assetsDir)) {
                for (const name of readdirSync(assetsDir)) {
                    if (/^ort-wasm.*\.wasm$/.test(name)) rmSync(join(assetsDir, name));
                }
            }
            // 2) Content-hash the models: Vite copied public/models verbatim into
            // dist/models/ under their original names; rename each to its hashed
            // name and drop the original so only the busted URL is served.
            for (const e of assets.modelEmit) {
                const srcDist = resolve("dist", e.rel);
                const dstDist = resolve("dist", e.distRel);
                if (!existsSync(srcDist)) {
                    throw new Error(`tracker-assets: model ${e.rel} missing in dist - public copy did not run first?`);
                }
                mkdirSync(dirname(dstDist), { recursive: true });
                copyFileSync(srcDist, dstDist);
                rmSync(srcDist);
            }
            // 3) Inject the current asset URL set into dist/sw.js so the activate
            // handler drops superseded TRACKER entries. Mirrors sw-precache's
            // placeholder replacement; must run before minifyServiceWorker (later
            // in the plugin array).
            const swPath = resolve("dist/sw.js");
            if (existsSync(swPath)) {
                const sw = readFileSync(swPath, "utf-8");
                if (!SW_PLACEHOLDER.test(sw)) {
                    throw new Error("tracker-assets: TRACKER_ASSET_URLS placeholder not found in dist/sw.js");
                }
                writeFileSync(
                    swPath,
                    sw.replace(SW_PLACEHOLDER, `const TRACKER_ASSET_URLS = ${JSON.stringify(assets.urls)};`),
                );
            }
        },
    };
}
