import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
    check70maiDatedGps,
    check70maiDatedGpsIncremental,
    check70maiHiddenGps,
    check70maiMissingGpsOpenCard,
    check70maiMissingGpsPicker,
    check70maiSessionGps,
} from "./_70mai-session-gps.js";
import {
    DESKTOP,
    expect,
    gotoApp,
    presetLocalStorage,
    REPO_ROOT,
    SAMPLE_70MAI,
    SAMPLE_NOGPS,
    test,
} from "./_fixtures.js";

test.use({ viewport: DESKTOP, viewerMap: "route-only", timezoneId: "Europe/Moscow" });

for (const locale of ["en", "ru"] as const) {
    test(`adds a missing 70mai GPS file through the picker (${locale})`, async ({ page }, info) => {
        if (locale === "ru") await page.setViewportSize({ width: 320, height: 640 });
        await presetLocalStorage(page, { theme: locale === "ru" ? "light" : "dark" });
        await gotoApp(page, locale);
        await check70maiMissingGpsPicker(page, info.outputPath("missing-gps.png"));
    });
}

test("reopens a full 70mai card to bind an unnamed GPS log without duplicating the video", async ({ page }, info) => {
    await presetLocalStorage(page);
    await page.addInitScript(() => {
        Object.defineProperty(window, "showDirectoryPicker", { configurable: true, value: undefined });
    });
    await gotoApp(page);
    await check70maiMissingGpsOpenCard(page, info.outputPath("card"));
});

test("keeps the missing-log prompt closed when the log is already present, the clip is rear-only, or another format has no GPS", async ({
    page,
}) => {
    await presetLocalStorage(page);
    await gotoApp(page);
    const input = page.locator("#file-input");
    const front = join(SAMPLE_70MAI, "Normal", "Front", "NO20260101-120000-000001F.MP4");
    const logWithoutFix = {
        name: "renamed.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("$V02\n1767240000,V,0,0,0,0,0,0,0,0,0,0,0\n"),
    };
    const embedded = {
        name: "NO20260101-140000-000001F.MP4",
        mimeType: "video/mp4",
        buffer: readFileSync(join(REPO_ROOT, "src/parsers/__fixtures__/70mai-embedded/real-anonymized.mp4")),
    };
    const frontInput = { name: "NO20260101-120000-000001F.MP4", mimeType: "video/mp4", buffer: readFileSync(front) };
    for (const files of [
        [join(SAMPLE_NOGPS, "clip-no-gps.mp4")],
        [join(SAMPLE_70MAI, "Normal", "Back", "NO20260101-120002-000002B.MP4")],
        [embedded],
        [frontInput, logWithoutFix],
    ]) {
        await page.evaluate(() => {
            document.documentElement.removeAttribute("data-test-ingest-done");
            window.addEventListener(
                "everydashcam:ingest-done",
                () => document.documentElement.setAttribute("data-test-ingest-done", ""),
                { once: true },
            );
        });
        await input.setInputFiles(files);
        await expect(page.locator("html")).toHaveAttribute("data-test-ingest-done", "");
        await expect(page.locator("#missing-70mai-gps-modal")).toBeHidden();
    }
});

test("imports a 70mai log from the supported .GPS layout", async ({ page }, info) => {
    await presetLocalStorage(page);
    await gotoApp(page);
    await check70maiHiddenGps(page, info.outputPath("card"));
});

test("binds a dated 70mai .GPS log to normal and event clips", async ({ page }, info) => {
    await presetLocalStorage(page);
    await gotoApp(page);
    await check70maiDatedGps(page, info.outputPath("card"));
});

test("keeps dated 70mai GPS when the first log row is malformed", async ({ page }, info) => {
    await presetLocalStorage(page);
    await gotoApp(page);
    await check70maiDatedGps(page, info.outputPath("card"), true);
});

for (const hasInitialVideo of [false, true]) {
    test(`binds later videos after importing a dated 70mai log ${hasInitialVideo ? "with a normal clip" : "alone"}`, async ({
        page,
    }, info) => {
        await presetLocalStorage(page);
        await gotoApp(page);
        await check70maiDatedGpsIncremental(page, info.outputPath("card"), hasInitialVideo);
    });
}

for (const withGps of [true, false]) {
    test(`70mai A500S card ${withGps ? "uses its root session log" : "plays without a GPS log"}`, async ({
        page,
    }, info) => {
        await presetLocalStorage(page);
        await gotoApp(page);
        await check70maiSessionGps(page, info.outputPath("cards"), withGps);
    });
}
