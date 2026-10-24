// File sources: <input webkitdirectory> in the header + full-page DnD
// (with recursive folder traversal via FileSystemEntry API). Both paths
// converge into ingestFiles(VendorFile[]).

import { identifyBrowser } from "../capabilities.js";
import type { IngestStructureEntry } from "../ingest-structure.js";
import { createLogger } from "../log.js";
import type { VendorFile } from "../parsers/types.js";

import { dom } from "./dom.js";
import { collectFilesFromDataTransfer } from "./file-source-entries.js";
import { beginPreIngestReading, endPreIngestReading } from "./ingest-overlay.js";
import { ingestFiles } from "./ingest.js";
import { toVendorFiles } from "./ingest-core.js";
import { showIosFolderWarning } from "./ios-folder-warning-modal.js";
import { notify } from "./notifications.js";
import { canUseDirectoryPicker, openViaDirectoryPicker } from "./persistent-folders.js";
import { shouldShowUploadWarning, showUploadWarning } from "./upload-warning-modal.js";

const log = createLogger("file-sources");

/**
 * Whether a DataTransfer contains files (not text/url/anything else). Used to
 * avoid showing the overlay when dragging text or internal page elements
 * (e.g. the sidebar resize handle).
 */
function dragHasFiles(dt: DataTransfer | null): boolean {
    // Per DOM Living Standard, DataTransfer.types is ReadonlyArray<string>
    // with native .includes. All targeted browsers (current major versions)
    // comply with this contract.
    return !!dt && dt.types?.includes("Files");
}

// Pending show-side rAF. hideDropOverlay cancels it: dragenter->dragleave
// within one frame otherwise runs hide BEFORE the rAF adds .visible, the
// 160ms check then sees the class and skips hidden=true - leaving a
// pointer-events:auto full-screen overlay stuck over the app.
let dropOverlayShowRaf = 0;

function showDropOverlay(): void {
    if (!dom.dropOverlay) return;
    dom.dropOverlay.hidden = false;
    // requestAnimationFrame so the browser applies hidden=false before adding
    // the class - otherwise the transition does not trigger (transitions from
    // display:none are not triggered in the browser layout pipeline).
    if (dropOverlayShowRaf) cancelAnimationFrame(dropOverlayShowRaf);
    dropOverlayShowRaf = requestAnimationFrame(() => {
        dropOverlayShowRaf = 0;
        dom.dropOverlay.classList.add("visible");
    });
}

function hideDropOverlay(): void {
    if (!dom.dropOverlay) return;
    if (dropOverlayShowRaf) {
        cancelAnimationFrame(dropOverlayShowRaf);
        dropOverlayShowRaf = 0;
    }
    dom.dropOverlay.classList.remove("visible");
    // Hide after the opacity transition ends to avoid an abrupt cut.
    // 160ms is slightly longer than the 120ms CSS transition.
    setTimeout(() => {
        if (!dom.dropOverlay.classList.contains("visible")) {
            dom.dropOverlay.hidden = true;
        }
    }, 160);
}

