import { checkPairedMediaBlur, checkPairedMediaTail } from "../e2e/_paired-media-tail.js";
import { canEncodeHighProfileH264, installExportCapture, presetLocalStorage } from "../e2e/_fixtures.js";
import { openPortable, test } from "./_fixtures.js";

test.use({ timezoneId: "UTC" });

test("plays and seeks the paired media tail from a file URL", async ({ page }, info) => {
    await presetLocalStorage(page);
    await openPortable(page, info.outputPath("paired-tail"));
    await checkPairedMediaTail(page);
});

test("previews and exports paired rear masks through the final interval from a file URL", async ({ page }, info) => {
    test.setTimeout(120_000);
    await presetLocalStorage(page);
    await installExportCapture(page);
    await openPortable(page, info.outputPath("paired-blur"));
    test.skip(!(await canEncodeHighProfileH264(page)), "WebCodecs High-profile H.264 encode unavailable");
    await checkPairedMediaBlur(page);
});
