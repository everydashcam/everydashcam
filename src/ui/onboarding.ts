// In-house onboarding tours. A guided "spotlight + coachmark" overlay that
// introduces the key controls at key moments in the flow:
//
//   - "ingest"       : after the very first ingest, when the trip list appears.
//   - "sources"      : after a later ingest (once the ingest tour is done),
//                      when the sidebar offers to remember the folder.
//   - "player"       : the first time a trip is opened (before playback starts).
//   - "export"       : the first time export mode is opened.
//   - "multichannel" : the first time a multi-camera trip is opened (after the
//                      generic player tour is already done/dismissed).
//
// Design choices (no framework, no new deps - same constraints as the rest of
// the app):
//   - The dim + spotlight cutout is drawn by ONE element (.dc-onb__spot) whose
//     huge box-shadow paints everything outside its rect. We never touch the
//     z-index / stacking of the highlighted element, so it works regardless of
//     where the target lives (player bar, export drawer, top-panel at z=9999).
//   - A transparent full-screen blocker captures clicks so the tour is the only
//     thing the user can act on - it is a guided tour, "Next" advances. The
//     highlighted element is shown, not made interactive.
//   - We reuse modal-helper (activateModal) for the cross-cutting a11y concerns
//     (focus-trap inside the popover, scroll-lock, focus restore, and the
//     central Escape handler -> "dismiss"). isAnyModalOpen() also makes the
//     player hotkeys inert while a tour is up, so Space/arrows don't leak to the
//     video behind the dim.
//   - Each step lists candidate anchor selectors; the first VISIBLE one wins.
//     This absorbs the desktop/mobile differences (a button that moves into the
//     overflow kebab, a panel that is a right-drawer on desktop and a bottom
//     sheet on mobile). If none is visible the popover centers with a full dim.
//   - On phones the popover docks to the bottom as a sheet (the floating
//     placement is unreadable next to a tiny target), while the spotlight still
//     highlights the target up top.
//
// Persistence: the completion flag is set only on "complete" or "skip"
// (Don't show again). Dismissing via Escape / X / "Later" does NOT set it, so
// the tour reappears at the next trigger - that is the "remind me next time"
// path the product asks for. A separate offered marker never suppresses a tour;
// it only records that first-run guidance has actually reached the user.

import { type I18nKey, t } from "../i18n/index.js";
import { createLogger } from "../log.js";
import { tripChannels } from "../trips.js";
import type { Trip } from "../trips.js";

import { activateModal, deactivateModal, isAnyModalOpen } from "./modal-helper.js";
import { MOBILE_LAYOUT_QUERY } from "./media-queries.js";

const log = createLogger("onboarding");

export type OnboardTourId = "ingest" | "sources" | "player" | "export" | "multichannel";

interface OnboardStep {
    /**
     * Candidate highlight targets in priority order. The first selector that
     * resolves to a visible, on-screen, sized element becomes the spotlight.
     * An empty list (or none visible) renders a centered, target-less step.
     */
    anchors: string[];
    titleKey: I18nKey;
    bodyKey: I18nKey;
    /** Extra padding (px) around the spotlight rect. Default 8. */
    pad?: number;
}

interface OnboardTour {
    id: OnboardTourId;
    steps: OnboardStep[];
    /**
     * Delay before the tour appears, to let the triggering transition settle
     * (ingest FLIP ~450ms, mobile browse->watch FLIP ~380ms, export slide-in).
     */
    delayMs: number;
}

function storageKey(id: OnboardTourId): string {
    return `everydashcam:onboarding:${id}`;
}

function offeredStorageKey(id: OnboardTourId): string {
    return `everydashcam:onboarding:${id}:offered`;
}

/** True if the user already completed or explicitly skipped this tour. */
function isTourDone(id: OnboardTourId): boolean {
    try {
        return localStorage.getItem(storageKey(id)) === "1";
    } catch {
        // Private mode - treat as "not done"; the worst case is the tour shows
        // again next session, which is harmless.
        return false;
    }
}

/** Marks a tour as seen-for-good (complete or skip). "Later" never calls this. */
function markTourDone(id: OnboardTourId): void {
    try {
        localStorage.setItem(storageKey(id), "1");
    } catch (err) {
        log.warn("could not persist onboarding flag", err);
    }
}

