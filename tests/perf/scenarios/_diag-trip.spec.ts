// Diag for trip-activation hang: poll lifecycle + state every 2s after click.
// Disabled by default - sleeps 24s and dumps console output that would just
// spam `make perf` runs. Opt in with DIAG=1 (and optionally DIAG_VENDOR=<name>).

import { test } from "@playwright/test";
import { setupPage } from "../harness/setup.js";
import { deliverFiles } from "../harness/files.js";
import { discoverVendors } from "../harness/vendors.js";

if (process.env.DIAG !== "1") test.skip(true, "diag spec disabled - set DIAG=1 to opt in");

const vendors = discoverVendors();
const target = process.env.DIAG_VENDOR ?? "escort";
const vendor = vendors.find((v) => v.name === target || v.name.includes(target));

if (!vendor) test.skip(true, `no vendor "${target}"`);

test(`_diag-trip: ${vendor?.name}`, async ({ browser }) => {
    test.setTimeout(40_000);
    if (!vendor) return;
    const ctx = await browser.newContext({ serviceWorkers: "block" });
    const page = await ctx.newPage();
    page.on("console", (msg) => console.log(`BROWSER[${msg.type()}]:`, msg.text()));
    page.on("pageerror", (err) => console.log(`BROWSER ERROR:`, err.message));
    await setupPage(page);
    await deliverFiles(page, vendor.absPath);
    await page.waitForFunction(
        () => {
            const w = window as unknown as {
                __everydashcamPerf?: { lifecycleEvents?: Array<{ type: string }> };
            };
            return !!w.__everydashcamPerf?.lifecycleEvents?.some((e) => e.type === "everydashcam:ingest-done");
        },
        { timeout: 15_000, polling: 100 },
    );
    console.log(">>> ingest done, clicking trip 0");

    // Reset lifecycle events
    await page.evaluate(() => {
        const w = window as unknown as { __everydashcamPerf?: { lifecycleEvents: unknown[] } };
        if (w.__everydashcamPerf) w.__everydashcamPerf.lifecycleEvents = [];
    });

    const t0 = Date.now();
    await page.locator(`li.trip[data-trip-index="0"] .trip-header`).click();
    console.log(`>>> click dispatched at +${Date.now() - t0}ms`);

    for (let i = 0; i < 12; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const snap = await page.evaluate(() => {
            const w = window as unknown as {
                __everydashcamPerf?: { lifecycleEvents?: Array<{ type: string }> };
                __everydashcam?: {
                    state: { active: unknown; trips: unknown[] };
                    dumpLog: () => Array<{ ns: string; msg: string; ts: number; ctx?: unknown }>;
                };
            };
            const video = document.querySelector("video.is-active") as HTMLVideoElement | null;
            return {
                events: (w.__everydashcamPerf?.lifecycleEvents ?? []).map((e) => e.type),
                active: w.__everydashcam?.state.active,
                videoState: video
                    ? {
                          readyState: video.readyState,
                          networkState: video.networkState,
                          hasSrc: !!video.src,
                          paused: video.paused,
                          currentTime: video.currentTime,
                          duration: video.duration,
                          videoWidth: video.videoWidth,
                          videoHeight: video.videoHeight,
                          rVFCSupported: typeof video.requestVideoFrameCallback === "function",
                      }
                    : "no video.is-active",
                tail: (w.__everydashcam?.dumpLog() ?? []).slice(-5).map((l) => ({
                    ns: l.ns,
                    msg: l.msg,
                    age: `${Math.round((Date.now() - l.ts) / 1000)}s`,
                })),
            };
        });
        console.log(`t=${(i + 1) * 2}s:`, JSON.stringify(snap, null, 2));
        if (
            snap.events.includes("everydashcam:player-first-frame") &&
            snap.events.includes("everydashcam:map-tracks-rendered") &&
            snap.events.includes("everydashcam:chart-rendered")
        ) {
            console.log(`>>> all events at t=${(i + 1) * 2}s`);
            break;
        }
    }
    await ctx.close();
});
