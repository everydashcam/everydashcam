// Notes-file selection follows the folder the user is working in without
// storing a folder -> file association: one notes file discovered in the
// opened folder wins, otherwise the last-used file remains active. Recording
// folders stay read-only. A discovered child handle is read-only too; only a
// handle returned by a file picker is ever asked for write permission.

import { t } from "../i18n/index.js";
import type { I18nKey } from "../i18n/keys.js";
import { createLogger } from "../log.js";
import { captureSentryMessage } from "../sentry.js";
import type { VendorFile } from "../parsers/types.js";
import {
    buildSidecarPayload,
    compareAnnotationVersions,
    notesBackupFilename,
    parseSidecarPayload,
    type SidecarParseResult,
} from "../persist/annotations.js";
import { ensureFileReadwritePermission, listFolders } from "../persist/folders.js";
import { getNotesFileState, setNotesFileHandle, setNotesStorage } from "../persist/notes-file.js";
import type { AnnotationRecord, NotesFileRecord, RememberedFolder } from "../persist/types.js";
import {
    annotationStoreAvailable,
    allAnnotationRecords,
    applyMergedRecords,
    persistImportedRecords,
    rebindFolderAnnotations,
    registerAnnotationPersistenceStatusHook,
    registerAnnotationsChangedHook,
    scopeAnnotationRecordsToFolder,
    waitForAnnotationsReady,
} from "./annotations.js";
import { notify } from "./notifications.js";
import { withFilePicker } from "./file-picker.js";
import {
    refreshFolderSources,
    registerFolderOpenedHook,
    registerNotesConnector,
    type NotesBackupStatus,
    type NotesConnectResult,
    type NotesWriteAction,
} from "./folder-sources.js";
import { renderTrips } from "./sidebar.js";
import { refreshTimelineMarkers } from "./timeline-markers.js";
import type { IngestOrigin } from "./state.js";

const log = createLogger("annotations-sidecar");
const SIDECAR_SUGGESTED_NAME = "notes.everydashcam";
const SIDECAR_EXTENSIONS = [".everydashcam", ".dashcamigo"];
const WRITE_DEBOUNCE_MS = 1500;
// Released clients must share this lock to serialize writes to the same notes file.
const WRITE_LOCK_NAME = "dashcamigo:active-notes-file";

let activeHandle: FileSystemFileHandle | null = null;
let activeAccess: NotesFileRecord["access"];
let currentFolderHandle: FileSystemDirectoryHandle | null = null;
let connectionGeneration = 0;
let stateLoad: Promise<void> | null = null;
let writeTimer: number | null = null;
let writeQueue: Promise<void> = Promise.resolve();
let pendingStateChecks = new Set<Promise<void>>();
let suppressAutomaticWrites = 0;
let readFailed = false;
let partialFile = false;
let writeFailed = false;
let readFailureNotified = false;
let writeAttentionHook: (() => void) | null = null;

function sidecarFileType(): FilePickerAcceptType {
    return {
        description: t("sidecar.fileDescription"),
        accept: { "application/json": SIDECAR_EXTENSIONS },
    };
}

export function registerNotesWriteAttentionHook(callback: () => void): void {
    writeAttentionHook = callback;
}

export function initAnnotationsSidecar(): void {
    registerAnnotationsChangedHook(onAnnotationsChanged);
    registerAnnotationPersistenceStatusHook((available) => {
        refreshFolderSources();
        if (!available) notify({ severity: "error", messageKey: "annotations.browserSaveFailed" });
    });
    registerFolderOpenedHook(onFolderOpened);
    registerNotesConnector({
        create: createSidecarFile,
        useExisting: useExistingSidecarFile,
        authorize: authorizeSidecarFile,
        chooseBrowser: chooseBrowserStorage,
        prepareWrite: prepareSidecarWrite,
        status: sidecarStatus,
        browserStorageReady: annotationStoreAvailable,
        canSelectFile: filePickersAvailable,
    });
    void loadSavedConnection();
    window.addEventListener("pagehide", () => void flushPendingSidecarWrites());
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") void flushPendingSidecarWrites();
    });
}

