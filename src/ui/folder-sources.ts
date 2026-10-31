// The SOURCES list: which folders the loaded trips came out of (with the
// remember controls), plus remembered folders that are NOT loaded yet -
// one click loads them into the session. The landing chips
// (persistent-folders.ts) answer the same "what can I open" question before
// the first ingest; this list takes over afterwards, because the landing is
// one-way - once trips are loaded it never comes back.
//
// Deliberately the LOW-level module of the folder feature: it owns the
// file-identity -> remembered-folder binding that every annotation resolves
// through, so ingest / persistent-folders / annotations-sidecar depend on it
// and never the other way round.
//
// Live picker sources are keyed by handle object, not their display name. Two
// cards commonly expose the same root name (DCIM); collapsing them would bind
// both cards' annotations to whichever folder opened last.

import { createPopover } from "./popover-lifecycle.js";
import { t } from "../i18n/index.js";
import type { DuplicateSourceMatch } from "../ingest-dedup.js";
import { createLogger } from "../log.js";
import type { VendorFile } from "../parsers/types.js";
import { canPersistFileHandles } from "../persist/file-handle-support.js";
import {
    type FolderAvailability,
    forgetFolder,
    listFolders,
    probeFolderAvailability,
    rememberFolder,
} from "../persist/folders.js";
import { fileIdentityKey, fileIdentityOf } from "../persist/identity.js";
import type { RememberedFolder } from "../persist/types.js";

import { buildLucideIcon } from "./icons.js";
import { notify } from "./notifications.js";
import type { IngestOrigin } from "./state.js";

const log = createLogger("folder-sources");

interface FolderSource {
    /** Root folder name; "" for files dropped without a folder around them. */
    key: string;
    /** Live handle - present only on the FSA path, the only one that can
     *  remember or re-read the folder later. */
    handle: FileSystemDirectoryHandle | null;
    /** Remembered-folder id, "" while the folder is only a session source. */
    folderId: string;
    availability: FolderAvailability | null;
    /** Identity keys of every file this source contributed. Kept (instead of
     *  the VendorFiles) because binding a late "remember" needs exactly these
     *  and nothing else - and a Set of strings is cheap to hold for a whole
     *  card. */
    identityKeys: Set<string>;
    /** Opaque per-ingest scopes contributed by this physical source. */
    sourceKeys: Set<string>;
}

// Insertion-ordered: the first folder the user opened stays first, so the row
// under the CTA does not reshuffle as more cards are added.
const sourcesByKey = new Map<string, FolderSource>();
let sourceKeyByHandle = new WeakMap<FileSystemDirectoryHandle, string>();
let nextHandleSourceId = 1;
let nextFolderDomId = 1;

// File identity key -> RememberedFolder.id, for every file that came out of a
// remembered folder this session. Annotations resolve their folderId through
// this. Far tighter than keying on the root folder NAME (which collides the
// moment two SD cards share one on-disk name), though not absolute: a
// byte-for-byte backup of a folder yields identical persistent keys. The
// per-ingest source scope below disambiguates those copies while both are open.
const folderIdByFileKey = new Map<string, string>();
const OWNERSHIP_SEPARATOR = String.fromCharCode(1);

function ownershipKey(identityKey: string, sourceKey: string): string {
    return `${sourceKey}${OWNERSHIP_SEPARATOR}${identityKey}`;
}

/** RememberedFolder.id that produced the file with this identity key, or ""
 *  when the file did not come out of a remembered folder (ad-hoc drop /
 *  never remembered). */
export function folderIdForFileKey(identityKey: string, sourceKey?: string): string {
    if (sourceKey !== undefined) {
        const exact = folderIdByFileKey.get(ownershipKey(identityKey, sourceKey));
        // A scoped caller knows which physical ingest produced the file. If
        // that source is not bound, borrowing the sole owner of an identical
        // file from another open card would silently send notes to that card.
        return exact ?? "";
    }
    const owners = new Set<string>();
    for (const [key, folderId] of folderIdByFileKey) {
        if (key.endsWith(`${OWNERSHIP_SEPARATOR}${identityKey}`)) owners.add(folderId);
    }
    return owners.size === 1 ? [...owners][0]! : "";
}

/** Drops a forgotten folder's session state - a later annotation must not
 *  resolve to the dead id (it would be invisible to every sidecar path).
 *  Only for forgetting from the landing, where no trip of that folder is
 *  open; forgetting an ACTIVE source deliberately keeps the binding (see
 *  onForget below). */
