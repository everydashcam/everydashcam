// Shared media-query predicates. One place for the matchMedia strings so the
// reduced-motion and coarse-pointer checks don't drift across modules
// (AGENTS.md "abstractions against duplicates"). All live and SSR/no-matchMedia
// safe: a MediaQueryList's .matches tracks the environment on its own, so the
// cached list below is as live as re-creating one per call.

/** True when the user asked the OS to reduce non-essential motion (WCAG 2.3.3). */
export function prefersReducedMotion(): boolean {
    return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

// Touch is detected by the pointer being coarse. Exposed as a shared query string
// too so a live MediaQueryList listener (the map's cooperative-gestures toggle)
// re-reads the exact same condition as the predicate.
export const COARSE_POINTER_QUERY = "(pointer: coarse)";

// Cached because isCoarsePointer sits on warm paths (timeline geometry during
// drags); creating a fresh MediaQueryList per call is avoidable garbage.
let coarsePointerList: MediaQueryList | null = null;

/** True on a coarse pointer (touch). */
export function isCoarsePointer(): boolean {
    if (typeof window === "undefined" || !window.matchMedia) return false;
    coarsePointerList ??= window.matchMedia(COARSE_POINTER_QUERY);
    return coarsePointerList.matches;
}

// The stacked (mobile) layout media. MUST mirror the CSS mobile block
// (viewer.css / sidebar.css / player-bar.css use the same pair): components
// pile vertically and .viewer scrolls, so gesture owners (map, video zoom)
// have to yield the plain wheel/one-finger scroll to the page.
export const MOBILE_LAYOUT_QUERY = "(max-width: 767px), (max-height: 500px) and (orientation: landscape)";

let mobileLayoutList: MediaQueryList | null = null;

/** True when the stacked (mobile) layout media applies - a narrow window or a
 *  low landscape one - regardless of pointer type: a squeezed desktop window
 *  gets the same layout as a phone. */
export function isMobileLayout(): boolean {
    if (typeof window === "undefined" || !window.matchMedia) return false;
    mobileLayoutList ??= window.matchMedia(MOBILE_LAYOUT_QUERY);
    return mobileLayoutList.matches;
}
