// Trip-list drawer. On phones (< 768px) the sidebar slides out via translateX(-100%) and
// the burger opens it. On a narrow desktop window the expanded map can take the whole
// sidebar column (sidebar.css); the same drawer then opens over the player from the
// player-bar list toggle. Scrim/Escape/resize close it. Drawer state is not persisted -
// reload and cross-boundary resize always start with a closed drawer.
//
// Browse state (body.browsing): trips are loaded but none is active yet. On
// mobile the trip list then fills the whole screen instead of hiding behind the
// burger, so the user can pick without first finding a menu. Picking a trip
// (browse -> watch) collapses that full-screen list into the topbar trips icon
// via a FLIP, teaching where the list now lives. See syncBrowseState.

import { createSubscribers } from "../subscribers.js";
import { dom } from "./dom.js";
import { subscribeExportState } from "./export-state.js";
import { flipCollapse } from "./flip.js";
import { isMobileLayout, MOBILE_LAYOUT_QUERY } from "./media-queries.js";
import { focusableWithin } from "./modal-helper.js";
import { state } from "./state.js";

const COLLAPSE_MS = 380;
const COLLAPSE_EASE = "cubic-bezier(0.22, 1, 0.36, 1)"; // ease-out-quint

const placementListeners = createSubscribers<[]>("trip-list-placement");

/**
 * The trip list panel is on screen: always on desktop; on phones while it is
 * the full-screen browse list or the open drawer.
 */
export function isTripListOnScreen(): boolean {
    if (!isMobileViewport()) return true;
    const browsing =
        document.body.classList.contains("browsing") && !document.body.classList.contains("preparing-trip");
    return browsing || dom.sidebar.dataset.drawerOpen === "true";
}

/** Fires whenever the drawer's state is reconciled; isTripListOnScreen may have changed. */
export function subscribeTripListPlacement(listener: () => void): () => void {
    return placementListeners.subscribe(listener);
}

// Once-per-session guard: the teaching collapse runs only on the first
// browse -> watch transition. Later trip switches happen from the open drawer,
// where the close direction is already obvious - replaying it would annoy.
let collapseShown = false;

function isMobileViewport(): boolean {
    return window.matchMedia(MOBILE_LAYOUT_QUERY).matches;
}

function isPlayerExpanded(): boolean {
    return dom.playerWrap.classList.contains("player-expanded");
}

/**
 * True while a desktop window can show the trip list only as the drawer over
 * the player: the expanded map holds the whole sidebar column. sidebar.css owns
 * the breakpoint and the conditions and publishes the verdict as
 * --sidebar-yielded; reading it back keeps them in one place. A fullscreen
 * player covers the column question entirely, so it reports false there.
 */
export function isDesktopListOverlay(): boolean {
    // Cheap class checks first: they skip the style read whenever no drawer
    // could apply, including the fullscreen controls' class flips.
    if (!dom.playerWrap.classList.contains("map-expanded") || isPlayerExpanded() || isMobileLayout()) return false;
    return getComputedStyle(dom.sidebar).getPropertyValue("--sidebar-yielded").trim() === "1";
}

/**
 * Closes a drawer that its layout no longer overlays. The desktop overlay
 * exists only while the map holds the column: collapsing the map, opening
 * export or widening the window puts the list back in its column, and a scrim
 * left open would block the whole viewer. Fullscreen closes any drawer: the
 * fullscreen player lives inside the viewer the open drawer marks inert.
 */
export function closeStrandedDrawer(): void {
    if (dom.sidebar.dataset.drawerOpen !== "true") return;
    if (!isPlayerExpanded() && (isMobileLayout() || isDesktopListOverlay())) return;
    setDrawerOpen(false);
}

// Toggle the standard `inert` attribute (removes from tab order + a11y tree).
// Set via attribute, not the HTMLElement.inert property, to stay independent of
// the TS lib version.
function setInert(el: HTMLElement, on: boolean): void {
    if (on) el.setAttribute("inert", "");
    else el.removeAttribute("inert");
}