export function purgeFolderSessionState(folderId: string): void {
    for (const [key, id] of folderIdByFileKey) {
        if (id === folderId) folderIdByFileKey.delete(key);
    }
    for (const source of sourcesByKey.values()) {
        if (source.folderId === folderId) source.folderId = "";
    }
    // The forgotten folder must also leave the "not loaded yet" rows.
    refreshRememberedFolders();
}

/** Same as purgeFolderSessionState, for the landing's "forget all" - none of
 *  the remembered ids exists anymore. */
export function purgeAllFolderSessionState(): void {
    folderIdByFileKey.clear();
    for (const source of sourcesByKey.values()) source.folderId = "";
    refreshRememberedFolders();
}

/** Clears the module-level session state between unit tests. */
export function _resetForTests(): void {
    sourcesByKey.clear();
    folderIdByFileKey.clear();
    sourceKeyByHandle = new WeakMap();
    nextHandleSourceId = 1;
    nextFolderDomId = 1;
    rememberedCache = [];
    rememberedAvailability.clear();
    folderOpenedHook = null;
    notesConnector = null;
    notesPanel = null;
    notesPanelRender = 0;
}

// The annotations layer rebinds portable records after a folder opens or is
// remembered. A registered hook avoids an import cycle.
let folderOpenedHook: ((folder: RememberedFolder) => void | Promise<void>) | null = null;

/** Registers the after-open hook for remembered folders. */
export function registerFolderOpenedHook(callback: (folder: RememberedFolder) => void | Promise<void>): void {
    folderOpenedHook = callback;
}

/** Notifies the sidecar layer that a folder is now open/remembered. */
export async function notifyFolderOpened(folder: RememberedFolder): Promise<void> {
    try {
        await folderOpenedHook?.(folder);
    } catch (err) {
        // Notes-file IO must not turn a successfully opened recordings folder
        // into a failed open. The sidecar layer logs its own expected failures;
        // this boundary catches any unexpected hook rejection.
        log.warn("folder-opened hook failed", { err: err instanceof Error ? err.message : String(err) });
    }
}

export type NotesBackupStatus =
    | { state: "browser" }
    | { state: "session" }
    | { state: "connected" | "ready" | "needsAttention"; fileName: string };
export type NotesConnectResult = "connected" | "cancelled" | "failed";
export type NotesWriteAction = "create" | "connect" | "authorize";

/** Actions and live status for the currently selected notes file. */
export interface NotesConnector {
    create(): Promise<NotesConnectResult>;
    /** `forWrite` is true only from the blocking first-write decision. */
    useExisting(forWrite?: boolean): Promise<NotesConnectResult>;
    authorize(): Promise<NotesConnectResult>;
    chooseBrowser(): Promise<void>;
    prepareWrite(force?: boolean): Promise<NotesWriteAction | null>;
    status(): Promise<NotesBackupStatus>;
    browserStorageReady(): boolean;
    canSelectFile(): boolean;
}

// Registered by annotations-sidecar.ts. The connector remains present without
// file pickers so the panel can still distinguish browser and session storage.
let notesConnector: NotesConnector | null = null;

/** Registers the current notes-file actions. */
export function registerNotesConnector(connector: NotesConnector): void {
    notesConnector = connector;
    renderNotesPanel();
}

/** The registered notes-file actions and status provider. */
export function getNotesConnector(): NotesConnector | null {
    return notesConnector;
}

// Loads a remembered folder into the session (permission re-prompt included).
// Registered by persistent-folders.ts, which owns the open flow - a direct
// import would cycle, it already imports this module.
let rememberedFolderOpener: ((folder: RememberedFolder) => void) | null = null;

/** Registers the click action for a remembered-but-not-loaded row. */
export function registerRememberedFolderOpener(callback: (folder: RememberedFolder) => void): void {
    rememberedFolderOpener = callback;
}

// Remembered folders as last read from the store, for the "not loaded yet"
// rows. A cache because rendering is synchronous; refreshed on init, on every
// store mutation this module makes, and on tab return.
let rememberedCache: RememberedFolder[] = [];
// Liveness per remembered folder id (session-local, re-probed on refresh).
const rememberedAvailability = new Map<string, FolderAvailability>();

/** Re-reads the remembered folders and re-renders; kicks a liveness probe per
 *  not-yet-loaded folder. Safe to call any time - store errors just leave the
 *  unloaded rows out. */
