import { installWorkerRpc } from "./_worker-rpc.js";
import { readFileSync } from "node:fs";
import path from "node:path";

import type { Page } from "@playwright/test";
import {
    DESKTOP,
    SAMPLE_70MAI,
    SAMPLE_GOPRO,
    expect,
    gotoApp,
    installExportCapture,
    loadTrip,
    openExport,
    pausePlayback,
    presetLocalStorage,
    readExportResult,
    shot,
    test,
} from "./_fixtures.js";

async function prepare(
    page: Page,
    locale = "en",
    pickerOptions?: Parameters<typeof installExportCapture>[2],
): Promise<void> {
    await presetLocalStorage(page);
    await installExportCapture(page, undefined, pickerOptions);
    await page.setViewportSize(DESKTOP);
    await gotoApp(page, locale);
    await loadTrip(page);
}

async function openSingleCameraExport(page: Page): Promise<void> {
    await openExport(page);
    const cameras = page.locator(".top-panel__channel-include");
    await cameras.nth(2).click();
    await cameras.nth(1).click();
    await expect(page.locator(".top-panel__channel-include:checked")).toHaveCount(1);
}

async function pickerCalls(page: Page): Promise<number> {
    return page.evaluate(() => (window as unknown as { __exportPickerCalls: number }).__exportPickerCalls);
}

async function holdFolderDrop(page: Page): Promise<void> {
    const bytes = Array.from(readFileSync(path.join(SAMPLE_GOPRO, "hero5-trimmed.mp4")));
    await page.evaluate((bytes) => {
        const file = new File([Uint8Array.from(bytes)], "hero5-trimmed.mp4", { type: "video/mp4" });
        const transfer = new DataTransfer();
        transfer.items.add(file);
        // Delay the external directory-entry callback, retaining real recording
        // bytes for the import that resumes after the foreground dialog closes.
        Object.defineProperty(transfer, "items", {
            value: [
                {
                    webkitGetAsEntry: () => ({
                        isFile: true,
                        isDirectory: false,
                        fullPath: "/another-card/hero5-trimmed.mp4",
                        file: (deliver: (file: File) => void) => {
                            (window as typeof window & { __releaseFolderDrop?: () => void }).__releaseFolderDrop = () =>
                                deliver(file);
                        },
                    }),
                },
            ],
        });
        window.dispatchEvent(new DragEvent("drop", { dataTransfer: transfer, bubbles: true, cancelable: true }));
    }, bytes);
    await expect(page.locator("#ingest-overlay")).toBeVisible();
}

async function releaseFolderDrop(page: Page): Promise<void> {
    await page.evaluate(() => {
        const release = (window as typeof window & { __releaseFolderDrop?: () => void }).__releaseFolderDrop;
        if (!release) throw new Error("folder drop has not reached its file callback");
        release();
    });
    await expect(page.locator("li.trip:not(.unindexed-note)").first()).toBeVisible({ timeout: 30_000 });
    await expect(page.locator("#ingest-overlay")).toBeHidden();
}

async function openUnreadableCardWarning(page: Page): Promise<void> {
    // The landing CTA is removed after ingest; use an opener that survives it.
    await page.locator("#settings-btn").focus();
    // Negative input exercises the real zero-trip recovery path.
    await page.locator("#file-input").setInputFiles({
        name: "recording.mp4",
        mimeType: "video/mp4",
        buffer: Buffer.from("unrecognized recording"),
    });
    await expect(page.locator("#no-recordings-modal")).toBeVisible();
    await expect(page.locator("#ingest-overlay")).toBeHidden();
    await expect(page.locator("#no-recordings-help")).toBeFocused();
}

