import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { BufferSource, Input, MP4 } from "mediabunny";
import { PORTABLE_UPDATE_URL } from "../../src/portable/manifest.mjs";
import { loadTrip, openExport, presetLocalStorage, SAMPLE_70MAI } from "../e2e/_fixtures.js";
import { openPortable } from "./_fixtures.js";
import { showOnlyCameras } from "../e2e/_cameras.js";

test("reports initial fallback allocation failure and allows a successful retry", async ({ page }, info) => {
    const errors: string[] = [];
    const expectedErrors: string[] = [];
    const unexpectedRequests: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
        if (message.type() !== "error") return;
        if (message.location().url === PORTABLE_UPDATE_URL && /net::ERR_/.test(message.text())) return;
        if (
            /^\[export-flow\] export failed RangeError: Array buffer allocation failed \(portable test\)/.test(
                message.text(),
            )
        )
            expectedErrors.push(message.text());
        else errors.push(message.text());
    });
    await page.route(/^https?:/, (route) => {
        if (route.request().url() !== PORTABLE_UPDATE_URL) unexpectedRequests.push(route.request().url());
        return route.abort();
    });
    await presetLocalStorage(page);
    await page.addInitScript(() => {
        const fault = { armed: false };
        Object.defineProperty(window, "__failNextPortableAllocation", {
            value: () => {
                fault.armed = true;
            },
        });
        Object.defineProperty(window, "showSaveFilePicker", {
            configurable: true,
            value: () => Promise.reject(new DOMException("file origin is denied", "SecurityError")),
        });
        window.ArrayBuffer = new Proxy(ArrayBuffer, {
            construct(target, args, newTarget) {
                if (fault.armed && args[0] === 64 * 1024) {
                    fault.armed = false;
                    throw new RangeError("Array buffer allocation failed (portable test)");
                }
                return Reflect.construct(target, args, newTarget);
            },
        });
    });
    await openPortable(page, info.outputPath("allocation"));
    await page.locator("#settings-btn").click();
    await page.locator("#settings-map-provider-select").selectOption("route-only");
    await page.locator("#settings-modal-header-close").click();
    await loadTrip(page, SAMPLE_70MAI);
    await openExport(page);
    await showOnlyCameras(page, ["front"]);
    await page.evaluate(() =>
        (window as unknown as { __failNextPortableAllocation: () => void }).__failNextPortableAllocation(),
    );
    await page.locator("#export-panel-save-btn").click();
    await expect(page.locator("#export-panel-error")).toContainText("Try a shorter clip or use the full version");
    await expect(page.locator("body")).not.toHaveClass(/dc-transcode-busy/);
    await page.locator("#export-panel-error > button").first().click();
    await expect(page.locator("#export-panel-save-btn")).toBeEnabled();
    await page.locator("#export-panel-save-btn").click();
    await expect(page.locator("#export-panel-done-summary")).toBeVisible();
    const pending = page.waitForEvent("download");
    await page.locator("#export-panel-done-summary button").click();
    const download = await pending;
    const target = info.outputPath("retry.mp4");
    await download.saveAs(target);
    const input = new Input({ source: new BufferSource(await readFile(target)), formats: [MP4] });
    try {
        const video = await input.getPrimaryVideoTrack();
        expect(video).not.toBeNull();
        expect(await video!.computeDuration()).toBeGreaterThan(1);
        expect(await input.getPrimaryAudioTrack()).not.toBeNull();
    } finally {
        input.dispose();
    }
    expect(expectedErrors).toHaveLength(1);
    expect(errors).toEqual([]);
    expect(unexpectedRequests).toEqual([]);
});
