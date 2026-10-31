// Copy the currently published release's data into the next deployment. Never
// copy its HTML, SW, headers or manifest; rollback uses the same operation.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { DeploymentAsset, DeploymentAssets } from "../vite-plugins/deployment-assets.ts";

const MAX_BYTES = 25 * 1024 * 1024;
const MAX_METADATA_BYTES = 2 * 1024 * 1024;
const MAX_ATTEMPTS = 3;
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function validUrl(url: unknown): url is string {
    return (
        typeof url === "string" &&
        /^\/(?:assets|ort|models|styles)\/[a-zA-Z0-9_./@-]+$/.test(url) &&
        !url.includes("..") &&
        !url.includes("//")
    );
}

function parseFiles(value: unknown): DeploymentAsset[] {
    if (!Array.isArray(value) || value.length > 10000) throw new Error("invalid deployment asset manifest");
    const seen = new Set<string>();
    const files: DeploymentAsset[] = [];
    for (const file of value) {
        if (
            !file ||
            !validUrl(file.url) ||
            seen.has(file.url) ||
            !Number.isSafeInteger(file.bytes) ||
            file.bytes <= 0 ||
            file.bytes > MAX_BYTES ||
            typeof file.sha256 !== "string" ||
            !/^[a-f0-9]{64}$/.test(file.sha256)
        ) {
            throw new Error("invalid deployment asset entry");
        }
        seen.add(file.url);
        files.push({ url: file.url, bytes: file.bytes, sha256: file.sha256 });
    }
    return files;
}

export function parseDeploymentAssets(value: unknown): DeploymentAssets {
    if (!value || typeof value !== "object" || !("schema" in value) || value.schema !== 1 || !("files" in value)) {
        throw new Error("invalid deployment asset manifest");
    }
    const result: DeploymentAssets = { schema: 1, files: parseFiles(value.files) };
    if ("publicAssetUrls" in value) {
        if (
            !Array.isArray(value.publicAssetUrls) ||
            value.publicAssetUrls.length > 10000 ||
            !value.publicAssetUrls.every((url) => validUrl(url) && url.startsWith("/assets/"))
        ) {
            throw new Error("invalid public asset inventory");
        }
        result.publicAssetUrls = [...new Set<string>(value.publicAssetUrls)];
        if (result.files.some((file) => result.publicAssetUrls?.includes(file.url))) {
            throw new Error("public asset declared immutable");
        }
    }
    if ("retainedFiles" in value) {
        result.retainedFiles = parseFiles(value.retainedFiles);
        const currentUrls = new Set(result.files.map((file) => file.url));
        if (result.retainedFiles.some((file) => currentUrls.has(file.url))) {
            throw new Error("retained asset overlaps current release");
        }
        if (result.retainedFiles.some((file) => result.publicAssetUrls?.includes(file.url))) {
            throw new Error("public asset declared immutable");
        }
    }
    if ("publication" in value) {
        if (value.publication !== "publishing" && value.publication !== "complete") {
            throw new Error("invalid deployment publication state");
        }
        result.publication = value.publication;
        if (result.publication === "publishing" && !result.retainedFiles) {
            throw new Error("publishing deployment has no retained asset inventory");
        }
    }
    return result;
}

class TransientDownloadError extends Error {}
function download(url: URL, limit: number): Promise<Uint8Array>;
function download(url: URL, limit: number, allowMissing: true): Promise<Uint8Array | undefined>;
async function download(url: URL, limit: number, allowMissing = false): Promise<Uint8Array | undefined> {
    for (let attempt = 0; ; attempt++) {
        try {
            return await downloadAttempt(url, limit, allowMissing);
        } catch (error) {
            if (!(error instanceof TransientDownloadError) || attempt + 1 === MAX_ATTEMPTS) throw error;
            await new Promise((done) => setTimeout(done, 250 * 2 ** attempt));
        }
    }
}

async function downloadAttempt(url: URL, limit: number, allowMissing: boolean): Promise<Uint8Array | undefined> {
    let response: Response;
    try {
        response = await fetch(url, { redirect: "error", cache: "no-store", signal: AbortSignal.timeout(60_000) });
    } catch (cause) {
        throw new TransientDownloadError(`asset request failed: ${url.pathname}`, { cause });
    }
    if ([408, 425, 429, 500, 502, 503, 504].includes(response.status)) {
        await response.body?.cancel();
        throw new TransientDownloadError(`asset download failed: ${response.status} ${url.pathname}`);
    }
    const isHtml = /text\/html/i.test(response.headers.get("content-type") ?? "");
    if (allowMissing && (response.status === 404 || (response.ok && isHtml))) {
        await response.body?.cancel();
        return;
    }
    if (response.status !== 200 || !response.body || isHtml) {
        await response.body?.cancel();
        throw new Error(`asset download failed: ${response.status} ${url.pathname}`);
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
        for (;;) {
            let chunk: ReadableStreamReadResult<Uint8Array>;
            try {
                chunk = await reader.read();
            } catch (cause) {
                throw new TransientDownloadError(`asset transfer failed: ${url.pathname}`, { cause });
            }
            if (chunk.done) break;
            size += chunk.value.length;
            if (size > limit) throw new Error(`asset exceeds limit: ${url.pathname}`);
            chunks.push(chunk.value);
        }
    } finally {
        // A failed body can reject cancellation too; preserve the transfer error.
        await reader.cancel().catch(() => {});
        reader.releaseLock();
    }
    return Buffer.concat(chunks, size);
}