/**
 * Reconciles the drawer's a11y state with the real layout, keyed on (mobile,
 * browsing, open) rather than a single toggle site - initial watch-mode and the
 * browse->watch FLIP both land on "closed drawer" WITHOUT calling setDrawerOpen,
 * so a reconciler is the only place that covers every path. Call it from every
 * site that changes one of those three inputs.
 *
 *   - closed off-canvas drawer (mobile, not browsing): inert the sidebar so a
 *     keyboard / screen-reader user cannot land on the off-screen trip list.
 *   - open drawer (mobile, or over the map on desktop): inert the
 *     scrim-covered viewer so Tab cannot escape behind the drawer (the scrim
 *     only blocks pointer events). The topbar (burger) stays live - it sits
 *     above the drawer and closes it.
 *   - desktop export: inert the sidebar while it is visually hidden.
 *   - browse full-screen list and ordinary desktop: everything live.
 */
export function syncDrawerA11y(): void {
    const mobile = isMobileViewport();
    const browsing =
        document.body.classList.contains("browsing") && !document.body.classList.contains("preparing-trip");
    const open = dom.sidebar.dataset.drawerOpen === "true";
    setInert(dom.sidebar, mobile ? !browsing && !open : state.exportModeOpen);
    setInert(dom.viewer, open && (mobile || isDesktopListOverlay()));
    placementListeners.emit();
}

/**
 * Reconciles body.browsing with state (trips loaded AND none active) and, on the
 * mobile browse -> watch transition, animates the full-screen trip list
 * collapsing into the topbar trips icon. Call after every trip-list render so
 * the class tracks selection; the FLIP fires at most once per session.
 *
 * The class toggle must NOT live in syncEmptyState: that runs mid-render while
 * the list is cleared, so the clone would be empty. renderTrips calls this at
 * the end, with cards already in the DOM.
 */
export function syncBrowseState(): void {
    const browsingNow = state.trips.length > 0 && !state.active;
    const wasBrowsing = document.body.classList.contains("browsing");

    if (
        wasBrowsing &&
        !browsingNow &&
        isMobileViewport() &&
        !collapseShown &&
        !document.body.classList.contains("preparing-trip")
    ) {
        collapseShown = true;
        // applyFinalLayout removes body.browsing -> CSS reverts the sidebar to the
        // off-canvas drawer and reveals the icon (the FLIP target). The list fades
        // to 0 as it shrinks into the icon corner.
        flipCollapse({
            fromEl: dom.sidebar,
            toEl: dom.topbarBurger,
            applyFinalLayout: () => {
                document.body.classList.remove("browsing");
                // browse->watch leaves a closed off-canvas drawer without going
                // through setDrawerOpen, so reconcile inert state here too.
                syncDrawerA11y();
            },
            durationMs: COLLAPSE_MS,
            easing: COLLAPSE_EASE,
            buildKeyframes: ({ dx, dy, sx, sy }) => [
                { transform: "translate(0, 0) scale(1, 1)", opacity: 1 },
                {
                    transform: `translate(${dx}px, ${dy}px) scale(${sx.toFixed(3)}, ${sy.toFixed(3)})`,
                    opacity: 0,
                },
            ],
        });
        return;
    }

    document.body.classList.toggle("browsing", browsingNow);
    syncDrawerA11y();
}

// Pending show-side rAF. The close path cancels it: an open->close toggle
// within one frame (fast double-tap on the burger) otherwise runs close's
// classList.remove BEFORE the rAF adds .open, the 220ms check then sees
// .open and never re-hides - a click-intercepting scrim over a closed drawer.
let scrimShowRaf = 0;
// Pending hide-side timer. The open path cancels it: after a close->open within
// its 220ms it could fire between the reopen and the show rAF, hiding the scrim
// under an open drawer so an outside click no longer closes it.
let scrimHideTimer: ReturnType<typeof setTimeout> | undefined;