/** Remembers that this optional tour has actually reached the user. */
function markTourOffered(id: OnboardTourId): void {
    try {
        localStorage.setItem(offeredStorageKey(id), "1");
    } catch {
        // The marker only coordinates optional UI; failure must stay invisible.
    }
}

function wasTourOffered(id: OnboardTourId): boolean {
    try {
        return localStorage.getItem(offeredStorageKey(id)) === "1";
    } catch {
        return false;
    }
}

// ---- tour definitions ----
//
// Anchors are chosen to be stable selectors that exist at the moment the tour
// fires. Where a control collapses into an overflow kebab on a narrow bar, the
// kebab button is listed as a fallback so the spotlight still lands on
// something real.

const TOURS: Record<OnboardTourId, OnboardTour> = {
    ingest: {
        id: "ingest",
        delayMs: 650,
        steps: [
            {
                anchors: ["li.trip:not(.unindexed-note)", "#trip-list", "#topbar-burger"],
                titleKey: "onboard.ingest.trips.title",
                bodyKey: "onboard.ingest.trips.body",
            },
        ],
    },
    sources: {
        id: "sources",
        delayMs: 650,
        steps: [
            {
                // The Remember button of a source row; the row list as the
                // fallback if a re-render swapped the button away between
                // scheduling and firing.
                anchors: [".folder-source__remember", "#folder-sources"],
                titleKey: "onboard.sources.remember.title",
                bodyKey: "onboard.sources.remember.body",
            },
        ],
    },
    player: {
        id: "player",
        delayMs: 450,
        steps: [
            {
                anchors: ["#player-chart", "#player-mini-progress"],
                titleKey: "onboard.player.timeline.title",
                bodyKey: "onboard.player.timeline.body",
            },
            {
                anchors: ["#player-export", "#player-overflow"],
                titleKey: "onboard.player.export.title",
                bodyKey: "onboard.player.export.body",
            },
        ],
    },
    export: {
        id: "export",
        delayMs: 250,
        steps: [
            {
                anchors: ["#timeline-range", "#export-trim-bar", "#player-chart"],
                titleKey: "onboard.export.range.title",
                bodyKey: "onboard.export.range.body",
            },
            {
                anchors: ["#export-panel-output", "#export-panel-options"],
                titleKey: "onboard.export.output.title",
                bodyKey: "onboard.export.output.body",
            },
        ],
    },
    multichannel: {
        id: "multichannel",
        delayMs: 450,
        steps: [
            {
                anchors: ["#top-panel-layout", "#player-view-mode", "#top-panel"],
                titleKey: "onboard.multi.layout.title",
                bodyKey: "onboard.multi.layout.body",
            },
            {
                anchors: ["#top-panel-channels", "#top-panel"],
                titleKey: "onboard.multi.channels.title",
                bodyKey: "onboard.multi.channels.body",
            },
        ],
    },
};

// Every tour id, in declaration order. Single source of truth for callers that
// enumerate tours (resetOnboarding here; the e2e suite mirrors it via a
// type-only import + exhaustive check, so a new tour can't escape suppression).
export const ONBOARD_TOUR_IDS = Object.keys(TOURS) as OnboardTourId[];

// ---- runtime ----

interface OnboardRuntime {
    tour: OnboardTour;
    index: number;
    /** Called on ANY exit (complete / skip / later). Used to resume playback. */
    onFinish?: () => void;
    finished: boolean;
    root: HTMLElement;
    spot: HTMLElement;
    pop: HTMLElement;
    titleEl: HTMLElement;
    bodyEl: HTMLElement;
    counterEl: HTMLElement;
    dotsEl: HTMLElement;
    backBtn: HTMLButtonElement;
    nextBtn: HTMLButtonElement;
    skipBtn: HTMLButtonElement;
    dismissBtn: HTMLButtonElement;
    reposition: () => void;
}

let active: OnboardRuntime | null = null;

// The reposition handler of the active tour, mirrored at module scope so BOTH
// teardown paths can detach the window listeners - finishTour (orderly) and
// hardKillOverlay (panic / setup-threw), which has no `rt` to read.
let activeReposition: (() => void) | null = null;

