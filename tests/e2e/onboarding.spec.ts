// First-run onboarding tours (src/ui/onboarding.ts). Asserts the triggers
// fire on first run, that "Don't show again" persists (and the X / "later" path
// does NOT), and that a seeded-done flag suppresses the tour entirely - the
// guarantee the rest of the e2e suite relies on (presetLocalStorage seeds every
// tour as done so trip/export specs are not blocked by the overlay).
//
// clearOnboarding() must run AFTER presetLocalStorage() and before gotoApp(),
// so beforeEach only presets + sizes; each test clears the tours it exercises,
// then navigates.

import {
    DESKTOP,
    MOBILE,
    ONBOARD_TOUR_IDS,
    SAMPLE_70MAI,
    clearOnboarding,
    expect,
    gotoApp,
    loadTrip,
    openExport,
    presetLocalStorage,
    shot,
    test,
} from "./_fixtures.js";

const FLAG = (id: string) => `everydashcam:onboarding:${id}`;

async function flag(page: import("@playwright/test").Page, id: string): Promise<string | null> {
    return page.evaluate((k) => localStorage.getItem(k), FLAG(id));
}

test.describe("onboarding", () => {
    test.beforeEach(async ({ page }) => {
        await presetLocalStorage(page);
        await page.setViewportSize(DESKTOP);
    });

    test("ingest tour appears after the first ingest and 'Don't show again' persists", async ({ page }) => {
        await clearOnboarding(page);
        await gotoApp(page, "en");

        // Load the SD card but DON'T click a trip - the ingest tour fires on its
        // own once the trip list is populated.
        await page.locator("#folder-input").setInputFiles(SAMPLE_70MAI);
        await expect(page.locator("li.trip:not(.unindexed-note)").first()).toBeVisible({ timeout: 30_000 });

        const onb = page.locator(".dc-onb");
        await expect(onb).toBeVisible({ timeout: 5_000 });
        await expect(page.locator(".dc-onb__title")).toContainText("Your trips");
        await expect(page.locator(".dc-onb__count")).toHaveText("1 / 1");
        await expect(page.locator(".dc-onb__next")).toHaveText(/Got it/);
        await shot(page, "onboarding-01-ingest");

        // "Don't show again" ends the tour and persists.
        await page.locator(".dc-onb__skip").click();
        await expect(onb).toHaveCount(0);
        for (const id of ONBOARD_TOUR_IDS) expect(await flag(page, id)).toBe("1");
    });

    test("player tour gates autoplay and completing it persists + resumes", async ({ page }) => {
        await clearOnboarding(page, ["player"]);
        await gotoApp(page, "en");
        await loadTrip(page, SAMPLE_70MAI);

        const onb = page.locator(".dc-onb");
        await expect(onb).toBeVisible({ timeout: 5_000 });
        await expect(page.locator(".dc-onb__title")).toContainText("One timeline");
        // Gated: playback is paused while the tour introduces the controls.
        await expect(page.locator("#player-play")).toHaveAttribute("data-paused", "true");

        // Step through to the end; the last button completes the tour.
        const next = page.locator(".dc-onb__next");
        await next.click(); // -> save clip
        await expect(next).toHaveText(/Got it/);
        await next.click(); // complete

        await expect(onb).toHaveCount(0);
        expect(await flag(page, "player")).toBe("1");
    });

    test("the X button dismisses without persisting (remind me later)", async ({ page }) => {
        await clearOnboarding(page, ["player"]);
        await gotoApp(page, "en");
        await loadTrip(page, SAMPLE_70MAI);

        const onb = page.locator(".dc-onb");
        await expect(onb).toBeVisible({ timeout: 5_000 });
        await page.locator(".dc-onb__x").click();
        await expect(onb).toHaveCount(0);
        // Not persisted: it must be able to show again next time.
        expect(await flag(page, "player")).toBeNull();
    });

    test("Escape always closes the tour (panic exit) without persisting", async ({ page }) => {
        await clearOnboarding(page, ["player"]);
        await gotoApp(page, "en");
        await loadTrip(page, SAMPLE_70MAI);

        const onb = page.locator(".dc-onb");
        await expect(onb).toBeVisible({ timeout: 5_000 });
        await page.keyboard.press("Escape");
        await expect(onb).toHaveCount(0);
        // Body scroll must be unlocked again (the app stays usable).
        expect(await page.evaluate(() => document.body.style.overflow)).not.toBe("hidden");
        expect(await flag(page, "player")).toBeNull();
    });

    test("clicking the dim outside the card closes the tour", async ({ page }) => {
        await clearOnboarding(page, ["player"]);
        await gotoApp(page, "en");
        await loadTrip(page, SAMPLE_70MAI);

        const onb = page.locator(".dc-onb");
        await expect(onb).toBeVisible({ timeout: 5_000 });
        // Top-left corner is dim (the card and spotlight are elsewhere).
        await page.locator(".dc-onb__blocker").click({ position: { x: 6, y: 6 } });
        await expect(onb).toHaveCount(0);
    });

    test("export tour appears the first time export mode opens", async ({ page }) => {
        await clearOnboarding(page, ["export"]);
        await gotoApp(page, "en");
        // Player/ingest tours stay suppressed (seeded done), so opening the trip
        // does not show a tour and export is reachable.
        await loadTrip(page, SAMPLE_70MAI);
        await openExport(page, false);

        const onb = page.locator(".dc-onb");
        await expect(onb).toBeVisible({ timeout: 5_000 });
        await expect(page.locator(".dc-onb__title")).toContainText("Pick a range");
        await shot(page, "onboarding-02-export");
        await page.locator(".dc-onb__skip").click();
        await expect(onb).toHaveCount(0);
        expect(await flag(page, "export")).toBe("1");
    });

    test("multichannel tour fires on a multi-camera trip once the player tour is done", async ({ page }) => {
        // Player tour already done (seeded), multichannel cleared -> opening the
        // 70mai multichannel trip surfaces the multichannel tour.
        await clearOnboarding(page, ["multichannel"]);
        await gotoApp(page, "en");
        await loadTrip(page, SAMPLE_70MAI);

        const onb = page.locator(".dc-onb");
        await expect(onb).toBeVisible({ timeout: 5_000 });
        await expect(page.locator(".dc-onb__title")).toContainText("Layout");
        // Step through to the dedicated reorder/hide-cameras step.
        await page.locator(".dc-onb__next").click(); // -> arrange cameras
        await expect(page.locator(".dc-onb__title")).toContainText("Arrange cameras");
        await page.locator(".dc-onb__skip").click();
        await expect(onb).toHaveCount(0);
        expect(await flag(page, "multichannel")).toBe("1");
    });

    test("danger zone 'Replay tips' clears the seen-state of every tour", async ({ page }) => {
        // Every tour is seeded done by presetLocalStorage.
        await gotoApp(page, "en");
        expect(await flag(page, "player")).toBe("1");

        await page.locator("#settings-btn").click();
        await expect(page.locator("#settings-modal")).toBeVisible();
        await page.locator("#settings-reset-onboarding-btn").click();

        // Toast confirms, and every onboarding flag is cleared.
        await expect(page.locator(".dc-toast")).toBeVisible();
        for (const id of ONBOARD_TOUR_IDS) {
            expect(await flag(page, id), `${id} flag cleared`).toBeNull();
        }
    });

    test("a seeded-done flag suppresses the tour entirely", async ({ page }) => {
        // No clearOnboarding: presetLocalStorage left all four marked done.
        await page.clock.install();
        await gotoApp(page, "en");
        await loadTrip(page, SAMPLE_70MAI);
        // Cross the player's 450ms deferred-start window without sleeping. If
        // the persisted flag were ignored, the timer would create the overlay.
        await page.clock.fastForward(500);
        await expect(page.locator(".dc-onb")).toHaveCount(0);
    });

    test("fail-open: a throw during tour setup tears the overlay down without trapping the user", async ({ page }) => {
        await clearOnboarding(page, ["player"]);
        // Make the popover's layout measurement throw, so positionStep (and thus
        // startTour) throws AFTER the overlay is built - the exact path the
        // fail-open catch must survive. Scoped to .dc-onb__pop so nothing else
        // is affected (the app's own getBoundingClientRect calls keep working).
        await page.addInitScript(() => {
            const orig = Element.prototype.getBoundingClientRect;
            Element.prototype.getBoundingClientRect = function (this: Element) {
                if (this.classList?.contains("dc-onb__pop")) throw new Error("injected onboarding layout failure");
                return orig.call(this);
            };
        });
        await gotoApp(page, "en");
        await loadTrip(page, SAMPLE_70MAI);

        // The gated playback (autoPlay=false because the player tour was picked)
        // must resume: startTour's catch runs onFinish even though the tour blew
        // up. This is also the positive signal that the tour machinery actually
        // fired and failed - it cannot turn green if the tour never ran.
        await expect(page.locator("#player-play")).toHaveAttribute("data-paused", "false", { timeout: 5_000 });
        // And the headline invariant: no overlay is left on screen and body
        // scroll is not locked, so the app stays fully usable.
        await expect(page.locator(".dc-onb")).toHaveCount(0);
        expect(await page.evaluate(() => document.body.style.overflow)).not.toBe("hidden");
        // The blocker is gone, so the trip list is clickable again: a trial
        // click runs the full actionability checks (visible, stable, receives
        // pointer events - i.e. no leftover overlay intercepts the hit target)
        // without actually clicking. `toBeEnabled()` would be a no-op here: a
        // non-form <li> is always "enabled".
        await page.locator("li.trip:not(.unindexed-note)").first().click({ trial: true });
    });

    test("mobile: ingest tour docks as a bottom sheet", async ({ page }) => {
        await page.setViewportSize(MOBILE);
        await clearOnboarding(page, ["ingest"]);
        await gotoApp(page, "en");

        await page.locator("#folder-input").setInputFiles(SAMPLE_70MAI);
        await expect(page.locator("li.trip:not(.unindexed-note)").first()).toBeVisible({ timeout: 30_000 });

        const pop = page.locator(".dc-onb__pop");
        await expect(pop).toBeVisible({ timeout: 5_000 });
        await expect(pop).toHaveAttribute("data-placement", "sheet");
        // Sheet spans the full width and sits at the bottom of the viewport.
        const box = await pop.boundingBox();
        expect(box, "sheet must have a box").not.toBeNull();
        expect(box!.width).toBeGreaterThan(MOBILE.width * 0.9);
        expect(box!.y + box!.height).toBeGreaterThan(MOBILE.height - 4);
        await shot(page, "onboarding-03-mobile-sheet");
    });

    test("mobile: player tour keeps the chart clear and docks above the bottom player bar", async ({ page }) => {
        await page.setViewportSize(MOBILE);
        await page.emulateMedia({ reducedMotion: "reduce" });
        await clearOnboarding(page, ["player"]);
        await gotoApp(page, "en");
        await loadTrip(page, SAMPLE_70MAI);

        const pop = page.locator(".dc-onb__pop");
        const spot = page.locator(".dc-onb__spot");
        await expect(pop).toBeVisible({ timeout: 5_000 });
        await expect(page.locator(".dc-onb")).toHaveAttribute("data-mode", "anchor");
        // The compact chart sits beneath the video, leaving room for a bottom
        // sheet. Its spotlight must remain completely above the explanation.
        await expect(pop).toHaveAttribute("data-placement", "sheet");
        const chartBox = await page.locator("#player-chart").boundingBox();
        const chartSpot = await spot.boundingBox();
        const bottomSheet = await pop.boundingBox();
        expect(chartBox, "chart must have a box").not.toBeNull();
        expect(chartSpot, "chart spotlight must have a box").not.toBeNull();
        expect(bottomSheet, "bottom sheet must have a box").not.toBeNull();
        expect(chartSpot!.y).toBeLessThanOrEqual(chartBox!.y);
        expect(chartSpot!.y + chartSpot!.height).toBeGreaterThanOrEqual(chartBox!.y + chartBox!.height);
        expect(bottomSheet!.y).toBeGreaterThan(chartSpot!.y + chartSpot!.height);
        expect(bottomSheet!.y + bottomSheet!.height).toBeCloseTo(MOBILE.height, 0);

        // The export control lives in the sticky bottom player bar, so this
        // step needs the opposite edge to keep its highlighted target visible.
        await page.locator(".dc-onb__next").click();
        await expect(page.locator(".dc-onb__count")).toHaveText("2 / 2");
        await expect(pop).toHaveAttribute("data-placement", "sheet-top");
        const topSheet = await pop.boundingBox();
        const playerSpot = await spot.boundingBox();
        const playerBar = await page.locator("#player-bar").boundingBox();
        expect(topSheet, "top sheet must have a box").not.toBeNull();
        expect(playerSpot, "player control spotlight must have a box").not.toBeNull();
        expect(playerBar, "player bar must have a box").not.toBeNull();
        expect(topSheet!.y).toBeCloseTo(0, 0);
        expect(topSheet!.y + topSheet!.height).toBeLessThan(playerSpot!.y);
        expect(playerSpot!.y + playerSpot!.height).toBeGreaterThan(playerBar!.y);
    });
});
