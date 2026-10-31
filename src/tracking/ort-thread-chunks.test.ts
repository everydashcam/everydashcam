import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { rolldown, type OutputChunk, type RolldownPlugin } from "rolldown";
import { afterEach, expect, it } from "vitest";
import { ortThreadChunks } from "../../vite-plugins/ort-thread-chunks.js";

const roots: string[] = [];
afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// The shape that matters in the official bundles: esbuild's require shim and a
// top-level thread entry selected by the worker name.
const RUNTIME_SOURCE = `var shim = typeof require < "u" ? require : null;
export const isThread = globalThis.self?.name?.startsWith("em-pthread") ?? false;
export default shim;
`;

function workerTree(entrySource: string): string {
    const root = mkdtempSync(join(tmpdir(), "dc-ort-chunks-"));
    roots.push(root);
    const files = {
        "node_modules/onnxruntime-web/dist/ort.wasm.bundle.min.mjs": RUNTIME_SOURCE,
        "node_modules/onnxruntime-web/dist/ort.webgpu.bundle.min.mjs": RUNTIME_SOURCE,
        "worker.mjs": entrySource,
    };
    for (const [name, source] of Object.entries(files)) {
        const path = join(root, name);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, source);
    }
    return root;
}

async function buildWorker(root: string, plugins: RolldownPlugin[]): Promise<OutputChunk[]> {
    const bundle = await rolldown({ input: join(root, "worker.mjs"), platform: "browser", plugins });
    try {
        const { output } = await bundle.generate({ format: "es" });
        return output.filter((item): item is OutputChunk => item.type === "chunk");
    } finally {
        await bundle.close();
    }
}

// The worker entry hosts Rolldown's require helper when it reads `require` too.
const TRACKER_ENTRY = `export const localRequire = typeof require < "u" ? require : null;
export const load = (runtime) =>
    runtime === "wasm"
        ? import("./node_modules/onnxruntime-web/dist/ort.wasm.bundle.min.mjs")
        : import("./node_modules/onnxruntime-web/dist/ort.webgpu.bundle.min.mjs");
`;

it("keeps both runtime chunks free of imports and records them for the main build", async () => {
    const threads = ortThreadChunks();
    const chunks = await buildWorker(workerTree(TRACKER_ENTRY), [threads.workerPlugin() as RolldownPlugin]);
    const runtimes = chunks.filter((chunk) => chunk.fileName.startsWith("ort."));
    expect(runtimes.map((chunk) => chunk.fileName.split("-")[0]).sort()).toEqual([
        "ort.wasm.bundle.min",
        "ort.webgpu.bundle.min",
    ]);
    for (const chunk of runtimes) {
        expect(chunk.imports, chunk.fileName).toEqual([]);
        expect(chunk.code, chunk.fileName).toContain("em-pthread");
    }
    const check = threads.plugin();
    const errors: string[] = [];
    const generateBundle = check.generateBundle as (this: unknown) => void;
    generateBundle.call({
        error: (message: string) => {
            errors.push(message);
        },
    });
    expect(errors).toEqual([]);
});

it("fails a worker build whose runtime chunk would import the worker entry", async () => {
    const threads = ortThreadChunks();
    const { transform: _transform, ...checkOnly } = threads.workerPlugin();
    await expect(buildWorker(workerTree(TRACKER_ENTRY), [checkOnly as RolldownPlugin])).rejects.toThrow(
        /ORT (?:wasm|webgpu) chunk .* cannot start threads: imports /,
    );
});

it("fails the main build when no worker build produced the runtime chunks", () => {
    const check = ortThreadChunks().plugin();
    const errors: string[] = [];
    const generateBundle = check.generateBundle as (this: unknown) => void;
    generateBundle.call({
        error: (message: string) => {
            errors.push(message);
        },
    });
    expect(errors).toEqual([expect.stringContaining("no checked ORT runtime chunk for wasm, webgpu")]);
});