// setTimeout handle of a tour that is scheduled but not yet shown. Tracked so a
// new schedule can supersede a pending one (see scheduleTour) and so cleanup can
// cancel it - guarding the "fast double trip-click" race where two tours would
// otherwise be queued at once.
let pendingTimer: number | null = null;

function clearPendingTour(): void {
    if (pendingTimer !== null) {
        window.clearTimeout(pendingTimer);
        pendingTimer = null;
    }
}

function isMobile(): boolean {
    return window.matchMedia(MOBILE_LAYOUT_QUERY).matches;
}

/**
 * Bounding rect of a selector IF it is a real, visible, on-screen, sized
 * element. Returns null for missing / [hidden] / display:none / collapsed /
 * fully off-screen (e.g. a closed drawer translated off-canvas, or a button
 * moved into a hidden overflow menu) so the caller can fall through to the next
 * candidate anchor.
 */
function visibleRect(selector: string): DOMRect | null {
    const el = document.querySelector<HTMLElement>(selector);
    if (!el || el.hasAttribute("hidden")) return null;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || cs.opacity === "0") return null;
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return null;
    // Must intersect the viewport (a drawer at translateX(-100%) has a size but
    // sits entirely to the left of x=0).
    if (r.bottom <= 0 || r.right <= 0 || r.left >= window.innerWidth || r.top >= window.innerHeight) return null;
    return r;
}

function resolveAnchor(step: OnboardStep): DOMRect | null {
    for (const sel of step.anchors) {
        const r = visibleRect(sel);
        if (r) return r;
    }
    return null;
}

/**
 * Positions the spotlight cutout and the popover for the current step. The
 * spotlight always carries the dim (huge box-shadow); a target-less step shows
 * a zero-size spot at center so the dim still covers the screen without a ring
 * (CSS keys the ring off data-mode). The popover floats next to the target on
 * desktop and docks to the bottom as a sheet on mobile (or whenever there is no
 * target).
 */
function positionStep(rt: OnboardRuntime, step: OnboardStep): void {
    const rect = resolveAnchor(step);
    const mobile = isMobile();
    const pad = step.pad ?? 8;

    if (rect) {
        rt.spot.style.top = `${rect.top - pad}px`;
        rt.spot.style.left = `${rect.left - pad}px`;
        rt.spot.style.width = `${rect.width + pad * 2}px`;
        rt.spot.style.height = `${rect.height + pad * 2}px`;
    } else {
        // Centered, zero-size spot: full dim, no ring (suppressed via data-mode).
        rt.spot.style.top = "50%";
        rt.spot.style.left = "50%";
        rt.spot.style.width = "0px";
        rt.spot.style.height = "0px";
    }

    // Placement of the popover card.
    if (mobile || !rect) {
        rt.root.dataset.mode = rect ? "anchor" : "center";
        if (!mobile) {
            rt.pop.dataset.placement = "center";
        } else if (rect && rect.top + rect.height / 2 > window.innerHeight * 0.55) {
            // Target sits low (player bar, lower export options) - dock the sheet
            // to the TOP so it does not cover the highlighted control.
            rt.pop.dataset.placement = "sheet-top";
        } else {
            rt.pop.dataset.placement = "sheet";
        }
        rt.pop.style.top = "";
        rt.pop.style.left = "";
        return;
    }

    rt.root.dataset.mode = "anchor";
    rt.pop.dataset.placement = "float";
    // Measure the popover after its content is set, then pick the side with room.
    const popRect = rt.pop.getBoundingClientRect();
    const gap = 12;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let top: number;
    let left: number;
    const belowSpace = vh - (rect.bottom + pad);
    const aboveSpace = rect.top - pad;
    const need = popRect.height + gap;
    if (belowSpace >= need && belowSpace >= aboveSpace) {
        // Fits below and below is the roomier side.
        top = rect.bottom + pad + gap;
    } else if (aboveSpace >= need) {
        // Fits above.
        top = rect.top - pad - gap - popRect.height;
    } else {
        // Neither side fully fits - take the roomier one (clamp keeps it onscreen).
        top = belowSpace >= aboveSpace ? rect.bottom + pad + gap : rect.top - pad - gap - popRect.height;
    }
    // Horizontally align to the target's left edge, clamped to the viewport.
    left = rect.left;
    left = Math.max(gap, Math.min(left, vw - popRect.width - gap));
    top = Math.max(gap, Math.min(top, vh - popRect.height - gap));
    rt.pop.style.top = `${top}px`;
    rt.pop.style.left = `${left}px`;
}

