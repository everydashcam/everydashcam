import { chmod, cp, readFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type Page, expect } from "@playwright/test";
import { BufferSource, EncodedPacketSink, Input, MP4 } from "mediabunny";

import { PORTABLE_UPDATE_URL } from "../../src/portable/manifest.mjs";
import { expectExportedPixelsCovered } from "../e2e/_export-pixels.js";
import {
    loadTrip,
    masterVideoTime,
    openExport,
    pausePlayback,
    presetLocalStorage,
    SAMPLE_70MAI,
} from "../e2e/_fixtures.js";

import { openPortable, test } from "./_fixtures.js";

test("plays and seeks offline, draws GPS and exports manual blur with a route overlay", async ({
    page,
    requests,
    context,
}, info) => {
    const workerNamesSeen = new Set<string>();
    page.on("worker", (worker) => {
        void worker.evaluate(() => self.name).then((name) => workerNamesSeen.add(name));
    });
    await presetLocalStorage(page);
    await page.addInitScript(() => {
        Object.defineProperty(window, "showSaveFilePicker", { configurable: true, value: undefined });
    });
    await context.setOffline(true);
    const htmlUrl = await openPortable(page, info.outputPath("offline"));
    const card = dirname(fileURLToPath(htmlUrl));
    await cp(SAMPLE_70MAI, card, { recursive: true });
    const sourceFiles = (await readdir(card, { recursive: true, withFileTypes: true }))
        .filter((entry) => entry.isFile())
        .map((entry) => resolve(entry.parentPath, entry.name));
    for (const source of sourceFiles) await chmod(source, 0o444);
    const htmlBefore = await readFile(fileURLToPath(htmlUrl));
    await loadTrip(page, card);
    await expect(page.locator("#player-chart-canvas")).toBeVisible();
    await expect
        .poll(() =>
            page.evaluate(() => {
                const { map, miniMap } = window.__everydashcam.state;
                return Boolean(
                    map?.getLayer("trip-line") && miniMap?.getLayer("trip-line") && miniMap.isSourceLoaded("trip-line"),
                );
            }),
        )
        .toBe(true);
    const workerNames = await Promise.all(page.workers().map((worker) => worker.evaluate(() => self.name)));
    expect(workerNames).toContain("ingest-worker");
    expect(workerNames).toContain("gps-extract-worker");
    expect(workerNames).toContain("indexer-worker");
    expect(page.workers().every((worker) => /^(blob:|data:)/.test(worker.url()))).toBe(true);
    await pausePlayback(page);
    await page.locator("#player-play").click();
    await expect.poll(() => masterVideoTime(page)).toBeGreaterThan(0.2);
    await pausePlayback(page);
    await page.locator("#player").evaluate((element) => {
        (element as HTMLVideoElement).currentTime = 1;
    });
    await expect
        .poll(() => page.locator("#player").evaluate((video) => (video as HTMLVideoElement).currentTime))
        .toBeCloseTo(1, 1);

    await openExport(page);
    await expect(page.locator("#export-panel-blur-auto")).toHaveCount(0);
    await page.locator("#export-panel-ov-map").check();
    await expect(page.locator("#export-map-provider-select")).toHaveValue("openfreemap");
    await expect(page.locator("#player-map-overlay-canvas")).toBeVisible();
    await expect
        .poll(() =>
            page.locator("#player-map-overlay-canvas").evaluate((element) => {
                const canvas = element as HTMLCanvasElement;
                const pixels = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data;
                return pixels.some((value, index) => index % 4 === 3 && value > 0);
            }),
        )
        .toBe(true);

    await page.locator(".export-panel__blur-add-btn").click();
    const drawLayer = page.locator('.video-tile[data-channel="front"] .blur-draw-layer');
    await expect(drawLayer).toBeVisible();
    const box = (await drawLayer.boundingBox())!;
    await page.mouse.move(box.x + box.width * 0.65, box.y + box.height * 0.55);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.9, box.y + box.height * 0.8, { steps: 6 });
    await page.mouse.up();
    await expect(page.locator('.video-tile[data-channel="front"] .blur-box:not([hidden])')).toBeVisible();
    await page.screenshot({ path: info.outputPath("manual-blur-route-overlay.png") });
    await saveAndInspectVideo(page, info.outputPath("blur-route.mp4"));
    await page.locator("#feedback-btn").click();
    await page.locator("#feedback-recordings-skip").click();
    const reportPromise = page.waitForEvent("download");
    await page.locator("#feedback-primary").click();
    const report = await readFile(await (await reportPromise).path(), "utf8");
    expect(report).toContain("== graphics ==\ncontext: webgl2");
    expect(report).toContain("video encoder config requested");
    expect(report).toMatch(/videoBitrateKbps=\d+/);
    expect(workerNamesSeen).toContain("transcode-worker");
    expect(workerNamesSeen).toContain("encoder-probe-worker");
    expect(report).toContain("encoder trial measured");
    expect(await readFile(fileURLToPath(htmlUrl)), "opening a card leaves its portable HTML unchanged").toEqual(
        htmlBefore,
    );
    expect(requests.some((url) => url.startsWith("https://tiles.openfreemap.org/"))).toBe(true);
});

