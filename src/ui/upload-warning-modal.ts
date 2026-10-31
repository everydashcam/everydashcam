// "Files stay on your device" modal. Shown before the system file-picker opens
// via CTA buttons (#landing-cta / #sidebar-cta) so the user is not startled by
// the browser prompt "Upload N files to this site?". The browser shows the same
// scary dialog for a real server upload and for local folder access - we explain
// upfront that this is the latter.
//
// Gate: shown ONCE per WARNING_TTL_MS (30 days) or on first visit. The timestamp
// of the last show is stored in localStorage. If localStorage is unavailable
// (private mode) the modal shows every session, which is harmless.
//
// Not shown on DnD: the user consciously dropped a folder into the window and
// the browser shows no prompts in that flow.

import { createLogger } from "../log.js";
import { dom } from "./dom.js";
import { createModalResult } from "./modal-result.js";
import { activateModal, deactivateModal, wireBackdropDismiss } from "./modal-helper.js";

const log = createLogger("upload-warning");

const STORAGE_KEY = "everydashcam:upload-warning-shown-at";
const WARNING_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

const modalResult = createModalResult<boolean>();

/**
 * Whether to show the modal on the next CTA trigger. Returns true if the
 * last-shown timestamp is absent or older than TTL. localStorage unavailable
 * -> true (safe fallback: the modal shows an extra time but does not block).
 */
export function shouldShowUploadWarning(): boolean {
    let raw: string | null;
    try {
        raw = localStorage.getItem(STORAGE_KEY);
    } catch {
        return true;
    }
    if (raw === null) return true;
    const shownAt = Number(raw);
    if (!Number.isFinite(shownAt)) return true;
    return Date.now() - shownAt > WARNING_TTL_MS;
}

/**
 * Persists the current show timestamp. Called on Continue, not on cancel -
 * otherwise a user who changed their mind the first time would see the same
 * warning a minute later and think something broke. This is "seen and agreed",
 * not just "seen".
 */
function markSeen(): void {
    try {
        localStorage.setItem(STORAGE_KEY, String(Date.now()));
    } catch (err) {
        log.warn("could not persist shown-at", err);
    }
}

/**
 * Shows the modal and resolves a promise:
 *  - true  - user pressed Continue (or Enter on the CTA button) -> caller
 *            should open the file-picker.
 *  - false - user pressed Cancel / Esc / clicked the backdrop -> caller
 *            does not open.
 *
 * Idempotent: if the modal is already open the previous promise resolves as
 * cancel. In practice the double-call happens if the user rapidly clicks the
 * CTA multiple times.
 */
export function showUploadWarning(): Promise<boolean> {
    if (!dom.uploadWarningModal) return Promise.resolve(true);

    const result = modalResult.wait(false);

    dom.uploadWarningModal.hidden = false;
    // Focus on the primary action (Continue) so the user can press Enter
    // immediately if confident. Cancel requires tab or mouse - correct for a
    // positive-confirm pattern.
    activateModal(dom.uploadWarningModal, {
        onClose: () => close(false),
        initialFocus: dom.uploadWarningModalContinue,
    });

    return result;
}

function close(continued: boolean): void {
    if (!dom.uploadWarningModal) return;
    dom.uploadWarningModal.hidden = true;
    deactivateModal(dom.uploadWarningModal);
    if (continued) markSeen();
    modalResult.settle(continued);
}

/**
 * Registers close event handlers. Called from app.ts once on startup.
 */
export function initUploadWarningModal(): void {
    dom.uploadWarningModalContinue?.addEventListener("click", () => close(true));
    dom.uploadWarningModalCancel?.addEventListener("click", () => close(false));
    // Click on the overlay itself (not the card inside) cancels.
    if (dom.uploadWarningModal) wireBackdropDismiss(dom.uploadWarningModal, () => close(false));
    // Escape is handled centrally by the modal manager (activateModal).
}