function refreshRememberedFolders(): void {
    listFolders()
        .then((folders) => {
            rememberedCache = folders;
            renderSources();
            for (const folder of unloadedRemembered()) {
                void probeFolderAvailability(folder.handle).then((availability) => {
                    if (rememberedAvailability.get(folder.id) === availability) return;
                    rememberedAvailability.set(folder.id, availability);
                    renderSources();
                });
            }
        })
        .catch(() => {
            rememberedCache = [];
            renderSources();
        });
}

/**
 * Records the liveness an actual open attempt just proved, for the row the user
 * clicked. The background probe is a guess about a folder nobody touched; a
 * real enumerate that succeeded or threw is the authoritative answer, and
 * without this the row keeps whatever the last probe said - green next to a
 * "could not open" toast.
 */
export function setRememberedAvailability(folderId: string, availability: FolderAvailability): void {
    if (rememberedAvailability.get(folderId) === availability) return;
    rememberedAvailability.set(folderId, availability);
    renderSources();
}

/** Remembered folders no session source is bound to - the rows offering to
 *  load. Bound ones are already represented by their session row. */
function unloadedRemembered(): RememberedFolder[] {
    const boundIds = new Set<string>();
    for (const source of sourcesByKey.values()) {
        if (source.folderId) boundIds.add(source.folderId);
    }
    return rememberedCache.filter((folder) => !boundIds.has(folder.id));
}

/**
 * Human form of a folder/source root name. Chromium names a drive-root handle
 * after the bare path separator ("\" on a Windows flash card), which on screen
 * reads as a rendering glitch - substitute a real label. Every other name
 * passes through unchanged, including "" (the loose-files row owns that case).
 */
export function folderDisplayLabel(rootName: string): string {
    return /^[\\/]+$/.test(rootName) ? t("folderSources.driveRoot") : rootName;
}

/**
 * Display labels for remembered folders, duplicates suffixed " (2)", " (3)"...
 * in addedAt order (stable across re-renders, unlike the lastOpenedAt list
 * order). The handle exposes only the folder's leaf name - two SD cards named
 * "DCIM" are otherwise indistinguishable. Shared with the landing chips.
 * Buckets by the DISPLAY label, so two drive roots ("\" and "/") collide the
 * way the user sees them collide.
 */
export function disambiguatedLabels(folders: RememberedFolder[]): Map<string, string> {
    const byLabel = new Map<string, RememberedFolder[]>();
    for (const folder of folders) {
        const label = folderDisplayLabel(folder.label);
        const bucket = byLabel.get(label);
        if (bucket) bucket.push(folder);
        else byLabel.set(label, [folder]);
    }
    const out = new Map<string, string>();
    for (const [label, bucket] of byLabel) {
        if (bucket.length === 1) continue;
        bucket.sort((a, b) => a.addedAt - b.addedAt);
        bucket.forEach((folder, index) => {
            if (index > 0) out.set(folder.id, `${label} (${index + 1})`);
        });
    }
    return out;
}

/** Root folder name of a relative path, or "" when the file was dropped
 *  without a folder around it (a bare filename has no leading segment). */
function rootNameOf(relativePath: string): string {
    const segments = relativePath.split(/[/\\]/).filter((segment) => segment.length > 0);
    return segments.length > 1 ? segments[0]! : "";
}

/**
 * Records the folders an ingested batch came from and binds its files to the
 * remembered folder when the batch came from one. Called for every drop
 * (picker, classic input, drag-and-drop) after the junk filter, so the row
 * appears together with the trips it explains.
 */
