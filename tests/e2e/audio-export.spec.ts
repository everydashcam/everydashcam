import { checkAudioExport } from "./_audio-export.js";
import {
    canEncodeHighProfileH264,
    gotoApp,
    installInMemoryExportCapture,
    presetLocalStorage,
    test,
} from "./_fixtures.js";

test.use({ viewerMap: "route-only" });

for (const locale of ["en", "ru"] as const) {
    test(`unsupported AAC keeps the video and explains missing audio in ${locale}`, async ({ page }) => {
        await presetLocalStorage(page);
        await installInMemoryExportCapture(page);
        await gotoApp(page, locale);
        await checkAudioExport(page, "aac-main", false, locale);
        await page.screenshot({ path: test.info().outputPath("audio-warning.png") });
    });
}

test("unsupported AAC also keeps the video when changing export quality", async ({ page }) => {
    await presetLocalStorage(page);
    await installInMemoryExportCapture(page);
    await gotoApp(page, "en");
    test.skip(!(await canEncodeHighProfileH264(page)), "WebCodecs High-profile H.264 encode unavailable");
    await checkAudioExport(page, "aac-main", true);
});

test("original quality re-encodes readable audio while copying video", { tag: "@golden-export" }, async ({ page }) => {
    await presetLocalStorage(page);
    await installInMemoryExportCapture(page);
    await gotoApp(page, "en");
    await checkAudioExport(page, "pcm-u8");
});

test("changing export quality preserves Opus audio with decoder pre-skip", async ({ page }) => {
    await presetLocalStorage(page);
    await installInMemoryExportCapture(page);
    await gotoApp(page, "en");
    test.skip(!(await canEncodeHighProfileH264(page)), "WebCodecs High-profile H.264 encode unavailable");
    await checkAudioExport(page, "opus", true);
});
