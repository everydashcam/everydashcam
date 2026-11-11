import type { Page } from "@playwright/test";
import { expect, gotoApp, loadTrip, presetLocalStorage, test } from "./_fixtures.js";

test.use({ viewerMap: "route-only" });

/**
 * Chromium accepts an emulated display-mode through Emulation.setEmulatedMedia
 * but does not apply it, so make the app's window-controls-overlay media rules
 * always match. The condition is rewritten in place, at any nesting depth, so
 * the rules keep their production cascade position. The app's stylesheets are
 * same-origin and writable through CSSOM.
 */
async function matchWindowControlsOverlayRules(page: Page): Promise<void> {
    const rewrittenRuleCount = await page.evaluate(() => {
        const condition = /\(\s*display-mode\s*:\s*window-controls-overlay\s*\)/g;
        let rewritten = 0;
        const visit = (rules: CSSRuleList) => {
            for (const rule of rules) {
                if (rule instanceof CSSImportRule && rule.styleSheet) visit(rule.styleSheet.cssRules);
                if (rule instanceof CSSMediaRule && condition.test(rule.media.mediaText)) {
                    rule.media.mediaText = rule.media.mediaText.replace(condition, "(min-width: 0px)");
                    rewritten++;
                }
                condition.lastIndex = 0;
                if ("cssRules" in rule && rule.cssRules instanceof CSSRuleList) visit(rule.cssRules);
            }
        };
        for (const sheet of document.styleSheets) {
            let rules: CSSRuleList;
            try {
                rules = sheet.cssRules;
            } catch {
                continue; // Cross-origin sheets are unreadable and carry no app rules.
            }
            visit(rules);
        }
        return rewritten;
    });
    expect(rewrittenRuleCount, "the window-controls-overlay rules exist").toBeGreaterThan(0);
    expect(
        await page.evaluate(() => getComputedStyle(document.body).paddingTop),
        "the window-controls-overlay rules apply",
    ).not.toBe("0px");
}

// In an installed window the OS owns every drag region: pointer, click and
// wheel input there never reach the page, whatever pointer-events or opacity
// say. app-region is inherited, and Chromium reports each box's border box
// without ancestor overflow clipping, so a drag value on a box with
// descendants leaks wherever they overflow (the logo's letter columns span the
// whole window height).
test("the installed window drags only by the title bar strip", async ({ page }) => {
    await presetLocalStorage(page);
    await page.setViewportSize({ width: 1266, height: 680 });
    await gotoApp(page);
    await loadTrip(page);
    await matchWindowControlsOverlayRules(page);

    const regions = await page.evaluate(() => {
        const appRegion = (style: CSSStyleDeclaration) => style.getPropertyValue("app-region");
        const describe = (element: Element) =>
            `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ""}${[...element.classList].map((name) => `.${name}`).join("")}`;
        const topbar = document.querySelector(".topbar");
        if (!topbar) throw new Error("topbar missing");
        const strip = topbar.getBoundingClientRect();
        const leaks: string[] = [];
        const pseudoRegions: string[] = [];
        for (const element of document.querySelectorAll("*")) {
            for (const pseudo of ["::before", "::after"]) {
                const style = getComputedStyle(element, pseudo);
                if (style.content === "none" || style.display === "none" || appRegion(style) !== "drag") continue;
                const insets = [style.top, style.right, style.bottom, style.left];
                pseudoRegions.push(`${describe(element)}${pseudo} ${style.position} ${insets.join(" ")}`);
            }
            const style = getComputedStyle(element);
            // Matches the boxes Chromium turns into regions.
            if (appRegion(style) !== "drag" || style.visibility !== "visible") continue;
            if (element.getClientRects().length === 0) continue;
            const box = element.getBoundingClientRect();
            const isInsideStrip =
                box.top >= strip.top - 0.5 &&
                box.bottom <= strip.bottom + 0.5 &&
                box.left >= strip.left - 0.5 &&
                box.right <= strip.right + 0.5;
            if (element.childElementCount > 0 || !isInsideStrip) {
                leaks.push(
                    `${describe(element)} children=${element.childElementCount} y=${Math.round(box.top)}..${Math.round(box.bottom)}`,
                );
            }
        }
        // Hidden controls count too: a menu or popover opened later must not
        // land on the drag strip.
        const interactive =
            'a[href], button, input, select, textarea, summary, label, [tabindex]:not([tabindex="-1"]), ' +
            '[role="button"], [role="link"], [role="menu"], [role="menuitem"], [role="dialog"]';
        const draggableControls = [...topbar.querySelectorAll(interactive)]
            .filter((control) => appRegion(getComputedStyle(control)) !== "no-drag")
            .map(describe);
        return { pseudoRegions, leaks, draggableControls };
    });

    expect(regions.pseudoRegions, "the title bar strip is the only pseudo-element drag region").toEqual([
        "header.topbar::before absolute 0px 0px 0px 0px",
    ]);
    expect(regions.leaks, "drag regions stay childless and inside the title bar").toEqual([]);
    expect(regions.draggableControls, "title bar controls stay clickable").toEqual([]);
});