function renderDots(rt: OnboardRuntime): void {
    const total = rt.tour.steps.length;
    rt.dotsEl.replaceChildren(
        ...Array.from({ length: total }, (_unused, i) => {
            const dot = document.createElement("span");
            dot.className = "dc-onb__dot";
            if (i === rt.index) dot.classList.add("is-active");
            return dot;
        }),
    );
}

/** Fills the popover with the current step's copy and repositions. */
function renderStep(rt: OnboardRuntime): void {
    const step = rt.tour.steps[rt.index];
    if (!step) return;
    const total = rt.tour.steps.length;
    const isLast = rt.index === total - 1;

    rt.titleEl.textContent = t(step.titleKey);
    rt.bodyEl.textContent = t(step.bodyKey);
    rt.counterEl.textContent = t("onboard.counter", { current: rt.index + 1, total });
    rt.backBtn.textContent = t("onboard.back");
    rt.backBtn.disabled = rt.index === 0;
    rt.nextBtn.textContent = isLast ? t("onboard.done") : t("onboard.next");
    rt.skipBtn.textContent = t("onboard.skip");
    rt.dismissBtn.setAttribute("aria-label", t("onboard.dismiss"));
    rt.dismissBtn.title = t("onboard.dismiss");
    rt.root.setAttribute("aria-label", t("onboard.dialogLabel"));
    renderDots(rt);
    // Step change (Next/Back/relocalize): re-enable the positional ease so the
    // spotlight glides to the new target; the scroll-tracking path re-adds the
    // class to suppress it again.
    rt.root.classList.remove("dc-onb--tracking");
    positionStep(rt, step);
}

function buildOverlay(tour: OnboardTour): OnboardRuntime {
    const root = document.createElement("div");
    root.className = "dc-onb";
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-modal", "true");

    const blocker = document.createElement("div");
    blocker.className = "dc-onb__blocker";

    const spot = document.createElement("div");
    spot.className = "dc-onb__spot";
    spot.setAttribute("aria-hidden", "true");

    const pop = document.createElement("div");
    pop.className = "dc-onb__pop";
    pop.tabIndex = -1;
    // Count + title + body live in one aria-live/atomic region so a step change
    // (Next/Back) and a mid-tour language flip are announced as a unit to screen
    // readers - focus stays on Next, so without this they would hear nothing.
    // Icon-less SVG X (matches the inline-svg convention used elsewhere).
    pop.innerHTML = `
        <button type="button" class="dc-onb__x">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>
        </button>
        <div class="dc-onb__copy" aria-live="polite" aria-atomic="true">
            <div class="dc-onb__count"></div>
            <h3 class="dc-onb__title" id="dc-onb-title"></h3>
            <p class="dc-onb__body"></p>
        </div>
        <div class="dc-onb__foot">
            <button type="button" class="dc-onb__skip"></button>
            <div class="dc-onb__nav">
                <div class="dc-onb__dots" aria-hidden="true"></div>
                <button type="button" class="dc-onb__back dc-btn dc-btn--secondary"></button>
                <button type="button" class="dc-onb__next dc-btn dc-btn--primary"></button>
            </div>
        </div>`;
    // The step-specific h3 is the dialog's accessible name (better than a generic
    // static label). Set once - the id is stable (one tour at a time).
    root.setAttribute("aria-labelledby", "dc-onb-title");

    root.append(blocker, spot, pop);
    document.body.appendChild(root);

    const rt: OnboardRuntime = {
        tour,
        index: 0,
        finished: false,
        root,
        spot,
        pop,
        titleEl: pop.querySelector(".dc-onb__title") as HTMLElement,
        bodyEl: pop.querySelector(".dc-onb__body") as HTMLElement,
        counterEl: pop.querySelector(".dc-onb__count") as HTMLElement,
        dotsEl: pop.querySelector(".dc-onb__dots") as HTMLElement,
        backBtn: pop.querySelector(".dc-onb__back") as HTMLButtonElement,
        nextBtn: pop.querySelector(".dc-onb__next") as HTMLButtonElement,
        skipBtn: pop.querySelector(".dc-onb__skip") as HTMLButtonElement,
        dismissBtn: pop.querySelector(".dc-onb__x") as HTMLButtonElement,
        reposition: () => {
            const step = active?.tour.steps[active.index];
            if (active && step) {
                // Tracking path (scroll/resize/orientation): snap the spotlight to
                // the moving target without the positional ease, so the cutout does
                // not trail behind a scrolled control. renderStep clears the class
                // so explicit Next/Back step changes keep their ease.
                active.root.classList.add("dc-onb--tracking");
                positionStep(active, step);
            }
        },
    };

    rt.nextBtn.addEventListener(
        "click",
        safeHandler(() => advance(1)),
    );
    rt.backBtn.addEventListener(
        "click",
        safeHandler(() => advance(-1)),
    );
    rt.skipBtn.addEventListener(
        "click",
        safeHandler(() => finishTour("skip")),
    );
    rt.dismissBtn.addEventListener(
        "click",
        safeHandler(() => finishTour("later")),
    );
    // Clicking the dim outside the card dismisses ("later", does not persist).
    // This is a deliberate, easy escape hatch: the user must always have an
    // obvious way out, in addition to X / Skip / Escape.
    blocker.addEventListener(
        "click",
        safeHandler(() => finishTour("later")),
    );

    // Give the X an accessible name before activateModal moves focus (renderStep
    // refreshes it per language; this avoids a transient nameless button).
    rt.dismissBtn.setAttribute("aria-label", t("onboard.dismiss"));

    return rt;
}

