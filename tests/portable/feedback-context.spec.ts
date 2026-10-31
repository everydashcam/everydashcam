import { expect } from "@playwright/test";
import { checkFeedbackStructureReport, writeFeedbackStructureCard } from "../e2e/_feedback-structure.js";
import { presetLocalStorage } from "../e2e/_fixtures.js";
import { openPortable, test } from "./_fixtures.js";

test("file-origin feedback includes excluded paths and keeps hidden GPS telemetry", async ({ page }, info) => {
    const directory = info.outputPath("card");
    writeFeedbackStructureCard(directory);
    await presetLocalStorage(page);
    await openPortable(page, info.outputPath("viewer"));
    await page.locator("#folder-input").setInputFiles(directory);
    await checkFeedbackStructureReport(page);
    await page.evaluate(() => {
        window.open = (url?: string | URL) => {
            if (typeof url !== "string" || !url.startsWith("mailto:")) return null;
            (window as unknown as { __mailto: string }).__mailto = url;
            return { closed: false } as Window;
        };
    });
    await page.locator("#feedback-post-download-mail").click();
    const mailto = await page.evaluate(() => (window as unknown as { __mailto: string }).__mailto);
    expect(new URL(mailto).searchParams.get("body")).toMatch(
        /^DON'T FORGET TO ATTACH THE DOWNLOADED REPORT!\neverydashcam-report-[^\n]+\.txt\nIt's in your Downloads folder\.$/,
    );
});
