// Persistent-folder UX (Chromium-only, capability "persistentFolder"):
//  - the FSA directory picker the landing CTA routes through,
//  - the recent-folder chips on the landing: one-click reopen, a status dot
//    per chip (a background liveness probe colors it), forget one / forget
//    all. Nothing opens without a click - a remembered folder is an offer,
//    not an autostart. Unavailable chips grey out but stay: a renamed-back or
//    re-plugged folder revives its stored handle.
//
// This is the LANDING half of the folder feature - "what can I open". Once
// trips are loaded the landing is gone for good, and the session half
// (ui/folder-sources.ts) takes over: which folder the open trips came from and
// whether it should be remembered.
//
// IndexedDB unavailability (private mode, storage off) quietly degrades the
// whole module to "picker without memory" - never a user-facing error.

import { detectCapabilities } from "../capabilities.js";
import { createLogger } from "../log.js";
import {
    enumerateFolder,
    type FolderAvailability,
    forgetAllFolders,
    forgetFolder,
    listFolders,
    markFolderOpened,
    probeFolderAvailability,
    queryFolderPermission,
    requestFolderPermission,
} from "../persist/folders.js";
import type { RememberedFolder } from "../persist/types.js";
import type { VendorFile } from "../parsers/types.js";
import { t } from "../i18n/index.js";

import { dom } from "./dom.js";
import { withFilePicker } from "./file-picker.js";
import {
    bindSourceToFolder,
    disambiguatedLabels,
    folderDisplayLabel,
    notifyFolderOpened,
    purgeAllFolderSessionState,
    purgeFolderSessionState,
    registerIngestSource,
    registerRememberedFolderOpener,
    setRememberedAvailability,
} from "./folder-sources.js";
import { beginPreIngestReading, endPreIngestReading } from "./ingest-overlay.js";
import { ingestFiles } from "./ingest.js";
import { notify } from "./notifications.js";

const log = createLogger("persistent-folders");

// Latest known liveness per folder, fed by the render-time probe and by
// actual open attempts. Session-only - reality is re-probed on every render.
const availabilityById = new Map<string, FolderAvailability>();

let pickerInFlight = false;

/** Whether the FSA picker path should be used instead of <input webkitdirectory>. */
export function canUseDirectoryPicker(): boolean {
    const report = detectCapabilities();
    return report.capabilities.some((c) => c.id === "persistentFolder" && c.ok);
}

/**
 * Wires the landing chips. Call once from app.ts after notifications/overlay
 * init. Resolves after the initial chip geometry is settled; no-op on browsers
 * without the API.
 */
export async function initPersistentFolders(): Promise<void> {
    if (!canUseDirectoryPicker()) return;
    // The SOURCES list's "load" action for a remembered-but-not-loaded folder:
    // same flow as a chip click (permission re-prompt inside the gesture, then
    // enumerate + ingest). Registered, not imported - folder-sources is the
    // lower module.
    registerRememberedFolderOpener((folder) => void openRememberedFolder(folder));
    await refreshChips();
}

/**
 * Opens the FSA directory picker and ingests the choice. The pre-ingest
 * overlay goes up before the picker for the same reason as the classic path:
 * enumeration of a big card takes seconds and the page must not look dead
 * meanwhile. Remembering the folder is not asked here - the session row under
 * the sidebar CTA owns that offer and does not expire.
 */
export async function openViaDirectoryPicker(): Promise<void> {
    if (pickerInFlight) return;
    const pickDirectory = window.showDirectoryPicker;
    if (typeof pickDirectory !== "function") return;
    pickerInFlight = true;
    try {
        beginPreIngestReading();
        let handle: FileSystemDirectoryHandle;
        try {
            const picked = await withFilePicker("directory", () =>
                pickDirectory.call(window, { id: "recordings", mode: "read" }),
            );
            if (!picked) {
                endPreIngestReading();
                return;
            }
            handle = picked;
        } catch (err) {
            endPreIngestReading();
            // AbortError = the user dismissed the picker; silent, mirrors the
            // input "cancel" event on the classic path.
            if (err instanceof DOMException && err.name === "AbortError") return;
            // Anything else (enterprise policy, embedding restrictions) - fall
            // back to the classic input so the click still opens something.
            // No overlay here: if the failed picker call consumed the user
            // activation, this programmatic click is silently blocked and an
            // overlay would sit over a dead page with nothing to retract it.
            log.warn("showDirectoryPicker failed, falling back to input", {
                err: err instanceof Error ? err.message : String(err),
            });
            dom.folderInput.click();
            return;
        }
        const enumerated = await openFolderHandle(handle, null);
        if (enumerated) await adoptIfAlreadyRemembered(handle);
    } finally {
        pickerInFlight = false;
    }
}

