import { checkAudioExport } from "../e2e/_audio-export.js";
import { canEncodeHighProfileH264, installInMemoryExportCapture, presetLocalStorage } from "../e2e/_fixtures.js";
import { openPortable, test } from "./_fixtures.js";

for (const source of ["aac-main", "pcm-u8"] as const) {
    test(`exports ${source} audio safely from a file URL`, async ({ page }, info) => {
        await presetLocalStorage(page);
        await installInMemoryExportCapture(page);
        await openPortable(page, info.outputPath("audio-export"));
        await checkAudioExport(page, source);
    });
}

test("changing export quality preserves Opus audio with decoder pre-skip from a file URL", async ({ page }, info) => {
    await presetLocalStorage(page);
    await installInMemoryExportCapture(page);
    await openPortable(page, info.outputPath("audio-export"));
    test.skip(!(await canEncodeHighProfileH264(page)), "WebCodecs High-profile H.264 encode unavailable");
    await checkAudioExport(page, "opus", true);
});
