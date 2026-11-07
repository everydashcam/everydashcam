// Drag handle between sidebar and main area. Width stored in --sidebar-width on :root and persisted to localStorage.
// Pointer capture keeps touch, pen and mouse drags attached to the handle.
// Also owns the collapse toggle (body.sidebar-collapsed + the player-bar toggle) -
// collapse is the other way the user manages the same column's width. When the
// expanded map takes the whole column, the same toggle opens the list as the drawer.

import { t } from "../i18n/index.js";
import { readLocalStorage, writeLocalStorage } from "../local-storage.js";
import { dom } from "./dom.js";
import { isMobileLayout } from "./media-queries.js";
import { closeStrandedDrawer, isDesktopListOverlay, setDrawerOpen } from "./mobile-drawer.js";
import { attachPointerDrag } from "./pointer-drag.js";

const SIDEBAR_WIDTH_KEY = "everydashcam:sidebar-width";
const SIDEBAR_MIN = 200;
const SIDEBAR_MAX = 600;

/** The widest sidebar the layout shows right now: the window minus the
 *  viewer reserve layout.css keeps, which the expanded map raises to keep a
 *  desktop-width player. Read from CSS, not repeated here, so drag, keyboard
 *  and aria limits match the visible edge. */
function maxSidebarWidth(): number {
    const viewerReserve = parseFloat(getComputedStyle(document.body).getPropertyValue("--viewer-reserve")) || 0;
    return Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, window.innerWidth - viewerReserve));
}

function syncResizeValue(): void {
    if (isMobileLayout()) return;
    const width = dom.sidebar.getBoundingClientRect().width;
    if (width < SIDEBAR_MIN) return;
    dom.sidebarResize.setAttribute("aria-valuemin", String(SIDEBAR_MIN));
    dom.sidebarResize.setAttribute("aria-valuemax", String(maxSidebarWidth()));
    dom.sidebarResize.setAttribute("aria-valuenow", String(Math.round(width)));
}

function applySidebarWidth(width: number, maxWidth: number): number {
    const clamped = Math.max(SIDEBAR_MIN, Math.min(maxWidth, width));
    document.documentElement.style.setProperty("--sidebar-width", `${clamped}px`);
    // No synchronous syncResizeValue: measuring right after the write forced a
    // layout on every pointermove. The ResizeObserver in initSidebarResize
    // reports the new width after layout, before the frame is painted.
    return clamped;
}

function restoreSidebarWidth(): void {
    const saved = parseInt(readLocalStorage(SIDEBAR_WIDTH_KEY) || "", 10);
    if (Number.isFinite(saved) && saved >= SIDEBAR_MIN && saved <= SIDEBAR_MAX) {
        document.documentElement.style.setProperty("--sidebar-width", `${saved}px`);
    }
}

/** Mirrors whether the list is on screen in the one toggle in the player bar:
 *  icon, label and aria-expanded. While the map holds the column the list
 *  shows only as the drawer, so the drawer state decides; otherwise the
 *  collapsed choice does. */
function syncSidebarToggle(): void {
    const listShown = isDesktopListOverlay()
        ? dom.sidebar.dataset.drawerOpen === "true"
        : !document.body.classList.contains("sidebar-collapsed");
    const toggle = dom.sidebarToggle;
    const label = t(listShown ? "sidebar.collapse" : "sidebar.expand");
    toggle.setAttribute("aria-expanded", String(listShown));
    toggle.setAttribute("aria-label", label);
    toggle.title = label;
    toggle.querySelector<SVGElement>(".i-panel-close")?.toggleAttribute("hidden", !listShown);
    toggle.querySelector<SVGElement>(".i-panel-open")?.toggleAttribute("hidden", listShown);
}

/** Applies the collapsed state to the DOM: the body class drives the CSS
 *  (0-track column), and the toggle mirrors it. */
function applySidebarCollapsed(collapsed: boolean): void {
    document.body.classList.toggle("sidebar-collapsed", collapsed);
    syncSidebarToggle();
}

