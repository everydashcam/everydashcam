import { normalizePath, type Plugin } from "vite";

// ONNX Runtime starts each WASM thread as a module worker of the file that
// holds its bundled ESM (`new Worker(import.meta.url, { name: "em-pthread" })`).
// The top level of that file runs the thread entry, and ORT waits for every
// thread's load handshake, without a timeout, before any session exists. A
// runtime chunk must therefore have no static imports: an import of the
// tracker worker entry would start a whole tracker in each thread, the
// handshake would never arrive, and initialization would hang.
const ORT_BUNDLE = /\/node_modules\/onnxruntime-web\/dist\/ort\.(wasm|webgpu)\.bundle\.min\.mjs$/;
const RUNTIMES = ["wasm", "webgpu"] as const;
const ROLLDOWN_HELPERS = "\0rolldown/runtime.js";

export interface OrtThreadChunks {
    /** For worker builds: keeps each ORT bundle a self-contained chunk and checks the result. */
    workerPlugin(): Plugin;
    /** For the main build: fails unless worker builds produced and checked both runtime chunks. */
    plugin(): Plugin;
}

/** Worker builds run inside the main build, so both plugins share one record. */
export function ortThreadChunks(): OrtThreadChunks {
    const checked = new Set<string>();
    return {
        workerPlugin: () => ({
            name: "everydashcam-ort-thread-chunks",
            transform(code, id) {
                if (!ORT_BUNDLE.test(normalizePath(id))) return;
                // The bundle's esbuild require shim reads a global `require`.
                // Rolldown replaces that free reference with its own runtime
                // helper, which the worker entry chunk hosts, so the runtime
                // chunk would import the entry. Browsers have no `require`; a
                // module-scoped binding keeps the shim's behavior. Appended,
                // because `var` hoists and the source map keeps every position.
                return { code: `${code}\nvar require;\n`, map: null };
            },
            generateBundle(_options, bundle) {
                for (const chunk of Object.values(bundle)) {
                    if (chunk.type !== "chunk") continue;
                    const ids = Object.keys(chunk.modules).filter((id) => chunk.modules[id]!.renderedLength > 0);
                    const runtime = ids.map((id) => ORT_BUNDLE.exec(normalizePath(id))?.[1]).find(Boolean);
                    if (!runtime) continue;
                    // Any other module would run its top level in every thread.
                    // Rolldown's helper module only defines functions.
                    const others = ids.filter((id) => !ORT_BUNDLE.test(normalizePath(id)) && id !== ROLLDOWN_HELPERS);
                    const problems = [
                        chunk.imports.length > 0 && `imports ${chunk.imports.join(", ")}`,
                        others.length > 0 && `also contains ${others.join(", ")}`,
                        !chunk.code.includes("em-pthread") && "lost the thread entry",
                    ].filter(Boolean);
                    if (problems.length) {
                        this.error(
                            `ORT ${runtime} chunk ${chunk.fileName} cannot start threads: ${problems.join("; ")}`,
                        );
                    }
                    checked.add(runtime);
                }
            },
        }),
        plugin: () => ({
            name: "everydashcam-ort-thread-chunks-check",
            apply: "build",
            generateBundle() {
                const missing = RUNTIMES.filter((runtime) => !checked.has(runtime));
                if (missing.length) {
                    this.error(`no checked ORT runtime chunk for ${missing.join(", ")}; is the tracker worker built?`);
                }
            },
        }),
    };
}
