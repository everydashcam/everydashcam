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
});
