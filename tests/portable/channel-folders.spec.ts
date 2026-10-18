import { checkFolderMulticam } from "../e2e/_channel-folders.js";
import { presetLocalStorage } from "../e2e/_fixtures.js";
import { openPortable, test } from "./_fixtures.js";

test("folder channels form a multicamera trip per card from a file URL", async ({ page }, info) => {
    await presetLocalStorage(page);
    await openPortable(page, info.outputPath("viewer"));
    await checkFolderMulticam(page, info.outputPath("cards"));
});
