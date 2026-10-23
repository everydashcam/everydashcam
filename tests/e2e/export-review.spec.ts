import path from "node:path";

import {
    DESKTOP,
    MOBILE,
    REPO_ROOT,
    SAMPLE_70MAI,
    SCREENSHOT_DIR,
    boxOf,
    expect,
    gotoApp,
    loadTrip,
    openExport,
    pausePlayback,
    presetLocalStorage,
    test,
} from "./_fixtures.js";

test.describe("export controls", () => {
    test.use({ viewport: DESKTOP });

    test.beforeEach(async ({ page }) => {
        await presetLocalStorage(page);
        await gotoApp(page, "en");
        await loadTrip(page, SAMPLE_70MAI);
        await openExport(page, false);
    });

    test("desktop privacy and overlays start expanded and toggle from the keyboard", async ({ page }) => {
        for (const [title, name] of [
            ["Hide plates & faces", "privacy"],
            ["Overlays", "overlays"],
        ] as const) {
            const section = page.locator(".export-panel__disclosure").filter({
                has: page.locator(":scope > summary", { hasText: title }),
            });
            const summary = section.locator(":scope > summary");
            const controls = section.locator(":scope > fieldset");
            await expect(section).toHaveAttribute("open", "");
            await expect(controls).toBeVisible();
            await summary.focus();
            await page.keyboard.press("Enter");
            await expect(section).not.toHaveAttribute("open");
            await expect(controls).toBeHidden();
            await expect(summary).toBeFocused();
            await page.keyboard.press("Space");
            await expect(section).toHaveAttribute("open", "");
            await expect(controls).toBeVisible();
            await summary.evaluate((element) => element.blur());
            await page.mouse.move(0, 0);
            await section.screenshot({ path: `${SCREENSHOT_DIR}/export-disclosure-${name}.png` });
        }
        await page.locator('.theme-toggle-btn[data-theme="light"]').click();
        await page.mouse.move(0, 0);
        const sections = page.locator(".export-panel__disclosure");
        await sections.nth(0).screenshot({ path: `${SCREENSHOT_DIR}/export-disclosure-privacy-light.png` });
        await sections.nth(1).screenshot({ path: `${SCREENSHOT_DIR}/export-disclosure-overlays-light.png` });
    });

    test("output and overlay controls expose their labels and selected states", async ({ page }) => {
        const video = page.locator('.export-panel__seg-btn[data-mode="video"]');
        const gpx = page.locator('.export-panel__seg-btn[data-mode="gpx"]');
        await expect(video).toHaveAttribute("aria-pressed", "true");
        await gpx.click();
        await expect(gpx).toHaveAttribute("aria-pressed", "true");
        await expect(video).toHaveAttribute("aria-pressed", "false");
        await video.click();

        const map = page.locator('.export-panel__ov-row[data-widget="map"]');
        const name = map.getByRole("button");
        await expect(map.getByRole("checkbox")).toHaveAccessibleName(await name.innerText());
        await name.click();
        await expect(name).toHaveAttribute("aria-expanded", "true");
        const circle = page.locator('button[data-shape="circle"]');
        await circle.click();
        await expect(circle).toHaveAttribute("aria-pressed", "true");
        await expect(page.locator('button[data-shape="rect"]')).toHaveAttribute("aria-pressed", "false");
        await name.click();
        await expect(name).toHaveAttribute("aria-expanded", "false");
        await expect(page.locator("#export-panel-overlay-inspector")).toBeHidden();
    });

    test("closing the drawer restores focus and removes its controls from keyboard navigation", async ({ page }) => {
        await page.locator("#export-panel-close").click();
        await expect(page.locator("#player-export")).toBeFocused();
        await expect(page.locator("#export-panel")).toHaveAttribute("inert", "");
        await page.keyboard.press("Enter");
        await expect(page.locator("#export-panel")).toBeVisible();
        await expect(page.locator("#export-panel")).not.toHaveAttribute("inert", "");
    });

    test("changing export quality keeps the clip preview playing", async ({ page }) => {
        await page.locator("#export-trim-preview").click();
        await expect(page.locator("#player-play")).toHaveAttribute("data-paused", "false");
        await page.locator('.export-panel__radio input[value="low"]').check();
        await expect(page.locator("#player-play")).toHaveAttribute("data-paused", "false");
    });

    test("editing a blur zone keeps its timing control focused and deleting it returns to Add", async ({ page }) => {
        await page.locator(".export-panel__blur-add-btn").click();
        const layer = page.locator('.video-tile[data-channel="front"] .blur-draw-layer');
        await expect(layer).toBeVisible();
        const box = await layer.boundingBox();
        expect(box).not.toBeNull();
        await page.mouse.move(box!.x + box!.width * 0.4, box!.y + box!.height * 0.4);
        await page.mouse.down();
        await page.mouse.move(box!.x + box!.width * 0.6, box!.y + box!.height * 0.6, { steps: 6 });
        await page.mouse.up();
        await expect(page.locator(".export-panel__blur-row")).toHaveCount(1);
        await page.locator("#player-play").focus();
        await page.keyboard.press("5");
        const start = page.locator(".export-panel__blur-row-actions button").first();
        await start.click();
        await expect(start).toBeFocused();
        await page.locator(".export-panel__blur-del-btn").click();
        await expect(page.locator(".export-panel__blur-add-btn")).toBeFocused();
    });

    test.describe("mobile", () => {
        test.use({ viewport: MOBILE });

        test("privacy and overlays start collapsed", async ({ page }) => {
            for (const title of ["Hide plates & faces", "Overlays"]) {
                const section = page.locator(".export-panel__disclosure").filter({
                    has: page.locator(":scope > summary", { hasText: title }),
                });
                await expect(section).not.toHaveAttribute("open");
                await expect(section.locator(":scope > summary")).toBeVisible();
                await expect(section.locator(":scope > fieldset")).toBeHidden();
            }
        });
    });
});

