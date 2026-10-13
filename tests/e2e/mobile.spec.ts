// Mobile (390x844 portrait + landscape) layout flows. The project treats
// mobile as first-class, so these are real regression guards, not screenshots:
// the drawer, the overflow kebab, the view-menu, the mini-progress fallback,
// map expansion, and the export panel sitting in-flow (not as a right drawer
// that shoves the player off-screen).

import type { Page } from "@playwright/test";

import {
    MOBILE,
    MOBILE_LANDSCAPE,
    SAMPLE_70MAI,
    boxOf,
    expect,
    gotoApp,
    loadTrip,
    openMobileExport,
    presetLocalStorage,
    shot,
    test,
} from "./_fixtures.js";

async function expandMobileMap(page: Page): Promise<void> {
    const button = page.locator("#player-map");
    if (await button.isVisible()) {
        await button.click();
    } else {
        await page.locator("#player-overflow").click();
        await page.locator("#player-overflow-menu").getByRole("button", { name: /map/i }).click();
    }
    await expect(page.locator("#player-wrap")).toHaveClass(/map-expanded/);
}

test.describe("mobile portrait", () => {
    test.beforeEach(async ({ page }) => {
        await presetLocalStorage(page);
        await page.setViewportSize(MOBILE);
        await gotoApp(page, "en");
    });

    test("browsing: trip list is the full-screen surface before a pick", async ({ page }) => {
        await page.locator("#folder-input").setInputFiles(SAMPLE_70MAI);
        await expect(page.locator("li.trip:not(.unindexed-note)").first()).toBeVisible({ timeout: 30_000 });
        // While browsing (trips loaded, none active) the burger is hidden - the
        // list itself is the surface.
        await expect(page.locator("#topbar-burger")).toBeHidden();
        await shot(page, "mobile-01-browsing-list");
    });

    test("export button is reachable and enabled after a trip loads", {
        tag: ["@golden-playback", "@golden-export"],
    }, async ({ page }) => {
        await loadTrip(page, SAMPLE_70MAI);
        await expect(page.locator("#player-export")).toBeEnabled();
        await openMobileExport(page);
        await expect(page.locator("#export-panel")).toBeVisible();
        await shot(page, "mobile-02-export-open");
    });

    test("overflow kebab opens as a sheet", async ({ page }) => {
        await loadTrip(page, SAMPLE_70MAI);
        const overflow = page.locator("#player-overflow");
        await expect(overflow).toBeVisible();
        await overflow.click();
        await expect(page.locator("#player-overflow-menu")).toBeVisible();
        await shot(page, "mobile-03-overflow");
    });

    test("overflow kebab carries a working volume slider", async ({ page }) => {
        // On the narrow bar mute collapses into the kebab; its popover slider is
        // hidden with the wrap, so the menu renders its own slider (drag to 0
        // mutes). Regression guard for the no-volume-in-kebab gap.
        await loadTrip(page, SAMPLE_70MAI);
        await page.locator("#player-overflow").click();
        await expect(page.locator("#player-overflow-menu")).toBeVisible();
        const slider = page.locator(".overflow-menu-volume-slider");
        await expect(slider).toBeVisible();

        // A range input is driven via a dispatched 'input' event (Playwright's
        // fill() does not move sliders).
        const setLevel = (v: string) =>
            slider.evaluate((el, value) => {
                (el as HTMLInputElement).value = value;
                el.dispatchEvent(new Event("input", { bubbles: true }));
            }, v);

        // Up: sets the level and lifts mute.
        await setLevel("0.5");
        await expect(page.locator("#player-mute")).toHaveAttribute("aria-label", "Mute");
        await expect(page.locator("#player-volume")).toHaveValue("0.5");

        // To 0: mutes (the bar slider mirrors to 0, the button flips to Unmute).
        await setLevel("0");
        await expect(page.locator("#player-mute")).toHaveAttribute("aria-label", "Unmute");
        await expect(page.locator("#player-volume")).toHaveValue("0");
    });

    test("view-menu opens", async ({ page }) => {
        await loadTrip(page, SAMPLE_70MAI);
        await page.locator("#player-view-menu").click();
        // The view-menu popover with the panel toggles.
        await expect(page.locator('.view-menu-row[data-panel="chart"]')).toBeVisible();
        await expect(page.locator('[data-map-mode="off"]')).toBeVisible();
        await expect(page.locator('[data-map-mode="off"]')).toHaveAttribute("aria-checked", "true");
        await expect(page.locator('[data-map-mode="mini"]')).toBeHidden();
        await expect(page.locator('[data-map-mode="large"]')).toBeVisible();
        await shot(page, "mobile-04-view-menu");
    });

    test("hiding both panels reveals the mini-progress scrubber", async ({ page }) => {
        await loadTrip(page, SAMPLE_70MAI);
        await page.locator("#player-view-menu").click();
        await page.locator('.view-menu-row[data-panel="chart"]').click();
        await page.locator('.view-menu-row[data-panel="strip"]').click();
        await page.locator("body").click(); // close popover
        await expect(page.locator("#player-mini-progress")).toBeVisible();
        await shot(page, "mobile-05-mini-progress");
    });

    test("sidebar drawer opens over the viewer", async ({ page }) => {
        await loadTrip(page, SAMPLE_70MAI);
        // Two .sidebar nodes exist (landing + app shell); dom.sidebar is the first.
        const sidebar = page.locator(".sidebar").first();
        // The drawer may already be open after the browse->watch transition; only
        // toggle when it is closed, then assert it is open (attr + scrim shown).
        if ((await sidebar.getAttribute("data-drawer-open")) !== "true") {
            await page.locator("#topbar-burger").click();
        }
        await expect(sidebar).toHaveAttribute("data-drawer-open", "true");
        await expect(page.locator("#drawer-scrim")).toBeVisible();
        await shot(page, "mobile-06-drawer");
    });

    test("map expands from the player bar", async ({ page }) => {
        await loadTrip(page, SAMPLE_70MAI);
        await expect(page.locator("#player-wrap")).not.toHaveClass(/map-expanded/);
        await expandMobileMap(page);
        await shot(page, "mobile-07-map-expanded");
    });
});

