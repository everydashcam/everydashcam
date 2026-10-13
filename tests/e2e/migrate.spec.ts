import { readFileSync } from "node:fs";
import type { Download, Page } from "@playwright/test";
import { migrationText } from "../../src/migrate/i18n.js";
import { parseSidecarPayload } from "../../src/persist/annotations.js";
import type { AnnotationRecord } from "../../src/persist/types.js";
import { expect, presetLocalStorage, test } from "./_fixtures.js";

const RECORDS: AnnotationRecord[] = [
    {
        id: "trip-one",
        folderId: "folder-one",
        kind: "tripMeta",
        updatedAt: 1_700_000_000_001,
        deleted: false,
        anchor: { fileIdentityKey: "first.mp4:1234:1700000000000", startUtc: 1_700_000_000_000 },
        name: "A saved trip",
        note: "Keep this note",
        isFavorite: true,
    },
    {
        id: "marker-two",
        folderId: "folder-two",
        kind: "marker",
        updatedAt: 1_700_000_000_002,
        deleted: false,
        utc: 1_700_000_012_000,
        text: "A marker from another folder",
        anchor: { fileIdentityKey: "second.mp4:1234:1700000000000", startUtc: 1_700_000_000_000, offsetSec: 12 },
    },
    {
        id: "deleted-marker",
        folderId: "forgotten-folder",
        kind: "marker",
        updatedAt: 1_700_000_000_003,
        deleted: true,
        utc: 1_700_000_000_000,
        text: "Deleted marker",
    },
];

async function seedDatabase(page: Page, records: unknown[], version = 1): Promise<void> {
    await page.goto("/migrate/?lang=en");
    await expect(page.locator("#migration-status")).toHaveAttribute("data-state", "empty");
    await page.evaluate(
        async ({ records, version }) => {
            await new Promise<void>((resolve, reject) => {
                const request = indexedDB.open("dashcamigo", version);
                request.onerror = () => reject(request.error);
                request.onupgradeneeded = () => {
                    const db = request.result;
                    db.createObjectStore("annotations", { keyPath: "id" });
                    db.createObjectStore("meta");
                };
                request.onsuccess = () => {
                    const db = request.result;
                    const transaction = db.transaction(["annotations", "meta"], "readwrite");
                    for (const record of records) transaction.objectStore("annotations").put(record);
                    transaction.objectStore("meta").put("keep this value", "unrelated");
                    transaction.oncomplete = () => {
                        db.close();
                        resolve();
                    };
                    transaction.onabort = () => reject(transaction.error);
                };
            });
        },
        { records, version },
    );
}

async function databaseSnapshot(page: Page): Promise<unknown> {
    return page.evaluate(
        async () =>
            new Promise((resolve, reject) => {
                const request = indexedDB.open("dashcamigo");
                request.onerror = () => reject(request.error);
                request.onsuccess = () => {
                    const db = request.result;
                    const stores = [...db.objectStoreNames];
                    const transaction = db.transaction(stores, "readonly");
                    const annotations = transaction.objectStore("annotations").getAll();
                    const meta = transaction.objectStore("meta").getAll();
                    transaction.oncomplete = () => {
                        resolve({ version: db.version, stores, annotations: annotations.result, meta: meta.result });
                        db.close();
                    };
                    transaction.onabort = () => reject(transaction.error);
                };
            }),
    );
}

async function downloadText(download: Download): Promise<string> {
    const path = await download.path();
    expect(path).not.toBeNull();
    return readFileSync(path!, "utf8");
}

async function exportNotes(page: Page): Promise<string> {
    await expect(page.locator("#migration-download")).toBeVisible();
    const pending = page.waitForEvent("download");
    await page.locator("#migration-download").click();
    const download = await pending;
    expect(download.suggestedFilename()).toMatch(/^everydashcam-notes-\d{4}-\d{2}-\d{2}\.everydashcam$/);
    return downloadText(download);
}

