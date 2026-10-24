import { readFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import { DESKTOP, MOBILE, expect, gotoApp, loadTrip, presetLocalStorage, shot, test } from "./_fixtures.js";
import { checkFeedbackStructureReport, writeFeedbackStructureCard } from "./_feedback-structure.js";

async function captureMailto(page: Page): Promise<void> {
    await page.addInitScript(() => {
        window.open = (url?: string | URL) => {
            if (typeof url !== "string" || !url.startsWith("mailto:")) return null;
            (window as unknown as { __mailto: string }).__mailto = url;
            return { closed: false } as Window;
        };
    });
}

async function openContextFeedback(page: Page, preset: "gps" | "cameras", recognitionIssue?: string): Promise<void> {
    await page.evaluate(
        ({ preset, recognitionIssue }) => {
            const button = document.createElement("button");
            button.className = "feedback-link";
            button.dataset.feedbackPreset = preset;
            if (recognitionIssue) button.dataset.recognitionIssue = recognitionIssue;
            document.body.append(button);
            button.click();
            button.remove();
        },
        { preset, recognitionIssue },
    );
    await expect(page.locator("#feedback-modal")).toBeVisible();
}

test.describe("contextual feedback", () => {
    test.beforeEach(async ({ page }) => {
        await presetLocalStorage(page);
        await page.setViewportSize(DESKTOP);
        await captureMailto(page);
    });

    test("folder input reports excluded paths while loading hidden GPS telemetry", async ({ page }, info) => {
        const directory = info.outputPath("card");
        writeFeedbackStructureCard(directory);
        await gotoApp(page, "en");
        await page.locator("#folder-input").setInputFiles(directory);
        await checkFeedbackStructureReport(page);
    });

    test("GPS help offers immediate email and an optional report without asking for recordings first", async ({
        page,
    }) => {
        await gotoApp(page, "en");
        await openContextFeedback(page, "gps");
        await expect(page.locator("#feedback-step-recordings")).toBeHidden();
        await expect(page.locator("#feedback-step-report")).toBeVisible();
        await expect(page.locator("#feedback-context-hint")).toContainText("GPS data may be stored beside your videos");
        await expect(page.locator("#feedback-primary")).toBeFocused();
        await expect(page.locator("#feedback-context-email")).toHaveText("feedback@everydashcam.app");
        await expect(page.locator("#feedback-context-email")).toHaveAttribute(
            "href",
            /^mailto:feedback@everydashcam.app\?subject=/,
        );
        await page.locator("#feedback-report-mail").click();
        const mailto = await page.evaluate(() => (window as unknown as { __mailto: string }).__mailto);
        const decoded = decodeURIComponent(mailto);
        expect(decoded).toContain("[everydashcam] Missing GPS");
        expect(decoded).toContain("Dashcam model:");
        expect(decoded).toContain("Expected number of cameras:");
        expect(decoded).toContain("What I expected to see (GPS, cameras):");
        expect(decoded).toContain("Recordings link:");
        expect(decoded).not.toContain("Attach this file:");
        await page.locator("#feedback-context-recordings summary").click();
        await expect(page.locator("#feedback-context-samples")).toContainText("every file stored beside them");
        await expect(page.locator("#feedback-modal")).toHaveCSS("opacity", "1");
        await shot(page, "feedback-gps-report-en");

        await page.locator("#feedback-cancel").click();
        await page.locator("#feedback-btn").click();
        await expect(page.locator("#feedback-step-recordings")).toBeVisible();
        await page.locator("#feedback-recordings-skip").click();
        await expect(page.locator("#feedback-report-mail")).toBeHidden();
        await expect(page.locator("#feedback-context-contact")).toBeHidden();
        await expect(page.locator("#feedback-context-recordings")).toBeHidden();
    });

    test("camera help fits a narrow Russian screen and asks for untouched original samples", async ({ page }) => {
        await page.setViewportSize(MOBILE);
        await gotoApp(page, "ru");
        await openContextFeedback(page, "cameras");
        await expect(page.locator("#feedback-context-hint")).toContainText("Открой всю папку карты памяти");
        await expect(page.locator("#feedback-context-email")).toBeVisible();
        await page.locator("#feedback-context-recordings summary").click();
        await expect(page.locator("#feedback-context-samples")).toContainText("одного и того же момента со всех камер");
        await expect(page.locator("#feedback-context-samples")).toContainText("не переименовывай файлы");
        const card = page.locator(".feedback-modal-card");
        expect(await card.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
        await expect(page.locator("#feedback-modal")).toHaveCSS("opacity", "1");
        await shot(page, "feedback-cameras-report-ru-mobile");
        await page.locator("#feedback-context-email").click();
        const mailto = await page.evaluate(() => (window as unknown as { __mailto: string }).__mailto);
        expect(decodeURIComponent(mailto)).toContain("[everydashcam] Не хватает камер");
        expect(decodeURIComponent(mailto)).toContain("Ожидаемое количество камер:");
    });

    test("large recognition reports keep email concise and preserve the complete file list in the download", async ({
        page,
    }) => {
        await gotoApp(page, "en");
        const files = Array.from({ length: 600 }, (_, index) => `recordings/front/clip-${index}.MP4`);
        const finalFile = "recordings/rear/final-affected-recording.MP4";
        const issue = `gps extraction failed:\n${files.join("\n")}\n\nrecognized cameras remain unpaired:\n${finalFile}`;
        await openContextFeedback(page, "gps", issue);
        await page.locator("#feedback-report-mail").click();
        const mailto = await page.evaluate(() => (window as unknown as { __mailto: string }).__mailto);
        expect(mailto.length).toBeLessThan(2_000);
        const decoded = decodeURIComponent(mailto);
        expect(decoded).toContain("gps extraction failed:");
        expect(decoded).toContain("recognized cameras remain unpaired:");
        expect(decoded).not.toContain(files[0]);
        expect(decoded).not.toContain(finalFile);

        const downloadPromise = page.waitForEvent("download");
        await page.locator("#feedback-primary").click();
        const report = readFileSync(await (await downloadPromise).path(), "utf8");
        expect(report).toContain(issue);
        expect(report).toContain(finalFile);
    });

    test("report and email retain the file, trip and recognition reason captured when help opens", async ({ page }) => {
        await gotoApp(page, "en");
        await loadTrip(page);
        const original = await page.evaluate(() => {
            const { state, dom } = window.__everydashcam;
            dom.player.pause();
            const active = state.active!;
            const frame = state.trips[active.trip]!.frames[active.frame]!;
            return {
                file: frame.channels.front!.file.name,
                trip: active.trip,
                frame: active.frame,
            };
        });
        await openContextFeedback(page, "gps", "embedded GPS reader failed for the open trip");
        await page.evaluate(() => {
            const { state } = window.__everydashcam;
            state.active = null;
            state.lastIngestFiles = [];
            state.lastIngestStructure = [];
        });

        await page.locator("#feedback-report-mail").click();
        const initialMailto = await page.evaluate(() => (window as unknown as { __mailto: string }).__mailto);
        expect(decodeURIComponent(initialMailto)).toContain(`File: ${original.file}`);
        expect(decodeURIComponent(initialMailto)).toContain("embedded GPS reader failed for the open trip");

        const downloadPromise = page.waitForEvent("download");
        await page.locator("#feedback-primary").click();
        const download = await downloadPromise;
        const report = readFileSync(await download.path(), "utf8");
        expect(report).toContain("startup capabilities:");
        expect(report).toContain("== graphics ==\ncontext: webgl2");
        expect(report).toMatch(/\nrenderer: (?!unavailable).+/);
        expect(report).toContain("Video encoder implementation and driver: not exposed by WebCodecs.");
        expect(report).toContain("== recognition issue ==\nembedded GPS reader failed for the open trip");
        expect(report).toContain(`File: ${original.file}`);
        expect(report).toContain(`active: trip ${original.trip} / frame ${original.frame}`);
        expect(report).toContain("everydashcam camera report");
        await page.locator("#feedback-post-download-mail").click();
        const mailto = await page.evaluate(() => (window as unknown as { __mailto: string }).__mailto);
        expect(decodeURIComponent(mailto)).toContain(`File: ${original.file}`);
        expect(decodeURIComponent(mailto)).toContain(download.suggestedFilename());
    });
});
