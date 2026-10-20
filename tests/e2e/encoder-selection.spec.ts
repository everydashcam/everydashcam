import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import type { EncoderProbeConfig, EncoderProbeResult } from "../../src/transcode/encoder-probe-result.js";
import {
    DESKTOP,
    expect,
    gotoApp,
    installExportCapture,
    loadTrip,
    openExport,
    presetLocalStorage,
    readExportResult,
    readTranscodeDoneFields,
    REPO_ROOT,
    SAMPLE_70MAI,
    test,
} from "./_fixtures.js";

test.use({ viewerMap: "route-only" });

const PROBE_WORKER = /\/encoder-probe-worker-[^/]+\.js$/;

async function prepareExport(page: Page, sampleDir = SAMPLE_70MAI): Promise<void> {
    await presetLocalStorage(page);
    await installExportCapture(page);
    await page.setViewportSize(DESKTOP);
    await gotoApp(page, "en");
    await loadTrip(page, sampleDir);
    await openExport(page);
}

async function saveExport(page: Page): Promise<void> {
    await page.locator("#export-panel-save-btn").click();
    await expect(page.locator("#export-panel-done-summary")).toBeVisible({ timeout: 90_000 });
    expect((await readExportResult(page))?.mdat).toBe(true);
}

interface EncoderRestriction {
    higherTarget?: "responsive" | "unsupported";
    softwareBitrate?: number;
}

async function restrictDefaultEncoder(page: Page, restriction: EncoderRestriction = {}): Promise<void> {
    await page.route(PROBE_WORKER, async (route) => {
        const response = await route.fetch();
        // Software keeps this faulty-backend simulation independent of the machine's graphics hardware.
        const inject = (restriction: EncoderRestriction) => {
            const configure = VideoEncoder.prototype.configure;
            let firstBitrate: number | undefined;
            VideoEncoder.prototype.configure = function (config: VideoEncoderConfig) {
                if (config.hardwareAcceleration === "no-preference") {
                    firstBitrate ??= config.bitrate;
                    const isHigherTarget = config.bitrate! > firstBitrate!;
                    if (isHigherTarget && restriction.higherTarget === "unsupported")
                        throw new DOMException("higher bitrate unavailable", "NotSupportedError");
                    configure.call(this, {
                        ...config,
                        hardwareAcceleration: "prefer-software",
                        bitrate: isHigherTarget && restriction.higherTarget === "responsive" ? config.bitrate : 100_000,
                    });
                } else {
                    configure.call(
                        this,
                        restriction.softwareBitrate ? { ...config, bitrate: restriction.softwareBitrate } : config,
                    );
                }
            };
        };
        await route.fulfill({
            response,
            body: `(${inject.toString()})(${JSON.stringify(restriction)});\n${await response.text()}`,
        });
    });
}

async function runProbe(page: Page, config: EncoderProbeConfig): Promise<EncoderProbeResult> {
    const file = readdirSync("dist/assets").find((name) => /^encoder-probe-worker-.*\.js$/.test(name));
    expect(file).toBeDefined();
    return page.evaluate(
        ({ file, config }) =>
            new Promise<EncoderProbeResult>((resolve, reject) => {
                const worker = new Worker(`/assets/${file}`, { type: "module" });
                const timeout = setTimeout(() => {
                    worker.terminate();
                    reject(new Error("probe did not finish"));
                }, 30_000);
                worker.onmessage = (event) => {
                    if (event.data.__k !== "res") return;
                    clearTimeout(timeout);
                    worker.terminate();
                    if (event.data.ok) resolve(event.data.result);
                    else reject(new Error(event.data.error.message));
                };
                worker.onerror = (event) => {
                    clearTimeout(timeout);
                    worker.terminate();
                    reject(new Error(event.message));
                };
                worker.postMessage({ __k: "req", id: 1, type: "probe", data: config });
            }),
        { file, config },
    );
}

for (const lang of ["en", "ru"] as const) {
    test(`encoder settings persist with an explanation in ${lang}`, async ({ page }, info) => {
        await presetLocalStorage(page);
        await page.setViewportSize(DESKTOP);
        await gotoApp(page, lang);
        await page.locator("#settings-btn").click();
        const select = page.locator("#settings-encoder-select");
        await expect(select).toHaveValue("auto");
        await expect(select.locator('option[value="auto"]')).toHaveText(lang === "en" ? "Automatic" : "Автоматически");
        await expect(page.locator("#settings-encoder-hint")).toHaveAttribute(
            "data-i18n",
            "settings.export.encoder.autoHint",
        );
        await select.selectOption("software");
        await expect(page.locator("#settings-encoder-hint")).toHaveAttribute(
            "data-i18n",
            "settings.export.encoder.softwareHint",
        );
        await page.screenshot({ path: info.outputPath(`settings-${lang}.png`), animations: "disabled" });
        await page.reload();
        await page.locator("#settings-btn").click();
        await expect(select).toHaveValue("software");
        await select.selectOption("hardware");
        await expect(page.locator("#settings-encoder-hint")).toHaveAttribute(
            "data-i18n",
            "settings.export.encoder.hardwareHint",
        );
    });
}

