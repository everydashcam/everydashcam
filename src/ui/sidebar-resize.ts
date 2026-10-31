// Drag handle between sidebar and main area. Width stored in --sidebar-width on :root and persisted to localStorage.
// mousemove is on document because the cursor can escape the handle during fast drags.
// Also owns the collapse toggle (body.sidebar-collapsed + the edge tab) -
// collapse is the other way the user manages the same column's width.

import { dom } from "./dom.js";
import { isMobileLayout } from "./media-queries.js";

const SIDEBAR_WIDTH_KEY = "everydashcam:sidebar-width";
const SIDEBAR_MIN = 200;
const SIDEBAR_MAX = 600;

function maxSidebarWidth(): number {
    // Match layout.css's viewport cap so keyboard steps start at the visible edge.
    return Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, window.innerWidth - 320));
}

function syncResizeValue(): void {
    if (isMobileLayout()) return;
    const width = dom.sidebar.getBoundingClientRect().width;
    if (width < SIDEBAR_MIN) return;
    dom.sidebarResize.setAttribute("aria-valuemin", String(SIDEBAR_MIN));
    dom.sidebarResize.setAttribute("aria-valuemax", String(maxSidebarWidth()));
    dom.sidebarResize.setAttribute("aria-valuenow", String(Math.round(width)));
}

function applySidebarWidth(width: number): number {
    const clamped = Math.max(SIDEBAR_MIN, Math.min(maxSidebarWidth(), width));
    document.documentElement.style.setProperty("--sidebar-width", `${clamped}px`);
    syncResizeValue();
    return clamped;
}

function lsGet(key: string): string | null {
    try {
        return localStorage.getItem(key);
    } catch {
        // Private mode or storage disabled - silent fall through to defaults.
        return null;
    }
}

function lsSet(key: string, value: string): void {
    try {
        localStorage.setItem(key, value);
    } catch {
        // Quota exceeded or storage disabled - persistence is best-effort.
    }
}

function restoreSidebarWidth(): void {
    const saved = parseInt(lsGet(SIDEBAR_WIDTH_KEY) || "", 10);
    if (Number.isFinite(saved) && saved >= SIDEBAR_MIN && saved <= SIDEBAR_MAX) {
        document.documentElement.style.setProperty("--sidebar-width", `${saved}px`);
    }
}

/** Applies the collapsed state to the DOM: the body class drives the CSS
 *  (0-track column + edge tab visibility), aria-expanded mirrors it on both
 *  toggles for screen readers. */
function applySidebarCollapsed(collapsed: boolean): void {
    document.body.classList.toggle("sidebar-collapsed", collapsed);
    dom.sidebarCollapseBtn.setAttribute("aria-expanded", String(!collapsed));
    dom.sidebarExpandTab.setAttribute("aria-expanded", String(!collapsed));
}

function setSidebarCollapsed(collapsed: boolean): void {
    applySidebarCollapsed(collapsed);
    // The vanished control would strand keyboard focus on a hidden element;
    // hand it to the counterpart so Tab keeps working from the same spot.
    (collapsed ? dom.sidebarExpandTab : dom.sidebarCollapseBtn).focus();
}

export function initSidebarResize(): void {
    restoreSidebarWidth();
    dom.sidebarResize.setAttribute("aria-controls", dom.sidebar.id);
    syncResizeValue();
    new ResizeObserver(syncResizeValue).observe(dom.sidebar);
    window.addEventListener("resize", syncResizeValue);
    // Session-only on purpose (no persistence): a fresh page always shows the
    // list - it is the only way to pick a trip to watch.
    dom.sidebarCollapseBtn.addEventListener("click", () => setSidebarCollapsed(true));
    dom.sidebarExpandTab.addEventListener("click", () => setSidebarCollapsed(false));

    let sidebarDragging = false;

    dom.sidebarResize.addEventListener("mousedown", (e) => {
        if (e.button !== 0 || isMobileLayout()) return;
        e.preventDefault();
        sidebarDragging = true;
        dom.sidebarResize.classList.add("dragging");
        document.body.classList.add("sidebar-resizing");
    });

    document.addEventListener("mousemove", (e) => {
        if (!sidebarDragging) return;
        applySidebarWidth(e.clientX);
    });

    const finishDrag = (): void => {
        if (!sidebarDragging) return;
        sidebarDragging = false;
        dom.sidebarResize.classList.remove("dragging");
        document.body.classList.remove("sidebar-resizing");
        const cur = document.documentElement.style.getPropertyValue("--sidebar-width");
        const w = parseInt(cur, 10);
        if (Number.isFinite(w)) lsSet(SIDEBAR_WIDTH_KEY, String(w));
    };
    document.addEventListener("mouseup", finishDrag);
    window.addEventListener("blur", finishDrag);

    // Arrow keys when the handle is focused shift by 16 px for accessibility.
    dom.sidebarResize.addEventListener("keydown", (e) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
        if (isMobileLayout()) return;
        e.preventDefault();
        const cur = dom.sidebar.getBoundingClientRect().width;
        const step = e.key === "ArrowLeft" ? -16 : 16;
        const target = e.key === "Home" ? SIDEBAR_MIN : e.key === "End" ? maxSidebarWidth() : cur + step;
        const w = applySidebarWidth(target);
        lsSet(SIDEBAR_WIDTH_KEY, String(w));
    });
}