export function registerIngestSource(
    files: VendorFile[],
    origin: IngestOrigin | null,
    duplicateMatches: readonly DuplicateSourceMatch[] = [],
): void {
    const sourceAliases = origin ? new Map<string, string>() : duplicateSourceAliases(duplicateMatches);
    const groups = new Map<string, { root: string; files: VendorFile[] }>();
    if (origin) {
        // A picker batch has exactly one root by construction - the picked
        // handle - so the whole batch lands on its row. Grouping by the paths'
        // first segment instead would shatter it when the handle's name is a
        // bare separator (a Windows drive root is named "\", which the path
        // split swallows, leaving the subfolders posing as roots). An empty
        // batch still names the folder: opening an already-loaded card dedups
        // every file away, and the row must still gain its handle (and with
        // it the offer to remember).
        let mapKey = origin.folderId ? `folder:${origin.folderId}` : sourceKeyByHandle.get(origin.handle);
        if (!mapKey) {
            mapKey = `handle:${nextHandleSourceId++}`;
        }
        sourceKeyByHandle.set(origin.handle, mapKey);
        groups.set(mapKey, { root: origin.handle.name, files });
    } else {
        // Handle-less paths (classic input, drag-and-drop): the leading path
        // segment is all there is to group by.
        for (const vendorFile of files) {
            const root = rootNameOf(vendorFile.relativePath);
            const proposedKey = `drop:${vendorFile.sourceKey ?? "unscoped"}:${root}`;
            const mapKey = sourceAliases.get(proposedKey) ?? proposedKey;
            const group = groups.get(mapKey);
            if (group) group.files.push(vendorFile);
            else groups.set(mapKey, { root, files: [vendorFile] });
        }
    }
    if (groups.size === 0) return;
    for (const [mapKey, group] of groups) {
        const source = sourcesByKey.get(mapKey) ?? {
            key: group.root,
            handle: null,
            folderId: "",
            availability: null,
            identityKeys: new Set<string>(),
            sourceKeys: new Set<string>(),
        };
        for (const vendorFile of group.files) {
            source.identityKeys.add(fileIdentityKey(fileIdentityOf(vendorFile.file, vendorFile.relativePath)));
            source.sourceKeys.add(vendorFile.sourceKey ?? "");
        }
        if (source.folderId) bindKeys(source, source.folderId);
        if (origin) {
            source.handle = origin.handle;
            source.availability = "available";
            // Bind the source's WHOLE key set, not just this batch: files the
            // dedup dropped (or a drag-and-drop of the same folder earlier in
            // the session) belong to this folder too, and their annotations
            // must resolve to it.
            if (origin.folderId) {
                for (const [otherKey, other] of sourcesByKey) {
                    if (otherKey === mapKey || other.folderId !== origin.folderId) continue;
                    for (const identityKey of other.identityKeys) source.identityKeys.add(identityKey);
                    for (const sourceKey of other.sourceKeys) source.sourceKeys.add(sourceKey);
                    sourcesByKey.delete(otherKey);
                }
                bindKeys(source, origin.folderId);
            }
        }
        sourcesByKey.set(mapKey, source);
    }
    renderSources();
}

function duplicateSourceAliases(matches: readonly DuplicateSourceMatch[]): Map<string, string> {
    const aliases = new Map<string, string>();
    const incomingSourceKeys = new Map<string, string>();
    const ambiguous = new Set<string>();
    for (const { incoming, loaded } of matches) {
        const proposedKey = `drop:${incoming.sourceKey ?? "unscoped"}:${rootNameOf(incoming.relativePath)}`;
        if (ambiguous.has(proposedKey)) continue;
        const loadedIdentity = fileIdentityKey(fileIdentityOf(loaded.file, loaded.relativePath));
        const candidates = [...sourcesByKey.entries()].filter(
            ([, source]) => source.sourceKeys.has(loaded.sourceKey ?? "") && source.identityKeys.has(loadedIdentity),
        );
        if (candidates.length !== 1) continue;
        const [targetKey] = candidates[0]!;
        const prior = aliases.get(proposedKey);
        if (prior && prior !== targetKey) {
            aliases.delete(proposedKey);
            incomingSourceKeys.delete(proposedKey);
            ambiguous.add(proposedKey);
            continue;
        }
        aliases.set(proposedKey, targetKey);
        incomingSourceKeys.set(proposedKey, incoming.sourceKey ?? "");
    }
    for (const [proposedKey, targetKey] of aliases) {
        const target = sourcesByKey.get(targetKey);
        if (!target) continue;
        target.sourceKeys.add(incomingSourceKeys.get(proposedKey) ?? "");
        if (target.folderId) bindKeys(target, target.folderId);
    }
    return aliases;
}

/**
 * Binds an already-remembered folder to the session source that came from it -
 * the picker path learns the folder is remembered only after the ingest, and a
 * "remember" click creates the record even later.
 */
