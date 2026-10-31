import type { Page } from "@playwright/test";

/** Exercise capability fallback paths in the actual hosted/portable application. */
export async function omitModernBrowserApis(page: Page): Promise<void> {
    await page.addInitScript(() => {
        Object.defineProperty(AbortSignal, "any", { configurable: true, value: undefined });
        for (const name of ["showPopover", "hidePopover", "togglePopover"]) {
            Object.defineProperty(HTMLElement.prototype, name, { configurable: true, value: undefined });
        }
        const matches = Element.prototype.matches;
        Object.defineProperty(Element.prototype, "matches", {
            configurable: true,
            value(this: Element, selector: string): boolean {
                if (selector.includes(":popover-open")) throw new DOMException("unsupported selector", "SyntaxError");
                return matches.call(this, selector);
            },
        });
    });
}
