import type { ClassifiedFile } from "../parsers/registry-light.js";
import type { VendorFile } from "../parsers/types.js";
import { candidateGroupingKey, type VideoCandidate } from "../trips.js";
import { vendorFileKey } from "../vendor-file-key.js";
import { dom } from "./dom.js";
import { activateModal, deactivateModal, isAnyModalOpen, wireBackdropDismiss } from "./modal-helper.js";
import { state } from "./state.js";

let hasShown = false;
let pendingOnDismiss: (() => void) | null = null;

export function is70maiGpsLog({ file, logExtractorId }: ClassifiedFile): boolean {
    // A named log can be present even if it's empty or its header is unreadable.
    return (
        /^gpsdata.*\.txt$/i.test(file.file.name) ||
        logExtractorId === "csv-70mai" ||
        logExtractorId === "csv-70mai-dated"
    );
}

function sourcePathKey(file: VendorFile): string {
    // The recording reader can replace the File with a repaired copy.
    return `${file.sourceKey ?? ""}\0${file.relativePath || file.file.name}`;
}

function normalizedPath(file: VendorFile): string {
    return (file.relativePath || file.file.name).replaceAll("\\", "/").replace(/^\/+/, "").toLowerCase();
}

function logCoversRecording(log: VendorFile, recording: VendorFile): boolean {
    if (log.sourceKey !== recording.sourceKey) return false;
    const path = normalizedPath(log);
    const directory = path.slice(0, path.lastIndexOf("/") + 1).replace(/(^|\/)\.gps\/$/, "$1");
    return normalizedPath(recording).startsWith(directory);
}

function isViewerBusy(): boolean {
    return (
        state.exportModeOpen ||
        state.transcodeInProgress ||
        (document.fullscreenElement ?? document.querySelector(".player-expanded")) !== null
    );
}

export function maybeShowMissing70maiGps(
    recordings: readonly VideoCandidate[],
    importedFiles: readonly VendorFile[],
    gpsLogs: readonly VendorFile[],
    onDismiss?: () => void,
): boolean {
    if (hasShown || isAnyModalOpen() || isViewerBusy()) return false;
    const mai70Recordings = recordings.filter((recording) => recording.fingerprint.startsWith("70mai|"));
    if (mai70Recordings.length === 0) return false;

    const camerasWithGpsOrIncompleteChecks = new Set<string>();
    for (const recording of mai70Recordings) {
        const key = vendorFileKey(recording);
        if (
            recording.records.length > 0 ||
            state.pendingHeavyEmbeddedGps.has(key) ||
            state.inflightEmbeddedGps.has(key) ||
            state.failedEmbeddedGps.has(key)
        ) {
            camerasWithGpsOrIncompleteChecks.add(candidateGroupingKey(recording));
        }
    }

    const imported = new Set(importedFiles.map(sourcePathKey));
    const mayNeedLog = mai70Recordings.some(
        (recording) =>
            recording.metadataReady === true &&
            (recording.channel === "front" || recording.channel === null) &&
            !recording.isTimelapse &&
            imported.has(sourcePathKey(recording)) &&
            !camerasWithGpsOrIncompleteChecks.has(candidateGroupingKey(recording)) &&
            !gpsLogs.some((log) => logCoversRecording(log, recording)),
    );
    if (!mayNeedLog) return false;

    hasShown = true;
    pendingOnDismiss = onDismiss ?? null;
    dom.missing70maiGpsModal.hidden = false;
    activateModal(dom.missing70maiGpsModal, {
        onClose: dismissMissing70maiGpsModal,
        initialFocus: dom.missing70maiGpsOpenCard,
        returnFocus: document.activeElement === document.body ? dom.sidebarCta : undefined,
    });
    return true;
}

function dismissMissing70maiGpsModal(): void {
    const onDismiss = pendingOnDismiss;
    pendingOnDismiss = null;
    if (dom.missing70maiGpsModal.hidden) return;
    dom.missing70maiGpsModal.hidden = true;
    deactivateModal(dom.missing70maiGpsModal);
    onDismiss?.();
}

export function hideMissing70maiGpsModal(): void {
    pendingOnDismiss = null;
    if (dom.missing70maiGpsModal.hidden) return;
    dom.missing70maiGpsModal.hidden = true;
    deactivateModal(dom.missing70maiGpsModal);
}

export function initMissing70maiGpsModal(onAddFiles: () => void, onOpenCard: () => void): void {
    // Keep the dialog underneath the picker wait so dismissing the picker
    // returns to the same action. A new ingest closes the dialog.
    dom.missing70maiGpsAddFiles.addEventListener("click", onAddFiles);
    dom.missing70maiGpsOpenCard.addEventListener("click", onOpenCard);
    dom.missing70maiGpsDismiss.addEventListener("click", dismissMissing70maiGpsModal);
    wireBackdropDismiss(dom.missing70maiGpsModal, dismissMissing70maiGpsModal);
}

export function _resetForTests(): void {
    hasShown = false;
    pendingOnDismiss = null;
}
