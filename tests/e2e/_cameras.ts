// Cameras menu driver shared by the e2e and portable suites. The menu is a
// popover rebuilt from state on every change, so each helper opens it, acts,
// and closes it again: a stale handle to a row would point at a detached node.

import { type Locator, type Page, expect } from "@playwright/test";

export type CameraChannel = "front" | "rear" | "interior" | "side";

/** Visibility checkboxes in the open menu, one per camera, in layout order. */
export function cameraCheckboxes(page: Page): Locator {
    return page.locator("#player-cameras-popover .cameras-menu__visible");
}

/** The checkbox that shows or hides `channel` in the open menu. */
export function cameraCheckbox(page: Page, channel: CameraChannel): Locator {
    return page.locator(
        `#player-cameras-popover .cameras-menu__camera[data-channel="${channel}"] .cameras-menu__visible`,
    );
}

/** Waits for the tiles to finish sliding into their new places: an arrangement
 *  change animates them, and a box read mid-slide is neither place. */
export async function settleCameraLayout(page: Page): Promise<void> {
    await page.evaluate(async () => {
        const tiles = [...document.querySelectorAll<HTMLElement>("#video-grid > .video-tile")];
        await Promise.all(tiles.flatMap((tile) => tile.getAnimations().map((animation) => animation.finished)));
    });
}

/** Opens the menu from its button, or from the overflow menu where a narrow
 *  bar folds the button. */
export async function openCamerasMenu(page: Page): Promise<void> {
    const panel = page.locator("#player-cameras-popover");
    if (await panel.isVisible()) return;
    if ((await page.locator("#player-cameras-wrap").getAttribute("data-overflow-hidden")) === "true") {
        // The overflow entry carries the button's localized name.
        const name = (await page.locator("#player-cameras").getAttribute("aria-label")) ?? "";
        await page.locator("#player-overflow").click();
        await page.locator("#player-overflow-menu .overflow-menu-btn").filter({ hasText: name }).click();
    } else {
        await page.locator("#player-cameras").click();
    }
    await expect(panel).toBeVisible();
}

export async function closeCamerasMenu(page: Page): Promise<void> {
    const panel = page.locator("#player-cameras-popover");
    if (!(await panel.isVisible())) return;
    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();
    await settleCameraLayout(page);
}

/** Flips one checkbox through a click. The menu re-renders on every change,
 *  so the state is read back through a fresh locator rather than the clicked
 *  node, which `check()` would do and find detached. */
async function setCheckbox(page: Page, channel: CameraChannel, checked: boolean): Promise<void> {
    if ((await cameraCheckbox(page, channel).isChecked()) === checked) return;
    await cameraCheckbox(page, channel).click();
    await expect(cameraCheckbox(page, channel)).toBeChecked({ checked });
}

/** Shows exactly `channels`. Checks first, so the last visible camera, whose
 *  checkbox is disabled, is never the one left to uncheck. */
export async function showOnlyCameras(page: Page, channels: readonly CameraChannel[]): Promise<void> {
    await openCamerasMenu(page);
    for (const channel of channels) await setCheckbox(page, channel, true);
    const rows = page.locator("#player-cameras-popover .cameras-menu__camera");
    for (const channel of await rows.evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.channel))) {
        if (!channels.includes(channel as CameraChannel)) await setCheckbox(page, channel as CameraChannel, false);
    }
    await expect(page.locator("#player-cameras-popover .cameras-menu__visible:checked")).toHaveCount(channels.length);
    await closeCamerasMenu(page);
}

/** Shows the first `count` cameras of the layout order and hides the rest. */
export async function showFirstCameras(page: Page, count: number): Promise<void> {
    const order = await page.evaluate(() => window.__everydashcam.state.composition.order);
    await showOnlyCameras(page, order.slice(0, count) as CameraChannel[]);
}

/** Shows or hides one camera. */
export async function setCameraShown(page: Page, channel: CameraChannel, shown: boolean): Promise<void> {
    await openCamerasMenu(page);
    await setCheckbox(page, channel, shown);
    await closeCamerasMenu(page);
}

/** Picks the sound source: a camera, or "follow-main". */
export async function chooseAudioSource(page: Page, value: CameraChannel | "follow-main"): Promise<void> {
    await openCamerasMenu(page);
    await page.locator("#player-cameras-popover .cameras-menu__audio-select").selectOption(value);
    await closeCamerasMenu(page);
}

/** Makes `channel` the main camera through its "Main" button in the menu. */
export async function makeMainFromMenu(page: Page, channel: CameraChannel): Promise<void> {
    await openCamerasMenu(page);
    await page
        .locator(`#player-cameras-popover .cameras-menu__camera[data-channel="${channel}"] .cameras-menu__main`)
        .click();
    await expect(
        page.locator(`#player-cameras-popover .cameras-menu__camera[data-channel="${channel}"] .cameras-menu__main`),
    ).toHaveAttribute("aria-pressed", "true");
    await closeCamerasMenu(page);
}

/** Switches between "main camera + others" and "all equal". */
export async function chooseArrangementMode(page: Page, mode: "main" | "equal"): Promise<void> {
    await openCamerasMenu(page);
    await page.locator(`#player-cameras-popover [data-camera-mode="${mode}"]`).click();
    await expect(page.locator("#video-grid")).toHaveAttribute("data-mode", mode);
    await closeCamerasMenu(page);
}

/** Allows or forbids the smaller cameras to sit over the main one. */
export async function setOverlayAllowed(page: Page, allowed: boolean): Promise<void> {
    await openCamerasMenu(page);
    const box = page.locator("#player-cameras-popover .cameras-menu__overlay");
    if ((await box.isChecked()) !== allowed) await box.click();
    await expect(page.locator("#player-cameras-popover .cameras-menu__overlay")).toBeChecked({ checked: allowed });
    await closeCamerasMenu(page);
}

/** Visible cameras in layout order, the main one first. */
export async function visibleCameraOrder(page: Page): Promise<CameraChannel[]> {
    return page.evaluate(() => {
        const c = window.__everydashcam.state.composition;
        return c.order.filter((channel) => !c.hidden.includes(channel)) as CameraChannel[];
    });
}