export function bindSourceToFolder(handle: FileSystemDirectoryHandle, folder: RememberedFolder): void {
    const mappedKey = sourceKeyByHandle.get(handle);
    let source = mappedKey ? sourcesByKey.get(mappedKey) : undefined;
    let sourceEntryKey = source ? mappedKey : undefined;
    if (!source) {
        const candidates = [...sourcesByKey.entries()].filter(
            ([, candidate]) => candidate.handle === null && candidate.key === handle.name,
        );
        if (candidates.length === 1) {
            [sourceEntryKey, source] = candidates[0]!;
        }
    }
    if (!source) return;
    const existingEntry = [...sourcesByKey.entries()].find(
        ([key, candidate]) => candidate !== source && candidate.folderId === folder.id && key !== sourceEntryKey,
    );
    if (existingEntry) {
        const [existingKey, existing] = existingEntry;
        for (const identityKey of source.identityKeys) existing.identityKeys.add(identityKey);
        for (const sourceKey of source.sourceKeys) existing.sourceKeys.add(sourceKey);
        existing.handle = handle;
        existing.availability = "available";
        if (sourceEntryKey) sourcesByKey.delete(sourceEntryKey);
        sourceKeyByHandle.set(handle, existingKey);
        source = existing;
    }
    source.handle = handle;
    source.availability = "available";
    bindKeys(source, folder.id);
    renderSources();
}

/** Marks every file of a source as belonging to a remembered folder - the
 *  lookup annotations go through. */
function bindKeys(source: FolderSource, folderId: string): void {
    source.folderId = folderId;
    for (const identityKey of source.identityKeys) {
        for (const sourceKey of source.sourceKeys) {
            folderIdByFileKey.set(ownershipKey(identityKey, sourceKey), folderId);
        }
    }
}

let listElement: HTMLElement | null = null;
let notesPanel: HTMLElement | null = null;
let notesPanelRender = 0;

/** Wires the SOURCES list under the sidebar CTA. Call once from app.ts. */
export function initFolderSources(): void {
    listElement = document.getElementById("folder-sources");
    notesPanel = document.getElementById("notes-file-status");
    const help = document.querySelector<HTMLDetailsElement>(".folder-sources-help");
    document.addEventListener("click", (event) => {
        if (!help?.open || help.contains(event.target as Node | null)) return;
        help.open = false;
    });
    help?.addEventListener("keydown", (event) => {
        if (event.key !== "Escape" || !help.open) return;
        event.preventDefault();
        help.open = false;
        help.querySelector<HTMLElement>("summary")?.focus();
    });
    // A card pulled out mid-session is the case the status dot exists for, and
    // returning to the tab is when the user is about to act on it - re-probe
    // then rather than on a timer that would keep an unplugged card spinning.
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") {
            probeAll();
            refreshRememberedFolders();
        }
    });
    refreshRememberedFolders();
    renderNotesPanel();
}

function probeAll(): void {
    for (const source of sourcesByKey.values()) {
        if (!source.handle) continue;
        const handle = source.handle;
        void probeFolderAvailability(handle).then((availability) => {
            // A slow probe can still land after its handle was replaced by a
            // fresher open of the same folder - ignore it then. An unchanged
            // answer renders nothing: a re-render closes an open row menu.
            if (source.handle !== handle || source.availability === availability) return;
            source.availability = availability;
            renderSources();
        });
    }
}

// Teardown of the open row menu's document listener. A re-render throws its
// rows away, and without this the listener would outlive them - dangling and
// piling up one per render.
let closeOpenMenu: (() => void) | null = null;

function renderSources(): void {
    if (!listElement) return;
    closeOpenMenu?.();
    listElement.replaceChildren();
    const unloaded = unloadedRemembered();
    listElement.hidden = sourcesByKey.size === 0 && unloaded.length === 0;
    const labels = rowDisplayLabels(unloaded);
    for (const [sourceId, source] of sourcesByKey) {
        listElement.appendChild(buildRow(sourceId, source, labels.sources.get(source)));
    }
    // Remembered-but-not-loaded folders come after the session sources: what
    // is on screen explains itself first, what can be added follows.
    for (const folder of unloaded) {
        listElement.appendChild(buildUnloadedRow(folder, labels.folders.get(folder.id)!));
    }
    renderNotesPanel();
}

/** Repaints notes health after an asynchronous file write changes it. */
export function refreshFolderSources(): void {
    renderSources();
    renderNotesPanel();
}

/** Repaints the notes-file section. It deliberately stores no folder mapping:
 * the current file may carry annotations from every recording source. */