/** Follows the expanded map's hold on the column: the yield, the narrowed
 *  width and the drawer that replaces the column. Its inputs are classes owned
 *  by several features (map layout, viewer placeholders, export, fullscreen,
 *  no-WebGL) plus the window size, so observing them here replaces a call at
 *  every site that flips one of them. */
function observeSidebarYield(): void {
    const reconcile = (): void => {
        closeStrandedDrawer();
        syncSidebarToggle();
        syncResizeValue();
    };
    // classList.add of a class already present still queues a record, and the
    // fullscreen controls re-add theirs on every pointer move. Only records
    // that changed the attribute reach the style reads.
    const observer = new MutationObserver((records) => {
        if (
            records.some(
                (record) => record.oldValue !== (record.target as Element).getAttribute(record.attributeName ?? ""),
            )
        ) {
            reconcile();
        }
    });
    for (const el of [document.body, dom.viewer, dom.playerWrap]) {
        observer.observe(el, { attributes: true, attributeFilter: ["class"], attributeOldValue: true });
    }
    observer.observe(dom.sidebar, { attributes: true, attributeFilter: ["data-drawer-open"], attributeOldValue: true });
    window.addEventListener("resize", reconcile);
}

export function initSidebarResize(): void {
    restoreSidebarWidth();
    dom.sidebarResize.setAttribute("aria-controls", dom.sidebar.id);
    syncResizeValue();
    new ResizeObserver(syncResizeValue).observe(dom.sidebar);
    window.addEventListener("resize", syncResizeValue);
    // Session-only on purpose (no persistence): a fresh page always shows the
    // list - it is the only way to pick a trip to watch.
    // The toggle keeps focus across the change: it stays where it was.
    applySidebarCollapsed(document.body.classList.contains("sidebar-collapsed"));
    observeSidebarYield();
    dom.sidebarToggle.addEventListener("click", () => {
        // No column to restore while the map holds it: show the list over the
        // player instead of leaving the toggle without an effect.
        if (isDesktopListOverlay()) {
            setDrawerOpen(dom.sidebar.dataset.drawerOpen !== "true");
            return;
        }
        applySidebarCollapsed(!document.body.classList.contains("sidebar-collapsed"));
    });

    // Read once per drag: the limit cannot change mid-drag, and a style read on
    // every pointermove would force a recalc right after each width write.
    let dragMaxWidth = SIDEBAR_MAX;
    attachPointerDrag(dom.sidebarResize, {
        onStart: (e) => {
            if (isMobileLayout()) return false;
            e.preventDefault();
            dragMaxWidth = maxSidebarWidth();
            dom.sidebarResize.classList.add("dragging");
            document.body.classList.add("sidebar-resizing");
            return true;
        },
        onMove: (e) => applySidebarWidth(e.clientX, dragMaxWidth),
        onEnd: () => {
            dom.sidebarResize.classList.remove("dragging");
            document.body.classList.remove("sidebar-resizing");
            const cur = document.documentElement.style.getPropertyValue("--sidebar-width");
            const w = parseInt(cur, 10);
            if (Number.isFinite(w)) writeLocalStorage(SIDEBAR_WIDTH_KEY, String(w));
        },
    });

    // Arrow keys when the handle is focused shift by 16 px for accessibility.
    dom.sidebarResize.addEventListener("keydown", (e) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
        if (isMobileLayout()) return;
        e.preventDefault();
        const cur = dom.sidebar.getBoundingClientRect().width;
        const maxWidth = maxSidebarWidth();
        // Growing at the visible edge changes nothing on screen, so it must not
        // rewrite the stored width either: the expanded map's cap is temporary,
        // and the wider saved width returns when the map collapses.
        if ((e.key === "ArrowRight" || e.key === "End") && cur >= maxWidth - 0.5) return;
        const step = e.key === "ArrowLeft" ? -16 : 16;
        const target = e.key === "Home" ? SIDEBAR_MIN : e.key === "End" ? maxWidth : cur + step;
        const w = applySidebarWidth(target, maxWidth);
        writeLocalStorage(SIDEBAR_WIDTH_KEY, String(w));
    });
}
