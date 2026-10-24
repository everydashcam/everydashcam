// The folder rows above the trip list: where the loaded trips came from, and
// (on the FSA path) remembering and forgetting that folder. The notes file is
// a separate app-wide section below the folder list.
//
// Two halves, deliberately separate: the classic <input webkitdirectory> path
// runs everywhere and gets an informational row, the FSA path gets the
// controls. The second half drives a fake directory picker (see
// mockDirectoryPicker) - the only way to reach that code from a spec.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import {
    checkFeedbackStructureReport,
    downloadFeedbackStructureReport,
    writeFeedbackStructureCard,
} from "./_feedback-structure.js";

import {
    SAMPLE_70MAI,
    SAMPLE_GOPRO,
    expect,
    gotoApp,
    mockDirectoryPicker,
    persistentTest as test,
    presetLocalStorage,
} from "./_fixtures.js";

const sourceRow = "#folder-sources .folder-source";

test("file-system picker includes excluded directory contents in the feedback report", async ({ page }, info) => {
    const directory = info.outputPath("card");
    writeFeedbackStructureCard(directory);
    const excludedOnly = info.outputPath("excluded-only");
    mkdirSync(join(excludedOnly, ".diagnostic-only"), { recursive: true });
    writeFileSync(join(excludedOnly, ".diagnostic-only", "trace.dat"), "excluded file content");
    await presetLocalStorage(page);
    await mockDirectoryPicker(page, [
        { label: "EXCLUDED", dir: excludedOnly },
        { label: "CARD", dir: directory },
    ]);
    await gotoApp(page, "en");
    await page.locator("#landing-cta").click();
    await expect
        .poll(() =>
            page.evaluate(() => {
                const { state } = window.__everydashcam;
                return {
                    finished: state.ingestController === null,
                    trips: state.trips.length,
                    files: state.lastIngestFiles?.length,
                    observedExcludedFile: state.lastIngestStructure?.some((entry) =>
                        entry.relativePath.endsWith(".diagnostic-only/trace.dat"),
                    ),
                };
            }),
        )
        .toEqual({ finished: true, trips: 0, files: 0, observedExcludedFile: true });
    const excludedReport = await downloadFeedbackStructureReport(page);
    expect(excludedReport).toMatch(/\.diagnostic-only\/trace\.dat[^\n]*excluded: hidden path/);
    await page.locator("#feedback-cancel").click();

    // The helper seeds real OPFS handles. An empty directory cannot be expressed
    // by its file listing, so add one before the app enumerates that same root.
    await page.evaluate(async () => {
        const picker = (window as unknown as { showDirectoryPicker: () => Promise<FileSystemDirectoryHandle> })
            .showDirectoryPicker;
        const root = await picker();
        await root.getDirectoryHandle(".empty-vendor", { create: true });
    });
    await page.locator("#landing-cta").click();
    const report = await checkFeedbackStructureReport(page, true);
    expect(report, "a new selection replaces the previous folder snapshot").not.toContain(".diagnostic-only");
});

test.describe("folder sources, classic picker", () => {
    test.beforeEach(async ({ page }) => {
        await presetLocalStorage(page);
        await gotoApp(page, "en");
    });

    test("names the folder the trips came from, without controls it cannot honour", async ({ page }) => {
        await expect(page.locator("#folder-sources")).toBeHidden();
        await page.locator("#folder-input").setInputFiles(SAMPLE_70MAI);
        await expect(page.locator("li.trip:not(.unindexed-note)").first()).toBeVisible({ timeout: 30_000 });

        const row = page.locator(sourceRow);
        await expect(row).toHaveCount(1);
        await expect(row).toContainText("70mai-multichannel");
        // Files, not a reopenable folder: nothing here can be remembered, so the
        // row must not pretend otherwise.
        await expect(row.locator(".folder-source__remember")).toHaveCount(0);
        await expect(row.locator(".folder-source__status")).toHaveCount(0);
        await expect(row.locator(".folder-source__menu")).toHaveCount(0);
    });

    test("re-opening the same folder through the picker upgrades its row", async ({ page }) => {
        // The fake picker hands back the SAME root the plain input just loaded.
        await mockDirectoryPicker(page, [{ label: "70mai-multichannel", dir: SAMPLE_70MAI }]);
        await page.reload();
        await page.locator("#folder-input").setInputFiles(SAMPLE_70MAI);
        const row = page.locator(sourceRow);
        await expect(row).toHaveCount(1);
        await expect(row.locator(".folder-source__remember")).toHaveCount(0);

        await page.locator("#sidebar-cta").click();
        // The clips dedup away against what is already loaded, so the second
        // batch is a remnant at best - the row must still stay single AND learn
        // that it now has a reopenable folder behind it.
        await expect(row).toHaveCount(1);
        await expect(row.locator(".folder-source__remember")).toBeVisible();
    });
});