for (const { name, viewport, hasTouch, targetWidth } of [
    { name: "desktop", viewport: DESKTOP, hasTouch: false, targetWidth: 16 },
    { name: "phone", viewport: MOBILE, hasTouch: true, targetWidth: 36 },
    { name: "tablet", viewport: { width: 1024, height: 768 }, hasTouch: true, targetWidth: 36 },
]) {
    test.describe(`short export ranges on ${name}`, () => {
        test.use({ viewport, hasTouch, viewerMap: "route-only", reducedMotion: "reduce" });

        test("both boundary targets remain distinct and drag without jumping", async ({ page }) => {
            await presetLocalStorage(page);
            await gotoApp(page, "en");
            await loadTrip(page, path.join(REPO_ROOT, "tests/testdata/asymmetric-channels"));
            await pausePlayback(page);
            await openExport(page, false);

            const startInput = page.locator('.export-trim-bar__input[data-range-edge="start"]');
            const endInput = page.locator('.export-trim-bar__input[data-range-edge="end"]');
            const tabs = {
                start: page.locator(".timeline-range__tab--start"),
                end: page.locator(".timeline-range__tab--end"),
            };
            await expect(tabs.end).toHaveAttribute("aria-valuemax", "104");
            const edgeValue = async (edge: "start" | "end") => Number(await tabs[edge].getAttribute("aria-valuenow"));
            const assertGripOwners = async () => {
                const grips = await page.locator(".timeline-range__tab").evaluateAll((elements) =>
                    elements.map((element) => {
                        const box = element.getBoundingClientRect();
                        const grip = getComputedStyle(element, "::after");
                        const centerX = box.x + Number.parseFloat(grip.left);
                        const width = Number.parseFloat(grip.width);
                        const y = box.y + Number.parseFloat(grip.top) + Number.parseFloat(grip.height) / 2;
                        const edge = element.classList.contains("timeline-range__tab--start") ? "start" : "end";
                        const mask = document.querySelector(
                            `.timeline-range__mask--${edge === "start" ? "left" : "right"}`,
                        );
                        if (!mask) throw new Error("range mask missing");
                        const maskBox = mask.getBoundingClientRect();
                        return {
                            edge,
                            left: centerX - width / 2,
                            right: centerX + width / 2,
                            spine: box.x + Number.parseFloat(getComputedStyle(element, "::before").left),
                            boundary: edge === "start" ? maskBox.right : maskBox.left,
                            owners: [-width / 2 + 0.5, 0, width / 2 - 0.5].map((offset) => {
                                const target = document
                                    .elementFromPoint(centerX + offset, y)
                                    ?.closest(".timeline-range__tab");
                                if (!target) return null;
                                return target.classList.contains("timeline-range__tab--start") ? "start" : "end";
                            }),
                        };
                    }),
                );
                for (const grip of grips) {
                    expect(grip.owners, "both visible edges and the center hit the grip's own boundary").toEqual([
                        grip.edge,
                        grip.edge,
                        grip.edge,
                    ]);
                    expect(grip.spine, "displaced grips keep their spine at the true range boundary").toBeCloseTo(
                        grip.boundary,
                        1,
                    );
                }
                expect(grips[1]!.left - grips[0]!.right, "colored grips have a visible gap").toBeGreaterThanOrEqual(
                    1.5,
                );
            };
            const touch = hasTouch ? await page.context().newCDPSession(page) : null;
            const pointerDown = async (x: number, y: number) => {
                if (touch) {
                    await touch.send("Input.dispatchTouchEvent", {
                        type: "touchStart",
                        touchPoints: [{ x, y, id: 1 }],
                    });
                } else {
                    await page.mouse.move(x, y);
                    await page.mouse.down();
                }
            };
            const pointerMove = async (x: number, y: number) => {
                if (touch) {
                    await touch.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y, id: 1 }] });
                } else {
                    await page.mouse.move(x, y);
                }
            };
            const pointerUp = async () => {
                if (touch) await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
                else await page.mouse.up();
            };

            for (const rangeStart of [50, 1, 102]) {
                for (const edge of ["start", "end"] as const) {
                    await startInput.fill("0");
                    await startInput.press("Enter");
                    await endInput.fill(String(rangeStart + 1));
                    await endInput.press("Enter");
                    await startInput.fill(String(rangeStart));
                    await startInput.press("Enter");
                    await page.locator("#player-chart").scrollIntoViewIfNeeded();

                    const start = await boxOf(page, ".timeline-range__tab--start");
                    const end = await boxOf(page, ".timeline-range__tab--end");
                    const host = await boxOf(page, "#player-chart");
                    expect(start.width, "range target follows pointer capability").toBe(targetWidth);
                    expect(end.width, "both boundaries keep their full target width").toBe(targetWidth);
                    const owners = await page.evaluate(
                        ({ start, end, host }) =>
                            [start, end].flatMap((box) =>
                                [0.25, 0.75].map((fraction) => {
                                    const left = Math.max(box.x, host.x);
                                    const right = Math.min(box.x + box.width, host.x + host.width);
                                    const target = document
                                        .elementFromPoint(left + (right - left) * fraction, box.y + box.height / 2)
                                        ?.closest(".timeline-range__tab");
                                    if (!target) return null;
                                    return target.classList.contains("timeline-range__tab--start") ? "start" : "end";
                                }),
                            ),
                        { start, end, host },
                    );
                    expect(owners, "each boundary owns both halves of its target").toEqual([
                        "start",
                        "start",
                        "end",
                        "end",
                    ]);
                    await assertGripOwners();

                    const box = edge === "start" ? start : end;
                    const x = box.x + box.width / 2;
                    const y = box.y + box.height / 2;
                    const direction = edge === "start" ? -1 : 1;
                    const before = await edgeValue(edge);
                    const other = edge === "start" ? "end" : "start";
                    const otherBefore = await edgeValue(other);
                    await pointerDown(x, y);
                    await expect(tabs[edge]).toHaveClass(/is-dragging/);
                    await pointerMove(x + direction, y);
                    expect(
                        Math.abs((await edgeValue(edge)) - before),
                        "one-pixel movement does not jump to the hit box",
                    ).toBeLessThan(0.5);
                    await pointerMove(x + direction * 40, y);
                    expect(
                        direction * ((await edgeValue(edge)) - before),
                        "captured drag moves the intended boundary",
                    ).toBeGreaterThan(0.5);
                    expect(await edgeValue(other), "drag keeps the opposite boundary fixed").toBeCloseTo(
                        otherBefore,
                        4,
                    );
                    await pointerUp();
                    await expect(tabs[edge]).not.toHaveClass(/is-dragging/);
                }
            }

            // Grab the outer edge of each split target: its offset from the
            // spine can exceed the gutter. One continuous drag must still reach
            // the trip endpoint before the pointer leaves the visible host.
            for (const edge of ["start", "end"] as const) {
                await startInput.fill("0");
                await startInput.press("Enter");
                await endInput.fill("51");
                await endInput.press("Enter");
                await startInput.fill("50");
                await startInput.press("Enter");
                const box = await boxOf(page, `.timeline-range__tab--${edge}`);
                const host = await boxOf(page, "#player-chart");
                const x = edge === "start" ? box.x + 1 : box.x + box.width - 1;
                const y = box.y + box.height / 2;
                await pointerDown(x, y);
                await expect(tabs[edge]).toHaveClass(/is-dragging/);
                await pointerMove(edge === "start" ? host.x : host.x + host.width - 1, y);
                expect(await edgeValue(edge), "outer target grab reaches the trip endpoint").toBe(
                    edge === "start" ? 0 : 104,
                );
                await pointerUp();
            }

            // A boundary just outside the view still has a directional grip.
            // Its target must not cover the nearby boundary that remains inside.
            await startInput.fill("0");
            await startInput.press("Enter");
            await endInput.fill("103");
            await endInput.press("Enter");
            await startInput.fill("1");
            await startInput.press("Enter");
            await page.locator("#export-trim-preview").click();
            await pausePlayback(page);
            for (const [rangeStart, rangeEnd, offscreenEdge] of [
                [0, 2, "start"],
                [102, 104, "end"],
            ] as const) {
                await startInput.fill("0");
                await startInput.press("Enter");
                await endInput.fill(String(rangeEnd));
                await endInput.press("Enter");
                await startInput.fill(String(rangeStart));
                await startInput.press("Enter");
                await page.locator("#player-chart").scrollIntoViewIfNeeded();
                await expect(tabs[offscreenEdge]).toHaveClass(/is-offscreen/);
                await assertGripOwners();
            }
            await touch?.detach();
        });
    });
}