/**
 * Enumerates a handle and feeds the result to ingest. `folder` is non-null
 * when opening a REMEMBERED folder - failures then grey its chip. Assumes
 * read permission is already granted and the pre-ingest overlay is up.
 * Returns the enumerated files (the caller may bind them to a folder record
 * later), or null when the folder could not be read.
 *
 * The handle travels into ingest as the batch's origin, so the session row
 * can offer to remember the folder (or show that it already is) without this
 * module having to know anything about the sidebar.
 */
async function openFolderHandle(
    handle: FileSystemDirectoryHandle,
    folder: RememberedFolder | null,
): Promise<VendorFile[] | null> {
    let files: Awaited<ReturnType<typeof enumerateFolder>>;
    try {
        files = await enumerateFolder(handle);
    } catch (err) {
        endPreIngestReading();
        if (folder) {
            availabilityById.set(folder.id, "unavailable");
            // The SOURCES row keeps its own map and its own probe cadence; an
            // open that just failed is the strongest liveness evidence there
            // is, and the landing chips are display:none once trips are loaded.
            setRememberedAvailability(folder.id, "unavailable");
            void refreshChips();
        }
        log.warn("folder enumeration failed", {
            label: handle.name,
            err: err instanceof Error ? err.message : String(err),
        });
        notify({
            severity: "warn",
            messageKey: "recentFolders.openFailed",
            messageParams: { name: folderDisplayLabel(handle.name) },
        });
        return null;
    }
    if (folder) {
        availabilityById.set(folder.id, "available");
        setRememberedAvailability(folder.id, "available");
        markFolderOpened(folder.id).catch(() => {});
        void refreshChips();
        // Register the source BEFORE the open hook: adopting stranded
        // annotations resolves each record through the file -> folder binding
        // this call establishes. Ingest registers the same source again once
        // the batch is filtered and deduped - the call is idempotent.
        registerIngestSource(files.files, { handle, folderId: folder.id });
        await notifyFolderOpened(folder);
    }
    if (files.readErrors > 0) {
        notify({ severity: "warn", messageKey: "status.dropReadFailed" });
    }
    if (files.files.length === 0) {
        // The structural snapshot still reaches ingest when no files survived.
        endPreIngestReading();
    }
    await ingestFiles(files.files, { handle, folderId: folder?.id ?? "" }, files.structure);
    return files.files;
}

// Chip-open guard, mirroring pickerInFlight: a double-click must not start
// two multi-second folder walks and two sidecar merges in parallel.
let chipOpenInFlight = false;

/** Click path for a chip: re-verify permission (prompting inside the user
 *  gesture when it lapsed), then open. */
async function openRememberedFolder(folder: RememberedFolder): Promise<void> {
    if (chipOpenInFlight || pickerInFlight) return;
    chipOpenInFlight = true;
    try {
        const permission = await queryFolderPermission(folder.handle);
        if (permission !== "granted") {
            const granted = await requestFolderPermission(folder.handle);
            if (!granted) {
                notify({
                    severity: "warn",
                    messageKey: "recentFolders.permissionDenied",
                    messageParams: { name: folderDisplayLabel(folder.label) },
                });
                return;
            }
        }
        beginPreIngestReading();
        await openFolderHandle(folder.handle, folder);
    } finally {
        chipOpenInFlight = false;
    }
}

/**
 * A folder picked afresh may already be remembered - the picker hands back a
 * new handle with no id on it, and only isSameEntry can tell. Binding it here
 * is what makes the session row say "remembered" (and the notes file resume)
 * instead of offering to remember a folder that already is.
 */
async function adoptIfAlreadyRemembered(handle: FileSystemDirectoryHandle): Promise<void> {
    let folders: RememberedFolder[];
    try {
        folders = await listFolders();
    } catch (err) {
        // No DB - nothing is remembered; the row just offers to remember.
        log.warn("persist db unavailable, remembered-folder match skipped", {
            err: err instanceof Error ? err.message : String(err),
        });
        return;
    }
    for (const folder of folders) {
        let same = false;
        try {
            same = await handle.isSameEntry(folder.handle);
        } catch {
            // Dead stored handle - not the same folder.
        }
        if (!same) continue;
        // Behaves like a chip open: bind the session files, stamp, merge notes.
        bindSourceToFolder(handle, folder);
        availabilityById.set(folder.id, "available");
        await markFolderOpened(folder.id).catch(() => {});
        void refreshChips();
        await notifyFolderOpened(folder);
        return;
    }
}

/** Re-renders the landing chips from the DB and kicks off a background
 *  liveness probe per folder - the status dots recolor as answers arrive.
 *  Hides the block when nothing is remembered. */