function renderNotesPanel(): void {
    const panel = notesPanel;
    if (!panel) return;
    const renderId = ++notesPanelRender;
    const connector = notesConnector;
    if (!connector) {
        panel.classList.remove("is-problem");
        panel.replaceChildren(notesStatusLabel(t("notesFile.browser")));
        return;
    }
    void connector
        .status()
        .then((status) => {
            if (!panel.isConnected || renderId !== notesPanelRender) return;
            const actions: HTMLButtonElement[] = [];
            panel.classList.toggle("is-problem", status.state === "needsAttention");
            const canSelectFile = connector.canSelectFile();
            let label: string;
            if (status.state === "browser" || status.state === "session") {
                label = t(status.state === "browser" ? "notesFile.browser" : "notesFile.session");
                if (canSelectFile) {
                    actions.push(notesPanelAction(t("notesFile.create"), () => connector.create()));
                    actions.push(notesPanelAction(t("notesFile.choose"), () => connector.useExisting()));
                }
            } else if (status.state === "ready") {
                label = t("notesFile.ready", { file: status.fileName });
                if (canSelectFile) actions.push(notesPanelAction(t("notesFile.change"), () => connector.create()));
            } else if (status.state === "connected") {
                label = t("notesFile.connected", { file: status.fileName });
                if (canSelectFile) actions.push(notesPanelAction(t("notesFile.change"), () => connector.create()));
            } else {
                label = t("notesFile.problem", { file: status.fileName });
                if (canSelectFile) {
                    actions.push(notesPanelAction(t("notesFile.create"), () => connector.create()));
                    actions.push(notesPanelAction(t("notesFile.choose"), () => connector.useExisting()));
                }
            }
            panel.replaceChildren(notesStatusLabel(label), ...actions);
        })
        .catch((err: unknown) => {
            log.warn("notes-file status failed", { err: err instanceof Error ? err.message : String(err) });
        });
}

function notesStatusLabel(label: string): HTMLElement {
    const element = document.createElement("span");
    element.className = "notes-file-status__label";
    element.textContent = label;
    return element;
}

function notesPanelAction(label: string, activate: () => Promise<NotesConnectResult>): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "notes-file-status__action";
    button.textContent = label;
    button.addEventListener("click", () => {
        button.disabled = true;
        void activate().finally(renderNotesPanel);
    });
    return button;
}

/** Unique, stable-enough labels across BOTH loaded and unloaded rows. Remembered
 * folders keep their addedAt ordinal; session-only duplicates follow them in
 * source insertion order. This keeps two simultaneously inserted DCIM cards
 * understandable before the user remembers either one. */
function rowDisplayLabels(unloaded: RememberedFolder[]): {
    sources: Map<FolderSource, string>;
    folders: Map<string, string>;
} {
    const sourceLabels = new Map<FolderSource, string>();
    const folderLabels = new Map<string, string>();
    const rows = [
        ...[...sourcesByKey.values()].map((source) => ({ source, folder: null })),
        ...unloaded.map((folder) => ({ source: null, folder })),
    ];
    const buckets = new Map<string, typeof rows>();
    for (const row of rows) {
        const raw = row.source?.key ?? row.folder?.label ?? "";
        const base = folderDisplayLabel(raw) || t("folderSources.looseFiles");
        const bucket = buckets.get(base);
        if (bucket) bucket.push(row);
        else buckets.set(base, [row]);
    }
    for (const [base, bucket] of buckets) {
        const remembered = rememberedCache
            .filter((folder) => (folderDisplayLabel(folder.label) || t("folderSources.looseFiles")) === base)
            .sort((a, b) => a.addedAt - b.addedAt);
        const ordinalByFolderId = new Map(remembered.map((folder, index) => [folder.id, index + 1]));
        let nextOrdinal = remembered.length + 1;
        for (const row of bucket) {
            const folderId = row.source?.folderId ?? row.folder?.id ?? "";
            const ordinal = ordinalByFolderId.get(folderId) ?? nextOrdinal++;
            const label = bucket.length === 1 || ordinal === 1 ? base : `${base} (${ordinal})`;
            if (row.source) sourceLabels.set(row.source, label);
            else if (row.folder) folderLabels.set(row.folder.id, label);
        }
    }
    return { sources: sourceLabels, folders: folderLabels };
}

