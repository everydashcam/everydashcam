// Offline banner controller. Shows the thin top strip (#offline-banner in
// index.html) whenever connectivity.ts reports effective offline, and wires the
// info button -> detail popover.
//
// No i18n logic here: the banner copy is tagged data-i18n / data-i18n-attr, so
// applyStaticI18n() (run on every language switch) re-localizes it for free.

import { createPopover } from "./popover-lifecycle.js";
import { subscribeConnectivity } from "./connectivity.js";

/**
 * Initialize the offline banner. Subscribes to connectivity (which calls back
 * immediately with the current state) and binds the info popover. Safe to call
 * when the banner element is absent (returns early).
 */
export function initOfflineBanner(): void {
    const banner = document.getElementById("offline-banner");
    if (!banner) return;
    const infoBtn = document.getElementById("offline-banner-info");
    const popover = document.getElementById("offline-banner-popover");

    const lifecycle =
        infoBtn && popover
            ? createPopover({
                  button: infoBtn,
                  panel: popover,
                  show: () => {
                      popover.hidden = false;
                      infoBtn.classList.add("is-open");
                  },
                  hide: () => {
                      popover.hidden = true;
                      infoBtn.classList.remove("is-open");
                  },
              })
            : null;

    subscribeConnectivity((offline) => {
        banner.hidden = !offline;
        // The body class is a CSS state hook. The banner overlays existing
        // chrome, so toggling connectivity never changes page geometry.
        document.body.classList.toggle("has-offline-banner", offline);
        // Going back online closes a left-open popover so it can't linger over
        // a now-hidden banner.
        if (!offline) lifecycle?.close();
    });

    infoBtn?.addEventListener("click", (event) => {
        event.stopPropagation();
        lifecycle?.toggle();
    });
}
