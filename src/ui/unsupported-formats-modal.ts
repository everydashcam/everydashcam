// "Some files cannot be opened" modal. Shown by ingest before indexing when the drop contains
// files with extensions we cannot play. User dismisses and ingest continues with the usable files.
//
// UNPLAYABLE_VIDEO_EXTENSIONS is a closed list of containers that neither native <video> nor
// mediabunny handles in any target browser: AVI (FineVu/Comtec/Cellstar/Lukas legacy),
// WMV/FLV, 3GP, MTS (AVCHD camcorder), and proprietary .JDR (IROAD),
// .MDT (Yupiteru legacy), .INSV (Insta360/Drift), .360 (Botslab), .CHK (some Chinese OEMs).
// MOV is excluded - QuickTime works in both <video> and mediabunny QTFF.
// TS/M2TS and MKV are excluded - mediabunny demuxes MPEG-TS and Matroska, and the
// player forces the MSE remux path for those (see per-file-mse.ts), so they ARE playable.
//
// There is no point running vendor classify() on these extensions - even if the plugin
// recognizes the name, the video will not play. The modal is the last communication channel.

import { escapeHtml } from "../escape.js";
import { t } from "../i18n/index.js";
import { dom } from "./dom.js";
import { createModalResult } from "./modal-result.js";
import { activateModal, deactivateModal, wireBackdropDismiss } from "./modal-helper.js";

/** Extensions we definitively cannot play. Lowercase, with dot. Everything outside this set is either playable (.mp4/.mov) or non-video (.txt/.gpx/.bin/...) and handled by classify(). */
const UNPLAYABLE_VIDEO_EXTENSIONS: ReadonlySet<string> = new Set([
    ".avi",
    ".mts",
    ".wmv",
    ".flv",
    ".3gp",
    ".jdr",
    ".mdt",
    ".insv",
    ".360",
    ".chk",
]);

/** Groups files by unsupported extension. Returns an empty Map if all extensions are supported (caller skips the modal). */
export function countUnplayableByExtension(filenames: Iterable<string>): Map<string, number> {
    const out = new Map<string, number>();
    for (const name of filenames) {
        const dot = name.lastIndexOf(".");
        if (dot < 0) continue;
        const ext = name.slice(dot).toLowerCase();
        if (!UNPLAYABLE_VIDEO_EXTENSIONS.has(ext)) continue;
        out.set(ext, (out.get(ext) ?? 0) + 1);
    }
    return out;
}

const modalResult = createModalResult<void>();

/**
 * Shows the modal and resolves when the user closes it (Got it / Esc / backdrop click).
 * Idempotent: a second call while open resolves the previous promise first, then sets a new one.
 * In practice this happens when a second drop arrives while the first modal is still shown.
 */
export function showUnsupportedFormatsModal(byExt: Map<string, number>): Promise<void> {
    if (!dom.unsupportedModal || !dom.unsupportedModalList) return Promise.resolve();

    const result = modalResult.wait(undefined);

    // Sort descending so the most common extension appears first.
    const entries = [...byExt.entries()].sort((a, b) => b[1] - a[1]);
    dom.unsupportedModalList.innerHTML = entries
        .map((entry) => {
            const ext = entry[0];
            const n = entry[1];
            return `<li>${escapeHtml(t("unsupported.modal.entry", { ext, n }))}</li>`;
        })
        .join("");

    dom.unsupportedModal.hidden = false;
    activateModal(dom.unsupportedModal, { onClose: closeModal, initialFocus: dom.unsupportedModalClose });

    return result;
}

/** Hides the modal and resolves the pending promise. */
function closeModal(): void {
    if (!dom.unsupportedModal) return;
    dom.unsupportedModal.hidden = true;
    deactivateModal(dom.unsupportedModal);
    modalResult.settle(undefined);
}

/** Wires up event listeners. Called once from app.ts on startup. */
export function initUnsupportedFormatsModal(): void {
    dom.unsupportedModalClose?.addEventListener("click", closeModal);
    // Click on the overlay itself (outside the card) also closes.
    if (dom.unsupportedModal) wireBackdropDismiss(dom.unsupportedModal, closeModal);
    // Escape is handled centrally by the modal manager (activateModal).
}