test.describe("standalone notes recovery", () => {
    for (const version of [1, 4, 17]) {
        test(`exports every folder and tombstones without changing schema version ${version}`, async ({ page }) => {
            await seedDatabase(page, RECORDS, version);
            const before = await databaseSnapshot(page);
            const requests: string[] = [];
            page.on("request", (request) => requests.push(new URL(request.url()).pathname));
            await page.reload();
            await expect(page.locator("#migration-continue")).toBeHidden();
            const text = await exportNotes(page);
            await expect(page.locator("#migration-continue")).toBeVisible();
            await expect(page.locator("#migration-continue")).toHaveAttribute(
                "href",
                "https://everydashcam.app/en/#restore-notes",
            );
            const payload = JSON.parse(text);
            expect(payload).toMatchObject({ app: "everydashcam", format: "annotations", version: 3 });
            expect(payload.annotations).toEqual(
                expect.arrayContaining(RECORDS.map(({ folderId: _folder, ...record }) => record)),
            );
            expect(payload.annotations).toHaveLength(RECORDS.length);
            expect(parseSidecarPayload(text)?.rejectedEntries).toBe(0);
            expect(await databaseSnapshot(page)).toEqual(before);
            expect(requests.length).toBeGreaterThanOrEqual(3);
            expect(
                requests.every(
                    (path) =>
                        path.startsWith("/migrate/") ||
                        path === "/fonts.css" ||
                        /^\/fonts\/[a-z0-9-]+\.woff2$/.test(path),
                ),
                "recovery loads only its own assets and shared fonts",
            ).toBe(true);
            await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", "noindex, nofollow");
            expect(await page.evaluate(() => "__everydashcam" in window), "the viewer is not initialized").toBe(false);
        });
    }

    test("leaves a fresh profile without a database and translates the empty state", async ({ page }) => {
        await page.goto("/migrate/?lang=en");
        await expect(page.locator("#migration-status")).toHaveAttribute("data-state", "empty");
        await expect(page.locator("#migration-status")).toContainText("No saved notes");
        await expect(page.locator("#migration-download")).toBeHidden();
        expect(await page.evaluate(() => indexedDB.databases())).toEqual([]);
        await page.locator("#migration-language").selectOption("ru");
        await expect(page.locator("html")).toHaveAttribute("lang", "ru");
        await expect(page.locator("#migration-status")).toContainText("нет сохранённых пометок");
        expect(await page.evaluate(() => localStorage.getItem("dashcamigo:lang"))).toBeNull();
    });

    test("offers every viewer language without changing saved preferences", async ({ page }) => {
        await page.addInitScript(() => localStorage.setItem("dashcamigo:lang", "fr"));
        await page.goto("/migrate/");
        await expect(page.locator("html")).toHaveAttribute("lang", "fr");
        await expect(page.locator("#migration-language")).toHaveValue("fr");
        await expect(page.locator("#migration-status")).toHaveAttribute("data-state", "empty");
        for (const lang of ["de", "en", "es", "fr", "ja", "ko", "pl", "pt", "ru", "zh"] as const) {
            await page.locator("#migration-language").selectOption(lang);
            await expect(page.locator("html")).toHaveAttribute("lang", lang);
            await expect(page.locator("h1")).toHaveText(migrationText(lang, "title"));
            await expect(page.locator("#migration-status")).toHaveText(migrationText(lang, "empty"));
            await expect(page.locator("footer")).toHaveText(migrationText(lang, "privacy"));
        }
        expect(await page.evaluate(() => localStorage.getItem("dashcamigo:lang"))).toBe("fr");
        expect(await page.evaluate(() => indexedDB.databases())).toEqual([]);
        await page.goto("/migrate/?lang=ja");
        await expect(page.locator("html")).toHaveAttribute("lang", "ja");
        await expect(page.locator("#migration-language")).toHaveValue("ja");
    });

    test("reports an existing empty store without changing it", async ({ page }) => {
        await seedDatabase(page, []);
        const before = await databaseSnapshot(page);
        await page.reload();
        await expect(page.locator("#migration-status")).toHaveAttribute("data-state", "empty");
        expect(await databaseSnapshot(page)).toEqual(before);
    });

    test("reports storage access failure separately from empty notes", async ({ page }) => {
        await page.addInitScript(() => {
            const databases = indexedDB.databases.bind(indexedDB);
            let hasFailed = false;
            indexedDB.databases = () => {
                if (hasFailed) return databases();
                hasFailed = true;
                return Promise.reject(new DOMException("storage blocked", "SecurityError"));
            };
        });
        await page.goto("/migrate/?lang=en");
        await expect(page.locator("#migration-status")).toHaveAttribute("data-state", "error");
        await expect(page.locator("#migration-status")).toContainText("Couldn't read your notes");
        await expect(page.locator("#migration-status")).not.toContainText("SecurityError");
        await expect(page.locator("#migration-retry")).toBeVisible();
        await expect(page.locator("#migration-download")).toBeHidden();
        await page.locator("#migration-retry").click();
        await expect(page.locator("#migration-status")).toHaveAttribute("data-state", "empty");
        await expect(page.locator("#migration-retry")).toBeHidden();
        expect(await page.evaluate(() => indexedDB.databases())).toEqual([]);
    });

    test("reports a missing notes store without repairing the database", async ({ page }) => {
        await page.goto("/migrate/?lang=en");
        await expect(page.locator("#migration-status")).toHaveAttribute("data-state", "empty");
        await page.evaluate(async () => {
            await new Promise<void>((resolve, reject) => {
                const request = indexedDB.open("dashcamigo", 7);
                request.onerror = () => reject(request.error);
                request.onupgradeneeded = () => request.result.createObjectStore("unrelated");
                request.onsuccess = () => {
                    request.result.close();
                    resolve();
                };
            });
        });
        await page.reload();
        await expect(page.locator("#migration-status")).toHaveAttribute("data-state", "error");
        await expect(page.locator("#migration-download")).toBeHidden();
        expect(await page.evaluate(() => indexedDB.databases())).toEqual([{ name: "dashcamigo", version: 7 }]);
        expect(
            await page.evaluate(
                async () =>
                    new Promise<string[]>((resolve, reject) => {
                        const request = indexedDB.open("dashcamigo");
                        request.onerror = () => reject(request.error);
                        request.onsuccess = () => {
                            resolve([...request.result.objectStoreNames]);
                            request.result.close();
                        };
                    }),
            ),
        ).toEqual(["unrelated"]);
    });

    test("keeps unsupported records intact and refuses a partial backup", async ({ page }) => {
        await seedDatabase(page, [...RECORDS, { id: "future-record", kind: "unknown" }]);
        const before = await databaseSnapshot(page);
        await page.reload();
        await expect(page.locator("#migration-status")).toHaveAttribute("data-state", "error");
        await expect(page.locator("#migration-download")).toBeHidden();
        expect(await databaseSnapshot(page)).toEqual(before);
    });

    test("aborts database creation if the existing database disappears before open", async ({ page }) => {
        await seedDatabase(page, RECORDS);
        await page.addInitScript(() => {
            const databases = indexedDB.databases.bind(indexedDB);
            indexedDB.databases = async () => {
                const entries = await databases();
                await new Promise<void>((resolve, reject) => {
                    const request = indexedDB.deleteDatabase("dashcamigo");
                    request.onsuccess = () => resolve();
                    request.onerror = () => reject(request.error);
                });
                return entries;
            };
        });
        await page.reload();
        await expect(page.locator("#migration-status")).toHaveAttribute("data-state", "empty");
        expect(await page.evaluate(() => IDBFactory.prototype.databases.call(indexedDB))).toEqual([]);
    });

    test("restores an exported backup in a fresh profile and keeps one copy after reload and repeated import", async ({
        page,
        browser,
    }) => {
        await seedDatabase(page, RECORDS);
        await page.reload();
        const text = await exportNotes(page);
        const context = await browser.newContext({ serviceWorkers: "block" });
        try {
            const restored = await context.newPage();
            const errors: string[] = [];
            restored.on("pageerror", (error) => errors.push(error.message));
            await presetLocalStorage(restored, { lang: "en" });
            const origin = new URL(page.url()).origin;
            await context.route(/^https?:\/\//, (route) =>
                new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
            );
            const file = {
                name: "everydashcam-notes.everydashcam",
                mimeType: "application/json",
                buffer: Buffer.from(text),
            };
            for (let attempt = 0; attempt < 2; attempt++) {
                await restored.goto(`${origin}/en/${attempt === 0 ? "#restore-notes" : ""}`);
                if (attempt === 0) {
                    await expect(restored.locator("#migration-restore-modal")).toBeVisible();
                    await expect(restored.locator("#migration-restore-choose")).toBeFocused();
                    await expect(restored.locator("#settings-modal")).toBeHidden();
                    await expect(restored).toHaveURL(`${origin}/en/`);
                    await restored.locator("#migration-restore-input").setInputFiles(file);
                    await expect(restored.locator("#migration-restore-modal")).toBeHidden();
                } else {
                    await restored.locator("#settings-btn").click();
                    await restored.locator("#settings-notes-import-input").setInputFiles(file);
                }
                await expect(
                    restored.locator("#toast-container").getByText("Restored 3 saved entries from the notes backup."),
                ).toBeVisible();
                await restored.reload();
                await restored.locator("#settings-btn").click();
                const pending = restored.waitForEvent("download");
                await restored.locator("#settings-notes-export-btn").click();
                const after = parseSidecarPayload(await downloadText(await pending));
                expect(after?.records).toHaveLength(RECORDS.length);
                expect(after?.records).toEqual(expect.arrayContaining(parseSidecarPayload(text)!.records));
            }
            expect(errors).toEqual([]);
        } finally {
            await context.close();
        }
    });
});

