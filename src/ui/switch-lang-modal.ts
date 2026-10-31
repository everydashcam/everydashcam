// "Reload to switch language?" confirm. Shown by the language switcher when the
// user picks a different language while a trip is loaded. Switching language is
// a full page reload (only the active locale is bundled, so a live in-place swap
// is no longer possible), and a reload discards the loaded recordings - the File
// API handles do not survive navigation. Warn before that; on confirm the
// switcher navigates to the prerendered /<lang>/ page.
//
// Unlike the upload-warning modal, default focus is the CANCEL button: this is a
// destructive confirm (reload throws away the in-memory session), so the safe
// action is the default and Enter does not nuke the session by reflex.

import { dom } from "./dom.js";
import { createModalResult } from "./modal-result.js";
import { activateModal, deactivateModal, wireBackdropDismiss } from "./modal-helper.js";

const modalResult = createModalResult<boolean>();

/**
 * Shows the confirm and resolves a promise:
 *  - true  - user pressed Reload -> caller navigates (loaded recordings are lost).
 *  - false - Cancel / Esc / backdrop click -> caller does nothing.
 *
 * If the modal markup is missing (should not happen), resolves false: a missing
 * confirm must never silently discard the session by navigating unconfirmed.
 *
 * Idempotent: a second call while the modal is open resolves the previous
 * promise as cancel first (a rapid double lang-pick).
 */
export function showSwitchLangConfirm(): Promise<boolean> {
    if (!dom.switchLangModal) return Promise.resolve(false);

    const result = modalResult.wait(false);

    dom.switchLangModal.hidden = false;
    activateModal(dom.switchLangModal, {
        onClose: () => close(false),
        initialFocus: dom.switchLangModalCancel,
    });

    return result;
}

function close(confirmed: boolean): void {
    if (!dom.switchLangModal) return;
    dom.switchLangModal.hidden = true;
    deactivateModal(dom.switchLangModal);
    modalResult.settle(confirmed);
}

/** Registers close event handlers. Called once from app.ts on startup. */
export function initSwitchLangModal(): void {
    dom.switchLangModalConfirm?.addEventListener("click", () => close(true));
    dom.switchLangModalCancel?.addEventListener("click", () => close(false));
    // Click on the overlay itself (not the card inside) cancels.
    if (dom.switchLangModal) wireBackdropDismiss(dom.switchLangModal, () => close(false));
    // Escape is handled centrally by the modal manager (activateModal).
}
