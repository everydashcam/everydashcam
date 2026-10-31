import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";

import { rolldown } from "rolldown";

import { canonicalProgram } from "./_cache-revision-ast.mjs";
import { parsePrimitiveId, parseRegistryBindings } from "./_parser-registry.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const REGISTRY_FILE = resolve(ROOT, "src/parsers/primitives/index.ts");
const DISPATCHER_FILE = resolve(ROOT, "src/parsers/registry.ts");
const GPS_EXTRACT_ARTIFACTS_FILE = resolve(ROOT, "src/ui/gps-extract-artifacts.ts");
const GPS_EXTRACT_REQUEST_FILE = resolve(ROOT, "src/workers/gps-extract-request.ts");
const CACHE_PROJECTION_FILE = resolve(ROOT, "src/ui/ingest-cache-artifacts.ts");
const CACHE_REVISIONS_FILE = resolve(ROOT, "src/parsers/primitives/cache-revisions.ts");
const METADATA_FILE = resolve(ROOT, "src/parsers/internal/mp4-indexing.ts");
const LOG_FILE = resolve(ROOT, "src/log.ts");
const GENERATED_FILE = resolve(ROOT, "src/parsers/primitives/cache-revisions.generated.ts");
const METADATA_GENERATED_FILE = resolve(ROOT, "src/persist/cache-revisions.generated.ts");
const REGISTRY_NAME = "VIDEO_EMBEDDED_PRIMITIVES";
const VIRTUAL_ENTRY = "virtual:everydashcam-cache-revision";

// Rolldown renders external specifiers relative to process.cwd(). Pin it so
// generated revisions are identical in npm hooks, IDE tasks, and CI wrappers
// that invoke this absolute script path from elsewhere.
process.chdir(ROOT);

function normalizedPath(path) {
    return relative(ROOT, path).split("\\").join("/");
}

