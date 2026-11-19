// Overflow-bar configuration for the topbar.
// When the header shrinks the low-priority buttons (what's new/offline-use/feedback/
// theme/settings) move into the kebab menu. Bell and language stay visible.
//
// This module is only wiring: which buttons collapse, in what order, how they
// look in the menu. The generic measuring and rendering logic is in
// ./overflow-bar.ts.

import { type I18nKey, t } from "../i18n/index.js";
import { type OverflowableItem, initOverflowBar } from "./overflow-bar.js";

export function initTopbarOverflow() {
    const topbar = document.querySelector<HTMLElement>(".topbar");
    const button = document.getElementById("topbar-overflow") as HTMLButtonElement | null;
    const menu = document.getElementById("topbar-overflow-menu") as HTMLUListElement | null;
    if (!topbar || !button || !menu) {
        // On a landing/test page not all elements may be present;
        // overflow is not needed without them.
        return;
    }

    const feedbackBtn = document.getElementById("feedback-btn") as HTMLButtonElement | null;
    const offlineUseBtn = document.getElementById("offline-use-btn") as HTMLButtonElement | null;
    const whatsNewBtn = document.getElementById("whats-new-btn") as HTMLButtonElement | null;
    const settingsBtn = document.getElementById("settings-btn") as HTMLButtonElement | null;
    const themeToggle = topbar.querySelector<HTMLElement>(".theme-toggle");

    const items: OverflowableItem[] = [];

    const portableLinks: { id: string; key?: I18nKey; priority: number }[] = [
        { id: "portable-update", key: "portable.update", priority: 3 },
        { id: "portable-full-version", key: "portable.fullVersion", priority: 4 },
        { id: "portable-github", priority: 5 },
    ];
    for (const { id, key, priority } of portableLinks) {
        const link = document.getElementById(id);
        if (!link) continue;
        items.push({
            el: link,
            priority,
            label: () => (key ? t(key) : (link.textContent ?? "")),
            isAvailable: () => !link.hidden,
        });
    }

    if (whatsNewBtn) {
        items.push({
            el: whatsNewBtn,
            // Collapses first: the panel is a curiosity, not a control. The
            // unread dot is invisible while collapsed - accepted, the badge is
            // a quiet hint and the kebab must not inherit its urgency.
            priority: 5,
            label: () => t("whatsnew.title"),
        });
    }

    if (feedbackBtn) {
        items.push({
            el: feedbackBtn,
            priority: 2,
            label: () => t("feedback.entry.title"),
            isAvailable: () => !feedbackBtn.hidden,
        });
    }

    if (offlineUseBtn) {
        items.push({
            el: offlineUseBtn,
            priority: 1,
            label: () => t("offlineUse.entry"),
        });
    }

    if (themeToggle) {
        items.push({
            el: themeToggle,
            priority: 3,
            label: () => t("theme.label"),
            // Custom render: move the whole theme-toggle group as a menu
            // section. Heading + three radio buttons in a row, just like in
            // the bar. We take the buttons from the original via
            // querySelectorAll - their click handlers are already wired by
            // initThemeToggle, we only forward the click.
            customMenuRow: () => renderThemeRow(themeToggle, () => handle.close()),
        });
    }

    if (settingsBtn) {
        items.push({
            el: settingsBtn,
            priority: 0,
            label: () => t("settings.entry.title"),
        });
    }

    const handle = initOverflowBar({
        container: topbar,
        overflowButton: button,
        overflowMenu: menu,
        items,
    });

    // The trips burger (#topbar-burger) is always-visible primary nav, not an
    // overflow item, so the bar never collapses it - but it is revealed/hidden
    // by body.browsing on the mobile browse<->watch transition (see topbar.css).
    // That toggle widens the row via a descendant `display` change driven from an
    // ANCESTOR class: it touches no topbar attribute and does not resize the
    // container's own box, so neither the overflow-bar's attribute observer nor
    // its ResizeObserver sees it - the row would inflate past the screen on
    // mobile (layout-viewport blow-out) without collapsing. Watch body's class
    // and remeasure synchronously: one over-wide painted frame is enough to
    // expand the mobile layout viewport, matching the overflow-bar's own
    // synchronous attribute path.
    let wasBrowsing = document.body.classList.contains("browsing");
    const browseObserver = new MutationObserver(() => {
        const browsing = document.body.classList.contains("browsing");
        if (browsing === wasBrowsing) return; // ignore unrelated body-class changes
        wasBrowsing = browsing;
        handle.remeasure({ immediate: true });
    });
    browseObserver.observe(document.body, { attributes: true, attributeFilter: ["class"] });

    return handle;
}

/** Render the theme-toggle row in the overflow menu. Inline copy of the bar's
 *  group to keep the "three auto/light/dark buttons" - a text row would hide
 *  the affordance: which mode is active and how to switch. */
function renderThemeRow(originalToggle: HTMLElement, closeMenu: () => void): HTMLElement {
    const li = document.createElement("li");
    li.className = "overflow-menu-item overflow-menu-item--theme";
    li.setAttribute("role", "none");

    const label = document.createElement("span");
    label.className = "overflow-menu-section-label";
    label.textContent = t("theme.label");

    const group = document.createElement("div");
    group.className = "overflow-menu-theme-group";
    group.setAttribute("role", "radiogroup");
    group.setAttribute("aria-label", t("theme.label"));

    const origBtns = originalToggle.querySelectorAll<HTMLButtonElement>(".theme-toggle-btn");
    for (const orig of origBtns) {
        const clone = document.createElement("button");
        clone.type = "button";
        clone.className = "overflow-menu-theme-btn";
        clone.setAttribute("data-theme", orig.dataset.theme ?? "");
        clone.setAttribute("aria-pressed", orig.getAttribute("aria-pressed") ?? "false");
        clone.setAttribute("aria-label", orig.getAttribute("aria-label") ?? "");
        clone.setAttribute("title", orig.getAttribute("title") ?? "");

        const svg = orig.querySelector("svg");
        if (svg) clone.appendChild(svg.cloneNode(true));

        clone.addEventListener("click", (e) => {
            e.stopPropagation();
            orig.click();
            // After the click, update aria-pressed on all clones in sync with
            // the original - so the user sees the active button without
            // reopening the menu.
            for (const c of group.querySelectorAll<HTMLButtonElement>(".overflow-menu-theme-btn")) {
                const origMatch = originalToggle.querySelector<HTMLButtonElement>(
                    `.theme-toggle-btn[data-theme="${c.dataset.theme}"]`,
                );
                c.setAttribute("aria-pressed", origMatch?.getAttribute("aria-pressed") ?? "false");
            }
            closeMenu();
        });

        group.appendChild(clone);
    }

    li.appendChild(label);
    li.appendChild(group);
    return li;
}
