// Trip-end behavior button: state.tripEndBehavior (stop / loop / advance) +
// aria/icon/title sync. The actual branching lives in the ended-handler in
// player.ts; here we only own the cycle button and its visual.

import { t } from "../i18n/index.js";
import { dom } from "./dom.js";
import { state } from "./state.js";
import { withShortcutHint } from "./shortcut-hint.js";

export function syncLoopButton(): void {
    const behavior = state.tripEndBehavior;
    const isAdvance = behavior === "advance";
    // aria-pressed = "trip end does NOT just stop" (loop or advance).
    dom.playerBar.loop.setAttribute("aria-pressed", behavior === "stop" ? "false" : "true");
    // Icon: repeat for stop/loop, skip-forward for advance.
    const repeatIcon = dom.playerBar.loop.querySelector<SVGElement>(".i-loop-repeat");
    const advanceIcon = dom.playerBar.loop.querySelector<SVGElement>(".i-loop-advance");
    if (repeatIcon) repeatIcon.toggleAttribute("hidden", isAdvance);
    if (advanceIcon) advanceIcon.toggleAttribute("hidden", !isAdvance);
    const label = isAdvance
        ? t("player.loop.advance")
        : behavior === "loop"
          ? t("player.loop.on")
          : t("player.loop.off");
    dom.playerBar.loop.setAttribute("aria-label", label);
    dom.playerBar.loop.setAttribute("title", withShortcutHint(label, "R"));
}

/** Cycles trip-end behavior stop -> loop -> advance -> stop (the media-player
 *  repeat-off/all/one convention). Shared by the click handler and the R hotkey
 *  so both go through one source of truth. */
export function toggleLoop(): void {
    state.tripEndBehavior =
        state.tripEndBehavior === "stop" ? "loop" : state.tripEndBehavior === "loop" ? "advance" : "stop";
    syncLoopButton();
}

export function initPlayerLoop(): void {
    dom.playerBar.loop.addEventListener("click", toggleLoop);
}
