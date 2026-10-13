import { readFileSync } from "node:fs";
import path from "node:path";
import {
    REPO_ROOT,
    expect,
    gotoApp,
    loadTrip,
    openExport,
    pausePlayback,
    presetLocalStorage,
    test,
} from "./_fixtures.js";

const policy = readFileSync(path.join(REPO_ROOT, "dist/_headers"), "utf8").match(
    /^\s+Content-Security-Policy: (.+)$/m,
)?.[1];
if (!policy) throw new Error("built content security policy is missing");

test.beforeEach(async ({ context, baseURL }) => {
    // Vite preview does not interpret Cloudflare's _headers. Apply the final
    // header to assets as well as documents so worker policy is exercised too.
    const origin = new URL(baseURL!).origin;
    await context.route(
        (url) => url.origin === origin,
        async (route) => {
            const response = await route.fetch();
            await route.fulfill({ response, headers: { ...response.headers(), "content-security-policy": policy } });
        },
    );
});

test.afterEach(async ({ context }) => {
    // Lazy chunk requests may still be in flight after the final assertion.
    // Suppress only route callbacks interrupted by test teardown.
    await context.unrouteAll({ behavior: "ignoreErrors" });
});

test("boots, plays local recordings and opens export under the deployed CSP", async ({ page }) => {
    const violations: string[] = [];
    page.on("console", (message) => {
        if (message.text().startsWith("csp violation:")) violations.push(message.text());
    });
    await page.addInitScript(() => {
        document.addEventListener("securitypolicyviolation", (event) => {
            console.error(`csp violation: ${event.effectiveDirective} ${event.blockedURI}`);
        });
    });
    await presetLocalStorage(page);
    await gotoApp(page);
    await loadTrip(page);
    await pausePlayback(page);
    await expect(page.locator("#player-chart-canvas")).toBeVisible();
    await openExport(page);
    await page.locator("#export-panel-ov-map").check();
    await expect(page.locator("#player-map-overlay-canvas")).toBeVisible();
    expect(violations, "startup, playback, maps and export have no CSP violations").toEqual([]);
});

test("permits WASM and blob workers while blocking JavaScript evaluation", async ({ page }) => {
    await presetLocalStorage(page);
    await gotoApp(page);
    const capabilities = await page.evaluate(async () => {
        const module = await WebAssembly.compile(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
        const workerUrl = URL.createObjectURL(new Blob(["postMessage('ready')"], { type: "text/javascript" }));
        const worker = new Worker(workerUrl);
        try {
            const message = await new Promise<unknown>((resolve, reject) => {
                worker.onmessage = (event) => resolve(event.data);
                worker.onerror = () => reject(new Error("blob worker failed"));
            });
            let evaluationBlocked = false;
            try {
                new Function("return 1")();
            } catch (error) {
                evaluationBlocked = error instanceof EvalError;
            }
            return { wasm: module instanceof WebAssembly.Module, worker: message, evaluationBlocked };
        } finally {
            worker.terminate();
            URL.revokeObjectURL(workerUrl);
        }
    });
    expect(capabilities).toEqual({ wasm: true, worker: "ready", evaluationBlocked: true });
});

test("allows configured services and blocks unrelated map subdomains", async ({ context }) => {
    // Use a separate page because these deliberately blocked request events
    // belong to the CSP assertion, not the shared fixture's egress failures.
    const requests: string[] = [];
    await context.route(/^https:/, (route) => {
        requests.push(route.request().url());
        return route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*" } });
    });
    await context.route("**/csp-probe", (route) =>
        route.fulfill({
            contentType: "text/html",
            body: "<!doctype html><title>CSP network probe</title>",
            headers: { "content-security-policy": policy },
        }),
    );
    const page = await context.newPage();
    await page.goto("/csp-probe");
    const allowed = [
        "https://tiles.openfreemap.org/planet",
        "https://vector.openstreetmap.org/shortbread_v1/0/0/0.mvt",
        "https://tile.openstreetmap.org/0/0/0.png",
        "https://tiles.api-maps.yandex.ru/v1/tiles/",
        "https://cloudflareinsights.com/cdn-cgi/rum",
        "https://o4511528520843264.ingest.de.sentry.io/api/1/envelope/",
    ];
    const blocked = "https://unconfigured.openfreemap.org/tile";
    const result = await page.evaluate(
        async ({ allowed, blocked }) => {
            const violation = new Promise<string>((resolve) => {
                document.addEventListener("securitypolicyviolation", (event) => {
                    if (event.blockedURI === blocked) resolve(event.effectiveDirective);
                });
            });
            const statuses = await Promise.all(allowed.map(async (url) => (await fetch(url)).status));
            let requestBlocked = false;
            try {
                await fetch(blocked);
            } catch {
                requestBlocked = true;
            }
            return { statuses, requestBlocked, directive: await violation };
        },
        { allowed, blocked },
    );
    expect(result).toEqual({ statuses: allowed.map(() => 204), requestBlocked: true, directive: "connect-src" });
    expect(requests).toEqual(allowed);
});
