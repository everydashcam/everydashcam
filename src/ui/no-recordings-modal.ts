// "Couldn't read this card" modal - shown after a zero-trips ingest that
// still contained recording-like files (the unrecognised-camera case). It is a
// thin router, not a report generator: the primary CTA is a .feedback-link that
// opens the feedback form (which auto-attaches the byte-free folder-structure
// report from the raw ingest snapshot), and the secondary link opens the public
// help page. Both delivery mechanics live in feedback.ts / the static page.

import { activateModal, deactivateModal, wireBackdropDismiss } from "./modal-helper.js";

function modalEl(): HTMLElement | null {
    return document.getElementById("no-recordings-modal");
}

/** Opens the modal. The demand signal for the unrecognised-camera funnel. */
export function showNoRecordingsModal(): void {
    const m = modalEl();
    if (!m) return;
    m.hidden = false;
    activateModal(m, { onClose: closeModal, initialFocus: document.getElementById("no-recordings-help") });
}

function closeModal(): void {
    const m = modalEl();
    if (!m) return;
    m.hidden = true;
    deactivateModal(m);
}

/** Wires the close paths. The "help" CTA is a .feedback-link handled centrally
 *  by feedback.ts (it closes this dialog and opens the form); the "how it works"
 *  link is a plain anchor. */
export function initNoRecordingsModal(): void {
    const m = modalEl();
    if (!m) return;
    document.getElementById("no-recordings-cancel")?.addEventListener("click", closeModal);
    // Backdrop click (outside the card) closes.
    wireBackdropDismiss(m, closeModal, { cardSelector: ".export-modal-card" });
    // Escape is handled centrally by the modal manager (onClose: closeModal).
}