test("falls back from a denied native picker and downloads MP4 and GPS without a service worker", async ({
    page,
    requests,
}, info) => {
    await presetLocalStorage(page);
    await page.addInitScript(() => {
        Object.defineProperty(window, "showSaveFilePicker", {
            configurable: true,
            value: () => Promise.reject(new DOMException("file origin is denied", "SecurityError")),
        });
    });
    await openPortable(page, info.outputPath("denied-picker"));
    await loadTrip(page, SAMPLE_70MAI);
    await openExport(page);
    const includes = page.locator(".top-panel__channel-include");
    await includes.nth(2).click();
    await includes.nth(1).click();
    await saveAndInspectVideo(page, info.outputPath("stream-copy.mp4"));
    await page.locator("#export-panel-done > button").click();
    await openExport(page);
    await page.locator('.export-panel__seg-btn[data-mode="gpx"]').click();
    const downloadPromise = page.waitForEvent("download");
    await page.locator("#export-panel-save-btn").click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/\.gpx$/);
    const target = info.outputPath("route.gpx");
    await download.saveAs(target);
    expect(await readFile(target, "utf8")).toContain("<trkpt");
    expect(requests.some((url) => url.startsWith("https://tiles.openfreemap.org/"))).toBe(true);
});

test("whole-clip fill covers the first and last exported frames at fractional trim bounds", async ({ page }, info) => {
    const start = 0.5005;
    const end = 1.5005;
    await presetLocalStorage(page);
    await page.addInitScript(() => {
        Object.defineProperty(window, "showSaveFilePicker", { configurable: true, value: undefined });
        window.addEventListener("dc:ready", () => window.__everydashcam.setMapProvider("route-only"), {
            once: true,
        });
    });
    await openPortable(page, info.outputPath("fractional-trim"));
    await loadTrip(page, SAMPLE_70MAI);
    await pausePlayback(page);
    await openExport(page);
    const includes = page.locator(".top-panel__channel-include");
    await includes.nth(2).click();
    await includes.nth(1).click();
    await expect(page.locator(".top-panel__channel-include:checked")).toHaveCount(1);

    for (const [edge, seconds] of [
        ["end", end],
        ["start", start],
    ] as const) {
        await page.locator("#player").evaluate(async (element, seconds) => {
            const video = element as HTMLVideoElement;
            const sought = new Promise<void>((resolve) =>
                video.addEventListener("seeked", () => resolve(), { once: true }),
            );
            video.currentTime = seconds;
            await sought;
        }, seconds);
        await page.locator(`.export-trim-bar__set[data-set-edge="${edge}"]`).click();
        await expect
            .poll(async () => Number(await page.locator(`.timeline-range__tab--${edge}`).getAttribute("aria-valuenow")))
            .toBeCloseTo(seconds, 5);
    }

    await page.locator(".export-panel__blur-add-btn").click();
    const drawLayer = page.locator('.video-tile[data-channel="front"] .blur-draw-layer');
    await expect(drawLayer).toBeVisible();
    const box = (await drawLayer.boundingBox())!;
    await page.mouse.move(box.x + box.width * 0.35, box.y + box.height * 0.35);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.65, box.y + box.height * 0.65, { steps: 6 });
    await page.mouse.up();
    await expect(page.locator('.video-tile[data-channel="front"] .blur-box:not([hidden])')).toBeVisible();
    await page.locator("#export-panel-blur-style").selectOption("fill");
    await page.getByRole("button", { name: "Keep this zone active for the whole clip" }).click();

    await page.locator("#export-panel-save-btn").click();
    await expect(page.locator("#export-panel-done-summary")).toBeVisible({ timeout: 75_000 });
    const downloadPromise = page.waitForEvent("download");
    await page.locator("#export-panel-done-summary button").click();
    const download = await downloadPromise;
    const target = info.outputPath("fractional-trim.mp4");
    await download.saveAs(target);
    const bytes = await readFile(target);
    const input = new Input({ source: new BufferSource(bytes), formats: [MP4] });
    const frames: { timestamp: number; duration: number }[] = [];
    try {
        const track = await input.getPrimaryVideoTrack();
        expect(track).not.toBeNull();
        for await (const packet of new EncodedPacketSink(track!).packets()) {
            frames.push({ timestamp: packet.timestamp, duration: packet.duration });
        }
    } finally {
        input.dispose();
    }
    frames.sort((a, b) => a.timestamp - b.timestamp);
    expect(frames.length).toBeGreaterThan(2);
    expect(frames[0]!.timestamp).toBeCloseTo(0, 5);
    // Sample inside the first and last presentation intervals, independent of
    // frame rate and encoder packet order. A middle-frame check misses this leak.
    const checkpoints = [frames[0]!, frames.at(-1)!].map((frame, index) => ({
        name: index === 0 ? "first frame" : "last frame",
        time: frame.timestamp + frame.duration / 2,
    }));
    await expectExportedPixelsCovered(
        page,
        { inside: { x: 0.475, y: 0.475, w: 0.05, h: 0.05 }, outside: [{ x: 0.4, y: 0.15, w: 0.2, h: 0.1 }] },
        checkpoints,
        Math.ceil(end * 30) / 30 - start,
        bytes.toString("base64"),
    );
});