test("a card warning keeps keyboard ownership above another folder drop", async ({ page }) => {
    await presetLocalStorage(page);
    await gotoApp(page);
    await openUnreadableCardWarning(page);
    await holdFolderDrop(page);
    await expect(page.locator("#no-recordings-help")).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.locator("#no-recordings-cancel")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.locator("#no-recordings-modal")).toBeHidden();
    await expect(page.locator("#ingest-overlay")).toBeVisible();
    await expect(page.locator("#ingest-overlay")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.locator("#ingest-overlay")).toBeHidden();
    await expect(page.locator("#settings-btn")).toBeFocused();
    await releaseFolderDrop(page);
});

test("equal-layer warnings paint in keyboard order and restore the previous dialog", async ({ page }) => {
    await presetLocalStorage(page);
    await gotoApp(page);
    await openUnreadableCardWarning(page);
    await page.locator("#file-input").setInputFiles({
        name: "legacy.avi",
        mimeType: "video/x-msvideo",
        buffer: Buffer.from("unsupported recording"),
    });
    const close = page.locator("#unsupported-modal-close");
    await expect(close).toBeFocused();
    expect(
        await close.evaluate((el) => {
            const rect = el.getBoundingClientRect();
            return document
                .elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
                ?.closest("[role=dialog]")?.id;
        }),
        "the focused dialog must also be painted above the older warning",
    ).toBe("unsupported-modal");
    await page.keyboard.press("Escape");
    await expect(page.locator("#unsupported-modal")).toBeHidden();
    await expect(page.locator("#no-recordings-help")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.locator("#no-recordings-modal")).toBeHidden();
    await expect(page.locator("#settings-btn")).toBeFocused();
});

test.describe("folder drops under the Chromium browser warning", () => {
    test.use({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:128.0) Gecko/20100101 Firefox/128.0" });

    test("Escape closes the visible browser warning before the folder wait", async ({ page }) => {
        await presetLocalStorage(page);
        await page.setViewportSize(DESKTOP);
        await gotoApp(page);
        await loadTrip(page);
        await openExport(page);
        await page.locator("#export-panel-chromium-banner").click();
        await expect(page.locator("#chromium-browsers-modal-close")).toBeFocused();
        await holdFolderDrop(page);
        await expect(page.locator("#chromium-browsers-modal-close")).toBeFocused();
        await page.keyboard.press("Tab");
        await expect(page.locator('.chromium-modal-chip[data-browser="chrome"]')).toBeFocused();
        await page.keyboard.press("Escape");
        await expect(page.locator("#chromium-browsers-modal")).toBeHidden();
        await expect(page.locator("#ingest-overlay")).toBeVisible();
        await expect(page.locator("#ingest-overlay")).toBeFocused();
        await page.keyboard.press("Escape");
        await expect(page.locator("#ingest-overlay")).toBeHidden();
        await expect(page.locator("#export-panel-chromium-banner")).toBeFocused();
        await releaseFolderDrop(page);
    });
});

test("folder reading traps focus without accidental cancellation and accepts a late selection after Escape", async ({
    page,
}) => {
    await presetLocalStorage(page);
    await page.addInitScript(() => {
        Object.defineProperty(window, "showDirectoryPicker", { configurable: true, value: undefined });
    });
    await gotoApp(page);
    const chooserPromise = page.waitForEvent("filechooser");
    await page.locator("#landing-cta").click();
    const chooser = await chooserPromise;
    const overlay = page.locator("#ingest-overlay");
    const cancel = page.locator("#ingest-overlay-cancel");
    await expect(overlay).toBeFocused();
    for (const key of ["Space", "Enter"]) {
        await page.keyboard.press(key);
        await expect(overlay).toBeVisible();
        await expect(overlay).toBeFocused();
    }
    await page.keyboard.press("Tab");
    await expect(cancel).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(cancel).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.locator("#ingest-overlay")).toBeHidden();
    await expect(page.locator("#landing-cta")).toBeFocused();

    await chooser.setFiles(SAMPLE_70MAI);
    const trip = page.locator("li.trip:not(.unindexed-note)").first();
    await expect(trip).toBeVisible({ timeout: 30_000 });
    await trip.locator(".trip-title").click();
    await pausePlayback(page);
    await page.keyboard.press("Space");
    await expect(page.locator("#player-play")).toHaveAttribute("data-paused", "false");
});