test("a real short probe retains detail-rich output despite bitrate undershoot", async ({ page }, info) => {
    await presetLocalStorage(page);
    await gotoApp(page, "en");
    const result = await runProbe(page, { width: 640, height: 480, frameRate: 25, bitrate: 100_000_000 });
    await info.attach("measurement", { body: JSON.stringify(result), contentType: "application/json" });
    expect(result.standard?.frames).toBe(50);
    expect(result.standard?.bitrate).toBeLessThan(100_000_000 * 0.35);
    expect(result.standard?.psnr).toBeGreaterThanOrEqual(30);
    expect(result.hardwareAcceleration).toBe("no-preference");
    expect(result.software).toBeNull();
    expect(result.response).toBeNull();
});

test("a real short probe confirms detail loss before choosing software", async ({ page }, info) => {
    await restrictDefaultEncoder(page);
    await presetLocalStorage(page);
    await gotoApp(page, "en");
    const result = await runProbe(page, { width: 3840, height: 2160, frameRate: 25, bitrate: 32_000_000 });
    await info.attach("measurement", { body: JSON.stringify(result), contentType: "application/json" });
    expect(result.standard?.frames).toBe(50);
    expect(result.standard?.psnr).toBeLessThan(30);
    expect(result.software?.frames).toBe(50);
    expect(result.reason).toBe("confirmed");
    expect(result.hardwareAcceleration).toBe("prefer-software");
    expect(result.response).toBeNull();
});

test("a medium-quality probe detects a default encoder that ignores bitrate increases", async ({ page }, info) => {
    await restrictDefaultEncoder(page, { softwareBitrate: 12_700_000 });
    await presetLocalStorage(page);
    await gotoApp(page, "en");
    // Keep the target above the Linux encoder's bitrate floor while the simulated
    // software quality has margin below the 2 dB direct-selection threshold.
    const bitrate = 29_000_000;
    const result = await runProbe(page, { width: 3840, height: 2160, frameRate: 25, bitrate });
    await info.attach("measurement", { body: JSON.stringify(result), contentType: "application/json" });
    expect(result.standard?.frames).toBe(50);
    expect(result.software?.frames).toBe(50);
    expect(result.standard?.psnr).toBeLessThan(30);
    const gain = result.software!.psnr! - result.standard!.psnr!;
    expect(gain).toBeGreaterThanOrEqual(0.5);
    expect(gain).toBeLessThan(2);
    expect(result.response?.bitrate).toBe(bitrate * 2);
    expect(result.response?.measurement.frames).toBe(50);
    expect(Math.abs(result.response!.measurement.bitrate / result.standard!.bitrate - 1)).toBeLessThanOrEqual(0.05);
    expect(Math.abs(result.response!.measurement.psnr! - result.standard!.psnr!)).toBeLessThanOrEqual(0.25);
    expect(result.reason).toBe("unresponsive");
    expect(result.hardwareAcceleration).toBe("prefer-software");
});

test("a probe keeps the default when software exceeds the requested size", async ({ page }, info) => {
    await restrictDefaultEncoder(page, { softwareBitrate: 64_000_000 });
    await presetLocalStorage(page);
    await gotoApp(page, "en");
    const bitrate = 32_000_000;
    const result = await runProbe(page, { width: 3840, height: 2160, frameRate: 25, bitrate });
    await info.attach("measurement", { body: JSON.stringify(result), contentType: "application/json" });
    expect(result.standard?.frames).toBe(50);
    expect(result.software?.frames).toBe(50);
    expect(result.standard?.psnr).toBeLessThan(30);
    expect(result.software?.bitrate).toBeGreaterThan(bitrate * 1.5);
    expect(result.reason).toBe("inconclusive");
    expect(result.hardwareAcceleration).toBe("no-preference");
    expect(result.response).toBeNull();
});