/**
 * Last-resort teardown: removes EVERY tour overlay from the DOM, drops the
 * modal-helper entry, detaches the window listeners, cancels any pending tour,
 * unlocks body scroll and clears `active` - bypassing the normal lifecycle.
 * Called when the orderly path itself throws (or setup threw before
 * activateModal armed), so a broken tour can never leave the screen blocked.
 *
 * A tour coexisting with another modal is only ruled out by the firing seams,
 * not structurally (the settle delay leaves a window where another modal can
 * open underneath a queued tour), so the scroll-lock is released only when no
 * other modal still owns it - deactivateModal already frees it when the stack
 * empties; a surviving sibling modal must keep it locked.
 */
function hardKillOverlay(): void {
    active = null;
    clearPendingTour();
    if (activeReposition) {
        window.removeEventListener("resize", activeReposition);
        window.removeEventListener("orientationchange", activeReposition);
        window.removeEventListener("scroll", activeReposition, true);
        activeReposition = null;
    }
    for (const el of Array.from(document.querySelectorAll<HTMLElement>(".dc-onb"))) {
        try {
            deactivateModal(el);
        } catch {
            // ignore - we remove the node regardless below
        }
        el.remove();
    }
    if (!isAnyModalOpen()) document.body.style.overflow = "";
}

/**
 * Wraps a control handler so that ANY exception inside it closes the tour
 * instead of leaving the user stuck behind a half-broken overlay. The guiding
 * rule for the whole engine: fail OPEN - if onboarding misbehaves, it gets out
 * of the way, it never traps the app.
 */
function safeHandler(fn: () => void): () => void {
    return () => {
        try {
            fn();
        } catch (err) {
            log.error("onboarding control failed - closing tour to avoid trapping the user", err);
            try {
                finishTour("later");
            } catch {
                hardKillOverlay();
            }
        }
    };
}

function advance(delta: number): void {
    if (!active) return;
    const next = active.index + delta;
    if (next < 0) return;
    if (next >= active.tour.steps.length) {
        finishTour("complete");
        return;
    }
    active.index = next;
    renderStep(active);
}

