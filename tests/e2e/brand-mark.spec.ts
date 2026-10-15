import type { Locator, Page } from "@playwright/test";
import { SUPPORTED_BRANDS } from "../../vite-plugins/supported-brands.js";
import { expect, gotoApp, loadTrip, presetLocalStorage, test } from "./_fixtures.js";

test.use({ viewerMap: "route-only" });

const positions = (columns: Locator) =>
    columns.evaluateAll((elements) =>
        elements.map((column) => Number((column as HTMLElement).style.getPropertyValue("--edc-letter-index"))),
    );
const visibleWord = (columns: Locator) =>
    columns.evaluateAll((elements) =>
        elements
            .map((column) => {
                const drum = column.parentElement!.getBoundingClientRect();
                return Array.from(column.children).find((letter) => {
                    const rect = letter.getBoundingClientRect();
                    return rect.top + rect.height / 2 > drum.top && rect.top + rect.height / 2 < drum.bottom;
                })?.textContent;
            })
            .join("")
            .trimEnd(),
    );
async function prepare(page: Page): Promise<void> {
    await presetLocalStorage(page);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await gotoApp(page);
    await expect(page.locator(".topbar .edc-mark")).toHaveClass(/edc-mark--interactive/);
    await expect(page.locator(".topbar .edc-mark")).not.toHaveClass(/edc-mark--animated/);
}

async function hoverBrand(mark: Locator, random: number): Promise<void> {
    await mark.evaluate((element, value) => {
        // Map workers use random request IDs; only the synchronous brand
        // shuffle may be deterministic, never unrelated application work.
        const original = Math.random;
        Math.random = () => value;
        try {
            element.dispatchEvent(new MouseEvent("mouseenter"));
        } finally {
            Math.random = original;
        }
    }, random);
}

for (const initialMode of ["compact", "reduced-motion"]) {
    test(`the ${initialMode} logo keeps its static letters until animation becomes available`, async ({ page }) => {
        await presetLocalStorage(page);
        await page.setViewportSize({ width: initialMode === "compact" ? 375 : 1280, height: 900 });
        await page.emulateMedia({ reducedMotion: initialMode === "reduced-motion" ? "reduce" : "no-preference" });
        await gotoApp(page);
        const mark = page.locator(".topbar .edc-mark");
        const columns = mark.locator(".edc-mark__column");
        await expect(mark).toHaveAccessibleName("everydashcam");
        await expect(columns).toHaveCount(5);
        await expect(mark.locator(".edc-mark__letter")).toHaveCount(5);
        await hoverBrand(mark, 0);
        await expect(mark).not.toHaveClass(/edc-mark--interactive/);
        await expect(mark).not.toHaveClass(/edc-mark--animated/);

        await page.setViewportSize({ width: 1280, height: 900 });
        await page.emulateMedia({ reducedMotion: "no-preference" });
        await expect.poll(() => visibleWord(columns)).toBe("EVERY");
        await page.clock.install();
        await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 1000);
        await hoverBrand(mark, 0);
        await expect(mark).toHaveClass(/edc-mark--interactive/);
        await page.clock.runFor(1400);
        expect(await visibleWord(columns)).toBe("70MAI");
        await mark.dispatchEvent("mouseleave");
        await page.clock.runFor(1400);
        expect(await visibleWord(columns)).toBe("EVERY");
        await expect(mark.locator(".edc-mark__word")).toHaveCSS("opacity", "1");
        await expect(mark).not.toHaveClass(/edc-mark--animated/);
        await page.clock.resume();
    });
}