test("a probe retains a default encoder that responds to a higher bitrate", async ({ page }, info) => {
    await restrictDefaultEncoder(page, { higherTarget: "responsive", softwareBitrate: 12_700_000 });
    await presetLocalStorage(page);
    await gotoApp(page, "en");
    const bitrate = 29_000_000;
    const result = await runProbe(page, { width: 3840, height: 2160, frameRate: 25, bitrate });
    await info.attach("measurement", { body: JSON.stringify(result), contentType: "application/json" });
    expect(result.response?.bitrate).toBe(bitrate * 2);
    expect(result.response?.measurement.frames).toBe(50);
    expect(result.response?.measurement.bitrate).toBeGreaterThan(result.standard!.bitrate * 1.05);
    expect(result.reason).toBe("inconclusive");
    expect(result.hardwareAcceleration).toBe("no-preference");
});

test("an unsupported higher bitrate preserves the original probe measurements", async ({ page }, info) => {
    await restrictDefaultEncoder(page, { higherTarget: "unsupported", softwareBitrate: 12_700_000 });
    await presetLocalStorage(page);
    await gotoApp(page, "en");
    const bitrate = 29_000_000;
    const result = await runProbe(page, { width: 3840, height: 2160, frameRate: 25, bitrate });
    await info.attach("measurement", { body: JSON.stringify(result), contentType: "application/json" });
    expect(result.standard?.frames).toBe(50);
    expect(result.software?.frames).toBe(50);
    expect(result.standard?.bitrate).toBeLessThan(bitrate * 0.35);
    expect(result.standard?.psnr).toBeLessThan(30);
    expect(result.software?.bitrate).toBeGreaterThanOrEqual(bitrate * 0.65);
    expect(result.software?.bitrate).toBeLessThanOrEqual(bitrate * 1.5);
    const gain = result.software!.psnr! - result.standard!.psnr!;
    expect(gain).toBeGreaterThanOrEqual(0.5);
    expect(gain).toBeLessThan(2);
    expect(result.response).toBeNull();
    expect(result.reason).toBe("inconclusive");
    expect(result.hardwareAcceleration).toBe("no-preference");
});

test("automatic selection reaches the export encoder and the standard notification drawer", async ({ page }, info) => {
    test.setTimeout(120_000);
    let probes = 0;
    page.on("worker", (worker) => {
        if (PROBE_WORKER.test(worker.url())) probes++;
    });
    // Use the same native encoding conditions as the moderate-gain worker probe.
    await restrictDefaultEncoder(page, { softwareBitrate: 12_700_000 });
    await prepareExport(page, join(REPO_ROOT, "tests/testdata/encoder-selection"));
    await page.locator("#export-panel-output").selectOption("custom");
    const dimensions = page.locator('.export-panel__output-custom input[type="number"]');
    await dimensions.nth(0).fill("3840");
    await dimensions.nth(0).blur();
    await dimensions.nth(1).fill("2160");
    await dimensions.nth(1).blur();
    await page.locator(".export-panel__manual-bitrate > summary").click();
    await page.locator("#export-panel-bitrate").fill("29");
    await page.locator("#export-panel-bitrate").blur();
    await saveExport(page);
    const config = await page.evaluate(
        () =>
            window.__everydashcam
                .dumpLog()
                .reverse()
                .find((r) => r.msg === "video encoder config requested")?.ctx,
    );
    const diagnostics = await page.evaluate(() =>
        window.__everydashcam.dumpLog().filter((r) => /encoder trial|export settings/.test(r.msg)),
    );
    await info.attach("selection", { body: JSON.stringify(diagnostics), contentType: "application/json" });
    expect(config, JSON.stringify(diagnostics)).toMatchObject({
        hardwareAcceleration: "prefer-software",
        bitrate: 29_000_000,
    });
    expect(diagnostics.find((entry) => entry.msg === "encoder trial measured")?.ctx).toMatchObject({
        frameRate: 25,
        reason: "unresponsive",
        response: { bitrate: 58_000_000 },
    });
    await page.locator("#notif-bell").click();
    await expect(page.locator("#notif-drawer-list")).toContainText("Automatically switched to software encoding");
    await expect(page.locator("#notif-drawer-list")).toContainText("Settings");
    await page.locator("#notif-bell").click();
    await page.locator("#export-panel-done > button").click();
    await openExport(page);
    await saveExport(page);
    expect(probes, "the same configuration reuses its session probe").toBe(1);
    expect(
        await page.evaluate(
            () =>
                window.__everydashcam
                    .dumpLog()
                    .reverse()
                    .find((r) => r.msg === "video encoder config requested")?.ctx,
        ),
    ).toMatchObject({ hardwareAcceleration: "prefer-software" });
});

