// iOS/iPadOS folder-picker warning. On iOS 18.4+ <input webkitdirectory> works
// by copying the ENTIRE chosen folder into the browser's temporary storage
// before the page sees a single file, and a copy interrupted mid-way strands
// the data on the device (mechanism + WebKit references:
// docs/browser-support.md).
//
// So on iOS the modal shows EVERY time before the folder picker - no TTL gate,
// it guards against real harm - and steers to picking individual files: those
// go through the same copy, but only for the selection, and a completed copy is
// scheduled for cleanup. On iOS this modal replaces upload-warning-modal (its
// body carries the "nothing is uploaded" reassurance).

import { dom } from "./dom.js";
import { createModalResult } from "./modal-result.js";
import { activateModal, deactivateModal, wireBackdropDismiss } from "./modal-helper.js";

/** What the user chose in the iOS folder warning:
 *  pick individual files, insist on the whole folder, or back out. */
export type IosFolderWarningChoice = "files" | "folder" | "cancel";

const modalResult = createModalResult<IosFolderWarningChoice>();

/**
 * Shows the modal and resolves with the user's choice. If the modal markup is
 * absent, resolves "folder" so the caller falls through to the pre-warning
 * behavior. If the modal is already open, the previous promise resolves as
 * cancel (rapid double-tap on the CTA).
 */
export function showIosFolderWarning(): Promise<IosFolderWarningChoice> {
    if (!dom.iosFolderWarningModal) return Promise.resolve("folder");

    const result = modalResult.wait("cancel");

    dom.iosFolderWarningModal.hidden = false;
    // Focus lands on the primary action - "choose files", the safe path.
    activateModal(dom.iosFolderWarningModal, {
        onClose: () => close("cancel"),
        initialFocus: dom.iosFolderWarningModalFiles,
    });

    return result;
}

function close(choice: IosFolderWarningChoice): void {
    if (!dom.iosFolderWarningModal) return;
    dom.iosFolderWarningModal.hidden = true;
    deactivateModal(dom.iosFolderWarningModal);
    modalResult.settle(choice);
}

/**
 * Registers close event handlers. Called from app.ts once on startup.
 */
export function initIosFolderWarningModal(): void {
    dom.iosFolderWarningModalFiles?.addEventListener("click", () => close("files"));
    dom.iosFolderWarningModalFolder?.addEventListener("click", () => close("folder"));
    dom.iosFolderWarningModalCancel?.addEventListener("click", () => close("cancel"));
    // Click on the overlay itself (not the card inside) cancels.
    if (dom.iosFolderWarningModal) wireBackdropDismiss(dom.iosFolderWarningModal, () => close("cancel"));
    // Escape is handled centrally by the modal manager (activateModal).
}