test("brand odometer rolls forward, starts and stops on the right, and respects reduced motion", async ({ page }) => {
    await prepare(page);
    const mark = page.locator(".topbar .edc-mark");
    const columns = mark.locator(".edc-mark__column");
    await expect(mark).toHaveAccessibleName("everydashcam");
    await expect(mark).toHaveRole("img");
    await expect(columns).toHaveCount(Math.max(...SUPPORTED_BRANDS.map((brand) => brand.displayName.length)));
    const wheelSize = (await columns.first().locator(".edc-mark__letter").count()) / 2;
    await expect.poll(() => visibleWord(columns)).toBe("EVERY");
    await page.clock.install();
    await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 1000);
    const initial = await positions(columns);
    await hoverBrand(mark, 0);

    await page.clock.runFor(200); // DASHCAM exits first; the right drum then starts.
    await expect(mark.locator(".edc-mark__word")).toHaveCSS("opacity", "0");
    const first = await positions(columns);
    expect(first.slice(0, 4)).toEqual(initial.slice(0, 4));
    expect(first[4]).not.toBe(initial[4]);
    await page.clock.runFor(40);
    const second = await positions(columns);
    expect(second.slice(0, 3)).toEqual(initial.slice(0, 3));
    expect(second[3]).not.toBe(initial[3]);

    // Actual travel per frame: every drum moves upward through its character
    // wheel, and every right drum moves farther in the same elapsed time.
    await page.clock.runFor(200);
    const before = await positions(columns);
    await page.clock.runFor(16);
    const after = await positions(columns);
    const travel = after.slice(0, 5).map((position, index) => (position - before[index]! + wheelSize) % wheelSize);
    for (const distance of travel) {
        expect(distance).toBeGreaterThan(0);
        expect(distance).toBeLessThan(8);
    }
    for (let index = 1; index < travel.length; index++) {
        expect(travel[index]!).toBeGreaterThan(travel[index - 1]! * 1.05);
    }

    await page.clock.runFor(500); // after the word exit, the left drum stops first
    expect((await positions(columns))[0]).toBe(34); // 7
    await expect(mark).toHaveClass(/edc-mark--animated/);
    await page.clock.runFor(180);
    expect((await positions(columns)).slice(0, 3)).toEqual([34, 27, 13]); // 70M
    await page.clock.runFor(80);
    expect((await positions(columns)).slice(0, 4)).toEqual([34, 27, 13, 1]); // 70MA
    await expect(mark).toHaveClass(/edc-mark--animated/); // rightmost still rolls
    await page.clock.runFor(112);
    expect(await visibleWord(columns)).toBe("70MAI");
    await expect(mark).not.toHaveClass(/edc-mark--animated/);
    await page.screenshot({ path: test.info().outputPath("brand-hover.png") });
    await page.clock.runFor(200);
    expect(await visibleWord(columns)).toBe("70MAI"); // hold starts after all stops
    await page.clock.runFor(180);
    await expect(mark).toHaveClass(/edc-mark--animated/);
    await page.clock.runFor(1100);
    // With a zero shuffle draw, the first brand is followed by the catalog tail in reverse order.
    expect(await visibleWord(columns)).toBe(SUPPORTED_BRANDS.at(-1)!.displayName.toUpperCase());
    await expect(mark.locator(".edc-mark__word")).toHaveCSS("opacity", "0");
    await mark.dispatchEvent("mouseleave");
    await page.clock.runFor(1400);
    expect(await visibleWord(columns)).toBe("EVERY");
    await expect(mark.locator(".edc-mark__word")).toHaveCSS("opacity", "1");
    await expect(mark).not.toHaveClass(/edc-mark--animated/);
    await page.clock.runFor(10_000);
    expect(await positions(columns)).toEqual(initial);

    await page.mouse.move(0, 200);
    await mark.hover();
    await page.clock.runFor(1400);
    expect(await visibleWord(columns)).toBe(SUPPORTED_BRANDS.at(-2)!.displayName.toUpperCase());
    // Media-query changes are delivered by the browser's rendering cycle,
    // independently of Playwright's mocked animation-frame clock.
    await page.clock.resume();
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect.poll(() => visibleWord(columns)).toBe("EVERY");
    await expect(mark).not.toHaveClass(/edc-mark--animated/);
    await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 100);
    await page.mouse.move(0, 200);
    await mark.hover();
    await page.clock.runFor(4000);
    expect(await positions(columns)).toEqual(initial);
    await page.clock.resume();
    await page.reload();
    await expect.poll(() => visibleWord(columns)).toBe("EVERY");
    await expect(mark).not.toHaveClass(/edc-mark--animated/);

    await loadTrip(page);
    await page.locator("#notif-bell").evaluate((element) => {
        (element as HTMLButtonElement).hidden = false;
    });
    await page.setViewportSize({ width: 320, height: 720 });
    await expect(mark.locator(".dc-mark__compact")).toBeVisible();
    await expect(mark.locator(".edc-mark__word")).toBeHidden();
    for (const selector of [".topbar-burger", "#notif-bell", "#lang-toggle", "#topbar-overflow"]) {
        const button = page.locator(selector);
        await expect(button).toBeVisible();
        await expect(button).toBeInViewport({ ratio: 1 });
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
    await page.setViewportSize({ width: 1280, height: 900 });
    await expect(mark.locator(".edc-mark__word")).toBeVisible();
    expect(await visibleWord(columns)).toBe("EVERY");
    await expect
        .poll(() =>
            mark.locator(".edc-mark__drums").evaluate((deck) => {
                const transform = getComputedStyle(deck).transform;
                return new DOMMatrixReadOnly(transform === "none" ? undefined : transform).isIdentity;
            }),
        )
        .toBe(true);
});

