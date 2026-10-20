import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { readPortableArtifacts } from "../../scripts/_portable-artifacts.mjs";
import { portableDownloadsPlugin } from "../../vite-plugins/portable-downloads.js";

const artifacts = resolve("dist-portable");
const manifest = readPortableArtifacts(join(artifacts, "manifest.json"), true);
const shell = '<!doctype html><a id="portable-download" hidden download>Download</a><p>Viewer</p>';
let root: string;
let server: ViteDevServer | undefined;
let previousManifest: string | undefined;

async function start(allowCustom = false): Promise<string> {
    server = await createServer({
        configFile: false,
        envFile: false,
        root,
        publicDir: false,
        logLevel: "silent",
        plugins: [portableDownloadsPlugin({ allowCustom })],
        server: { host: "127.0.0.1", port: 0 },
        optimizeDeps: { noDiscovery: true, include: [] },
    });
    await server.listen();
    const address = server.httpServer?.address();
    if (!address || typeof address === "string") throw new Error("development server has no local address");
    return `http://127.0.0.1:${address.port}`;
}

function localArtifacts(locale: string, distribution = "public"): string {
    const directory = join(root, "dist-portable");
    mkdirSync(directory);
    const file = manifest.files[locale];
    if (!file) throw new Error(`missing portable test locale: ${locale}`);
    copyFileSync(join(artifacts, file.filename), join(directory, file.filename));
    const path = join(directory, "manifest.json");
    writeFileSync(path, JSON.stringify({ ...manifest, distribution, files: { [locale]: file } }));
    return path;
}

test.beforeEach(() => {
    previousManifest = process.env.PORTABLE_MANIFEST;
    delete process.env.PORTABLE_MANIFEST;
    root = mkdtempSync(join(tmpdir(), "portable-dev-download-"));
    writeFileSync(join(root, "index.html"), shell);
});

test.afterEach(async () => {
    await server?.close();
    server = undefined;
    if (previousManifest === undefined) delete process.env.PORTABLE_MANIFEST;
    else process.env.PORTABLE_MANIFEST = previousManifest;
    rmSync(root, { recursive: true, force: true });
});

test("downloads the matching built public file through Vite with its exact filename and bytes", async ({
    page,
    request,
}) => {
    symlinkSync(artifacts, join(root, "dist-portable"), "dir");
    const origin = await start();
    const file = manifest.files.ru!;
    await page.goto(`${origin}/ru/?test=download`);
    const anchor = page.locator("#portable-download");
    await expect(anchor).toBeVisible();
    await expect(anchor).toHaveAttribute("href", "/downloads/portable/ru.html");
    await expect(anchor).toHaveAttribute("title", new RegExp(manifest.version));
    const pendingDownload = page.waitForEvent("download");
    await anchor.click();
    const download = await pendingDownload;
    expect(download.suggestedFilename()).toBe(file.filename);
    const saved = await download.path();
    expect(saved).not.toBeNull();
    const bytes = readFileSync(saved!);
    expect(bytes.length).toBe(file.bytes);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(file.sha256);

    const metadata = await request.get(`${origin}/downloads/portable/latest.json`);
    expect(metadata.headers()["access-control-allow-origin"]).toBe("*");
    expect(metadata.headers()["content-disposition"]).toBeUndefined();
    expect(await metadata.json()).toEqual(manifest);
    const redirect = await request.get(`${origin}/downloads/portable/ru.html`, { maxRedirects: 0 });
    expect(redirect.status()).toBe(302);
    expect(redirect.headers().location).toBe(file.path);
    expect(redirect.headers()["cache-control"]).toBe("no-store, no-transform");
    const head = await request.head(`${origin}${file.path}`);
    expect(head.headers()["content-type"]).toBe("application/octet-stream");
    expect(head.headers()["content-disposition"]).toBe(`attachment; filename="${file.filename}"`);
    expect(head.headers()["content-length"]).toBe(String(file.bytes));
    expect(head.headers()["cache-control"]).toBe("no-store, no-transform");
    expect((await head.body()).length).toBe(0);
    expect((await request.get(`${origin}/downloads/portable/missing`)).status()).toBe(404);
    expect((await request.post(`${origin}${file.path}`)).status()).toBe(405);
    expect((await request.post(`${origin}/downloads/portable/ru.html`)).status()).toBe(405);
    await page.goto(`${origin}/xx/`);
    await expect(page.locator("#portable-download")).toHaveCount(0);
});

test("prefers an explicit manifest and rejects changed bytes while the server runs", async ({ page, request }) => {
    const explicit = localArtifacts("ru");
    const explicitDirectory = join(root, "explicit");
    mkdirSync(explicitDirectory);
    const file = manifest.files.ru!;
    copyFileSync(explicit, join(explicitDirectory, "manifest.json"));
    copyFileSync(join(root, "dist-portable", file.filename), join(explicitDirectory, file.filename));
    rmSync(join(root, "dist-portable"), { recursive: true });
    symlinkSync(artifacts, join(root, "dist-portable"), "dir");
    process.env.PORTABLE_MANIFEST = join(explicitDirectory, "manifest.json");
    const origin = await start();
    await page.goto(`${origin}/en/`);
    await expect(page.locator("#portable-download")).toHaveCount(0);
    await page.goto(`${origin}/ru/`);
    await expect(page.locator("#portable-download")).toBeVisible();
    writeFileSync(join(explicitDirectory, file.filename), "changed after startup");
    const response = await request.get(`${origin}${file.path}`);
    expect(response.status()).toBe(503);
    expect(response.headers()["content-disposition"]).toBeUndefined();
    expect(await response.text()).not.toContain(root);
});

test("keeps the link absent when portable files have not been built", async ({ page, request }) => {
    const origin = await start();
    await page.goto(`${origin}/ru/`);
    await expect(page.locator("#portable-download")).toHaveCount(0);
    expect((await request.get(`${origin}/downloads/portable/latest.json`)).status()).toBe(404);
});

test("rejects custom artifacts in local development even when custom publication is enabled", async () => {
    localArtifacts("ru", "custom");
    await expect(start(true)).rejects.toThrow("invalid public portable artifacts for local development");
});
