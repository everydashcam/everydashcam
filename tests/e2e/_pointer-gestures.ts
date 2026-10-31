import type { Locator, Page } from "@playwright/test";
import { boxOf, expect } from "./_fixtures.js";

/** Real touch input verifies CSS gesture ownership as well as pointer handlers. */
export async function verifyTouchGestures(page: Page): Promise<void> {
    const touch = await page.context().newCDPSession(page);
    const send = (type: "touchStart" | "touchMove" | "touchEnd", points: { x: number; y: number; id: number }[]) =>
        touch.send("Input.dispatchTouchEvent", { type, touchPoints: points });
    try {
        const before = await boxOf(page, "#sidebar");
        const grip = await boxOf(page, "#sidebar-resize");
        const x = grip.x + grip.width / 2;
        const y = grip.y + 80;
        await send("touchStart", [{ x, y, id: 1 }]);
        await expect(page.locator("body")).toHaveClass(/sidebar-resizing/);
        await send("touchMove", [{ x: x + 30, y, id: 1 }]);
        await send("touchMove", [{ x: x + 70, y, id: 1 }]);
        await send("touchEnd", []);
        await expect(page.locator("body")).not.toHaveClass(/sidebar-resizing/);
        const after = await boxOf(page, "#sidebar");
        expect(after.width - before.width, "a tablet touch resizes the sidebar").toBeCloseTo(70, -1);
        await expect(page.locator("#sidebar-resize")).toHaveAttribute("aria-valuenow", String(Math.round(after.width)));

        const pinch = async (selector: string) => {
            const box = await boxOf(page, selector);
            const center = box.x + box.width * 0.55;
            const y = box.y + box.height * 0.65;
            const halfWidth = Math.min(35, box.width * 0.1);
            await send("touchStart", [{ x: center - halfWidth, y, id: 1 }]);
            await send("touchStart", [
                { x: center - halfWidth, y, id: 1 },
                { x: center + halfWidth, y, id: 2 },
            ]);
            await send("touchMove", [
                { x: center - 2 * halfWidth, y, id: 1 },
                { x: center + 2 * halfWidth, y, id: 2 },
            ]);
            await send("touchEnd", []);
        };
        await pinch(".video-tile.active video:not(.preload-slot):not(.tile-blur-bg)");
        await expect.poll(() => page.evaluate(() => window.__everydashcam.state.videoZoom.scale)).toBeGreaterThan(1.5);
        // The tablet mini-map can cover this corner after the sidebar widens.
        // Keyboard activation still exercises the public reset control.
        await page.locator(".zoom-badge").focus();
        await page.keyboard.press("Enter");
        await expect.poll(() => page.evaluate(() => window.__everydashcam.state.videoZoom.scale)).toBe(1);

        const span = () =>
            page.evaluate(() => {
                const scale = window.__everydashcam.state.chart!.scales.x!;
                return scale.max - scale.min;
            });
        const fullSpan = await span();
        await pinch("#player-chart-canvas");
        await expect.poll(span).toBeLessThan(fullSpan * 0.8);
    } finally {
        // Each successful gesture already ended. A duplicate touchEnd with no
        // active contacts can wait forever for Chromium's input acknowledgement.
        // On failure Playwright closes this test's page and cancels its input.
        await touch.detach().catch(() => {});
    }
}

async function releaseCurrentCapture(target: Locator): Promise<void> {
    await target.evaluate((element) => {
        const id = Number(element.getAttribute("data-test-pointer-id"));
        if (!element.hasPointerCapture(id)) throw new Error("test pointer is not captured");
        element.releasePointerCapture(id);
        element.removeAttribute("data-test-pointer-id");
    });
}

export async function verifyLostPointerCapture(page: Page): Promise<void> {
    for (const [selector, draggingClass] of [
        ["#sidebar-resize", "dragging"],
        ["#mini-map", "is-dragging"],
    ] as const) {
        const target = page.locator(selector);
        await target.evaluate((element) => {
            element.addEventListener(
                "gotpointercapture",
                (event) => {
                    element.setAttribute("data-test-pointer-id", String((event as PointerEvent).pointerId));
                },
                { once: true },
            );
        });
        const box = await boxOf(page, selector);
        const x = box.x + box.width / 2;
        const y = box.y + box.height / 2;
        await page.mouse.move(x, y);
        await page.mouse.down();
        await page.mouse.move(x + 25, y + 10, { steps: 3 });
        await expect(target).toHaveClass(new RegExp(draggingClass));
        await releaseCurrentCapture(target);
        await page.mouse.move(x + 30, y + 10);
        await expect(target).not.toHaveClass(new RegExp(draggingClass));
        const settled = await boxOf(page, selector === "#sidebar-resize" ? "#sidebar" : selector);
        await page.mouse.move(x + 80, y + 20);
        const after = await boxOf(page, selector === "#sidebar-resize" ? "#sidebar" : selector);
        expect(after.x).toBeCloseTo(settled.x, 0);
        expect(after.y).toBeCloseTo(settled.y, 0);
        expect(after.width).toBeCloseTo(settled.width, 0);
        await page.mouse.up();
    }
    await expect(page.locator("body")).not.toHaveClass(/sidebar-resizing/);
}

export async function verifyLocalizedNumbers(page: Page, locale: "en" | "ru"): Promise<void> {
    const card = page.locator("li.trip").first();
    const toggle = card.locator(".trip-chevron");
    if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
    const decimal = locale === "ru" ? "," : "\\.";
    const unit = locale === "ru" ? "МБ" : "MB";
    await expect(card.locator(".file-meta-text").first()).toContainText(new RegExp(`\\d${decimal}\\d ${unit}`));
    await expect(page.locator("#pm-distance-value")).toHaveText(new RegExp(`^\\d+${decimal}\\d$`));
    // Coordinates retain their portable decimal-point notation.
    await expect(page.locator("#pm-coords")).toHaveText(/-?\d+\.\d+, -?\d+\.\d+/);
}