function buildRow(_sourceId: string, source: FolderSource, resolvedLabel?: string): HTMLElement {
    const row = document.createElement("li");
    row.className = "folder-source";

    if (source.handle) {
        const status = document.createElement("span");
        status.className = "folder-source__status";
        status.setAttribute("aria-hidden", "true");
        row.appendChild(status);
        applyAvailability(row, source.availability);
    }

    // A bare drop has no folder to name; say what it is instead of showing an
    // empty row - the trips still came from somewhere the user recognizes.
    const displayLabel = resolvedLabel ?? (folderDisplayLabel(source.key) || t("folderSources.looseFiles"));
    const label = document.createElement("span");
    label.className = "folder-source__label";
    label.id = `folder-source-label-${nextFolderDomId++}`;
    label.textContent = displayLabel;
    label.title = displayLabel;
    row.appendChild(label);

    if (!source.handle || !canPersistFileHandles()) return row;

    if (source.folderId) {
        const badge = document.createElement("span");
        badge.className = "folder-source__state";
        badge.textContent = t("folderSources.remembered");
        badge.title = t("folderSources.rememberedHint");
        row.appendChild(badge);
        row.appendChild(buildMenu(source, displayLabel));
        return row;
    }

    const remember = document.createElement("button");
    remember.type = "button";
    remember.className = "folder-source__remember";
    remember.textContent = t("folderSources.remember");
    remember.title = t("folderSources.rememberHint");
    // Several rows carry the same verb; the folder is what tells them apart, so
    // it belongs in the accessible name and not only in the row above it. Its
    // own key, not a colon glued on here - word order and separator are the
    // dictionary's to choose.
    remember.setAttribute("aria-label", t("folderSources.rememberAria", { folder: displayLabel }));
    remember.addEventListener("click", () => void onRemember(source, remember));
    row.appendChild(remember);
    return row;
}

/** A remembered folder not loaded this session: muted name + a "load" action.
 *  The dot still shows liveness - the user decides whether to click by it. */
function buildUnloadedRow(folder: RememberedFolder, displayLabel: string): HTMLElement {
    const row = document.createElement("li");
    row.className = "folder-source folder-source--unloaded";

    const status = document.createElement("span");
    status.className = "folder-source__status";
    status.setAttribute("aria-hidden", "true");
    row.appendChild(status);
    applyAvailability(row, rememberedAvailability.get(folder.id) ?? null);

    const label = document.createElement("span");
    label.className = "folder-source__label";
    label.id = `folder-source-label-${nextFolderDomId++}`;
    label.textContent = displayLabel;
    label.title = displayLabel;
    row.appendChild(label);

    const load = document.createElement("button");
    load.type = "button";
    load.className = "folder-source__load";
    load.textContent = t("folderSources.load");
    load.title = t("folderSources.loadHint");
    // Same verb on every unloaded row - name the folder it belongs to.
    load.setAttribute("aria-label", t("folderSources.loadAria", { folder: displayLabel }));
    // Clickable in every liveness state on purpose: a re-plugged card revives
    // its stored handle, and the permission re-prompt needs this very gesture.
    load.addEventListener("click", () => rememberedFolderOpener?.(folder));
    row.appendChild(load);

    row.appendChild(
        buildMenuShell((menu, setOpen) => {
            menu.appendChild(
                menuAction(t("recentFolders.forgetLabel"), () => {
                    setOpen(false);
                    forgetFolder(folder.id)
                        .then(() => purgeFolderSessionState(folder.id))
                        .catch((err) => {
                            log.warn("forgetFolder failed", {
                                err: err instanceof Error ? err.message : String(err),
                            });
                        });
                }),
            );
        }, displayLabel),
    );
    return row;
}

/** Colors a row by liveness: green = readable right now, red = gone
 *  (moved/unplugged), amber = permission lapsed. Mirrors the landing chips so
 *  one dot means one thing across the app. The two problem states also get a
 *  text equivalent on the dot - a colour alone says nothing to a screen reader
 *  (or to anyone who cannot tell the red from the green). */
function applyAvailability(row: HTMLElement, availability: FolderAvailability | null): void {
    row.classList.toggle("is-available", availability === "available");
    row.classList.toggle("is-unavailable", availability === "unavailable");
    row.classList.toggle("is-unknown", availability === "unknown");
    // Own hints, not the landing chips': those promise a retry on click, and
    // this row has nothing to click - it states the situation instead.
    const hint =
        availability === "unavailable"
            ? t("folderSources.unavailableHint")
            : availability === "unknown"
              ? t("folderSources.permissionHint")
              : null;
    if (hint) row.title = hint;
    else row.removeAttribute("title");
    const status = row.querySelector<HTMLElement>(".folder-source__status");
    if (!status) return;
    if (hint) {
        status.setAttribute("role", "img");
        status.setAttribute("aria-label", hint);
        status.removeAttribute("aria-hidden");
    } else {
        status.setAttribute("aria-hidden", "true");
        status.removeAttribute("role");
        status.removeAttribute("aria-label");
    }
}

