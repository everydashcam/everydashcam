import { readFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import { expect, gotoApp, presetLocalStorage, test } from "./_fixtures.js";

const BACKUP = {
    app: "dashcamigo",
    format: "annotations",
    version: 2,
    savedAt: 1_700_000_000_100,
    annotations: [
        {
            id: "durability-trip",
            kind: "tripMeta",
            updatedAt: 1_700_000_000_001,
            deleted: false,
            anchor: {
                fileIdentityKey: ["trip.mp4", 1234, 1_700_000_000_000].join("\0"),
                startUtc: 1_700_000_000_000,
            },
            name: "A restored trip",
            note: "This note must survive a reload",
            isFavorite: true,
        },
        {
            id: "durability-marker",
            kind: "marker",
            updatedAt: 1_700_000_000_002,
            deleted: false,
            utc: 1_700_000_012_000,
            text: "A restored marker",
        },
    ],
};

const BACKUP_FILE = {
    name: "saved-notes.dashcamigo",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(BACKUP)),
};

const RESTORED_MESSAGE = "Restored 2 saved entries from the notes backup.";

async function controlAnnotationWrites(page: Page, mode: "hold" | "abort"): Promise<void> {
    await page.evaluate((mode) => {
        const root = document.documentElement;
        root.dataset.annotationWriteMode = mode;
        root.dataset.annotationReadCycles = "0";
        root.dataset.annotationAborts = "0";
        const nativeTransaction = IDBDatabase.prototype.transaction;
        IDBDatabase.prototype.transaction = function (storeNames, transactionMode, options) {
            const transaction = nativeTransaction.call(this, storeNames, transactionMode, options);
            if (
                this.name !== "dashcamigo" ||
                transactionMode !== "readwrite" ||
                !transaction.objectStoreNames.contains("annotations")
            ) {
                return transaction;
            }
            if (root.dataset.annotationWriteMode === "abort") {
                transaction.addEventListener("abort", () => {
                    root.dataset.annotationAborts = String(Number(root.dataset.annotationAborts) + 1);
                });
                const request = transaction.objectStore("annotations").get("missing-durability-test-record");
                request.onsuccess = () => transaction.abort();
            } else if (root.dataset.annotationWriteMode === "hold") {
                // Native requests keep the transaction active while the app's
                // puts finish; releasing the loop allows a real commit.
                const keepOpen = () => {
                    if (root.dataset.annotationWriteMode !== "hold") return;
                    const request = transaction.objectStore("annotations").get("missing-durability-test-record");
                    request.onsuccess = () => {
                        root.dataset.annotationReadCycles = String(Number(root.dataset.annotationReadCycles) + 1);
                        keepOpen();
                    };
                };
                keepOpen();
            }
            return transaction;
        };
    }, mode);
}

async function expectBackupAfterReload(page: Page): Promise<void> {
    await page.reload();
    await page.locator("#settings-btn").click();
    const pendingDownload = page.waitForEvent("download");
    await page.locator("#settings-notes-export-btn").click();
    const downloaded = await pendingDownload;
    const path = await downloaded.path();
    expect(path).not.toBeNull();
    const saved = JSON.parse(readFileSync(path!, "utf8"));
    expect(saved).toMatchObject({ app: "everydashcam", format: "annotations", version: 3 });
    expect(saved.annotations).toHaveLength(BACKUP.annotations.length);
    expect(saved.annotations).toEqual(expect.arrayContaining(BACKUP.annotations));
}

test.beforeEach(async ({ page }) => {
    await presetLocalStorage(page, { lang: "en" });
    await gotoApp(page);
    await page.locator("#settings-btn").click();
});

test("waits for the notes transaction to commit before reporting a successful import", async ({ page }) => {
    await controlAnnotationWrites(page, "hold");
    await page.locator("#settings-notes-import-input").setInputFiles(BACKUP_FILE);
    await expect
        .poll(() => page.evaluate(() => Number(document.documentElement.dataset.annotationReadCycles)))
        .toBeGreaterThan(10);
    await expect(page.locator("#settings-notes-import-btn")).toBeDisabled();
    await expect(page.locator("#toast-container").getByText(RESTORED_MESSAGE, { exact: true })).not.toBeVisible();

    await page.evaluate(() => {
        document.documentElement.dataset.annotationWriteMode = "allow";
    });
    await expect(page.locator("#toast-container").getByText(RESTORED_MESSAGE, { exact: true })).toBeVisible();
    await expect(page.locator("#settings-notes-import-btn")).toBeEnabled();
    await expectBackupAfterReload(page);
});

test("reports failed writes and durably retries the same backup in the same tab", async ({ page }) => {
    await controlAnnotationWrites(page, "abort");
    await page.locator("#settings-notes-import-input").setInputFiles(BACKUP_FILE);
    await expect
        .poll(() => page.evaluate(() => Number(document.documentElement.dataset.annotationAborts)))
        .toBeGreaterThan(0);
    await expect(page.locator("#settings-notes-import-btn")).toBeEnabled();
    await expect(
        page.locator("#toast-container").getByText("This browser couldn't save your latest changes.", { exact: false }),
    ).toBeVisible();
    await expect(page.locator("#toast-container").getByText(RESTORED_MESSAGE, { exact: true })).not.toBeVisible();

    await page.evaluate(() => {
        document.documentElement.dataset.annotationWriteMode = "allow";
    });
    await page.locator("#settings-notes-import-input").setInputFiles(BACKUP_FILE);
    await expect(page.locator("#toast-container").getByText(RESTORED_MESSAGE, { exact: true })).toBeVisible();
    await expectBackupAfterReload(page);
});