export function setDrawerOpen(open: boolean): void {
    // Read the prior state BEFORE mutating it: focus restore must fire only on a
    // real open->close transition, not on the many no-op closes (matchMedia
    // leaving mobile, tile-click, Escape with no drawer open) that would
    // otherwise yank focus to a now-hidden burger.
    const wasOpen = dom.sidebar.dataset.drawerOpen === "true";
    if (open) {
        dom.sidebar.dataset.drawerOpen = "true";
        // A browse->watch FLIP hides the sidebar (visibility:hidden) for the
        // length of its animation and clears it only on cleanup. Its
        // applyFinalLayout removes body.browsing synchronously at the start, so
        // the burger becomes tappable mid-animation; opening the drawer then
        // would slide in an invisible sidebar until the FLIP timer fires. Clear
        // the override here so the opened drawer is visible immediately.
        dom.sidebar.style.visibility = "";
        clearTimeout(scrimHideTimer);
        dom.drawerScrim.hidden = false;
        // rAF lets [hidden]→display:flex take effect before adding .open, so the opacity transition fires.
        if (scrimShowRaf) cancelAnimationFrame(scrimShowRaf);
        scrimShowRaf = requestAnimationFrame(() => {
            scrimShowRaf = 0;
            dom.drawerScrim.classList.add("open");
        });
    } else {
        delete dom.sidebar.dataset.drawerOpen;
        if (scrimShowRaf) {
            cancelAnimationFrame(scrimShowRaf);
            scrimShowRaf = 0;
        }
        dom.drawerScrim.classList.remove("open");
        // Hide after transition ends (200 ms). Without this the transparent scrim stays over the viewer and intercepts clicks.
        clearTimeout(scrimHideTimer);
        scrimHideTimer = setTimeout(() => {
            if (!dom.drawerScrim.classList.contains("open")) dom.drawerScrim.hidden = true;
        }, 220);
    }
    dom.topbarBurger.setAttribute("aria-expanded", String(open));
    syncDrawerA11y();
    // Focus management: move into the drawer on open (first control, else the
    // sidebar root), return to the control that opens it on close. Restore only
    // when this was a genuine close of an open drawer that is now off screen,
    // and focus is still inside the drawer (don't steal it if the user moved
    // on). A list back in its desktop column keeps focus where it is, and a
    // fullscreen player owns focus itself - both openers sit outside it.
    if (open && !wasOpen) {
        (focusableWithin(dom.sidebar)[0] ?? dom.sidebar).focus({ preventScroll: true });
    } else if (!open && wasOpen && !isPlayerExpanded() && dom.sidebar.contains(document.activeElement)) {
        if (isMobileViewport()) dom.topbarBurger.focus();
        else if (isDesktopListOverlay()) dom.sidebarToggle.focus();
    }
}

export function initMobileDrawer(): void {
    // tabindex=-1 makes the sidebar a programmatic focus fallback when the trip
    // list is empty (no focusable child to land on when the drawer opens). Not in
    // the Tab order, so desktop is unaffected.
    dom.sidebar.tabIndex = -1;
    subscribeExportState(syncDrawerA11y);

    dom.topbarBurger.addEventListener("click", () => {
        const isOpen = dom.sidebar.dataset.drawerOpen === "true";
        setDrawerOpen(!isOpen);
    });

    dom.drawerScrim.addEventListener("click", () => setDrawerOpen(false));

    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && dom.sidebar.dataset.drawerOpen === "true") {
            setDrawerOpen(false);
        }
    });

    // Close the drawer when leaving the mobile layout; on desktop it would
    // stay open and break the grid layout. Watches the SAME compound query
    // the drawer CSS applies under (width OR short-landscape) - a width-only
    // listener missed the short-landscape -> desktop transition (window grows
    // taller without crossing 767px) and left the drawer stuck open.
    window.matchMedia(MOBILE_LAYOUT_QUERY).addEventListener("change", (e) => {
        if (!e.matches) setDrawerOpen(false);
        // Reconcile on every boundary crossing: entering mobile must inert the
        // closed off-canvas sidebar; leaving it must clear all inert state.
        syncDrawerA11y();
    });

    // Initial reconcile - first paint may already be in mobile watch-mode.
    syncDrawerA11y();
}