function resolveSourceImport(fromPath, specifier) {
    if (!specifier.startsWith(".")) return null;
    const raw = resolve(fromPath, "..", specifier);
    const candidates = raw.endsWith(".js")
        ? [`${raw.slice(0, -3)}.ts`, `${raw.slice(0, -3)}.tsx`, raw]
        : [raw, `${raw}.ts`, `${raw}.tsx`, resolve(raw, "index.ts")];
    return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function registryEntries() {
    const bindings = parseRegistryBindings(
        normalizedPath(REGISTRY_FILE),
        readFileSync(REGISTRY_FILE, "utf8"),
        REGISTRY_NAME,
    );
    return bindings.map(({ specifier, exportName }) => {
        const path = resolveSourceImport(REGISTRY_FILE, specifier);
        if (!path) throw new Error(`cannot resolve ${exportName} import from ${specifier}`);
        const id = parsePrimitiveId(normalizedPath(path), readFileSync(path, "utf8"), exportName);
        return { exportName, path, id };
    });
}

async function semanticRevision(path, exportName, extraExternal = []) {
    // Diagnostics are observational: changing log buffering/download UI cannot
    // change parsed facts. Keep the import itself in the bundle so adding or
    // removing a log call can still perturb the producer's semantic bundle,
    // but do not drag the complete logging implementation into every revision.
    const external = new Set([LOG_FILE, ...extraExternal]);
    const bundle = await rolldown({
        cwd: ROOT,
        input: { revision: VIRTUAL_ENTRY },
        platform: "browser",
        external: (id) => external.has(id),
        plugins: [
            {
                name: "everydashcam-cache-revision-entry",
                resolveId(id) {
                    if (id === VIRTUAL_ENTRY) return id;
                },
                load(id) {
                    if (id === VIRTUAL_ENTRY) {
                        return `export { ${exportName} as default } from ${JSON.stringify(path)};`;
                    }
                },
            },
        ],
    });
    try {
        // No minify, and chunk names carry neither a content hash nor a module
        // name: minifier passes and hashes differ between bundler releases, and
        // a module name changes on a file rename, while the runtime code does
        // not. Every such difference would drop all users' caches.
        const output = await bundle.generate({
            format: "es",
            entryFileNames: "revision.js",
            chunkFileNames: "revision-chunk.js",
        });
        const hash = createHash("sha256");
        for (const item of [...output.output].sort((a, b) => a.fileName.localeCompare(b.fileName))) {
            hash.update(item.fileName);
            hash.update("\0");
            hash.update(item.type === "chunk" ? canonicalProgram(item.fileName, item.code) : item.source);
            hash.update("\0");
        }
        return hash.digest("hex").slice(0, 16);
    } finally {
        await bundle.close();
    }
}

async function embeddedGeneratedSource() {
    const entries = registryEntries();
    const ids = new Set();
    for (const entry of entries) {
        if (ids.has(entry.id)) throw new Error(`duplicate primitive id: ${entry.id}`);
        ids.add(entry.id);
    }
    const revisions = await Promise.all(
        entries.map(async (entry) => ({ ...entry, revision: await semanticRevision(entry.path, entry.exportName) })),
    );
    const commonRevisions = await Promise.all([
        semanticRevision(
            DISPATCHER_FILE,
            "dispatchParseVideoEmbeddedGps",
            // Primitive implementations/order are folded into prefix revisions
            // below. Bundling the registry here would turn any parser edit into
            // a global embedded-GPS invalidation.
            [REGISTRY_FILE],
        ),
        // Grouping, request wiring, and shard failure/merge behavior decide
        // which file supplied facts and whether a negative is retryable.
        semanticRevision(GPS_EXTRACT_ARTIFACTS_FILE, "shardByCloneAffinity"),
        semanticRevision(GPS_EXTRACT_ARTIFACTS_FILE, "buildGpsExtractShardRequest"),
        semanticRevision(GPS_EXTRACT_ARTIFACTS_FILE, "mergeSettledGpsExtractShards"),
        semanticRevision(GPS_EXTRACT_REQUEST_FILE, "dispatchGpsExtractRequest", [DISPATCHER_FILE]),
        // Hash the raw-record serializer/error/source projection too. Keep its
        // revision lookup external: parser implementations already contribute
        // at their precise prefix and must not become global through this edge.
        semanticRevision(CACHE_PROJECTION_FILE, "buildEmbeddedGpsCacheArtifactUpdates", [CACHE_REVISIONS_FILE]),
    ]);
    const dispatchRevision = createHash("sha256").update(commonRevisions.join("\0")).digest("hex").slice(0, 16);
    const rows = revisions.map(
        (entry) => `    { id: ${JSON.stringify(entry.id)}, revision: ${JSON.stringify(entry.revision)} },`,
    );
    return [
        "// Generated by scripts/parser-cache-revisions.mjs. Do not edit by hand.",
        "// Revisions hash the normalized AST of tree-shaken runtime bundles, including external package code.",
        "",
        `export const VIDEO_EMBEDDED_DISPATCH_CACHE_REVISION = ${JSON.stringify(dispatchRevision)};`,
        "",
        "export const VIDEO_EMBEDDED_PRIMITIVE_CACHE_REVISIONS = [",
        ...rows,
        "] as const;",
        "",
    ].join("\n");
}

async function metadataGeneratedSource() {
    const revision = await semanticRevision(METADATA_FILE, "indexOneFile");
    return [
        "// Generated by scripts/parser-cache-revisions.mjs. Do not edit by hand.",
        "// Hashes the normalized AST of the tree-shaken metadata producer, including external package code.",
        "",
        `export const RECORDING_METADATA_CACHE_REVISION = ${JSON.stringify(revision)};`,
        "",
    ].join("\n");
}

const generatedFiles = [
    [GENERATED_FILE, await embeddedGeneratedSource()],
    [METADATA_GENERATED_FILE, await metadataGeneratedSource()],
];
if (process.argv.includes("--check")) {
    const stale = generatedFiles.some(
        ([path, expected]) => !existsSync(path) || readFileSync(path, "utf8") !== expected,
    );
    if (stale) {
        console.error("cache revisions are stale; run npm run generate:parser-cache-revisions");
        process.exitCode = 1;
    }
} else {
    for (const [path, expected] of generatedFiles) writeFileSync(path, expected);
}