test.describe("folder sources, file-system picker", () => {
    test.beforeEach(async ({ page }) => {
        await presetLocalStorage(page);
        await mockDirectoryPicker(page, [
            { label: "MOCKCARD", dir: SAMPLE_70MAI },
            { label: "MOCKCARD", dir: SAMPLE_GOPRO },
        ]);
        await gotoApp(page, "en");
    });

    test("offers to remember a picked folder, then keeps the offer settled", async ({ page }) => {
        await page.locator("#landing-cta").click();
        await expect(page.locator("li.trip:not(.unindexed-note)").first()).toBeVisible({ timeout: 30_000 });

        const row = page.locator(sourceRow);
        await expect(row).toHaveCount(1);
        await expect(row).toContainText("MOCKCARD");
        // The dot exists because this folder CAN be reopened; the offer is a
        // standing control, not a toast that expires.
        await expect(row.locator(".folder-source__status")).toHaveCount(1);
        await expect(page.locator(".dc-toast")).toHaveCount(0);

        await row.locator(".folder-source__remember").click();
        await expect(row.locator(".folder-source__state")).toHaveText(/Remembered/);
        await expect(row.locator(".folder-source__remember")).toHaveCount(0);
    });

    test("menu forgets the folder without disturbing the open trips", async ({ page }) => {
        await page.locator("#landing-cta").click();
        await expect(page.locator("li.trip:not(.unindexed-note)").first()).toBeVisible({ timeout: 30_000 });
        const row = page.locator(sourceRow);
        await row.locator(".folder-source__remember").click();
        await expect(row.locator(".folder-source__state")).toBeVisible();
        await expect(page.locator("#notes-file-status")).toContainText("Notes are saved in this browser");

        await row.locator(".folder-source__menu").click();
        const menu = row.locator(".folder-source__popup");
        await expect(menu).toBeVisible();
        await expect(menu, "folder actions do not configure the current notes file").not.toContainText("notes");

        await menu.getByRole("button", { name: "Forget this folder" }).click();
        // Back to an offer, and the trips it produced are untouched.
        await expect(row.locator(".folder-source__remember")).toBeVisible();
        await expect(page.locator("li.trip:not(.unindexed-note)").first()).toBeVisible();
    });

    test("offers a notes backup where trip annotations are edited", async ({ page }) => {
        await page.locator("#landing-cta").click();
        const card = page.locator("li.trip:not(.unindexed-note)").first();
        await expect(card).toBeVisible({ timeout: 30_000 });

        // This entry is visible even before the separate Remember action: the
        // backup flow can remember the live source as part of the same click.
        await card.locator(".trip-edit").click();
        const modal = page.locator("#trip-meta-modal");
        await expect(modal).toBeVisible();
        await expect(modal.locator("#trip-meta-storage-action")).toBeVisible();
        await expect(modal.locator("#trip-meta-storage-action")).toHaveText("Create notes backup…");
        await modal.locator("#trip-meta-cancel").click();
    });

    test("connects only a notes file from the blocking first-write choice", async ({ page }) => {
        await page.locator("#landing-cta").click();
        const card = page.locator("li.trip:not(.unindexed-note)").first();
        await expect(card).toBeVisible({ timeout: 30_000 });

        await card.locator(".trip-edit").click();
        await page.locator("#trip-meta-name").fill("File-backed trip");
        await page.locator("#trip-meta-save").click();
        const decision = page.locator("#notes-storage-modal");
        await expect(decision).toBeVisible();
        await decision.getByRole("button", { name: "Save to a file" }).click();
        await expect(decision).toBeHidden();

        await expect(page.locator("#notes-file-status")).toContainText("Saving to notes.everydashcam");
        await expect
            .poll(
                () =>
                    page.evaluate(async () => {
                        const handle = (window as unknown as { __e2eNotesFileHandle?: FileSystemFileHandle })
                            .__e2eNotesFileHandle;
                        if (!handle) return false;
                        const payload = JSON.parse(await (await handle.getFile()).text()) as {
                            annotations?: Array<{ name?: string }>;
                        };
                        return payload.annotations?.some((record) => record.name === "File-backed trip") ?? false;
                    }),
                { message: "the first edit must be written through the selected notes-file handle" },
            )
            .toBe(true);
    });

    test("a second folder gets its own row", async ({ page }) => {
        await page.locator("#landing-cta").click();
        await expect(page.locator("li.trip:not(.unindexed-note)").first()).toBeVisible({ timeout: 30_000 });
        await expect(page.locator(sourceRow)).toHaveCount(1);

        // The second picker call hands back another physical card with the same
        // display name. The source scope keeps its different files separate.
        await page.locator("#sidebar-cta").click();
        await expect(page.locator(sourceRow)).toHaveCount(2);
        await expect(page.locator(sourceRow).nth(0)).toContainText("MOCKCARD");
        await expect(page.locator(sourceRow).nth(1)).toContainText("MOCKCARD (2)");
    });
    test("a remembered folder from an earlier session shows as a loadable row", async ({ page }) => {
        await page.locator("#landing-cta").click();
        await expect(page.locator("li.trip:not(.unindexed-note)").first()).toBeVisible({ timeout: 30_000 });
        await page.locator(`${sourceRow} .folder-source__remember`).click();
        await expect(page.locator(".folder-source__state")).toBeVisible();

        // Next session: the trips come from somewhere else entirely, but the
        // remembered folder must still be one click away in the SOURCES list.
        await page.reload();
        await page.locator("#folder-input").setInputFiles(SAMPLE_GOPRO);
        await expect(page.locator("li.trip:not(.unindexed-note)").first()).toBeVisible({ timeout: 30_000 });

        const unloaded = page.locator(".folder-source--unloaded");
        await expect(unloaded).toHaveCount(1);
        await expect(unloaded).toContainText("MOCKCARD");
        await expect(unloaded.locator(".folder-source__load")).toBeVisible();
        // Not loaded - nothing here can claim the trips on screen.
        await expect(unloaded.locator(".folder-source__remember")).toHaveCount(0);

        // Forgetting from the row removes it without touching the loaded trips.
        await unloaded.locator(".folder-source__menu").click();
        await unloaded.locator(".folder-source__popup").getByRole("button", { name: "Forget this folder" }).click();
        await expect(page.locator(".folder-source--unloaded")).toHaveCount(0);
        await expect(page.locator("li.trip:not(.unindexed-note)").first()).toBeVisible();
    });

    test("the first annotation change requires an explicit storage choice", async ({ page }) => {
        await page.locator("#landing-cta").click();
        const card = page.locator("li.trip:not(.unindexed-note)").first();
        await expect(card).toBeVisible({ timeout: 30_000 });

        // The edit lands locally first, then the non-dismissible decision asks
        // whether one file should also receive it.
        await card.locator(".trip-fav").click();
        await expect(card.locator(".trip-fav.is-on")).toBeVisible();
        const storageModal = page.locator("#notes-storage-modal");
        await expect(storageModal).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(storageModal, "Escape must not skip the storage decision").toBeVisible();
        await expect(page.locator(".dc-toast")).toHaveCount(0);

        await storageModal.getByRole("button", { name: "Only in this browser" }).click();
        await expect(storageModal).toBeHidden();
        await expect
            .poll(() => storedAnnotationFolderIds(page), { message: "the local edit remains stored" })
            .toEqual([""]);

        // The app-wide browser choice is remembered; another write does not nag.
        await card.locator(".trip-fav").click();
        await expect(card.locator(".trip-fav.is-on")).toHaveCount(0);
        await expect(storageModal).toBeHidden();
    });
});

/** folderId of every stored annotation, read straight out of IndexedDB. */
async function storedAnnotationFolderIds(page: Page): Promise<string[]> {
    return page.evaluate(
        () =>
            new Promise<string[]>((resolve, reject) => {
                const request = indexedDB.open("dashcamigo");
                request.onerror = () => reject(request.error);
                request.onsuccess = () => {
                    const db = request.result;
                    const all = db.transaction("annotations").objectStore("annotations").getAll();
                    all.onerror = () => reject(all.error);
                    all.onsuccess = () => {
                        resolve((all.result as { folderId: string }[]).map((record) => record.folderId));
                        db.close();
                    };
                };
            }),
    );
}
