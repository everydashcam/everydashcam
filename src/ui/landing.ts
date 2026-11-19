// Landing mode (body.no-trips) and the transition to normal UI on first ingest.
//
// Contract:
//  - HTML starts with <body class="no-trips">. CSS keeps the final app grid in
//    place but visibility-hidden under an absolute .landing overlay.
//  - exitLanding() is called from ui/sidebar.ts renderTrips() when state.trips first becomes non-empty.
//    Removes body.no-trips and runs the FLIP animation: large landing-cta → compact sidebar-cta.
//  - Idempotent: subsequent calls after the transition are no-ops (guarded by body.classList.contains("no-trips")).
//
// FLIP source: the orange <button id="landing-cta"> inside the .landing-drop card.
// We animate just the button, not the whole drop card - the dashed-border card
// disappears with the rest of the landing, but the orange CTA stays continuous
// from hero to sidebar header. The card handles clicks from the button and the surrounding hint.
//
// The FLIP mechanics (clone, measure, animate, cleanup) live in ./flip.ts and
// are shared with the mobile browse->watch collapse. Here we only supply the
// from/to elements, the final-layout mutation (remove body.no-trips), and the
// keyframes (a slight mid-lift for a "fly over" feel).

import { createLogger } from "../log.js";

import { dom } from "./dom.js";
import { flipCollapse } from "./flip.js";
import { disconnectLandingDock } from "./landing-dock.js";
import { disconnectLandingTopbar } from "./landing-topbar.js";
import { initTripUi } from "./trip-ui-init.js";

const log = createLogger("landing");

const ANIM_DURATION_MS = 450;
const ANIM_EASE = "cubic-bezier(0.22, 1, 0.36, 1)"; // ease-out-quint

/**
 * Removes the entire #landing block from the DOM. It is ~500 nodes (hero/features/how/privacy/footer).
 * After the first ingest they are hidden by CSS, but still counted in node-count.
 * Unconditional removal is safe: there is no way back to landing until page reload.
 */
function removeLandingFromDom(): void {
    if (dom.landingRoot?.parentNode) {
        dom.landingRoot.parentNode.removeChild(dom.landingRoot);
        dom.landingRoot = null;
    }
    // Drop every remaining JS root into the detached subtree - any single one
    // (the dock observer's target, a dom.* ref) keeps all ~500 nodes reachable
    // and turns the removal above into a detached-DOM leak. All consumers
    // null-check these refs; there is no way back to landing until reload.
    disconnectLandingDock();
    disconnectLandingTopbar();
    dom.landingCta = null;
    dom.landingDrop = null;
    dom.landingDock = null;
}

/** Starts the exit from landing mode if the page is still in it. Idempotent. Called once when state.trips first becomes non-empty. */
export function exitLanding(): void {
    if (!document.body.classList.contains("no-trips")) return;

    // Heavy UI initializes here - before this no map, chart.js, player listeners, or rAF loops. See trip-ui-init.ts.
    // initTripUi() is now async: it lazy-loads maplibre-gl (~1MB) on first ingest (T9). We deliberately do NOT await it
    // before the FLIP - blocking the landing->app transition on a 1MB download would freeze the animation. The viewer
    // DOM nodes are static HTML, so the map area just populates a beat later. The sidebar play-callback (app.ts) awaits
    // initTripUi() before playFrame, so a trip can never render against a half-initialized viewer.
    void initTripUi().catch((err: unknown) => {
        log.error("viewer init failed", err);
    });

    // landingCta is nullable only after removeLandingFromDom below; the
    // no-trips guard above means the landing - and its CTA - is still in the
    // DOM here. The clone is the landing button; flip.ts sets
    // pointer-events:none + tabindex=-1 so it is not a clickable overlay.
    const landingCta = dom.landingCta;
    if (!landingCta) return;
    flipCollapse({
        fromEl: landingCta,
        toEl: dom.sidebarCta,
        // The final grid already exists under the overlay; this only swaps paint.
        applyFinalLayout: () => document.body.classList.remove("no-trips"),
        durationMs: ANIM_DURATION_MS,
        easing: ANIM_EASE,
        hideTargetDuringRun: true,
        buildKeyframes: ({ dx, dy, sx, sy }) => [
            { transform: "translate(0, 0) scale(1, 1)", opacity: 1 },
            // Mid-keyframe: slight lift above the target for a "fly over" feel instead of a straight shrinking slide.
            {
                transform: `translate(${dx * 0.6}px, ${dy * 0.5 - 12}px) scale(${(1 - (1 - sx) * 0.4).toFixed(3)}, ${(1 - (1 - sy) * 0.4).toFixed(3)})`,
                opacity: 1,
                offset: 0.55,
            },
            { transform: `translate(${dx}px, ${dy}px) scale(${sx.toFixed(3)}, ${sy.toFixed(3)})`, opacity: 0.7 },
        ],
        onSettled: () => {
            removeLandingFromDom();
            log.info("exited landing", { durationMs: ANIM_DURATION_MS });
        },
    });
}
