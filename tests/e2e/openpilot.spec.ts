// openpilot routes: raw HEVC cameras plus a qlog that dates them. The ingest
// test runs everywhere and checks what only the real worker path can prove:
// the qlog's timing reaches the candidates (frame-0 UTC, 3 s instead of the
// nominal 60 s), and one of a segment's two road views fills the front slot -
// the full-res file where raw HEVC plays, the H.264 preview where it does not.
// The playback test needs an HEVC decoder and skips itself without one, as
// hevc.spec.ts does.

import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { Page } from "@playwright/test";

import {
    DESKTOP,
    REPO_ROOT,
    expect,
    gotoApp,
    openTripWithRecording,
    presetLocalStorage,
    shot,
    test,
    waitForMetadata,
} from "./_fixtures.js";

const FIXTURES = path.join(REPO_ROOT, "src/parsers/__fixtures__/openpilot");
const PREFIX = "0123456789abcdef_00000001--0000000000";
// Frame 0 of segment 19 from the full real qlog.
const SEGMENT_19_START = Date.parse("2026-11-03T08:57:23.943Z") / 1000;

const directories: string[] = [];

/** Raw HEVC plays only through MSE; ingest keeps the full-res road view only then. */
async function mseHevcSupported(page: Page): Promise<boolean> {
    return await page.evaluate(
        () => typeof MediaSource !== "undefined" && MediaSource.isTypeSupported('video/mp4; codecs="hvc1.1.6.L150.90"'),
    );
}

/** A comma connect download folder holding both fixture segments. */
function routeFolder(): string {
    const root = mkdtempSync(path.join(tmpdir(), "everydashcam-openpilot-"));
    directories.push(root);
    const folder = path.join(root, "comma");
    mkdirSync(folder);
    for (const name of readdirSync(FIXTURES).filter((file) => file.startsWith(PREFIX))) {
        copyFileSync(path.join(FIXTURES, name), path.join(folder, name));
    }
    return root;
}

test.use({ viewport: DESKTOP });
test.beforeEach(async ({ page }) => {
    await presetLocalStorage(page);
    await gotoApp(page, "en");
});
test.afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

test("an openpilot route is dated and sized by its qlog", async ({ page }) => {
    await page.locator("#folder-input").setInputFiles(routeFolder());
    await expect(page.locator("li.trip:not(.unindexed-note)").first()).toBeVisible({ timeout: 30_000 });
    await waitForMetadata(page);

    const clips = await page.evaluate(() =>
        window.__everydashcam.state.trips.flatMap((trip) =>
            trip.frames.flatMap((frame) =>
                Object.entries(frame.channels).map(([channel, candidate]) => ({
                    name: candidate.file.name,
                    channel,
                    startUtc: candidate.startUtc,
                    startSource: candidate.startSource,
                    durationSec: candidate.durationSec,
                    gpsRecords: candidate.records.length,
                })),
            ),
        ),
    );
    const byName = new Map(clips.map((clip) => [clip.name.replace(`${PREFIX}--`, ""), clip]));
    const clip = (name: string) => {
        const found = byName.get(name);
        if (!found) throw new Error(`${name} is not loaded`);
        return found;
    };
    const rawHevcPlays = await mseHevcSupported(page);
    const road = rawHevcPlays ? "19--fcamera.hevc" : "19--qcamera.TS";
    expect([...byName.keys()].sort()).toEqual([road, "19--dcamera.hevc", "19--ecamera.hevc", "20--qcamera.TS"].sort());
    expect(clip(road)).toMatchObject({ channel: "front", startSource: "embedded" });
    expect(clip("19--ecamera.hevc")).toMatchObject({ channel: "side", durationSec: 3 });
    expect(clip("19--dcamera.hevc")).toMatchObject({ channel: "interior", durationSec: 3 });
    expect(clip("20--qcamera.TS")).toMatchObject({ channel: "front", startSource: "embedded" });
    // The raw stream's duration can only come from the qlog; the preview has its own.
    if (rawHevcPlays) expect(clip(road).durationSec).toBe(3);
    expect(Math.abs(clip(road).startUtc - SEGMENT_19_START)).toBeLessThan(0.002);
    expect(clip("20--qcamera.TS").startUtc - clip(road).startUtc).toBeCloseTo(60, 1);
    expect(clip(road).gpsRecords).toBeGreaterThan(0);
    expect(clip("20--qcamera.TS").gpsRecords).toBeGreaterThan(0);
});

test("raw HEVC cameras play through their MP4 view", async ({ page }) => {
    test.skip(!(await mseHevcSupported(page)), "HEVC decode not supported on this platform");

    await page.locator("#folder-input").setInputFiles(routeFolder());
    await expect(page.locator("li.trip:not(.unindexed-note)").first()).toBeVisible({ timeout: 30_000 });
    // The newest trip comes first and may be the preview-only segment.
    await openTripWithRecording(page, `${PREFIX}--19--fcamera.hevc`);
    await expect
        .poll(() => page.evaluate(() => (document.getElementById("player") as HTMLVideoElement).currentTime), {
            timeout: 15_000,
        })
        .toBeGreaterThan(0);
    expect(await page.evaluate(() => (document.getElementById("player") as HTMLVideoElement).videoWidth)).toBe(320);
    await shot(page, "openpilot-01-playing");
});