test.describe("recovery with hosting-injected analytics", () => {
    test("blocks the Pages beacon while keeping notes export available", async ({ browser, baseURL }) => {
        if (!baseURL) throw new Error("missing test base url");
        const context = await browser.newContext({ baseURL, serviceWorkers: "block" });
        try {
            const page = await context.newPage();
            const errors: string[] = [];
            page.on("pageerror", (error) => errors.push(error.message));
            page.on("console", (message) => {
                if (message.type() !== "error") return;
                if (
                    /Loading the script 'https:\/\/static\.cloudflareinsights\.com\/beacon\.min\.js' violates/.test(
                        message.text(),
                    )
                )
                    return;
                errors.push(message.text());
            });
            const externalRequests: string[] = [];
            await context.route(/^https?:\/\//, (route) => {
                if (new URL(route.request().url()).origin === new URL(baseURL).origin) return route.continue();
                externalRequests.push(route.request().url());
                return route.abort();
            });
            await seedDatabase(page, RECORDS);
            const before = await databaseSnapshot(page);
            await page.route("**/migrate/", async (route) => {
                const response = await route.fetch();
                const html = await response.text();
                const beacon = `<script defer src="https://static.cloudflareinsights.com/beacon.min.js" data-cf-beacon='{"token":"migration-regression"}'></script>`;
                await route.fulfill({ response, body: html.replace("</body>", `${beacon}</body>`) });
            });
            await page.addInitScript(() => {
                document.addEventListener("securitypolicyviolation", (event) => {
                    document.documentElement.dataset.blockedScript = event.blockedURI;
                });
            });
            await page.goto("/migrate/");
            await expect(page.locator("html")).toHaveAttribute(
                "data-blocked-script",
                "https://static.cloudflareinsights.com/beacon.min.js",
            );
            expect(parseSidecarPayload(await exportNotes(page))?.records).toHaveLength(RECORDS.length);
            expect(await databaseSnapshot(page)).toEqual(before);
            // Chromium reports CSP-blocked request events, but never sends them to the network route.
            expect(externalRequests).toEqual([]);
            expect(errors).toEqual([]);
        } finally {
            await context.close();
        }
    });
});