// A real phone reports a coarse pointer, which the other describes above do not
// emulate (setViewportSize alone leaves the pointer fine). The trip card packs
// an absolutely-placed title over a meta row, and its corner controls carry
// touch-only tap zones - neither shows up without this emulation.
test.describe("mobile portrait, touch pointer", () => {
    test.use({ hasTouch: true, isMobile: true });

    test.beforeEach(async ({ page }) => {
        await presetLocalStorage(page);
        await page.setViewportSize(MOBILE);
        // Russian: the longest meta string of the shipped locales.
        await gotoApp(page, "ru");
    });

    test("trip card title and meta row do not overlap", async ({ page }) => {
        await page.locator("#folder-input").setInputFiles(SAMPLE_70MAI);
        const card = page.locator("li.trip:not(.unindexed-note)").first();
        await expect(card).toBeVisible({ timeout: 30_000 });
        // The ingest overlay covers the list while previews are still being
        // generated - hit-testing the card underneath would only find the scrim.
        await expect(page.locator("#ingest-overlay")).toBeHidden({ timeout: 30_000 });
        // Entering the browse state slides the list in from off-canvas. A card
        // measured mid-transition still hangs off the left edge, and every
        // hit-test below then probes a point outside the viewport. Two matching
        // reads, a poll interval apart, mean the slide is over.
        let previousX = Number.NaN;
        await expect
            .poll(
                async () => {
                    const x = (await card.boundingBox())?.x ?? Number.NaN;
                    const settled = x === previousX;
                    previousX = x;
                    return settled;
                },
                { message: "the trip list must finish sliding in before it is measured" },
            )
            .toBe(true);

        const geometry = await page.evaluate(() => {
            const trip = document.querySelector("li.trip:not(.unindexed-note)") as HTMLElement;
            const rect = (selector: string) => trip.querySelector(selector)?.getBoundingClientRect() ?? null;
            const favourite = trip.querySelector(".trip-fav") as HTMLElement;
            const favouriteBox = favourite.getBoundingClientRect();
            // The tap zone is a pseudo-element, invisible to getBoundingClientRect -
            // probe it through hit-testing instead. Down and left: the star sits in
            // the card's top-left corner, so those are the directions it can grow
            // (the header clips whatever reaches past its edges).
            const actionAt = (x: number, y: number) =>
                (document.elementFromPoint(x, y) as HTMLElement | null)
                    ?.closest("[data-action]")
                    ?.getAttribute("data-action") ?? null;
            return {
                title: rect(".trip-title"),
                metaText: rect(".trip-meta-text"),
                header: rect(".trip-header"),
                favouriteLeft: actionAt(favouriteBox.left - 3, favouriteBox.top + 13),
                favouriteBelow: actionAt(favouriteBox.left + 13, favouriteBox.bottom + 5),
            };
        });
        const { title, metaText, header } = geometry;
        expect(title, "the card renders a title").not.toBeNull();
        expect(metaText, "the card renders a meta line").not.toBeNull();
        // Line boxes may touch (that is the shipped density), but must not cross.
        expect(title?.bottom ?? 0, "the title line ends above the meta line").toBeLessThanOrEqual(
            (metaText?.top ?? 0) + 1,
        );
        expect(metaText?.bottom ?? 0, "the meta line stays inside the card").toBeLessThanOrEqual(header?.bottom ?? 0);
        // Touch reach: the star keeps a tap zone well past its 26px icon box.
        expect(geometry.favouriteLeft, "the star is tappable left of its icon").toBe("trip-fav");
        expect(geometry.favouriteBelow, "the star is tappable below its icon").toBe("trip-fav");
    });
});