async function onRemember(source: FolderSource, button: HTMLButtonElement): Promise<void> {
    if (!source.handle) return;
    button.disabled = true;
    try {
        const record = await rememberFolder(source.handle);
        bindSourceToFolder(source.handle, record);
        // Adopts annotations made before this click (they carry folderId "").
        // Notes-file selection was already resolved when the folder opened.
        await notifyFolderOpened(record);
        refreshRememberedFolders();
    } catch (err) {
        log.warn("rememberFolder failed", { err: err instanceof Error ? err.message : String(err) });
        button.disabled = false;
        notify({
            severity: "warn",
            messageKey: "folderSources.rememberFailed",
            messageParams: { name: folderDisplayLabel(source.key) },
        });
    }
}

/** The per-row overflow menu contains only folder actions. */
function buildMenu(source: FolderSource, folderLabel: string): HTMLElement {
    return buildMenuShell((menu, setOpen) => fillMenu(menu, source, setOpen), folderLabel);
}

/** The shared ⋯ popup shell: open/close state, outside-click and Escape
 *  teardown. `fill` populates the (already emptied) menu right before it
 *  opens - the contents come from the store and can change between opens. */
function buildMenuShell(
    fill: (menu: HTMLElement, setOpen: (open: boolean) => void) => void,
    folderLabel: string,
): HTMLElement {
    const wrap = document.createElement("span");
    wrap.className = "folder-source__menu-wrap";

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "folder-source__menu";
    // Every row has one of these; without the folder in the name a screen
    // reader reads the same "Folder actions" over and over.
    toggle.setAttribute("aria-label", t("folderSources.menuAria", { folder: folderLabel }));
    toggle.setAttribute("aria-expanded", "false");
    toggle.title = t("folderSources.menu");
    toggle.appendChild(buildLucideIcon(["M5 12h.01", "M12 12h.01", "M19 12h.01"], 14));

    const menu = document.createElement("ul");
    menu.className = "overflow-menu folder-source__popup";
    menu.setAttribute("role", "menu");
    menu.hidden = true;

    const popover = createPopover({
        button: toggle,
        panel: menu,
        show: () => {
            menu.hidden = false;
            closeOpenMenu = () => popover.close();
        },
        hide: () => {
            menu.hidden = true;
            closeOpenMenu = null;
        },
    });
    const setOpen = (open: boolean): void => {
        if (open) popover.open();
        else popover.close();
    };

    toggle.addEventListener("click", () => {
        if (popover.isOpen) {
            setOpen(false);
            return;
        }
        menu.replaceChildren();
        fill(menu, setOpen);
        setOpen(true);
    });
    wrap.appendChild(toggle);
    wrap.appendChild(menu);
    return wrap;
}

function fillMenu(menu: HTMLElement, source: FolderSource, setOpen: (open: boolean) => void): void {
    menu.appendChild(
        menuAction(t("recentFolders.forgetLabel"), () => {
            setOpen(false);
            void onForget(source);
        }),
    );
}

function menuAction(label: string, onActivate: () => void): HTMLElement {
    const item = document.createElement("li");
    item.className = "overflow-menu-item";
    item.setAttribute("role", "menuitem");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "overflow-menu-btn";
    const text = document.createElement("span");
    text.className = "overflow-menu-label";
    text.textContent = label;
    button.appendChild(text);
    button.addEventListener("click", (event) => {
        event.stopPropagation();
        onActivate();
    });
    item.appendChild(button);
    return item;
}

/**
 * Forgetting an OPEN folder only drops the stored record: the session keeps
 * its file -> folder binding, so annotations made afterwards still resolve
 * (and re-attach if the user remembers the folder again). Cutting the binding
 * here - the way the landing does when nothing of that folder is open - would
 * strand every note taken for the rest of the session.
 */
async function onForget(source: FolderSource): Promise<void> {
    const folderId = source.folderId;
    if (!folderId) return;
    try {
        await forgetFolder(folderId);
    } catch (err) {
        log.warn("forgetFolder failed", { err: err instanceof Error ? err.message : String(err) });
        return;
    }
    source.folderId = "";
    refreshRememberedFolders();
}