test("a stalled quality probe times out and exports with the default encoder", async ({ page }) => {
    test.setTimeout(90_000);
    await page.route(PROBE_WORKER, (route) => route.fulfill({ contentType: "text/javascript", body: "" }));
    await prepareExport(page);
    await page.locator("#export-panel-output").selectOption("720_16x9");
    await saveExport(page);
    expect(page.workers().some((worker) => PROBE_WORKER.test(worker.url()))).toBe(false);
    const logs = await page.evaluate(() => window.__everydashcam.dumpLog());
    expect(logs.find((r) => r.msg === "encoder trial unavailable")?.ctx).toMatchObject({
        err: "encoder probe timed out",
    });
    expect(logs.find((r) => r.msg === "video encoder config requested")?.ctx).toMatchObject({
        hardwareAcceleration: "no-preference",
    });
    expect(logs.some((r) => r.msg === "encoder trial measured")).toBe(false);
});

test("an unavailable probe worker does not block export", async ({ page }) => {
    await page.route(PROBE_WORKER, (route) => route.abort("failed"));
    await prepareExport(page);
    await page.locator("#export-panel-output").selectOption("720_16x9");
    await saveExport(page);
    const logs = await page.evaluate(() => window.__everydashcam.dumpLog());
    expect(logs.some((r) => r.msg === "encoder trial unavailable")).toBe(true);
    expect(logs.find((r) => r.msg === "video encoder config requested")?.ctx).toMatchObject({
        hardwareAcceleration: "no-preference",
    });
});

test("cancelling a quality probe terminates its worker and does not cache the cancellation", async ({ page }) => {
    test.setTimeout(90_000);
    await page.route(PROBE_WORKER, (route) => route.fulfill({ contentType: "text/javascript", body: "" }));
    await prepareExport(page);
    await page.locator("#export-panel-output").selectOption("720_16x9");
    const workerPromise = page.waitForEvent("worker", (worker) => PROBE_WORKER.test(worker.url()));
    await page.locator("#export-panel-save-btn").click();
    const worker = await workerPromise;
    const closed = worker.waitForEvent("close");
    await expect(page.locator("#export-panel-progress-status")).toHaveText("Checking export quality…");
    await page.locator("#export-panel-progress").getByRole("button", { name: "Cancel", exact: true }).click();
    await closed;
    await expect(page.locator("#export-panel-save-btn")).toBeVisible();
    expect((await readExportResult(page))?.len).toBe(0);
    await page.unroute(PROBE_WORKER);
    await saveExport(page);
    expect(
        await page.evaluate(() => window.__everydashcam.dumpLog().some((r) => r.msg === "encoder trial measured")),
    ).toBe(true);
});

for (const layout of ["single", "composite"] as const) {
    test(`explicit software selection bypasses the probe for ${layout} exports`, async ({ page }) => {
        let probes = 0;
        page.on("worker", (worker) => {
            if (PROBE_WORKER.test(worker.url())) probes++;
        });
        await page.addInitScript(() => localStorage.setItem("everydashcam:encoder", "software"));
        await prepareExport(page);
        if (layout === "single") {
            const includes = page.locator(".top-panel__channel-include");
            await includes.nth(2).click();
            await includes.nth(1).click();
            await page.locator('input[name="export-panel-quality"][value="medium"]').check();
            await page.locator("#export-panel-watermark").uncheck();
        } else {
            await page.locator("#export-panel-output").selectOption("720_16x9");
        }
        await saveExport(page);
        expect(probes).toBe(0);
        expect(
            await page.evaluate(
                () =>
                    window.__everydashcam
                        .dumpLog()
                        .reverse()
                        .find((r) => r.msg === "video encoder config requested")?.ctx,
            ),
        ).toMatchObject({ hardwareAcceleration: "prefer-software" });
        if (layout === "single") expect((await readTranscodeDoneFields(page))?.framesDirect).toBeGreaterThan(0);
    });
}

test("an unsupported manual encoder explains how to recover while unchanged exports remain available", async ({
    page,
}) => {
    await page.addInitScript(() => {
        localStorage.setItem("everydashcam:encoder", "hardware");
        const supported = VideoEncoder.isConfigSupported.bind(VideoEncoder);
        VideoEncoder.isConfigSupported = async (config) =>
            config.hardwareAcceleration === "prefer-hardware" ? { supported: false, config } : supported(config);
    });
    let probes = 0;
    page.on("worker", (worker) => {
        if (PROBE_WORKER.test(worker.url())) probes++;
    });
    await prepareExport(page);
    await expect(page.locator("#export-panel-save-btn")).toBeDisabled();
    await expect(page.locator("#export-panel-encode-note")).toContainText("Automatic");
    const includes = page.locator(".top-panel__channel-include");
    await includes.nth(2).click();
    await includes.nth(1).click();
    await saveExport(page);
    expect(probes).toBe(0);
    expect(
        await page.evaluate(() =>
            window.__everydashcam.dumpLog().some((r) => r.msg === "video encoder config requested"),
        ),
    ).toBe(false);
});