test("brand odometer displays the hyphen in E-ACE", async ({ page }) => {
    await prepare(page);
    const mark = page.locator(".topbar .edc-mark");
    const columns = mark.locator(".edc-mark__column");
    const brandIndex = SUPPORTED_BRANDS.findIndex((brand) => brand.displayName === "E-ACE");
    expect(brandIndex).toBeGreaterThanOrEqual(0);
    await page.clock.install();
    await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 1000);
    await hoverBrand(mark, (brandIndex + 0.5) / SUPPORTED_BRANDS.length);
    await page.clock.runFor(1400);
    expect(await visibleWord(columns)).toBe("E-ACE");
    await expect(mark).not.toHaveClass(/edc-mark--animated/);
    await page.clock.resume();
});

test("leaving and reentering the logo redirects the moving drums without stale timers", async ({ page }) => {
    await prepare(page);
    const mark = page.locator(".topbar .edc-mark");
    const columns = mark.locator(".edc-mark__column");
    await page.clock.install();
    await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 1000);
    for (const elapsed of [40, 400, 1400]) {
        await mark.hover();
        await page.clock.runFor(elapsed);
        const beforeLeave = await positions(columns);
        await page.mouse.move(0, 200);
        expect(await positions(columns)).toEqual(beforeLeave);
        await page.clock.runFor(100);
        const beforeReenter = await positions(columns);
        await mark.hover();
        expect(await positions(columns)).toEqual(beforeReenter);
        await page.clock.runFor(1500);
        expect(await visibleWord(columns)).not.toBe("EVERY");
        await expect(mark.locator(".edc-mark__word")).toHaveCSS("opacity", "0");
        await page.mouse.move(0, 200);
        await page.clock.runFor(1700);
        expect(await visibleWord(columns)).toBe("EVERY");
        await expect(mark.locator(".edc-mark__word")).toHaveCSS("opacity", "1");
        await expect(mark).not.toHaveClass(/edc-mark--animated/);
        const resting = await positions(columns);
        await page.clock.runFor(5000);
        expect(await positions(columns)).toEqual(resting);
    }
    await page.clock.resume();
});

test("the drum count settles before the new letters in both directions", async ({ page }) => {
    await prepare(page);
    const mark = page.locator(".topbar .edc-mark");
    const columns = mark.locator(".edc-mark__column");
    const visibleDrums = () =>
        mark.evaluate(
            (element) =>
                Array.from(element.querySelectorAll(".edc-mark__drum")).filter((drum) => {
                    const rect = drum.getBoundingClientRect();
                    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
                    return hit && drum.contains(hit);
                }).length,
        );
    await page.clock.install();
    await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 1000);
    const longest = SUPPORTED_BRANDS.reduce((a, b) => (a.displayName.length > b.displayName.length ? a : b));
    await hoverBrand(mark, (SUPPORTED_BRANDS.indexOf(longest) + 0.5) / SUPPORTED_BRANDS.length);
    await page.clock.runFor(400);
    expect(await visibleDrums()).toBe(longest.displayName.length);
    expect(await visibleWord(columns)).not.toBe(longest.displayName.toUpperCase());
    await page.clock.runFor(900);
    expect(await visibleWord(columns)).toBe(longest.displayName.toUpperCase());
    await mark.dispatchEvent("mouseleave");
    await page.clock.runFor(240);
    expect(await visibleDrums()).toBe(5);
    expect(await visibleWord(columns)).not.toBe("EVERY");
    await page.clock.runFor(1100);
    expect(await visibleWord(columns)).toBe("EVERY");
    expect(await visibleDrums()).toBe(5);
    await page.clock.resume();
});