test.describe("recovery through an installed pre-migration worker", () => {
    test.use({ serviceWorkers: "allow" });

    test("loads the new recovery page without replacing the old worker or changing notes", async ({
        page,
        context,
    }) => {
        // Use the real worker with a manifest from before /migrate/ existed.
        // The old shell has a revision marker just like a published app build.
        const revision = "0123456789abcdef";
        const shell = `<html><head><meta name="dc-precache-revision" content="${revision}"></head><body>Old app shell</body></html>`;
        const manifest = [{ url: "/en/", revision, htmlRevision: revision }];
        const worker = readFileSync("public/sw.js", "utf8").replace(
            "const PRECACHE_MANIFEST = []; // __DC_PRECACHE_MANIFEST__",
            `const PRECACHE_MANIFEST = ${JSON.stringify(manifest)};`,
        );
        await context.route("**/sw.js", (route) => route.fulfill({ contentType: "text/javascript", body: worker }));
        await context.route("**/en/", (route) => route.fulfill({ contentType: "text/html", body: shell }));
        await seedDatabase(page, RECORDS, 1);
        const before = await databaseSnapshot(page);
        await page.evaluate(async () => {
            await navigator.serviceWorker.register("/sw.js");
            await navigator.serviceWorker.ready;
        });
        await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
        const response = await page.reload();
        expect(response?.fromServiceWorker()).toBe(true);
        expect(parseSidecarPayload(await exportNotes(page))?.records).toHaveLength(RECORDS.length);
        expect(await databaseSnapshot(page)).toEqual(before);
        expect(
            await page.evaluate(async () => {
                const registration = await navigator.serviceWorker.getRegistration();
                return { active: registration?.active?.scriptURL, waiting: Boolean(registration?.waiting) };
            }),
        ).toEqual({ active: new URL("/sw.js", page.url()).href, waiting: false });
    });
});