export interface RetentionResult {
    copied: number;
    hasPreviousManifest: boolean;
}

export async function retainDeploymentAssets(root: string, origin: string): Promise<RetentionResult> {
    const base = new URL(origin);
    if (base.pathname !== "/" || base.search || base.hash || !["https:", "http:"].includes(base.protocol)) {
        throw new Error("invalid deployment origin");
    }
    const manifestPath = resolve(root, "deployment-assets.json");
    const current = parseDeploymentAssets(JSON.parse(readFileSync(manifestPath, "utf8")));
    if (!current.publicAssetUrls) throw new Error("rebuild recovery artifact with current deployment metadata");
    const publicUrls = new Set(current.publicAssetUrls);
    const currentFiles = new Map(current.files.map((file) => [file.url, file]));
    for (const file of current.files) {
        const bytes = readFileSync(resolve(root, file.url.slice(1)));
        if (bytes.length !== file.bytes || digest(bytes) !== file.sha256) {
            throw new Error(`current asset integrity mismatch: ${file.url}`);
        }
    }
    const previousBytes = new Map<string, Uint8Array>();
    const metadata = await download(new URL("/deployment-assets.json", base), MAX_METADATA_BYTES, true);
    const previous: DeploymentAssets = metadata
        ? parseDeploymentAssets(JSON.parse(new TextDecoder().decode(metadata)))
        : { schema: 1, files: [] };
    const sameGeneration =
        current.files.length === previous.files.length &&
        previous.files.every((file) => {
            const currentFile = currentFiles.get(file.url);
            return currentFile?.sha256 === file.sha256 && currentFile.bytes === file.bytes;
        });
    // Object storage publishes a pending inventory before replacing pages and
    // the worker. An interrupted upload may have served either generation, so
    // protect both until a later publication completes. Retrying the same code
    // generation must not retire its predecessor. Atomic hosts omit state.
    const previousFiles =
        previous.publication === "publishing" || sameGeneration
            ? [...previous.files, ...(previous.retainedFiles ?? [])]
            : previous.files;
    // Stable public files may change even when the source manifest lists them.
    // The explicit inventory separates these URLs from immutable collisions.
    const protectedFiles = previousFiles.filter((file) => !publicUrls.has(file.url));
    const retainedFiles: DeploymentAsset[] = [];
    // Fetch and verify the complete generation before modifying a recovery artifact.
    for (const file of protectedFiles) {
        const path = resolve(root, file.url.slice(1));
        if (existsSync(path)) {
            const bytes = readFileSync(path);
            if (bytes.length !== file.bytes || digest(bytes) !== file.sha256) {
                throw new Error(`immutable asset collision: ${file.url}`);
            }
        } else {
            const bytes = await download(new URL(file.url, base), MAX_BYTES);
            if (bytes.length !== file.bytes || digest(bytes) !== file.sha256) {
                throw new Error(`previous asset integrity mismatch: ${file.url}`);
            }
            previousBytes.set(file.url, bytes);
        }
        if (!currentFiles.has(file.url)) retainedFiles.push(file);
    }
    const carriedUrls = current.retainedFiles?.map((file) => file.url) ?? [];
    const retainedUrls = new Set(retainedFiles.map((file) => file.url));
    for (const url of carriedUrls) {
        if (!currentFiles.has(url) && !publicUrls.has(url) && !retainedUrls.has(url)) {
            rmSync(resolve(root, url.slice(1)), { force: true });
        }
    }
    let copied = 0;
    for (const file of retainedFiles) {
        const path = resolve(root, file.url.slice(1));
        if (existsSync(path)) continue;
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, previousBytes.get(file.url)!);
        copied++;
    }
    current.publicAssetUrls = [...publicUrls].sort();
    current.retainedFiles = retainedFiles;
    current.publication = "complete";
    writeFileSync(manifestPath, JSON.stringify(current));
    return { copied, hasPreviousManifest: metadata !== undefined };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    const [root, origin] = process.argv.slice(2);
    if (!root || !origin) throw new Error("usage: retain-deployment-assets.mts <dist> <published-origin>");
    const result = await retainDeploymentAssets(resolve(root), origin);
    if (!result.hasPreviousManifest) {
        console.warn("published deployment has no asset manifest; previous assets are not retained");
    }
    console.log(`retained ${result.copied} previous deployment assets`);
}