function filePickersAvailable(): boolean {
    return typeof window.showOpenFilePicker === "function" && typeof window.showSaveFilePicker === "function";
}

async function loadSavedConnection(): Promise<void> {
    if (stateLoad) return stateLoad;
    const generation = connectionGeneration;
    stateLoad = (async () => {
        await waitForAnnotationsReady();
        try {
            const saved = await getNotesFileState();
            if (generation === connectionGeneration) {
                activeHandle = saved.handle ?? null;
                activeAccess = saved.access;
            }
        } catch (err) {
            log.warn("notes-file state unavailable", { err: err instanceof Error ? err.message : String(err) });
            refreshFolderSources();
            return;
        }
        refreshFolderSources();
    })();
    return stateLoad;
}

/** Resolves the notes file for one opened batch. A readable file in an FSA
 * folder becomes the last-used connection without acquiring write access. If
 * that folder has none, the previous connection is restored. Handle-less
 * drops retain the compatibility path: their single notes file is imported
 * read-only but cannot become a writable connection. */
export async function mergeNotesFilesFromBatch(files: VendorFile[], origin: IngestOrigin | null): Promise<void> {
    await loadSavedConnection();
    currentFolderHandle = origin?.handle ?? null;
    if (origin) {
        const discovered = await discoverFolderNotesFile(origin.handle);
        if (discovered === "multiple") {
            log.warn("multiple notes files in folder root, keeping last-used file", { folder: origin.handle.name });
            notify({ severity: "warn", messageKey: "sidecar.multipleFound" });
        } else if (discovered) {
            const attached = await attachSidecar(discovered, false, false, "derived", origin.folderId);
            if (attached) return;
        }
        if (activeHandle && (await filePermissionState(activeHandle, "read")) === "granted") {
            await mergeFromActiveFile();
        }
        return;
    }

    const notesFiles = files.filter((vendorFile) => isNotesBackupName(vendorFile.file.name));
    if (notesFiles.length > 1) {
        log.warn("multiple notes files in ingest batch, none merged", { files: notesFiles.length });
        notify({ severity: "warn", messageKey: "sidecar.multipleFound" });
        return;
    }
    const vendorFile = notesFiles[0];
    if (!vendorFile) return;
    await waitForAnnotationsReady();
    let parsed: ReturnType<typeof parseSidecarPayload>;
    try {
        parsed = parseSidecarPayload(await vendorFile.file.text());
    } catch (err) {
        log.warn("notes file in batch unreadable", { err: err instanceof Error ? err.message : String(err) });
        notify({ severity: "error", messageKey: "sidecar.importFailed" });
        return;
    }
    if (!parsed) {
        notify({ severity: "error", messageKey: "sidecar.notOurFile" });
        return;
    }
    await mergePortableRecords(parsed.records);
    if (parsed.rejectedEntries > 0) {
        notify({
            severity: "error",
            messageKey: "sidecar.partialReadOnly",
            messageParams: { n: parsed.rejectedEntries },
        });
    }
}

/** Exactly one conventional notes file wins over other backups. Otherwise one
 * supported notes file in the folder root is unambiguous. Nested backups are not
 * candidates: opening a recordings folder must not make an unrelated archive
 * writable. */
async function discoverFolderNotesFile(
    folder: FileSystemDirectoryHandle,
): Promise<FileSystemFileHandle | "multiple" | null> {
    const conventional: FileSystemFileHandle[] = [];
    const candidates: FileSystemFileHandle[] = [];
    try {
        for await (const child of folder.values()) {
            if (child.kind !== "file" || !isNotesBackupName(child.name)) continue;
            candidates.push(child);
            if (SIDECAR_EXTENSIONS.some((extension) => child.name.toLowerCase() === `notes${extension}`)) {
                conventional.push(child);
            }
        }
    } catch (err) {
        log.warn("notes-file discovery failed", { err: err instanceof Error ? err.message : String(err) });
        return null;
    }
    if (conventional.length === 1) return conventional[0]!;
    if (conventional.length > 1) return "multiple";
    if (candidates.length === 1) return candidates[0]!;
    return candidates.length > 1 ? "multiple" : null;
}

