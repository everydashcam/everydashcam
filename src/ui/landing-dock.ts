// Docked CTA on the landing: a fixed pill at the bottom edge that appears
// when the inline drop card (#landing-drop) scrolls out of view, so the
// primary action - open/drop the SD-card folder - stays one tap away at any
// scroll depth. The pill and the card share the picker handler in file-sources.ts.
// The dock lives in index.html (#landing-dock) inside
// .landing, so it vanishes with the landing after the first ingest.

let observer: IntersectionObserver | null = null;

/** Wires the docked CTA to the inline drop card's visibility. Safe to call
 *  once on startup; no-op when the landing markup is absent. */
export function initLandingDock(): void {
    const dock = document.getElementById("landing-dock");
    const dropCard = document.getElementById("landing-drop");
    if (!dock || !dropCard) return;
    // Viewport-root observation works even though the card scrolls inside the
    // .landing container. Show the pill only when the card is FULLY out of
    // view - while any part of it is visible, a second CTA would just double
    // the same control on screen.
    observer = new IntersectionObserver(
        (entries) => {
            const cardVisible = entries[entries.length - 1]?.isIntersecting ?? true;
            dock.hidden = cardVisible;
        },
        { threshold: 0 },
    );
    observer.observe(dropCard);
}

/** Releases the dock's IntersectionObserver. Called when the landing subtree
 *  is removed from the DOM (landing.ts) - the observed #landing-drop reference
 *  would otherwise keep the whole detached subtree reachable for the session. */
export function disconnectLandingDock(): void {
    observer?.disconnect();
    observer = null;
}
