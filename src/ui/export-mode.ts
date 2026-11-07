// Export-mode visual orchestration. Listens to state.exportModeOpen changes
// (via subscribeExportState) and applies the side-effects that don't fit
// inside individual UI modules:
//  - toggles body.export-mode (CSS-driven: sidebar slide-out, export-panel
//    slide-in, top-panel visibility);
//  - shows/hides the export-panel skeleton (visibility kept in sync with the
//    body class so the panel is not focusable while hidden);
//  - wires the panel's Close button to closeExportMode();
//  - pauses the video when entering export mode (the user is configuring,
//    audio over an unattended file is jarring; matches the previous modal
//    behavior).
//
// The panel content (Save button, quality controls, progress section, ...) is
// rendered by src/ui/export-panel.ts; this module owns only the show/hide and
// global mode-side-effects.

import { dom } from "./dom.js";
import { cancelActiveExport } from "./export-flow.js";
import { closeExportMode, exportPanelState, subscribeExportState } from "./export-state.js";
import { maybeRunExportTour } from "./onboarding.js";
import { pausePlayback } from "./playback-pause.js";
import { resetVideoZoom } from "./player-zoom.js";
import { state } from "./state.js";

/**
 * Wires the export-mode lifecycle. Must be called once on startup, after
 * dom.ts has resolved the new element refs. Idempotent if called more than
 * once but does not detect re-init - keep the call site single.
 */
export function initExportMode(): void {
    subscribeExportState(syncExportModeChrome);

    if (dom.exportPanelClose) {
        dom.exportPanelClose.addEventListener("click", () => {
            closeExportAndCancelIfRunning();
        });
    }

    // Esc closes export-mode globally. Document-level listener is fine here -
    // export-mode is a coarse-grained app state, not a stack of nested dialogs.
    // We bail out when other elements have intercepted the key (e.g. a focused
    // dropdown handling its own Esc) by checking defaultPrevented.
    //
    // While an export is running we deliberately ignore Esc: a reflexive
    // keypress must not silently kill a long export. The header X and the
    // progress-section Cancel button are the explicit ways out (both cancel).
    document.addEventListener("keydown", (ev) => {
        if (ev.key !== "Escape") return;
        if (ev.defaultPrevented) return;
        if (!state.exportModeOpen) return;
        // Escape leaves the preview before it can close the editor.
        if (dom.playerWrap.classList.contains("player-expanded")) return;
        if (exportPanelState.phase === "progress" || exportPanelState.configurationLocked) return;
        closeExportMode();
    });

    // Initial sync so the chrome reflects the default state.exportModeOpen=false.
    syncExportModeChrome();
}

/**
 * Closes the panel, aborting an in-flight export first. Used by the header X:
 * clicking it during progress means "get me out", so we cancel the export
 * (drops the partial output on disk via the FSA temp-file rollback) rather than
 * leaving it running in the background with the UI hidden. A no-op abort is
 * safe in options/done/error phases (no active controller).
 */
function closeExportAndCancelIfRunning(): void {
    if (exportPanelState.configurationLocked && exportPanelState.phase === "options") return;
    if (exportPanelState.phase === "progress") cancelActiveExport();
    closeExportMode();
}

/**
 * Applies state.exportModeOpen to the DOM. Called by every subscriber tick;
 * cheap (read flag, toggle a class, flip hidden). The CSS in export-panel.css
 * drives all visual transitions from the body class - no per-element
 * animation code here.
 */
let wasExportModeOpen = false;
let exportOpener: HTMLElement | null = null;

function syncExportModeChrome(): void {
    const open = state.exportModeOpen;
    const isOpening = open && !wasExportModeOpen;
    const isClosing = !open && wasExportModeOpen;
    const focusWasInExport =
        !!dom.exportPanel?.contains(document.activeElement) ||
        !!dom.exportTrimBar?.contains(document.activeElement) ||
        !!dom.topPanel?.contains(document.activeElement);
    if (isOpening) {
        exportOpener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    }
    document.body.classList.toggle("export-mode", open);

    // On entering export mode, reset digital zoom: the crop preview owns the
    // video transform here (player-crop), so a leftover zoom transform would
    // fight it, and the zoom mini-preview is irrelevant while configuring the
    // export. Only on the transition - not every subscriber tick.
    if (isOpening) {
        resetVideoZoom();
        // First-run onboarding for the export panel. Self-guarded; deferred so
        // export-panel.ts has rendered the options by the time the tour points
        // at them.
        maybeRunExportTour();
    }
    wasExportModeOpen = open;

    // The panel uses [hidden]=false + CSS transform for slide animation. We
    // keep [hidden]=false whenever the body class allows the slide-in, so
    // tab navigation doesn't get stuck on an invisible-but-focusable element
    // immediately after the close transition.
    if (dom.exportPanel) {
        dom.exportPanel.hidden = !open;
        dom.exportPanel.inert = !open;
    }

    if (isClosing && (focusWasInExport || document.activeElement === document.body)) {
        const candidates = [
            exportOpener,
            dom.exportBtn,
            document.getElementById("player-overflow"),
            document.getElementById("player-play"),
        ];
        candidates
            .find(
                (el) =>
                    el &&
                    el !== document.body &&
                    el.getClientRects().length > 0 &&
                    !el.matches(":disabled") &&
                    !el.closest("[inert]"),
            )
            ?.focus();
        exportOpener = null;
    }

    // Pause playback on entering export mode: the user is configuring, and
    // background audio is distracting. Matches the previous modal behavior
    // (export-modal.ts paused dom.player on openExportClick).
    if (isOpening) pausePlayback();
}
