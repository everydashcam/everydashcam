// Shared FLIP "collapse" animation: morph one element into another element's
// position via a fixed-position clone (translate + scale + fade). Two callers:
//   - landing exit: the large hero CTA collapses into the compact sidebar CTA.
//   - mobile browse->watch: the full-screen trip list collapses into the trips
//     icon in the topbar, so the user sees where the list went.
// One implementation keeps the two transitions from drifting apart (AGENTS.md
// "abstractions against duplicates").

import { prefersReducedMotion } from "./media-queries.js";

export interface FlipDeltas {
    dx: number;
    dy: number;
    sx: number;
    sy: number;
}

export interface FlipCollapseOptions {
    // Element that visually collapses. A deep clone is animated; the original is
    // hidden (visibility) for the run so only the clone is on screen.
    fromEl: HTMLElement;
    // Target whose rect the clone lands on - top-left aligned, scaled to size.
    toEl: HTMLElement;
    // Layout mutation applied AFTER measuring fromEl and BEFORE measuring toEl.
    // It must put the DOM in its final (post-transition) state synchronously, so
    // toEl already sits at its resting rect when measured.
    applyFinalLayout: () => void;
    durationMs: number;
    easing: string;
    // Keyframes built from the measured deltas. transform-origin is pinned to
    // 0 0, so translate(dx,dy) scale(sx,sy) maps fromRect's top-left and size
    // exactly onto toRect.
    buildKeyframes: (deltas: FlipDeltas) => Keyframe[];
    // Also hide toEl while the clone flies (landing hides its target CTA until
    // the clone arrives). Default false.
    hideTargetDuringRun?: boolean;
    // Fires once after finish/cancel/timeout, or immediately on the
    // no-animation fallback. Use for one-shot teardown.
    onSettled?: () => void;
}

/**
 * Runs a FLIP collapse of opts.fromEl into opts.toEl. fromEl/toEl must be live
 * in the DOM at call time. Degrades to applyFinalLayout + onSettled (no clone)
 * when the Web Animations API is missing or either rect measures zero
 * (off-screen / display:none) - the final layout is already on screen, so the
 * result is seamless, just without the morph.
 */
export function flipCollapse(opts: FlipCollapseOptions): void {
    const { fromEl, toEl, applyFinalLayout, durationMs, easing, buildKeyframes } = opts;

    // First: source rect before the layout changes.
    const fromRect = fromEl.getBoundingClientRect();
    // Last: apply the final layout, then measure the target's resting rect.
    applyFinalLayout();
    const toRect = toEl.getBoundingClientRect();

    // No WAAPI, a zero rect (element off-screen / display:none at measure time),
    // or the user prefers reduced motion: the final layout is already painted, so
    // just settle. The instant settle is the same seamless path taken when WAAPI
    // is missing - it honors prefers-reduced-motion (WCAG 2.3.3) for both callers
    // (landing exit and mobile browse->watch).
    if (prefersReducedMotion() || typeof fromEl.animate !== "function" || fromRect.width === 0 || toRect.width === 0) {
        opts.onSettled?.();
        return;
    }

    // Invert: a fixed clone pinned over fromRect. transform-origin 0 0 + the
    // inline rect override any stylesheet rules the clone inherits via its class
    // (e.g. .sidebar's own position/transform on mobile).
    const clone = fromEl.cloneNode(true) as HTMLElement;
    clone.style.position = "fixed";
    clone.style.left = `${fromRect.left}px`;
    clone.style.top = `${fromRect.top}px`;
    clone.style.width = `${fromRect.width}px`;
    clone.style.height = `${fromRect.height}px`;
    clone.style.margin = "0";
    clone.style.transformOrigin = "0 0";
    clone.style.transform = "none";
    clone.style.transition = "none";
    clone.style.overflow = "hidden";
    // Sit at the modal tier during the morph - var() resolves against :root in
    // the CSSOM, so the clone follows the documented z-index ladder (tokens.css)
    // instead of a magic 100.
    clone.style.zIndex = "var(--dc-z-modal)";
    clone.style.pointerEvents = "none";
    clone.setAttribute("aria-hidden", "true");
    clone.setAttribute("tabindex", "-1");
    document.body.appendChild(clone);

    // Hide originals (visibility preserves layout) so only the clone shows.
    fromEl.style.visibility = "hidden";
    if (opts.hideTargetDuringRun) toEl.style.visibility = "hidden";

    const deltas: FlipDeltas = {
        dx: toRect.left - fromRect.left,
        dy: toRect.top - fromRect.top,
        sx: toRect.width / fromRect.width,
        sy: toRect.height / fromRect.height,
    };

    const animation = clone.animate(buildKeyframes(deltas), {
        duration: durationMs,
        easing,
        fill: "forwards",
    });

    // Idempotent cleanup: finish/cancel may not fire in background tabs or
    // headless preview, so a timer guarantees teardown.
    let cleanedUp = false;
    const cleanup = (): void => {
        if (cleanedUp) return;
        cleanedUp = true;
        clone.remove();
        fromEl.style.visibility = "";
        if (opts.hideTargetDuringRun) toEl.style.visibility = "";
        opts.onSettled?.();
    };
    animation.addEventListener("finish", cleanup);
    animation.addEventListener("cancel", cleanup);
    setTimeout(cleanup, durationMs + 50);
}