function finishTour(outcome: "complete" | "skip" | "later"): void {
    const rt = active;
    if (!rt || rt.finished) return;
    rt.finished = true;
    active = null;
    clearPendingTour();

    // Tear down defensively: the user must never be trapped, so a throw in the
    // DOM/listener cleanup must still leave the overlay gone and scroll unlocked.
    try {
        window.removeEventListener("resize", rt.reposition);
        window.removeEventListener("orientationchange", rt.reposition);
        window.removeEventListener("scroll", rt.reposition, true);
        activeReposition = null;
        deactivateModal(rt.root);
        rt.root.remove();
    } catch (err) {
        log.warn("onboarding teardown threw - forcing cleanup", err);
        hardKillOverlay();
    }

    // Persistence / analytics / resume are non-critical to "get the overlay off
    // the screen" - guard them so none can resurrect a trapped state.
    if (outcome === "complete" || outcome === "skip") {
        try {
            if (outcome === "skip") {
                for (const tour of Object.values(TOURS)) markTourDone(tour.id);
            } else {
                markTourDone(rt.tour.id);
            }
        } catch (err) {
            log.warn("could not persist onboarding flag", err);
        }
    }
    try {
        rt.onFinish?.();
    } catch (err) {
        log.warn("onboarding resume callback threw", err);
    }
}

function startTour(tour: OnboardTour, onFinish?: () => void): void {
    // Never stack tours. If one is already up, just run the resume callback so a
    // gated playback (autoPlay=false) is not left paused forever.
    if (active) {
        onFinish?.();
        return;
    }

    // A body-level fixed overlay is not rendered inside a fullscreened element.
    // A tour can't normally fire in fullscreen (hotkeys are inert under a modal
    // and the controls sit behind the blocker), but if we somehow are, drop out.
    if (document.fullscreenElement) void document.exitFullscreen?.()?.catch(() => {});

    // Build + arm the whole tour inside one try/catch. If ANY part of setup
    // throws (a missing anchor button, a DOM API quirk, a thrown listener), we
    // fail OPEN: remove the partial overlay, resume gated playback, and leave the
    // app fully usable rather than stuck behind a broken blocker.
    let rt: OnboardRuntime | null = null;
    try {
        rt = buildOverlay(tour);
        rt.onFinish = onFinish;
        active = rt;
        markTourOffered(tour.id);

        // Mirror the handler at module scope BEFORE attaching it, so a throw
        // later in setup routes through hardKillOverlay, which detaches these
        // via activeReposition (finishTour can't run once active is cleared).
        activeReposition = rt.reposition;
        window.addEventListener("resize", rt.reposition);
        window.addEventListener("orientationchange", rt.reposition);
        // Capture-phase scroll: any scroll container moving the target should
        // reflow the spotlight.
        window.addEventListener("scroll", rt.reposition, true);

        // Reuse the modal manager: focus-trap inside the popover, scroll-lock,
        // focus restore, and Escape -> dismiss ("later", does not persist).
        activateModal(rt.root, { onClose: () => finishTour("later"), initialFocus: rt.nextBtn });

        renderStep(rt);
        // A second position pass on the next frame: the entrance animation and
        // font metrics can change the popover size after the first measure.
        requestAnimationFrame(() => rt?.reposition());
        // The display font may swap in after the first measure (font-display:
        // swap), changing the popover height. Re-place once it lands (no-op if
        // the tour already closed - reposition guards on `active`).
        if (document.fonts?.ready) void document.fonts.ready.then(() => rt?.reposition()).catch(() => {});
    } catch (err) {
        log.error("onboarding failed to start - skipping tour", err);
        hardKillOverlay(); // removes any partial overlay + unlocks scroll + active=null
        try {
            onFinish?.();
        } catch {
            // resume is best-effort; the app is already usable
        }
    }
}

/**
 * Schedules a tour after its settle delay. Re-checks "already running" at fire
 * time (the user may have triggered something else in the meantime).
 *
 * Only one tour may be queued: a new schedule supersedes a pending one. This
 * closes the fast-double-trip-click race - within the settle delay `active` is
 * still null, so without this a second trip-open would queue a SECOND tour whose
 * startTour, seeing `active` set by the first, would fire its resume callback
 * immediately and un-pause playback behind the dim. The stale timer is cancelled
 * WITHOUT running its onFinish: that resume targets a trip that is no longer
 * loaded; the surviving (latest) schedule's onFinish matches the current trip.
 */
function scheduleTour(id: OnboardTourId, onFinish?: () => void): void {
    const tour = TOURS[id];
    clearPendingTour();
    pendingTimer = window.setTimeout(() => {
        pendingTimer = null;
        startTour(tour, onFinish);
    }, tour.delayMs);
}

// ---- public triggers (called from the relevant feature seams) ----

