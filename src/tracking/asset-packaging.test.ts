import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { computeTrackerAssets } from "../../vite-plugins/tracker-assets.js";

const roots: string[] = [];
afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function sourceTree() {
    const root = mkdtempSync(join(tmpdir(), "dc-assets-"));
    roots.push(root);
    const files = {
        "node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm": Buffer.from("plain"),
        "node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.wasm": Buffer.alloc(26 * 1024 * 1024, 7),
        "node_modules/onnxruntime-web/dist/ort.wasm.bundle.min.mjs": Buffer.from("plain glue"),
        "node_modules/onnxruntime-web/dist/ort.webgpu.bundle.min.mjs": Buffer.from("webgpu glue"),
        "public/models/vittrack/object_tracking_vittrack_2023sep.onnx": Buffer.from("tracker"),
        "public/models/plate/yolo26n-plate-640-fp16.onnx": Buffer.from("plate"),
        "public/models/face/yolo26n-face-640-fp16.onnx": Buffer.from("face"),
    };
    for (const [name, bytes] of Object.entries(files)) {
        const path = join(root, name);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, bytes);
    }
    return root;
}
it("uses identical immutable metadata in dev and production and splits over-limit binaries", () => {
    const root = sourceTree();
    const dev = computeTrackerAssets("serve", root);
    const build = computeTrackerAssets("build", root);
    expect(dev.app).toEqual(build.app);
    expect(build.app.ort.webgpu.wasm.parts.map((part) => part.bytes)).toEqual([16 * 1024 * 1024, 10 * 1024 * 1024]);
    for (const [url, bytes] of build.files) {
        expect(bytes.length).toBeLessThanOrEqual(25 * 1024 * 1024);
        expect(url).toMatch(/\.[a-f0-9]{64}\./);
    }
    const model = build.app.models.tracker;
    writeFileSync(join(root, "public/models/vittrack/object_tracking_vittrack_2023sep.onnx"), "replacement");
    expect(build.files.get(model.url)!.toString()).toBe("tracker");
    expect(computeTrackerAssets("build", root).app.models.tracker.url).not.toBe(model.url);
});
it("refuses a runtime whose glue changed after the binary snapshot", () => {
    const root = sourceTree();
    const assets = computeTrackerAssets("build", root);
    writeFileSync(join(root, "node_modules/onnxruntime-web/dist/ort.webgpu.bundle.min.mjs"), "new glue");
    expect(() => assets.assertRuntimeUnchanged()).toThrow("onnxruntime changed");
});

it.each([
    "node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm",
    "public/models/vittrack/object_tracking_vittrack_2023sep.onnx",
])("rejects an empty binary source at %s", (path) => {
    const root = sourceTree();
    writeFileSync(join(root, path), "");
    expect(() => computeTrackerAssets("build", root)).toThrow("empty tracker");
});