test("an active import requires explicit cancellation instead of playback keys or Escape", async ({ page }) => {
    await presetLocalStorage(page);
    await installWorkerRpc(page, () => {
        const target = window as typeof window & { __classificationHeld?: boolean; __holdClassification?: boolean };
        window.__workerRpc.intercept(["ingest-worker"], () => (type, _data, forward) => {
            if (type === "classify-batch" && target.__holdClassification) {
                target.__classificationHeld = true;
                return new Promise(() => {});
            }
            return forward();
        });
    });
    await gotoApp(page);
    await loadTrip(page, SAMPLE_GOPRO);
    await pausePlayback(page);
    await page.evaluate(() => {
        (window as typeof window & { __holdClassification?: boolean }).__holdClassification = true;
    });
    await page.locator("#folder-input").setInputFiles(SAMPLE_70MAI);
    await expect
        .poll(() =>
            page.evaluate(() => (window as typeof window & { __classificationHeld?: boolean }).__classificationHeld),
        )
        .toBe(true);
    const overlay = page.locator("#ingest-overlay");
    await expect(overlay).toBeFocused();
    for (const key of ["Space", "Enter", "Escape"]) {
        await page.keyboard.press(key);
        await expect(overlay).toBeVisible();
        await expect(overlay).toBeFocused();
        expect(await page.evaluate(() => window.__everydashcam.state.ingestController?.signal.aborted)).toBe(false);
    }
    await expect(page.locator("#player-play")).toHaveAttribute("data-paused", "true");
    await page.keyboard.press("Tab");
    await expect(page.locator("#ingest-overlay-cancel")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(overlay).toBeHidden();
    await expect.poll(() => page.evaluate(() => window.__everydashcam.state.ingestController)).toBeNull();
});

test("an unsupported-file warning retains focus after background import finishes", async ({ page }) => {
    await presetLocalStorage(page);
    await page.setViewportSize(DESKTOP);
    await gotoApp(page);
    await loadTrip(page);
    await expect(page.locator("#landing-cta")).toHaveCount(0);
    const opener = page.locator("#sidebar-cta");
    await opener.focus();
    await expect(opener).toBeFocused();

    const name = "NO20260101-120000-000001F.MP4";
    await page.locator("#file-input").setInputFiles([
        { name, mimeType: "video/mp4", buffer: readFileSync(path.join(SAMPLE_70MAI, "Normal/Front", name)) },
        // This warning uses the extension; unsupported bytes never reach a parser.
        { name: "legacy.avi", mimeType: "video/x-msvideo", buffer: Buffer.from("unsupported recording") },
    ]);
    const warning = page.locator("#unsupported-modal");
    await expect(warning).toBeVisible();
    await expect(page.locator("#ingest-overlay")).toBeHidden();
    await expect(page.locator("#unsupported-modal-close")).toBeFocused();

    await page.evaluate(() => {
        const overlay = document.getElementById("ingest-overlay")!;
        const warning = document.getElementById("unsupported-modal")!;
        const observer = new MutationObserver(() => {
            if (overlay.hidden) return;
            overlay.dataset.warningFocus = String(warning.contains(document.activeElement));
            observer.disconnect();
        });
        observer.observe(overlay, { attributes: true, attributeFilter: ["hidden"] });
    });
    await page.locator("#file-input").setInputFiles(path.join(SAMPLE_GOPRO, "hero5-trimmed.mp4"));
    await expect(page.locator("#ingest-overlay")).toHaveAttribute("data-warning-focus", "true");
    await expect(page.locator("li.trip:not(.unindexed-note)")).toHaveCount(2, { timeout: 30_000 });
    await expect(page.locator("#ingest-overlay")).toBeHidden();
    await expect(page.locator("#unsupported-modal-close")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(warning).toBeHidden();
    await expect(opener).toBeFocused();
});

test("repeated Save events open only one native picker", async ({ page }) => {
    await prepare(page, "en", { pickerDelayMs: 30_000 });
    await openSingleCameraExport(page);
    const save = page.locator("#export-panel-save-btn");
    await save.click();
    for (let i = 0; i < 4; i++) await save.dispatchEvent("click");
    expect(await pickerCalls(page)).toBe(1);
    await expect(save).toBeDisabled();
    await expect(page.locator("#export-panel-error")).toBeHidden();
});

test("export recovers after the browser rejects an already active picker", async ({ page }) => {
    await prepare(page, "en", {
        pickerErrorOnce: {
            name: "NotAllowedError",
            message: "Failed to execute 'showSaveFilePicker' on 'Window': File picker already active.",
        },
    });
    await openSingleCameraExport(page);
    const save = page.locator("#export-panel-save-btn");
    await save.click();

    const error = page.locator("#export-panel-error");
    await expect(error).toBeVisible();
    await expect(error).toContainText("A file dialog is already open.");
    expect(await pickerCalls(page), "the failed picker is not retried automatically").toBe(1);
    expect(await readExportResult(page), "a failed picker never starts writing").toBeNull();

    await error.locator(".export-panel__primary-btn").click();
    await expect(save).toBeEnabled();
    await save.click();
    await expect(page.locator("#export-panel-done-summary")).toBeVisible();
    expect(await pickerCalls(page)).toBe(2);
    const output = await readExportResult(page);
    expect(output?.len).toBeGreaterThan(1024);
    expect(output?.gpmd, "a fresh user click saves the MP4 with GPS").toBe(true);
});

for (const [locale, warning] of [
    ["en", "A file dialog is already open."],
    ["ru", "Окно выбора файла уже открыто."],
] as const) {
    test(`export retries after the pending directory picker closes (${locale})`, async ({ page }) => {
        await prepare(page, locale);
        await page.evaluate(() => {
            const w = window as unknown as {
                showDirectoryPicker: () => Promise<never>;
                dismissDirectoryPicker: () => void;
            };
            w.showDirectoryPicker = () =>
                new Promise<never>((_resolve, reject) => {
                    w.dismissDirectoryPicker = () => reject(new DOMException("cancelled", "AbortError"));
                });
        });
        await page.locator("#sidebar-cta").click();
        await expect(page.locator("#ingest-overlay")).toBeVisible();
        await expect(page.locator("#ingest-overlay")).toBeFocused();
        await page.locator("#ingest-overlay-cancel").click();
        await expect(page.locator("#ingest-overlay")).toBeHidden();
        await openSingleCameraExport(page);
        const save = page.locator("#export-panel-save-btn");
        await save.click();

        const error = page.locator("#export-panel-error");
        await expect(error).toBeVisible();
        await expect(error).toContainText(warning);
        await expect(error.locator(".export-panel__error-status")).toBeFocused();
        await expect(error).toHaveCSS("opacity", "1");
        expect(await pickerCalls(page), "a pending directory picker prevents the native Save call").toBe(0);
        await shot(page, `file-picker-busy-${locale}`);

        await page.evaluate(() =>
            (window as unknown as { dismissDirectoryPicker: () => void }).dismissDirectoryPicker(),
        );
        await error.locator(".export-panel__primary-btn").click();
        await expect(save).toBeEnabled();
        await save.click();
        await expect(page.locator("#export-panel-done-summary")).toBeVisible();
        expect(await pickerCalls(page)).toBe(1);
        const output = await readExportResult(page);
        expect(output?.len).toBeGreaterThan(1024);
        expect(output?.gpmd, "the retry saves an MP4 with GPS through the native destination").toBe(true);
    });
}