test("opens the default internet map with embedded styles and sprites", async ({ page }, info) => {
    const network: string[] = [];
    const unexpected: string[] = [];
    await page.route(/^https?:/, async (route) => {
        const url = new URL(route.request().url());
        network.push(url.href);
        const headers = { "access-control-allow-origin": "*" };
        if (url.href === PORTABLE_UPDATE_URL) {
            await route.fulfill({ json: {}, headers });
        } else if (url.origin === "https://tiles.openfreemap.org" && url.pathname === "/planet") {
            await route.fulfill({
                json: { tilejson: "3.0.0", tiles: ["https://tiles.openfreemap.org/portable-test/{z}/{x}/{y}.pbf"] },
                headers,
            });
        } else if (url.origin === "https://tiles.openfreemap.org" && url.pathname.startsWith("/portable-test/")) {
            await route.fulfill({ body: Buffer.alloc(0), contentType: "application/x-protobuf", headers });
        } else {
            unexpected.push(url.href);
            await route.abort();
        }
    });
    await presetLocalStorage(page);
    await openPortable(page, info.outputPath("internet-map"));
    expect(network.filter((url) => url !== PORTABLE_UPDATE_URL)).toEqual([]);
    await expect(page.locator("#settings-map-provider-select")).toHaveValue("openfreemap");
    await loadTrip(page, SAMPLE_70MAI);
    await pausePlayback(page);
    await expect
        .poll(() =>
            page.evaluate(() => {
                const map = window.__everydashcam.state.miniMap;
                return Boolean(map?.getSource("openmaptiles") && map.isStyleLoaded() && map.listImages().length > 0);
            }),
        )
        .toBe(true);
    expect(network.some((url) => url.endsWith("/planet"))).toBe(true);
    await page.locator('.theme-toggle-btn[data-theme="light"]').click();
    await expect.poll(() => page.evaluate(() => window.__everydashcam.state.miniMap?.isStyleLoaded())).toBe(true);
    await openExport(page);
    await page.locator("#export-panel-ov-map").check();
    await expect(page.locator("#export-map-provider-select")).toHaveValue("openfreemap");
    await expect(page.locator("#player-map-overlay-canvas")).toBeVisible();
    expect(unexpected, "map styles and sprites never need sibling files or remote sprite resources").toEqual([]);
});

async function saveAndInspectVideo(page: Page, target: string): Promise<void> {
    await page.locator("#export-panel-save-btn").click();
    await expect(page.locator("#export-panel-done-summary")).toBeVisible({ timeout: 75_000 });
    const downloadPromise = page.waitForEvent("download");
    await page.locator("#export-panel-done-summary button").click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/\.mp4$/);
    await download.saveAs(target);
    const bytes = await readFile(target);
    expect(bytes.length).toBeGreaterThan(1024);
    expect(bytes.includes(Buffer.from("gpmd")), "export carries embedded GPS").toBe(true);
    const input = new Input({ source: new BufferSource(bytes), formats: [MP4] });
    try {
        const video = await input.getPrimaryVideoTrack();
        expect(video).not.toBeNull();
        expect(await video!.computeDuration()).toBeGreaterThan(1);
        expect(await input.getPrimaryAudioTrack()).not.toBeNull();
    } finally {
        input.dispose();
    }
}
