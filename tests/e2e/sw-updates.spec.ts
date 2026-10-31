import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
// Real worker lifecycle across releases on one origin and one browser profile.
// The shell fixtures are deliberately tiny; caching/installation is public/sw.js.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";

const workerSource = readFileSync(resolve("public/sw.js"), "utf8");
const hash = (body: string) => createHash("sha256").update(body).digest("hex").slice(0, 16);
function release(id: string) {
    const code = `window.testGeneration=${JSON.stringify(id)};navigator.serviceWorker.register('/sw.js',{updateViaCache:'none'}).catch(()=>{});`;
    const htmlRevision = hash(id);
    const html = `<!doctype html><meta name="dc-precache-revision" content="${htmlRevision}"><title>${id}</title><script src="/assets/generation-${id}.js"></script>`;
    const manifest = [
        { url: "/en/", revision: hash(html), htmlRevision },
        { url: `/assets/generation-${id}.js`, revision: hash(code) },
    ];
    const sw = workerSource
        .replace(
            /const PRECACHE_MANIFEST = \[\];\s*\/\/ __DC_PRECACHE_MANIFEST__/,
            `const PRECACHE_MANIFEST = ${JSON.stringify(manifest)};`,
        )
        .replace(
            /const TRACKER_ASSET_URLS = \[\];\s*\/\/ __DC_TRACKER_ASSET_URLS__/,
            `const TRACKER_ASSET_URLS = ["/models/${id}.onnx"];`,
        );
    return { code, html, sw };
}

test.use({ serviceWorkers: "allow" });

test(
    "A to B to C and rollback preserve open clients, failed installs and offline launches",
    {
        tag: "@golden-offline",
    },
    async ({ playwright }, info) => {
        const profile = info.outputPath("browser-profile");
        const options = { channel: "chromium", headless: true, serviceWorkers: "allow" as const };
        let context = await playwright.chromium.launchPersistentContext(profile, options);
        let page = await context.newPage();
        test.setTimeout(120_000);
        const releases = { a: release("a"), b: release("b"), c: release("c") };
        let published: keyof typeof releases = "a";
        let incomplete = false;
        let offline = false;
        // Updated SW main scripts bypass Playwright routing. A real HTTP server
        // owns the published version, including update checks and installation.
        const server = createServer((request, response) => {
            if (offline) {
                response.destroy();
                return;
            }
            const path = new URL(request.url!, "http://localhost").pathname;
            const send = (body: string, type: string, status = 200) => {
                response.writeHead(status, { "content-type": type, "cache-control": "no-store" });
                response.end(body);
            };
            if (path === "/sw.js") return send(releases[published].sw, "text/javascript");
            if (path === "/en/") return send(releases[published].html, "text/html");
            const id = path.match(/^\/assets\/generation-([abc])\.js$/)?.[1] as keyof typeof releases | undefined;
            if (id && !(incomplete && id === published)) return send(releases[id].code, "text/javascript");
            if (/^\/models\/[abc]\.onnx$/.test(path)) return send(path, "application/octet-stream");
            send("missing", "text/plain", 404);
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        try {
            await page.goto(`${origin}/en/`);
            await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
            await page.evaluate(async () => {
                localStorage.setItem("keep-preference", "chosen");
                await fetch("/models/a.onnx");
            });
            published = "b";
            incomplete = true;
            // Observe the actual installing worker reaching failure, not a timer guess.
            await page.evaluate(async () => {
                const registration = (await navigator.serviceWorker.getRegistration())!;
                const failed = new Promise<void>((resolve) =>
                    registration.addEventListener(
                        "updatefound",
                        () => {
                            const installing = registration.installing!;
                            installing.addEventListener("statechange", () => {
                                if (installing.state === "redundant") resolve();
                            });
                        },
                        { once: true },
                    ),
                );
                await registration.update();
                await failed;
            });
            await page.reload();
            expect(await page.title()).toBe("a");
            incomplete = false;
            const update = async () => {
                await page.evaluate(async () => {
                    await (await navigator.serviceWorker.getRegistration())!.update();
                });
                await page.waitForFunction(async () => !!(await navigator.serviceWorker.getRegistration())?.waiting);
            };
            await update();
            const other = await context.newPage();
            await other.goto(`${origin}/en/`);
            expect(await other.title()).toBe("a");
            expect(await page.title()).toBe("a");
            await other.close();
            const restart = async (expected: string) => {
                // There must be no controlled client left. Reload alone overlaps clients
                // and must not be used to force activation while a recording is open.
                const nextPage = await context.newPage();
                await page.close();
                page = nextPage;
                await expect
                    .poll(async () => {
                        for (const worker of context.serviceWorkers()) {
                            const result = await worker
                                .evaluate<{ title: string; waiting: boolean }>(
                                    "({title: PRECACHE_MANIFEST[0].htmlRevision, waiting: !!self.registration.waiting})",
                                )
                                .catch(() => null);
                            if (result?.title === hash(expected) && !result.waiting) return true;
                        }
                        return false;
                    })
                    .toBe(true);
                await page.goto(`${origin}/en/`);
                expect(await page.title()).toBe(expected);
                expect(await page.evaluate(() => localStorage.getItem("keep-preference"))).toBe("chosen");
            };
            await restart("b");
            await page.evaluate(async () => {
                await fetch("/models/b.onnx");
            });
            published = "c";
            await update();
            await restart("c");
            // Reopen the actual on-disk profile with the server unavailable. This
            // checks persisted installation, not just a tab's live worker process.
            await context.close();
            offline = true;
            context = await playwright.chromium.launchPersistentContext(profile, options);
            page = await context.newPage();
            await page.goto(`${origin}/en/`);
            expect(await page.title()).toBe("c");
            expect(await page.evaluate(() => localStorage.getItem("keep-preference"))).toBe("chosen");
            offline = false;
            published = "b";
            await update();
            await restart("b");
            offline = true;
            await page.reload();
            expect(await page.title()).toBe("b");
            expect(await page.evaluate(async () => (await fetch("/models/b.onnx")).text())).toBe("/models/b.onnx");
        } finally {
            await context.close();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    },
);