async function refreshChips(): Promise<void> {
    // Once ingest removes the landing page there is nowhere to render chips;
    // avoid an IndexedDB read as well as retaining or touching detached nodes.
    if (!document.getElementById("recent-folders") || !document.getElementById("recent-folders-list")) return;
    const renderToken = ++chipsRenderToken;
    let folders: RememberedFolder[];
    try {
        folders = await listFolders();
    } catch {
        if (renderToken === chipsRenderToken) {
            const container = document.getElementById("recent-folders");
            if (container) container.hidden = true;
        }
        return;
    }
    if (renderToken !== chipsRenderToken) return;
    // The landing page is removed after the first successful ingest. Resolve
    // its nodes only after the asynchronous DB read so this module never keeps
    // or writes through detached DOM references.
    const chipsContainer = document.getElementById("recent-folders");
    const chipsList = document.getElementById("recent-folders-list");
    if (!chipsContainer || !chipsList) return;
    chipsContainer.hidden = folders.length === 0;
    chipsList.replaceChildren();
    const labels = disambiguatedLabels(folders);
    const chipById = new Map<string, HTMLElement>();
    for (const folder of folders) {
        const chip = buildChip(folder, labels.get(folder.id) ?? folderDisplayLabel(folder.label));
        chipById.set(folder.id, chip);
        chipsList.appendChild(chip);
    }
    syncForgetAllButton(chipsContainer, folders.length > 1);
    for (const folder of folders) {
        void probeFolderAvailability(folder.handle).then((availability) => {
            // A newer render has its own probes in flight - a slow answer
            // from this one must not overwrite their fresher result (the map
            // seeds the next render's initial chip state).
            if (renderToken !== chipsRenderToken) return;
            availabilityById.set(folder.id, availability);
            const chip = chipById.get(folder.id);
            if (chip?.isConnected) applyAvailability(chip, availability);
        });
    }
}

// Monotonic render stamp for the probe staleness check above.
let chipsRenderToken = 0;

function buildChip(folder: RememberedFolder, displayLabel: string): HTMLElement {
    const wrap = document.createElement("span");
    wrap.className = "recent-folder-chip";

    const open = document.createElement("button");
    open.type = "button";
    open.className = "recent-folder-chip__open";

    const status = document.createElement("span");
    status.className = "recent-folder-chip__status";
    status.setAttribute("aria-hidden", "true");
    open.appendChild(status);
    // The label lives in its own block-level span: inline-flex turns a bare
    // text node into an anonymous flex item, where text-overflow does not
    // apply and a long folder name would clip without the ellipsis.
    const labelSpan = document.createElement("span");
    labelSpan.className = "recent-folder-chip__label";
    labelSpan.textContent = displayLabel;
    open.appendChild(labelSpan);
    open.addEventListener("click", () => void openRememberedFolder(folder));
    wrap.appendChild(open);

    const forget = document.createElement("button");
    forget.type = "button";
    forget.className = "recent-folder-chip__forget";
    forget.setAttribute("aria-label", t("recentFolders.forgetLabel"));
    forget.title = t("recentFolders.forgetLabel");
    forget.textContent = "×";
    forget.addEventListener("click", () => {
        forgetFolder(folder.id)
            .then(() => {
                purgeFolderSessionState(folder.id);
                return refreshChips();
            })
            .catch(() => {});
    });
    wrap.appendChild(forget);

    const known = availabilityById.get(folder.id);
    if (known) applyAvailability(wrap, known);
    return wrap;
}

/** Colors a chip by liveness: green = readable right now, red+greyed = gone
 *  (moved/unplugged; still clickable - a re-plug revives the handle), amber =
 *  permission lapsed, a click re-prompts. */
function applyAvailability(chip: HTMLElement, availability: FolderAvailability): void {
    chip.classList.toggle("is-available", availability === "available");
    chip.classList.toggle("is-unavailable", availability === "unavailable");
    chip.classList.toggle("is-unknown", availability === "unknown");
    if (availability === "unavailable") chip.title = t("recentFolders.unavailableHint");
    else if (availability === "unknown") chip.title = t("recentFolders.permissionHint");
    else chip.removeAttribute("title");
}

function syncForgetAllButton(container: HTMLElement, shouldShow: boolean): void {
    let forgetAllButton = container.querySelector<HTMLElement>(".recent-folders-forget-all");
    if (!shouldShow) {
        forgetAllButton?.remove();
        return;
    }
    if (!forgetAllButton) {
        const forgetAll = document.createElement("button");
        forgetAll.type = "button";
        forgetAll.className = "recent-folders-forget-all";
        forgetAll.textContent = t("recentFolders.forgetAll");
        forgetAll.addEventListener("click", () => {
            forgetAllFolders()
                .then(() => {
                    // Only remembered-folder ids ever enter these maps, and
                    // none of them exists anymore.
                    purgeAllFolderSessionState();
                    availabilityById.clear();
                    return refreshChips();
                })
                .catch(() => {});
        });
        forgetAllButton = forgetAll;
    }
    container.querySelector(".recent-folders-head")?.appendChild(forgetAllButton);
}