export function isNotesBackupName(name: string): boolean {
    return SIDECAR_EXTENSIONS.some((extension) => name.toLowerCase().endsWith(extension));
}

async function readSidecarFile(handle: FileSystemFileHandle): Promise<SidecarParseResult | null> {
    const emptyApp = handle.name.toLowerCase().endsWith(".dashcamigo") ? "dashcamigo" : "everydashcam";
    return parseSidecarPayload(await (await handle.getFile()).text(), emptyApp);
}

export async function downloadPortableNotesBackup(): Promise<void> {
    await waitForAnnotationsReady();
    const records = allAnnotationRecords();
    if (records.length === 0) {
        notify({ severity: "info", messageKey: "sidecar.exportEmpty" });
        return;
    }
    const blob = new Blob([JSON.stringify(buildSidecarPayload(records, Date.now()))], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = notesBackupFilename();
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
    notify({ severity: "info", messageKey: "sidecar.exported" });
}

export async function importPortableNotesBackup(file: File): Promise<boolean> {
    await waitForAnnotationsReady();
    let parsed: ReturnType<typeof parseSidecarPayload>;
    try {
        parsed = parseSidecarPayload(await file.text());
    } catch (err) {
        log.warn("portable notes backup read failed", { err: err instanceof Error ? err.message : String(err) });
        notify({ severity: "error", messageKey: "sidecar.importFailed" });
        return false;
    }
    if (!parsed) {
        notify({ severity: "error", messageKey: "sidecar.notOurFile" });
        return false;
    }
    const changed = await mergePortableRecords(parsed.records);
    if (!(await persistImportedRecords(parsed.records))) {
        notify({ severity: "error", messageKey: "annotations.browserSaveFailed" });
        return false;
    }
    notify({ severity: "info", messageKey: "sidecar.imported", messageParams: { n: parsed.records.length } });
    if (parsed.rejectedEntries > 0) {
        notify({
            severity: "error",
            messageKey: "sidecar.partialReadOnly",
            messageParams: { n: parsed.rejectedEntries },
        });
    } else if (changed && activeHandle && activeAccess === "file" && (await hasFileReadwritePermission(activeHandle))) {
        scheduleWrite(0);
    }
    return parsed.rejectedEntries === 0;
}

export interface AnnotationStorageState {
    hintKey: I18nKey;
    backupAction: "create" | "reconnect" | null;
}

async function readNotesFileState(): Promise<NotesFileRecord> {
    return getNotesFileState().catch(() => ({ id: "global" }));
}

export async function annotationStorageState(): Promise<AnnotationStorageState> {
    await loadSavedConnection();
    const browserReady = annotationStoreAvailable();
    const state = await readNotesFileState();
    if (state.storage === "browser") {
        return {
            hintKey: browserReady ? "annotations.storageHint" : "annotations.storageHintSession",
            backupAction: "create",
        };
    }
    if (!activeHandle) {
        return {
            hintKey: browserReady ? "annotations.storageHint" : "annotations.storageHintSession",
            backupAction: filePickersAvailable() ? "create" : null,
        };
    }
    if (
        activeAccess !== "file" ||
        partialFile ||
        readFailed ||
        writeFailed ||
        !(await hasFileReadwritePermission(activeHandle))
    ) {
        if (!filePickersAvailable()) {
            return {
                hintKey: browserReady ? "annotations.storageHint" : "annotations.storageHintSession",
                backupAction: null,
            };
        }
        return {
            hintKey: browserReady ? "annotations.storageHintReconnect" : "annotations.storageHintSession",
            backupAction: "reconnect",
        };
    }
    return {
        hintKey: browserReady ? "annotations.storageHintFile" : "annotations.storageHintFileOnly",
        backupAction: null,
    };
}

async function sidecarStatus(): Promise<NotesBackupStatus> {
    await loadSavedConnection();
    const state = await readNotesFileState();
    if (state.storage === "browser") return { state: annotationStoreAvailable() ? "browser" : "session" };
    if (!activeHandle) return { state: annotationStoreAvailable() ? "browser" : "session" };
    if (partialFile || readFailed || writeFailed) return { state: "needsAttention", fileName: activeHandle.name };
    if (activeAccess !== "file") return { state: "connected", fileName: activeHandle.name };
    const permission = await filePermissionState(activeHandle, "readwrite");
    return {
        state: permission === "granted" ? "ready" : permission === "prompt" ? "connected" : "needsAttention",
        fileName: activeHandle.name,
    };
}

async function onFolderOpened(folder: RememberedFolder): Promise<void> {
    await waitForAnnotationsReady();
    const liveFolderIds = await liveFolderIdSet(folder.id);
    suppressAutomaticWrites++;
    try {
        const changed = rebindFolderAnnotations(folder.id, liveFolderIds);
        if (changed > 0) refreshAnnotationUi();
    } finally {
        suppressAutomaticWrites--;
    }
}

function onAnnotationsChanged(): void {
    if (suppressAutomaticWrites > 0) return;
    const task = (async () => {
        await loadSavedConnection();
        const state = await readNotesFileState();
        if (
            state.storage === "browser" ||
            !activeHandle ||
            activeAccess !== "file" ||
            !(await hasFileReadwritePermission(activeHandle))
        )
            return;
        scheduleWrite();
    })();
    pendingStateChecks.add(task);
    void task.finally(() => pendingStateChecks.delete(task));
}

async function createSidecarFile(): Promise<NotesConnectResult> {
    const pickSaveFile = window.showSaveFilePicker;
    if (typeof pickSaveFile !== "function") return "failed";
    let handle: FileSystemFileHandle;
    try {
        const picked = await withFilePicker("save", () =>
            pickSaveFile.call(window, {
                id: "annotations-sidecar",
                ...(currentFolderHandle ? { startIn: currentFolderHandle } : {}),
                suggestedName: SIDECAR_SUGGESTED_NAME,
                excludeAcceptAllOption: true,
                types: [sidecarFileType()],
            }),
        );
        if (!picked) return "cancelled";
        handle = picked;
    } catch (err) {
        if (isPickerDismissal(err)) return "cancelled";
        log.warn("notes save picker failed", { err: err instanceof Error ? err.message : String(err) });
        return "failed";
    }
    if (!(await ensureFileReadwritePermission(handle))) return "failed";
    // A Save picker may target an existing file. Merge before replacement.
    return (await attachSidecar(handle, true, true, "file")) ? "connected" : "failed";
}

async function useExistingSidecarFile(forWrite = false): Promise<NotesConnectResult> {
    const pickOpenFile = window.showOpenFilePicker;
    if (typeof pickOpenFile !== "function") return "failed";
    let handle: FileSystemFileHandle | undefined;
    try {
        const picked = await withFilePicker("open", () =>
            pickOpenFile.call(window, {
                id: "annotations-sidecar",
                ...(currentFolderHandle ? { startIn: currentFolderHandle } : {}),
                multiple: false,
                excludeAcceptAllOption: true,
                types: [sidecarFileType()],
            }),
        );
        if (!picked) return "cancelled";
        [handle] = picked;
    } catch (err) {
        if (isPickerDismissal(err)) return "cancelled";
        log.warn("notes open picker failed", { err: err instanceof Error ? err.message : String(err) });
        return "failed";
    }
    if (!handle) return "cancelled";
    if (forWrite && !(await ensureFileReadwritePermission(handle))) return "failed";
    return (await attachSidecar(handle, forWrite, forWrite, "file")) ? "connected" : "failed";
}

async function attachSidecar(
    handle: FileSystemFileHandle,
    writeNow: boolean,
    writePermissionReady = false,
    access: NonNullable<NotesFileRecord["access"]> = "file",
    legacyFolderId = "",
): Promise<boolean> {
    // Finish edits destined for the previous file before any records from the
    // new file enter memory. Otherwise a pending debounce could serialize the
    // newly discovered folder's notes back into the old destination.
    if (activeHandle && activeHandle !== handle) await flushPendingSidecarWrites();
    const generation = ++connectionGeneration;
    let parsed: ReturnType<typeof parseSidecarPayload>;
    try {
        parsed = await readSidecarFile(handle);
    } catch (err) {
        log.warn("notes file read failed at attach", { err: err instanceof Error ? err.message : String(err) });
        notify({ severity: "error", messageKey: "sidecar.importFailed" });
        return false;
    }
    if (!parsed) {
        notify({ severity: "error", messageKey: "sidecar.notOurFile" });
        return false;
    }
    if (parsed.version === 1 && legacyFolderId) {
        const liveFolderIds = await liveFolderIdSet(legacyFolderId);
        const records = scopeAnnotationRecordsToFolder(parsed.records, legacyFolderId, liveFolderIds);
        applyIncomingRecords(records, liveFolderIds);
    } else {
        await mergePortableRecords(parsed.records);
    }
    if (parsed.rejectedEntries > 0) {
        notify({
            severity: "error",
            messageKey: "sidecar.partialReadOnly",
            messageParams: { n: parsed.rejectedEntries },
        });
        return false;
    }
    if (writeNow && access !== "file") return false;
    if (writeNow && !writePermissionReady && !(await ensureFileReadwritePermission(handle))) return false;
    // A slow startup read of the previously saved connection must not replace
    // the file the user just picked.
    if (generation !== connectionGeneration) return false;
    activeHandle = handle;
    activeAccess = access;
    readFailed = false;
    partialFile = false;
    writeFailed = false;
    readFailureNotified = false;
    try {
        await setNotesFileHandle(handle, access);
        await setNotesStorage(null);
    } catch (err) {
        // The picked handle still works in this tab when IndexedDB cannot
        // remember it; annotation persistence already reports session mode.
        log.warn("notes-file handle could not be remembered", {
            err: err instanceof Error ? err.message : String(err),
        });
    }
    const written = !writeNow || (await enqueueWrite());
    refreshFolderSources();
    if (writeNow && written && access === "file") {
        notify({ severity: "info", messageKey: "sidecar.enabled", messageParams: { file: handle.name } });
    }
    return written;
}

async function authorizeSidecarFile(): Promise<NotesConnectResult> {
    const handle = activeHandle;
    if (!handle || activeAccess !== "file") return "failed";
    if (!(await ensureFileReadwritePermission(handle))) return "failed";
    return (await enqueueWrite()) ? "connected" : "failed";
}

async function chooseBrowserStorage(): Promise<void> {
    try {
        await setNotesStorage("browser");
    } catch (err) {
        log.warn("browser-only notes choice could not be remembered", {
            err: err instanceof Error ? err.message : String(err),
        });
    }
    refreshFolderSources();
}

async function prepareSidecarWrite(force = false): Promise<NotesWriteAction | null> {
    await loadSavedConnection();
    const state = await readNotesFileState();
    if (state.storage === "browser") {
        if (!force) return null;
        return activeHandle ? "connect" : "create";
    }
    if (!activeHandle) return "create";
    if (activeAccess !== "file") return "connect";
    if (partialFile || readFailed || writeFailed) return "connect";
    const permission = await filePermissionState(activeHandle, "readwrite");
    if (permission === "granted") return null;
    return permission === "prompt" ? "authorize" : "connect";
}

async function mergeFromActiveFile(): Promise<SidecarParseResult | null> {
    const handle = activeHandle;
    if (!handle) return null;
    let parsed: ReturnType<typeof parseSidecarPayload>;
    try {
        parsed = await readSidecarFile(handle);
    } catch (err) {
        readFailed = true;
        refreshFolderSources();
        log.warn("notes file read failed", { err: err instanceof Error ? err.message : String(err) });
        return null;
    }
    if (!parsed) {
        readFailed = true;
        refreshFolderSources();
        notifyOnceForReadFailure("sidecar.notOurFile");
        return null;
    }
    if (parsed.rejectedEntries > 0) {
        partialFile = true;
        await mergePortableRecords(parsed.records);
        refreshFolderSources();
        notifyOnceForReadFailure("sidecar.partialReadOnly", { n: parsed.rejectedEntries });
        return null;
    }
    await mergePortableRecords(parsed.records);
    readFailed = false;
    partialFile = false;
    readFailureNotified = false;
    return parsed;
}

function notifyOnceForReadFailure(
    messageKey: "sidecar.notOurFile" | "sidecar.partialReadOnly",
    params?: { n: number },
): void {
    if (readFailureNotified) return;
    readFailureNotified = true;
    notify({ severity: "error", messageKey, ...(params ? { messageParams: params } : {}) });
}

async function mergePortableRecords(records: readonly AnnotationRecord[]): Promise<boolean> {
    const liveFolderIds = await liveFolderIdSet();
    const portable = records.map((record) =>
        liveFolderIds.has(record.folderId) ? record : record.folderId === "" ? record : { ...record, folderId: "" },
    );
    return applyIncomingRecords(portable, liveFolderIds);
}

function applyIncomingRecords(records: AnnotationRecord[], liveFolderIds: ReadonlySet<string>): boolean {
    suppressAutomaticWrites++;
    try {
        let changed = applyMergedRecords(records, { preserveFolderIds: liveFolderIds });
        for (const folderId of liveFolderIds) changed += rebindFolderAnnotations(folderId, liveFolderIds);
        if (changed > 0) refreshAnnotationUi();
        return changed > 0;
    } finally {
        suppressAutomaticWrites--;
    }
}

async function liveFolderIdSet(extraFolderId?: string): Promise<Set<string>> {
    let ids: Set<string>;
    try {
        ids = new Set((await listFolders()).map((folder) => folder.id));
    } catch {
        // A transient IndexedDB failure must not detach otherwise valid local
        // ownership while importing a file. Dead ids can be cleaned up the
        // next time the folder store is available.
        ids = new Set(
            allAnnotationRecords()
                .map((record) => record.folderId)
                .filter(Boolean),
        );
    }
    if (extraFolderId) ids.add(extraFolderId);
    return ids;
}

function refreshAnnotationUi(): void {
    renderTrips();
    refreshTimelineMarkers();
}

function scheduleWrite(delayMs = WRITE_DEBOUNCE_MS): void {
    if (writeTimer !== null) clearTimeout(writeTimer);
    writeTimer = window.setTimeout(() => {
        writeTimer = null;
        void enqueueWrite();
    }, delayMs);
}

function enqueueWrite(): Promise<boolean> {
    let result = false;
    const queued = writeQueue
        .catch(() => {})
        .then(() =>
            withSidecarWriteLock(async () => {
                result = await writeSidecar();
            }),
        )
        .catch((err: unknown) => {
            log.warn("queued notes-file write failed", { err: err instanceof Error ? err.message : String(err) });
        });
    writeQueue = queued;
    return queued.then(() => result);
}

export async function flushPendingSidecarWrites(): Promise<void> {
    if (pendingStateChecks.size > 0) await Promise.allSettled([...pendingStateChecks]);
    if (writeTimer !== null) {
        clearTimeout(writeTimer);
        writeTimer = null;
        void enqueueWrite();
    }
    await writeQueue.catch(() => {});
}

async function withSidecarWriteLock<T>(write: () => Promise<T>): Promise<T> {
    if (typeof navigator !== "undefined" && navigator.locks) return navigator.locks.request(WRITE_LOCK_NAME, write);
    return write();
}

async function writeSidecar(): Promise<boolean> {
    const handle = activeHandle;
    if (!handle || activeAccess !== "file" || !(await hasFileReadwritePermission(handle))) {
        notifyWriteFailure();
        return false;
    }
    let writable: FileSystemWritableFileStream | null = null;
    try {
        const readable = await mergeFromActiveFile();
        if (!readable) {
            // The edit that queued this write has already completed. Surface
            // the blocking recovery choice now; waiting for another edit would
            // leave the first failed save easy to miss.
            notifyWriteFailure();
            return false;
        }
        const records = allAnnotationRecords();
        // Open the replacement stream only after the current file has been
        // parsed successfully. Some implementations lock reads once a writer
        // exists, and there is no reason to touch an invalid/partial file.
        writable = await handle.createWritable({ mode: "exclusive" });
        await writable.write(JSON.stringify(buildSidecarPayload(records, Date.now(), readable.app)));
        await writable.close();
        writable = null;
        const verified = await readSidecarFile(handle);
        const verifiedById = new Map(verified?.records.map((record) => [record.id, record]) ?? []);
        if (
            verified?.app !== readable.app ||
            verified.version !== (readable.app === "dashcamigo" ? 2 : 3) ||
            verified.rejectedEntries > 0 ||
            records.some((record) => {
                const saved = verifiedById.get(record.id);
                return !saved || compareAnnotationVersions(saved, record) < 0;
            })
        ) {
            throw new Error("notes-file verification failed");
        }
        writeFailed = false;
        readFailureNotified = false;
        refreshFolderSources();
        log.info("notes file written", { records: records.length });
        return true;
    } catch (err) {
        await writable?.abort().catch(() => {});
        log.warn("notes-file write failed", { err: err instanceof Error ? err.message : String(err) });
        if (
            !writeFailed &&
            !(err instanceof Error && ["AbortError", "NotAllowedError", "SecurityError"].includes(err.name))
        ) {
            // Only the durability failure leaves the browser, never the file
            // contents, handle name or a parser's text-bearing exception.
            captureSentryMessage("notes file write failed", {
                level: "error",
                fingerprint: ["notes_file_write_failed"],
                tags: { feature: "annotations", storage: "sidecar" },
            });
        }
        notifyWriteFailure();
        return false;
    }
}

async function hasFileReadwritePermission(handle: FileSystemFileHandle): Promise<boolean> {
    return (await filePermissionState(handle, "readwrite")) === "granted";
}

async function filePermissionState(handle: FileSystemFileHandle, mode: "read" | "readwrite"): Promise<PermissionState> {
    if (typeof handle.queryPermission !== "function") return "granted";
    try {
        return await handle.queryPermission({ mode });
    } catch {
        return "denied";
    }
}

function notifyWriteFailure(): void {
    if (writeFailed) return;
    writeFailed = true;
    refreshFolderSources();
    writeAttentionHook?.();
}

function isPickerDismissal(err: unknown): boolean {
    return err instanceof DOMException && err.name === "AbortError";
}

export function _resetForTests(): void {
    if (writeTimer !== null) clearTimeout(writeTimer);
    activeHandle = null;
    activeAccess = undefined;
    currentFolderHandle = null;
    connectionGeneration++;
    stateLoad = null;
    writeTimer = null;
    writeQueue = Promise.resolve();
    pendingStateChecks = new Set();
    suppressAutomaticWrites = 0;
    readFailed = false;
    partialFile = false;
    writeFailed = false;
    readFailureNotified = false;
    writeAttentionHook = null;
}
