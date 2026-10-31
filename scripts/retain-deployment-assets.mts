// Copy the currently published release's data into the next deployment. Never
// copy its HTML, SW, headers or manifest; rollback uses the same operation.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
    collectDeploymentAssets,
    type DeploymentAsset,
    type DeploymentAssets,
} from "../vite-plugins/deployment-assets.ts";

const MAX_BYTES = 25 * 1024 * 1024;
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function validUrl(url: unknown): url is string {
    return (
        typeof url === "string" &&
        /^\/(?:assets|ort|models|styles)\/[a-zA-Z0-9_./@-]+$/.test(url) &&
        !url.includes("..") &&
        !url.includes("//")
    );
}

export function parseDeploymentAssets(value: unknown): DeploymentAssets {
    if (
        !value ||
        typeof value !== "object" ||
        !("schema" in value) ||
        value.schema !== 1 ||
        !("files" in value) ||
        !Array.isArray(value.files) ||
        value.files.length > 10000
    ) {
        throw new Error("invalid deployment asset manifest");
    }
    const seen = new Set<string>();
    const files: DeploymentAsset[] = [];
    for (const file of value.files) {
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
    return { schema: 1, files };
}

// First upgrade from releases predating deployment-assets.json. Extract literal
// data from the two known constants; never evaluate a downloaded worker script.
export function legacyAssetUrls(source: string): string[] {
    const urls = new Set<string>();
    for (const name of ["PRECACHE_MANIFEST", "TRACKER_ASSET_URLS"]) {
        const data = source.match(
            new RegExp(`(?:\\b(?:const|let|var)\\s+|,)\\s*${name}\\s*=\\s*(\\[[\\s\\S]*?\\])(?=[,;])`),
        )?.[1];
        if (!data) throw new Error(`legacy deployment has no ${name}`);
        for (const match of data.matchAll(/["'`]([^"'`]+)["'`]/g)) {
            if (validUrl(match[1])) urls.add(match[1]);
        }
    }
    if (!urls.size) throw new Error("legacy deployment asset list is empty");
    return [...urls];
}

function download(url: URL, limit: number): Promise<Uint8Array>;
function download(url: URL, limit: number, allowMissing: true): Promise<Uint8Array | undefined>;
async function download(url: URL, limit: number, allowMissing = false): Promise<Uint8Array | undefined> {
    const response = await fetch(url, { redirect: "error", cache: "no-store", signal: AbortSignal.timeout(60_000) });
    if (allowMissing && response.status === 404) {
        await response.body?.cancel();
        return;
    }
    if (response.status !== 200 || !response.body || /text\/html/i.test(response.headers.get("content-type") ?? "")) {
        throw new Error(`asset download failed: ${response.status} ${url.pathname}`);
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
        for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            size += value.length;
            if (size > limit) throw new Error(`asset exceeds limit: ${url.pathname}`);
            chunks.push(value);
        }
    } finally {
        await reader.cancel();
        reader.releaseLock();
    }
    return Buffer.concat(chunks, size);
}

export async function retainDeploymentAssets(root: string, origin: string): Promise<number> {
    const base = new URL(origin);
    if (base.pathname !== "/" || base.search || base.hash || !["https:", "http:"].includes(base.protocol))
        throw new Error("invalid deployment origin");
    const current = parseDeploymentAssets(JSON.parse(readFileSync(resolve(root, "deployment-assets.json"), "utf8")));
    const currentUrls = new Set(current.files.map((file) => file.url));
    for (const file of current.files) {
        const bytes = readFileSync(resolve(root, file.url.slice(1)));
        if (bytes.length !== file.bytes || digest(bytes) !== file.sha256)
            throw new Error(`current asset integrity mismatch: ${file.url}`);
    }
    // Recovery artifacts can already contain a previous release. Do not carry
    // that older generation forward again, including when redeploying a rollback.
    for (const file of collectDeploymentAssets(root).files) {
        if (!currentUrls.has(file.url)) rmSync(resolve(root, file.url.slice(1)));
    }
    const response = await fetch(new URL("/deployment-assets.json", base), {
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(30_000),
    });
    let previous: DeploymentAssets;
    if (response.status === 404 || (response.ok && /text\/html/i.test(response.headers.get("content-type") ?? ""))) {
        const sw = await download(new URL("/sw.js", base), 2 * 1024 * 1024, true);
        if (!sw) return 0; // First deployment: neither metadata nor a worker exists.
        const files: DeploymentAsset[] = [];
        for (const url of legacyAssetUrls(new TextDecoder().decode(sw))) {
            const bytes = await download(new URL(url, base), MAX_BYTES);
            files.push({ url, bytes: bytes.length, sha256: digest(bytes) });
        }
        previous = { schema: 1, files };
    } else {
        if (!response.ok) throw new Error(`deployment manifest request failed: ${response.status}`);
        previous = parseDeploymentAssets(await response.json());
        const sw = await download(new URL("/sw.js", base), 2 * 1024 * 1024);
        const publishedUrls = legacyAssetUrls(new TextDecoder().decode(sw));
        const declaredUrls = new Set(previous.files.map((file) => file.url));
        if (publishedUrls.some((url) => !declaredUrls.has(url))) {
            throw new Error("published worker and asset manifest disagree; retry after deployment propagation");
        }
    }
    let copied = 0;
    for (const file of previous.files) {
        const path = resolve(root, file.url.slice(1));
        if (existsSync(path)) {
            const bytes = readFileSync(path);
            if (bytes.length !== file.bytes || digest(bytes) !== file.sha256)
                throw new Error(`immutable asset collision: ${file.url}`);
            continue;
        }
        if (currentUrls.has(file.url)) throw new Error(`current deployment asset missing: ${file.url}`);
        const bytes = await download(new URL(file.url, base), MAX_BYTES);
        if (bytes.length !== file.bytes || digest(bytes) !== file.sha256)
            throw new Error(`previous asset integrity mismatch: ${file.url}`);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, bytes);
        copied++;
    }
    return copied;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    const [root, origin] = process.argv.slice(2);
    if (!root || !origin) throw new Error("usage: retain-deployment-assets.mts <dist> <published-origin>");
    console.log(`retained ${await retainDeploymentAssets(resolve(root), origin)} previous deployment assets`);
}