test.describe("mobile landscape", () => {
    test.beforeEach(async ({ page }) => {
        await presetLocalStorage(page);
        await page.setViewportSize(MOBILE_LANDSCAPE);
        await gotoApp(page, "en");
        await loadTrip(page, SAMPLE_70MAI);
    });

    test("stacked layout yields plain wheel to the page scroll", async ({ page }) => {
        // The reported trap: video (and map) consumed the wheel, so a short
        // viewport could never scroll down to the timeline. Plain wheel must
        // fall through to .viewer (the stacked scroll container); zoom moves
        // to Ctrl/Cmd+wheel, mirroring the map's cooperative gestures.
        const video = await boxOf(page, "#video-grid");
        await page.mouse.move(video.x + video.width / 2, video.y + video.height / 2);

        // The cooperative bypass zooms. Checked before any scrolling so the
        // cursor is still guaranteed to sit on the active video element.
        await page.keyboard.down("Control");
        await page.mouse.wheel(0, -200);
        await page.keyboard.up("Control");
        await expect
            .poll(() =>
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                page.evaluate(() => (window as any).__everydashcam.state.videoZoom.scale),
            )
            .toBeGreaterThan(1);
        // Back to the neutral scale so the plain-wheel check below starts clean.
        await page.keyboard.down("Control");
        await page.mouse.wheel(0, 800);
        await page.keyboard.up("Control");
        await expect
            .poll(() =>
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                page.evaluate(() => (window as any).__everydashcam.state.videoZoom.scale),
            )
            .toBe(1);

        await page.mouse.wheel(0, 300);
        await expect
            .poll(() => page.evaluate(() => document.querySelector(".viewer")?.scrollTop ?? 0), "plain wheel scrolls")
            .toBeGreaterThan(0);
        const zoomAfterPlain = await page.evaluate(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            () => (window as any).__everydashcam.state.videoZoom.scale,
        );
        expect(zoomAfterPlain, "plain wheel does not zoom the video").toBe(1);

        // The map runs MapLibre cooperative gestures in this layout even on a
        // fine pointer - the overlay hint (with the Ctrl/Cmd message) exists,
        // which means the wheel is not trapped by the map either.
        await expandMobileMap(page);
        await expect(page.locator(".maplibregl-cooperative-gesture-screen")).toBeAttached();
    });

    test("export panel is in-flow, not a right drawer squeezing the player", async ({ page }) => {
        await openMobileExport(page);
        const panel = await boxOf(page, "#export-panel");
        // Regression: the panel used to stay a 360px right drawer on landscape
        // (its bottom-sheet breakpoint was max-width:720, and 844 > 720), pushing
        // the player off-screen. In-flow now: the panel spans most of the width.
        expect(panel.width).toBeGreaterThan(MOBILE_LANDSCAPE.width * 0.6);
        await shot(page, "mobile-08-landscape-export");
    });
});