export function initFileSources(): void {
    dom.folderInput.addEventListener("change", () => {
        const files = Array.from(dom.folderInput.files || []);
        if (files.length === 0) {
            // Empty selection (an empty folder, or some browsers' "open" with
            // nothing chosen). ingestFiles([]) only warns and returns, so it
            // will not hide the pre-ingest overlay we raised on click - retract
            // it here.
            endPreIngestReading();
        }
        ingestFiles(toVendorFiles(files));
        dom.folderInput.value = "";
    });

    // The OS file picker was dismissed without choosing anything - retract the
    // pre-ingest overlay raised in openFolderPicker(). This is the seamless
    // auto-retract on browsers that fire the input "cancel" event (Chrome 113+,
    // Firefox 109+, Safari 16.4+). Chrome/Edge 94-112 are within our support
    // floor (Chrome 94, docs/browser-support.md) and do NOT fire it; there the
    // overlay's own Cancel button (kept enabled during the pre-ingest phase) is
    // the manual escape, so a missed cancel is never a reload-only dead end.
    dom.folderInput.addEventListener("cancel", () => endPreIngestReading());

    // The plain multi-file input (the iOS escape hatch) mirrors the folder
    // input's change/cancel wiring. webkitRelativePath is empty for a flat
    // pick, so toVendorFiles falls back to bare filenames - same shape a flat
    // file drop produces.
    dom.fileInput.addEventListener("change", () => {
        const files = Array.from(dom.fileInput.files || []);
        if (files.length === 0) endPreIngestReading();
        ingestFiles(toVendorFiles(files));
        dom.fileInput.value = "";
    });
    dom.fileInput.addEventListener("cancel", () => endPreIngestReading());

    // Drag-and-drop works across the whole window. CTA wrappers (landing-drop
    // and sidebar-cta) are label[for="folder-input"] elements. The landing
    // drop card contains an inner <button id="landing-cta"> as the primary
    // visual CTA - <button> is a labelable element, so HTML spec skips the
    // label's "synthesize click on the labeled control" default action when
    // the click target is the button. That means clicking the orange button
    // would do nothing if we relied on native label semantics. We bypass that
    // by always preventDefault + always calling folderInput.click() ourselves.
    //
    // Before the picker opens, the upload-warning modal (once per 30 days, see
    // upload-warning-modal.ts) shows so the user is not greeted by the scary
    // "Upload N files to this site?" prompt without context. uploadWarningInFlight
    // guards a double-click while the async modal renders.
    // Raises the pre-ingest overlay, THEN opens the OS folder picker. The
    // overlay goes up before .click() on purpose: once the picker is open the
    // page yields control, and after the user picks a folder the browser
    // enumerates the whole tree before firing change - a window that runs no JS
    // and can take seconds on a slow card. Showing the overlay first means the
    // page is never blank across that window. Retracted by the change handler
    // (a selection) or the cancel event (a dismissal).
    const openFolderPicker = (): void => {
        // On Chromium the FSA directory picker yields a persistable handle
        // (remember + zero-click restore, see persistent-folders.ts); the
        // classic input stays everywhere else AND as the in-flight fallback.
        if (canUseDirectoryPicker()) {
            void openViaDirectoryPicker();
            return;
        }
        beginPreIngestReading();
        dom.folderInput.click();
    };

    // On iOS/iPadOS the folder picker copies the entire chosen tree into the
    // browser's temporary storage before firing change (see
    // ios-folder-warning-modal.ts) - so the CTA routes through a warning that
    // shows EVERY time and steers to picking individual files. It replaces the
    // TTL-gated upload warning there: its body carries the same "nothing is
    // uploaded" reassurance. Computed once - the UA does not change mid-session.
    const isIos = identifyBrowser().os === "ios";

    let pickerGateInFlight = false;
    for (const cta of [dom.landingDrop, dom.landingDock, dom.sidebarCta]) {
        if (!cta) continue;
        cta.addEventListener("click", async (e) => {
            // Stop both native label-for-activation (when target is a passive
            // descendant) and any default button activation. We open the picker
            // explicitly below.
            e.preventDefault();
            if (isIos) {
                if (pickerGateInFlight) return;
                pickerGateInFlight = true;
                try {
                    const choice = await showIosFolderWarning();
                    if (choice === "files") {
                        beginPreIngestReading();
                        dom.fileInput.click();
                    } else if (choice === "folder") {
                        openFolderPicker();
                    }
                } finally {
                    pickerGateInFlight = false;
                }
                return;
            }
            if (!shouldShowUploadWarning()) {
                openFolderPicker();
                return;
            }
            if (pickerGateInFlight) return;
            pickerGateInFlight = true;
            try {
                const continued = await showUploadWarning();
                if (continued) openFolderPicker();
            } finally {
                pickerGateInFlight = false;
            }
        });
    }

    // Counter of active dragenter events without a matching dragleave. Without
    // it the overlay flickers as the cursor moves over child elements - dragleave
    // fires on every nested element boundary. Only the outermost enter/leave at
    // the window boundary behaves correctly.
    let dragDepth = 0;

    window.addEventListener("dragenter", (e) => {
        if (!dragHasFiles(e.dataTransfer)) return;
        e.preventDefault();
        dragDepth++;
        if (dragDepth === 1) showDropOverlay();
    });

    window.addEventListener("dragover", (e) => {
        if (!dragHasFiles(e.dataTransfer)) return;
        // preventDefault is required - without it drop does not fire (the browser
        // navigates to the file by default, as if opening it).
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    });

    window.addEventListener("dragleave", (e) => {
        if (!dragHasFiles(e.dataTransfer)) return;
        dragDepth = Math.max(0, dragDepth - 1);
        if (dragDepth === 0) hideDropOverlay();
    });

    window.addEventListener("drop", async (e) => {
        if (!dragHasFiles(e.dataTransfer)) return;
        e.preventDefault();
        dragDepth = 0;
        hideDropOverlay();

        // Raise the overlay BEFORE walking the dropped tree:
        // collectFilesFromDataTransfer enumerates the tree and opens eligible
        // file handles. This can take seconds on a large card, during which
        // the drop overlay is already gone and the real ingest has not started.
        // No-op when an ingest is already running (the second drop queues and
        // that overlay stays - see beginPreIngestReading).
        beginPreIngestReading();

        let files: VendorFile[];
        let readErrors: number;
        let structure: IngestStructureEntry[];
        try {
            ({ files, readErrors, structure } = await collectFilesFromDataTransfer(e.dataTransfer));
        } catch (err) {
            // Defensive net: walkEntry swallows per-entry errors, so this only
            // fires on an unexpected failure of the whole traversal. Without it
            // a rejected promise would silently drop the gesture.
            endPreIngestReading();
            log.error("dnd: file collection failed", err);
            notify({ severity: "error", messageKey: "status.dropReadFailed" });
            return;
        }

        if (files.length === 0) {
            // Release the traversal overlay before passing diagnostic names
            // to ingest; there are no file handles to process.
            endPreIngestReading();
            // Preserve the structure even when nothing is eligible or readable.
            // Ingest owns the report snapshot; a failed drop still has names.
            if (readErrors > 0) {
                notify({ severity: "error", messageKey: "status.dropReadFailed" });
            }
            ingestFiles(files, null, structure);
            return;
        }

        // Partial success: ingest what we read, but flag the skipped files.
        if (readErrors > 0) notify({ severity: "warn", messageKey: "status.dropReadFailed" });
        ingestFiles(files, null, structure);
    });

    // Keyboard activation for label-based CTAs. sidebarCta is a focusable
    // label[for=folder-input]; without explicit handling, Space/Enter on the
    // focused label do nothing - the native form-control activation runs only
    // on click. We delegate to cta.click() so the click handler with the
    // upload-warning gate fires once. landingDrop has no tabindex - its inner
    // <button id="landing-cta"> handles Enter/Space natively (browser fires a
    // click on the button, which bubbles to the label's click listener).
    if (dom.sidebarCta) {
        const cta = dom.sidebarCta;
        cta.addEventListener("keydown", (e) => {
            if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                cta.click();
            }
        });
    }

    // Native labels can open the picker before JavaScript is ready. Keep the
    // inputs and hero button disabled until selections have their handlers.
    dom.folderInput.disabled = false;
    dom.fileInput.disabled = false;
    dom.landingCta?.removeAttribute("disabled");
    dom.landingCta?.classList.remove("is-pending");
    dom.landingCta?.removeAttribute("aria-busy");
}
