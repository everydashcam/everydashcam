import { Buffer } from "node:buffer";
import { gzipSync } from "node:zlib";
import type { OutputChunk } from "rolldown";
import { normalizePath, type Plugin, type ResolvedConfig } from "vite";

// Match source identities, not generated chunk names or minified signatures.
const LAZY_PACKAGES = /\/node_modules\/(maplibre-gl|chart\.js|mediabunny|onnxruntime-web|@sentry\/[^/]+)\//;
// These metadata helpers are shared with the eager ingest/cache UI.
const EAGER_PARSER_HELPERS = new Set([
    "cache-revisions.ts",
    "cache-revisions.generated.ts",
    "clone-groups.ts",
    "markers.ts",
    "types.ts",
]);

function lazyBoundary(id: string, root: string): string | null {
    const [path = "", query] = normalizePath(id).split("?");
    const params = new URLSearchParams(query);
    // Vite's asset/worker proxies contain a URL or constructor, not the library code.
    if (!params.has("inline") && (params.has("url") || params.has("worker") || params.has("sharedworker"))) return null;
    const packageName = path.match(LAZY_PACKAGES)?.[1];
    if (packageName) return packageName;
    const primitives = `${root}/src/parsers/primitives/`;
    if (path.startsWith(primitives) && !EAGER_PARSER_HELPERS.has(path.slice(primitives.length))) {
        return "parser primitives";
    }
    return null;
}

const kib = (bytes: number): string => `${(bytes / 1024).toFixed(1)} KiB`;

export function lazyBoundariesPlugin(): Plugin {
    let root: string;
    let logger: ResolvedConfig["logger"];
    return {
        name: "everydashcam-lazy-boundaries",
        apply: "build",
        enforce: "post",
        configResolved(config) {
            root = normalizePath(config.root);
            logger = config.logger;
        },
        generateBundle: {
            order: "post",
            handler(_options, bundle) {
                const fail: (message: string) => never = (message) => {
                    // closeBundle publishers can fail on missing output and mask the original error.
                    logger.error(`[lazy-boundaries] ${message}`);
                    return this.error(message);
                };
                const chunks = new Map<string, OutputChunk>();
                for (const item of Object.values(bundle)) {
                    if (item.type === "chunk") chunks.set(item.fileName, item);
                }
                const entries = [...chunks.values()].filter((chunk) => chunk.isEntry);
                if (!entries.length) fail("no JavaScript entry chunks found; cannot check lazy boundaries");

                const eager = new Map<string, string[]>();
                const visit = (fileName: string, parents: string[]): void => {
                    if (eager.has(fileName)) return;
                    const path = [...parents, fileName];
                    const chunk = chunks.get(fileName);
                    if (!chunk) fail(`unbundled eager import: ${path.join(" -> ")}`);
                    eager.set(fileName, path);
                    // Dynamic imports and separately built worker assets are deferred.
                    for (const imported of chunk.imports) visit(imported, path);
                };
                for (const entry of entries) visit(entry.fileName, []);

                const violations: string[] = [];
                let rawBytes = 0;
                let gzipBytes = 0;
                const sizes: string[] = [];
                for (const [fileName, path] of eager) {
                    const chunk = chunks.get(fileName)!;
                    const boundaries = new Map<string, string>();
                    for (const [id, module] of Object.entries(chunk.modules)) {
                        // Tree-shaken imports and extracted CSS carry no eager JS.
                        if (module.renderedLength === 0) continue;
                        const boundary = lazyBoundary(id, root);
                        if (boundary && !boundaries.has(boundary)) boundaries.set(boundary, id);
                    }
                    for (const [boundary, id] of boundaries) {
                        const source = normalizePath(id).replace(`${root}/`, "");
                        violations.push(`  ${boundary}: ${path.join(" -> ")}\n    contains ${source}`);
                    }
                    const bytes = Buffer.byteLength(chunk.code);
                    const compressed = gzipSync(chunk.code).length;
                    rawBytes += bytes;
                    gzipBytes += compressed;
                    sizes.push(`  ${kib(bytes)} raw / ${kib(compressed)} gzip  ${fileName}`);
                }
                if (violations.length) {
                    fail(
                        `lazy dependencies are included in the landing's eager JavaScript:\n${violations.join("\n")}\n` +
                            "check static imports and chunk grouping at these boundaries",
                    );
                }
                // Size is diagnostic; application growth must not masquerade as a lazy-loading regression.
                logger.info(
                    `[lazy-boundaries] OK - ${eager.size} eager chunks, ${kib(rawBytes)} raw / ${kib(gzipBytes)} gzip\n${sizes.join("\n")}`,
                );
            },
        },
    };
}