/** Fired after the first successful ingest (trip list now on screen). */
export function maybeRunIngestTour(): void {
    if (active || isTourDone("ingest")) return;
    scheduleTour("ingest");
}

/**
 * Fired after every successful ingest, together with maybeRunIngestTour. It
 * waits its turn: nothing shows until the ingest tour is done/skipped, so the
 * two never compete for the same moment - this one takes the NEXT ingest.
 * The visible Remember button is the whole precondition: no button (ad-hoc
 * drop, a browser without the folder picker, everything already remembered)
 * means nothing to teach.
 */
export function maybeRunSourcesTour(): void {
    if (active || isTourDone("sources") || !isTourDone("ingest")) return;
    if (!visibleRect(".folder-source__remember")) return;
    scheduleTour("sources");
}

/** Fired when export mode is opened for the first time. */
export function maybeRunExportTour(): void {
    if (active || isTourDone("export")) return;
    scheduleTour("export");
}

/**
 * Picks which tour (if any) should run when a trip is opened. The generic
 * player tour wins until it is done; only then does a multi-camera trip surface
 * the multichannel tour. Returning non-null tells the caller to gate autoplay
 * (so the tour introduces the controls before the clip rolls).
 */
export function pickTripOpenTour(trip: Trip): OnboardTourId | null {
    if (!isTourDone("player")) return "player";
    if (!isTourDone("multichannel") && tripChannels(trip).length > 1) return "multichannel";
    return null;
}

/**
 * Runs the tour chosen by pickTripOpenTour. `onResume` is invoked on every exit
 * (complete/skip/later) and is where the caller resumes the gated playback.
 */
export function runTripOpenTour(id: OnboardTourId, onResume: () => void): void {
    if (active) {
        // A tour from a previous trip click is still up. Resume THIS trip's
        // playback immediately (so it is never stranded paused) but do not queue
        // a second tour with a competing resume callback.
        onResume();
        return;
    }
    if (isTourDone(id)) {
        // Raced to done between pick and run - don't show, just resume.
        onResume();
        return;
    }
    scheduleTour(id, onResume);
}

/**
 * Whether a later, optional prompt may safely appear without jumping ahead of
 * first-run guidance. Core ingest/player tips block until they have actually
 * reached the user; choosing "Later" keeps a tour eligible for its next feature
 * trigger, but must not suppress unrelated prompts forever. Conditional tips
 * block only while active/pending: merely loading a multi-camera trip or having
 * export available is not a reason to postpone feedback.
 */
export function isOnboardingSettledForSupportPrompt(): boolean {
    if (active || pendingTimer !== null) return false;
    if (!isTourDone("ingest") && !wasTourOffered("ingest")) return false;
    if (!isTourDone("player") && !wasTourOffered("player")) return false;
    return true;
}

/**
 * Clears the seen-state of every tour so they replay at their next trigger
 * (next ingest / trip open / export open). Exposed for the settings "Danger
 * zone" Replay-tips control. Closes any open tour first (without persisting).
 */
export function resetOnboarding(): void {
    if (active) finishTour("later");
    for (const id of ONBOARD_TOUR_IDS) {
        try {
            localStorage.removeItem(storageKey(id));
            localStorage.removeItem(offeredStorageKey(id));
        } catch {
            // Private mode - nothing was persisted anyway.
        }
    }
}

/**
 * Wires the tour panic-exit. Called once from app.ts.
 */
export function initOnboarding(): void {
    // Panic exit, independent of any tour instance AND of modal-helper: Escape
    // ALWAYS tears a tour overlay down, even if `active` desynced or the modal
    // manager never armed (e.g. setup threw before activateModal). This is the
    // hard guarantee that a user can never be permanently stuck behind the dim.
    // Capture phase + presence check so it is inert when no tour is up.
    document.addEventListener(
        "keydown",
        (e) => {
            if (e.key !== "Escape") return;
            if (!document.querySelector(".dc-onb")) return;
            e.preventDefault();
            e.stopPropagation();
            try {
                finishTour("later");
            } catch {
                // ignore - hard cleanup below is the real guarantee
            }
            // If anything is still on screen (finishTour wedged / state desync),
            // remove it by force.
            if (document.querySelector(".dc-onb")) hardKillOverlay();
        },
        true,
    );
}
