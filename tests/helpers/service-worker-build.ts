import { resolve } from "node:path";
import { build } from "vite";

export interface ServiceWorkerEntry {
    url: string;
    revision?: string | null;
    integrity?: string;
}

/** Bundle the production worker with a small synthetic deployment for browser tests. */
export async function buildServiceWorker(manifest: ServiceWorkerEntry[]): Promise<string> {
    const result = await build({
        configFile: false,
        logLevel: "silent",
        publicDir: false,
        define: {
            "self.__WB_MANIFEST": JSON.stringify(manifest),
            "process.env.NODE_ENV": JSON.stringify("production"),
        },
        build: {
            write: false,
            emptyOutDir: false,
            minify: false,
            lib: { entry: resolve("src/sw.ts"), formats: ["iife"], name: "EverydashcamServiceWorker" },
        },
    });
    const bundle = Array.isArray(result) ? result[0] : result;
    if (!bundle || !("output" in bundle)) throw new Error("service worker fixture did not produce one bundle");
    const chunk = bundle.output.find((output) => output.type === "chunk" && output.isEntry);
    if (chunk?.type !== "chunk") throw new Error("service worker fixture entry missing");
    return chunk.code;
}
