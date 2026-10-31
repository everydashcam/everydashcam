import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test } from "@playwright/test";
import { buildServiceWorker } from "../helpers/service-worker-build.js";

test.use({ serviceWorkers: "allow" });

for (const failure of ["none", "copy", "metadata"] as const) {
    test(`preserves legacy tracker downloads through ${failure === "none" ? "migration" : `${failure} failure and retry`}`, async ({
        page,
        context,
    }) => {
        const worker = await buildServiceWorker([]);
        // Fault the browser storage boundary; run the actual production migration.
        const fault =
            failure === "copy"
                ? `const originalPut = Cache.prototype.put;
                   Cache.prototype.put = function(request, response) {
                       if (String(request).endsWith('/models/second.onnx')) {
                           throw new DOMException('storage full', 'QuotaExceededError');
                       }
                       return originalPut.call(this, request, response);
                   };`
                : failure === "metadata"
                  ? `const originalOpen = IDBFactory.prototype.open;
                     IDBFactory.prototype.open = function(name, version) {
                         if (name === 'workbox-expiration') throw new DOMException('storage unavailable', 'UnknownError');
                         return originalOpen.call(this, name, version);
                     };`
                  : "";
        let published = fault + worker;
        const server = createServer((request, response) => {
            const path = new URL(request.url!, "http://localhost").pathname;
            response.setHeader("cache-control", "no-store");
            if (path === "/sw.js") {
                response.setHeader("content-type", "text/javascript");
                response.end(published);
                return;
            }
            if (path === "/setup" || path === "/app/check") {
                response.setHeader("content-type", "text/html");
                response.end("<!doctype html><title>migration setup</title>");
                return;
            }
            response.writeHead(404);
            response.end("missing");
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        try {
            await page.goto(`${origin}/setup`);
            await page.evaluate(async () => {
                const legacy = await caches.open("everydashcam-tracker-v3");
                await legacy.put("/ort/first.wasm?__dc_repair=old", new Response("runtime bytes"));
                await legacy.put("/models/second.onnx", new Response("model bytes"));
                await legacy.put("/models/existing.onnx", new Response("older cached copy"));
                await legacy.put(
                    "/models/missing.onnx",
                    new Response("<!doctype html>fallback", { headers: { "content-type": "text/html" } }),
                );
                await (await caches.open("everydashcam-tracker")).put(
                    "/models/existing.onnx",
                    new Response("existing verified copy"),
                );
                await (await caches.open("unrelated-cache")).put("/keep", new Response("keep"));
                await navigator.serviceWorker.register("/sw.js", { scope: "/app/", updateViaCache: "none" });
            });
            await page.waitForFunction(async () => {
                const registration = await navigator.serviceWorker.getRegistration("/app/");
                return registration?.active?.state === "activated";
            });
            if (failure !== "none") {
                expect(await page.evaluate(async () => caches.has("everydashcam-tracker-v3"))).toBe(true);
                expect(
                    await page.evaluate(async () =>
                        (await (await caches.open("everydashcam-tracker-v3")).keys()).map((entry) => entry.url),
                    ),
                ).toHaveLength(4);
                published = worker;
                // The setup page is outside this registration's scope, so retry
                // activation does not require closing a controlled recording tab.
                await page.evaluate(async () => {
                    await (await navigator.serviceWorker.getRegistration("/app/"))!.update();
                });
            }
            await expect.poll(() => page.evaluate(async () => caches.has("everydashcam-tracker-v3"))).toBe(false);
            expect(
                await page.evaluate(async () => {
                    const cache = await caches.open("everydashcam-tracker");
                    return Promise.all(
                        (await cache.keys()).map(async (request) => [
                            new URL(request.url).pathname,
                            await (await cache.match(request))!.text(),
                        ]),
                    );
                }),
            ).toEqual([
                ["/models/existing.onnx", "existing verified copy"],
                ["/ort/first.wasm", "runtime bytes"],
                ["/models/second.onnx", "model bytes"],
            ]);
            expect(await page.evaluate(async () => caches.has("unrelated-cache"))).toBe(true);
            const timestamped = await page.evaluate(async () => {
                const database = await new Promise<IDBDatabase>((resolve, reject) => {
                    const request = indexedDB.open("workbox-expiration");
                    request.onsuccess = () => resolve(request.result);
                    request.onerror = () => reject(request.error);
                });
                try {
                    return await new Promise<string[]>((resolve, reject) => {
                        const request = database.transaction("cache-entries").objectStore("cache-entries").getAll();
                        request.onsuccess = () =>
                            resolve(
                                request.result
                                    .filter(
                                        (entry) => entry.cacheName === "everydashcam-tracker" && entry.timestamp > 0,
                                    )
                                    .map((entry) => new URL(entry.url).pathname)
                                    .sort(),
                            );
                        request.onerror = () => reject(request.error);
                    });
                } finally {
                    database.close();
                }
            });
            expect(timestamped).toEqual(["/models/existing.onnx", "/models/second.onnx", "/ort/first.wasm"]);
            await page.goto(`${origin}/app/check`);
            await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
            await context.setOffline(true);
            expect(await page.evaluate(async () => (await fetch("/ort/first.wasm")).text())).toBe("runtime bytes");
            expect(await page.evaluate(async () => (await fetch("/models/second.onnx")).text())).toBe("model bytes");
        } finally {
            await context.setOffline(false);
            await new Promise<void>((resolve) => {
                server.close(() => resolve());
                server.closeAllConnections();
            });
        }
    });
}