test("the orange drum stays visible while brand names expand, retract and reverse", async ({ page }) => {
    await prepare(page);
    const mark = page.locator(".topbar .edc-mark");
    await page.clock.install();
    await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 1000);
    await mark.evaluate((element) => {
        const misses: number[] = [];
        element.setAttribute("data-accent-misses", "[]");
        const sample = () => {
            const orange = element.querySelector(".edc-mark__drum--last")!;
            const rect = orange.getBoundingClientRect();
            let visibleWidth = 0;
            for (let x = rect.left + 0.25; x < rect.right; x += 0.5) {
                const hit = document.elementFromPoint(x, rect.top + rect.height / 2);
                if (hit && orange.contains(hit)) visibleWidth += 0.5;
            }
            if (getComputedStyle(orange).backgroundColor !== "rgb(255, 144, 0)" || visibleWidth < rect.width * 0.4) {
                misses.push(visibleWidth);
                element.setAttribute("data-accent-misses", JSON.stringify(misses));
            }
            requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
    });
    const longest = SUPPORTED_BRANDS.reduce((a, b) => (a.displayName.length > b.displayName.length ? a : b));
    await hoverBrand(mark, (SUPPORTED_BRANDS.indexOf(longest) + 0.5) / SUPPORTED_BRANDS.length);
    await page.clock.runFor(1400);
    await mark.dispatchEvent("mouseleave");
    await page.clock.runFor(1700);
    await hoverBrand(mark, 0);
    await page.clock.runFor(220);
    await mark.dispatchEvent("mouseleave");
    await page.clock.runFor(60);
    await hoverBrand(mark, 0);
    await page.clock.runFor(5000);
    await expect(mark).toHaveAttribute("data-accent-misses", "[]");
    await page.clock.resume();
});

for (const width of [601, 768]) {
    test(`long brand drums use the word's space without moving toolbar controls at ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        await prepare(page);
        await loadTrip(page);
        await page.locator("#notif-bell").evaluate((element) => {
            (element as HTMLButtonElement).hidden = false;
        });
        const mark = page.locator(".topbar .edc-mark");
        const columns = mark.locator(".edc-mark__column");
        await page.clock.install();
        await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 1000);
        const geometry = () =>
            page.evaluate(() => {
                const mark = document.querySelector(".topbar .edc-mark")!.getBoundingClientRect();
                return {
                    mark: { x: mark.x, width: mark.width },
                    controls: Array.from(document.querySelectorAll<HTMLElement>(".topbar button"))
                        .map((button) => ({ id: button.id, rect: button.getBoundingClientRect() }))
                        .filter(({ rect }) => rect.width > 0 && rect.height > 0)
                        .map(({ id, rect }) => ({ id, x: rect.x, right: rect.right })),
                    scrollWidth: document.documentElement.scrollWidth,
                };
            });
        const initial = await geometry();
        for (const control of initial.controls) {
            expect(control.x).toBeGreaterThanOrEqual(0);
            expect(control.right).toBeLessThanOrEqual(width);
        }
        const longest = SUPPORTED_BRANDS.reduce((a, b) => (a.displayName.length > b.displayName.length ? a : b));
        await hoverBrand(mark, (SUPPORTED_BRANDS.indexOf(longest) + 0.5) / SUPPORTED_BRANDS.length);
        for (const elapsed of [64, 160, 560, 616]) {
            await page.clock.runFor(elapsed);
            expect(await geometry()).toEqual(initial);
        }
        expect(await visibleWord(columns)).toBe(longest.displayName.toUpperCase());
        await expect(mark.locator(".edc-mark__word")).toHaveCSS("opacity", "0");
        await expect(mark).toHaveAccessibleName("everydashcam");
        expect(await mark.locator(".edc-mark__word").evaluate((word) => getComputedStyle(word).clipPath)).not.toBe(
            "inset(0px)",
        );
        const last = await mark.locator(".edc-mark__drum").last().boundingBox();
        expect(last!.x + last!.width).toBeLessThanOrEqual(initial.mark.x + initial.mark.width + 0.01);
        await page.screenshot({ path: test.info().outputPath(`brand-long-${width}.png`) });
        await mark.dispatchEvent("mouseleave");
        for (const elapsed of [250, 800, 400, 350]) {
            await page.clock.runFor(elapsed);
            expect(await geometry()).toEqual(initial);
        }
        expect(await visibleWord(columns)).toBe("EVERY");
        await expect(mark.locator(".edc-mark__word")).toHaveCSS("opacity", "1");
        expect(await mark.locator(".edc-mark__word").evaluate((word) => getComputedStyle(word).clipPath)).toBe(
            "inset(0px)",
        );
        await expect(mark).not.toHaveClass(/edc-mark--animated/);
        await page.clock.resume();
    });
}
