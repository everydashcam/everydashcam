import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { VendorFile } from "../parsers/types.js";
import type { AnnotationRecord, NotesFileRecord, RememberedFolder, TripMetaAnnotation } from "../persist/types.js";
import type { NotesConnector } from "./folder-sources.js";
import * as sentry from "../sentry.js";

const mocks = vi.hoisted(() => ({
    annotationHook: null as (() => void) | null,
    connector: null as NotesConnector | null,
    folderHook: null as ((folder: RememberedFolder) => void | Promise<void>) | null,
    folders: [] as RememberedFolder[],
    notesState: { id: "global" } as NotesFileRecord,
    records: new Map<string, AnnotationRecord>(),
    storeAvailable: true,
    applyMergedRecords: vi.fn((records: AnnotationRecord[], options?: { preserveFolderIds?: ReadonlySet<string> }) => {
        let changed = 0;
        for (const incoming of records) {
            const previous = mocks.records.get(incoming.id);
            const record =
                previous && options?.preserveFolderIds?.has(previous.folderId)
                    ? { ...incoming, folderId: previous.folderId }
                    : incoming;
            if (!previous || record.updatedAt > previous.updatedAt) {
                mocks.records.set(record.id, record);
                changed++;
            }
        }
        return changed;
    }),
    ensureFileReadwritePermission: vi.fn(async (handle: FileSystemFileHandle) => {
        if (typeof handle.requestPermission !== "function") return true;
        return (await handle.requestPermission({ mode: "readwrite" })) === "granted";
    }),
    notify: vi.fn(),
    renderTrips: vi.fn(),
    refreshTimelineMarkers: vi.fn(),
    savePicker: vi.fn(),
    openPicker: vi.fn(),
    setNotesFileHandle: vi.fn(async (handle: FileSystemFileHandle, access: "file" | "derived" = "file") => {
        mocks.notesState = { id: "global", handle, access };
    }),
    setNotesStorage: vi.fn(async (storage: "browser" | null) => {
        if (storage === "browser") mocks.notesState = { ...mocks.notesState, storage };
        else {
            const next = { ...mocks.notesState };
            delete next.storage;
            mocks.notesState = next;
        }
    }),
}));

vi.mock("../persist/folders.js", () => ({
    ensureFileReadwritePermission: mocks.ensureFileReadwritePermission,
    listFolders: vi.fn(async () => mocks.folders),
}));
vi.mock("../persist/notes-file.js", () => ({
    getNotesFileState: vi.fn(async () => mocks.notesState),
    setNotesFileHandle: mocks.setNotesFileHandle,
    setNotesStorage: mocks.setNotesStorage,
}));
vi.mock("./annotations.js", () => ({
    annotationStoreAvailable: vi.fn(() => mocks.storeAvailable),
    allAnnotationRecords: () => [...mocks.records.values()],
    applyMergedRecords: mocks.applyMergedRecords,
    rebindFolderAnnotations: vi.fn(() => 0),
    registerAnnotationsChangedHook: (hook: () => void) => {
        mocks.annotationHook = hook;
    },
    registerAnnotationPersistenceStatusHook: vi.fn(),
    waitForAnnotationsReady: vi.fn(async () => {}),
    scopeAnnotationRecordsToFolder: (records: AnnotationRecord[], folderId: string) =>
        records.map((record) => ({ ...record, folderId })),
}));
vi.mock("./folder-sources.js", () => ({
    refreshFolderSources: vi.fn(),
    registerFolderOpenedHook: (hook: (folder: RememberedFolder) => void | Promise<void>) => {
        mocks.folderHook = hook;
    },
    registerNotesConnector: (connector: NotesConnector) => {
        mocks.connector = connector;
    },
}));
vi.mock("./notifications.js", () => ({ notify: mocks.notify }));
vi.mock("./sidebar.js", () => ({ renderTrips: mocks.renderTrips }));
vi.mock("./timeline-markers.js", () => ({ refreshTimelineMarkers: mocks.refreshTimelineMarkers }));

import {
    _resetForTests,
    annotationStorageState,
    flushPendingSidecarWrites,
    initAnnotationsSidecar,
    isNotesBackupName,
    mergeNotesFilesFromBatch,
    registerNotesWriteAttentionHook,
} from "./annotations-sidecar.js";

function tripMeta(id: string, folderId = "folder-1", updatedAt = 100): TripMetaAnnotation {
    return {
        id,
        folderId,
        updatedAt,
        deleted: false,
        kind: "tripMeta",
        anchor: { fileIdentityKey: `key-${id}`, startUtc: 1_700_000_000_000 },
        name: id,
    };
}

function payload(records: unknown[], version: 1 | 2 | 3 = 1): string {
    return JSON.stringify({
        app: version === 3 ? "everydashcam" : "dashcamigo",
        format: "annotations",
        version,
        annotations: records,
    });
}

interface FakeNotesFile {
    handle: FileSystemFileHandle;
    read(): string;
    writes(): number;
    replace(text: string): void;
    setReadFailure(fails: boolean): void;
    setWritePermission(state: PermissionState): void;
    setWriteFailure(error: Error | null): void;
}

function fakeNotesFile(
    initial: string,
    initialWritePermission: PermissionState = "granted",
    name = "notes.dashcamigo",
): FakeNotesFile {
    let contents = initial;
    let readFails = false;
    let writePermission = initialWritePermission;
    let writeCount = 0;
    let writeFailure: Error | null = null;
    const handle = {
        kind: "file",
        name,
        async getFile() {
            if (readFails) throw new DOMException("file unavailable", "NotFoundError");
            return { text: async () => contents };
        },
        async queryPermission(options?: FileSystemHandlePermissionDescriptor) {
            return options?.mode === "readwrite" ? writePermission : "granted";
        },
        async requestPermission() {
            writePermission = "granted";
            return "granted" as const;
        },
        async createWritable() {
            if (writeFailure) throw writeFailure;
            let staged = "";
            return {
                async write(value: string) {
                    staged = value;
                },
                async abort() {},
                async close() {
                    contents = staged;
                    writeCount++;
                },
            };
        },
    } as unknown as FileSystemFileHandle;
    return {
        handle,
        read: () => contents,
        writes: () => writeCount,
        replace: (text) => {
            contents = text;
        },
        setReadFailure: (fails) => {
            readFails = fails;
        },
        setWritePermission: (state) => {
            writePermission = state;
        },
        setWriteFailure: (error) => {
            writeFailure = error;
        },
    };
}

function folderHandle(name: string, files: FileSystemFileHandle[] = []): FileSystemDirectoryHandle {
    return {
        kind: "directory",
        name,
        async *values() {
            yield* files;
        },
    } as unknown as FileSystemDirectoryHandle;
}

function vendorNotes(contents: string): VendorFile {
    return { file: new File([contents], "notes.dashcamigo"), relativePath: "CARD/notes.dashcamigo" };
}

beforeEach(() => {
    _resetForTests();
    vi.clearAllMocks();
    mocks.annotationHook = null;
    mocks.connector = null;
    mocks.folders = [];
    mocks.notesState = { id: "global" };
    mocks.records.clear();
    mocks.storeAvailable = true;
    vi.stubGlobal("window", {
        showSaveFilePicker: mocks.savePicker,
        showOpenFilePicker: mocks.openPicker,
        addEventListener: vi.fn(),
        setTimeout: globalThis.setTimeout.bind(globalThis),
    });
    vi.stubGlobal("document", { visibilityState: "visible", addEventListener: vi.fn() });
    vi.stubGlobal("navigator", {});
});

afterEach(() => {
    _resetForTests();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe("active notes file", () => {
    it.each(["notes.everydashcam", "notes.dashcamigo", "BACKUP.EVERYDASHCAM", "BACKUP.DASHCAMIGO"])(
        "recognizes the supported notes filename %s",
        (name) => expect(isNotesBackupName(name)).toBe(true),
    );

    it("does not recognize an unrelated file or a suffixed backup", () => {
        expect(isNotesBackupName("notes.json")).toBe(false);
        expect(isNotesBackupName("notes.everydashcam.old")).toBe(false);
    });

    it("creates current v3 notes with the new suggested filename", async () => {
        const notes = fakeNotesFile("", "granted", "notes.everydashcam");
        mocks.records.set("local", tripMeta("local"));
        mocks.savePicker.mockResolvedValue(notes.handle);
        initAnnotationsSidecar();

        const connection = mocks.connector!.create();
        expect(mocks.savePicker).toHaveBeenCalledOnce();
        expect(mocks.savePicker.mock.contexts[0]).toBe(window);
        await expect(connection).resolves.toBe("connected");

        expect(mocks.savePicker).toHaveBeenCalledWith(
            expect.objectContaining({
                suggestedName: "notes.everydashcam",
                types: [expect.objectContaining({ accept: { "application/json": [".everydashcam", ".dashcamigo"] } })],
            }),
        );
        expect(JSON.parse(notes.read())).toMatchObject({
            app: "everydashcam",
            version: 3,
            annotations: [{ id: "local" }],
        });
    });

    it("preserves the legacy dialect when the chosen empty file has the old extension", async () => {
        const notes = fakeNotesFile("");
        mocks.savePicker.mockResolvedValue(notes.handle);
        initAnnotationsSidecar();
        await expect(mocks.connector!.create()).resolves.toBe("connected");
        expect(JSON.parse(notes.read())).toMatchObject({ app: "dashcamigo", version: 2 });
    });

    it("discovers the new conventional filename without writing or renaming it", async () => {
        const notes = fakeNotesFile(
            payload([{ ...tripMeta("local"), folderId: undefined }], 3),
            "prompt",
            "notes.everydashcam",
        );
        initAnnotationsSidecar();
        await mergeNotesFilesFromBatch([], { handle: folderHandle("card", [notes.handle]), folderId: "folder-1" });
        expect(mocks.records.has("local")).toBe(true);
        expect(mocks.setNotesFileHandle).toHaveBeenCalledWith(notes.handle, "derived");
        expect(notes.writes()).toBe(0);
    });

    it("does not choose between old and new conventional files in the same folder", async () => {
        const old = fakeNotesFile(payload([], 2));
        const current = fakeNotesFile(payload([], 3), "granted", "notes.everydashcam");
        initAnnotationsSidecar();
        await mergeNotesFilesFromBatch([], {
            handle: folderHandle("card", [old.handle, current.handle]),
            folderId: "folder-1",
        });
        expect(mocks.setNotesFileHandle).not.toHaveBeenCalled();
        expect(mocks.notify).toHaveBeenCalledWith(expect.objectContaining({ messageKey: "sidecar.multipleFound" }));
        expect(old.writes() + current.writes()).toBe(0);
    });

    it("uses the dialect reread under the shared write lock, preserving concurrent records", async () => {
        const notes = fakeNotesFile(payload([], 3), "granted", "notes.everydashcam");
        mocks.openPicker.mockResolvedValue([notes.handle]);
        initAnnotationsSidecar();
        await expect(mocks.connector!.useExisting()).resolves.toBe("connected");
        const remote = { ...tripMeta("remote", "", 300), deleted: true, folderId: undefined };
        const lock = vi.fn(async (_name: string, write: () => Promise<unknown>) => {
            notes.replace(payload([remote], 2));
            return write();
        });
        vi.stubGlobal("navigator", { locks: { request: lock } });
        mocks.records.set("local", tripMeta("local"));
        mocks.annotationHook?.();
        await flushPendingSidecarWrites();

        expect(lock).toHaveBeenCalledOnce();
        const saved = JSON.parse(notes.read());
        expect(saved).toMatchObject({ app: "dashcamigo", version: 2 });
        expect(saved.annotations).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ id: "local", updatedAt: 100 }),
                expect.objectContaining({ id: "remote", updatedAt: 300, deleted: true }),
            ]),
        );
    });

    it("prefers a notes file discovered in the opened folder without requesting write access", async () => {
        const notes = fakeNotesFile(payload([tripMeta("local")], 1), "prompt");
        initAnnotationsSidecar();
        await mergeNotesFilesFromBatch([vendorNotes(notes.read())], {
            handle: folderHandle("folder-1", [notes.handle]),
            folderId: "folder-1",
        });

        expect(mocks.ensureFileReadwritePermission).not.toHaveBeenCalled();
        expect(mocks.setNotesFileHandle).toHaveBeenCalledWith(notes.handle, "derived");
        expect(notes.writes()).toBe(0);
        expect(mocks.records.get("local")).toMatchObject({ folderId: "folder-1" });
        await expect(mocks.connector!.status()).resolves.toEqual({
            state: "connected",
            fileName: "notes.dashcamigo",
        });
    });

    it("reads an old file from an ingest batch without connecting or rewriting it", async () => {
        const old = tripMeta("old", "foreign-folder");
        initAnnotationsSidecar();
        await mergeNotesFilesFromBatch([vendorNotes(payload([old], 1))], null);

        expect(mocks.records.get("old")).toMatchObject({ folderId: "" });
        expect(mocks.setNotesFileHandle).not.toHaveBeenCalled();
        expect(mocks.ensureFileReadwritePermission).not.toHaveBeenCalled();
    });

    it("switches from the last-used file to the opened folder's file and writes only after reconnecting it", async () => {
        const previous = fakeNotesFile(payload([tripMeta("previous")], 2), "granted", "report.dashcamigo");
        const local = fakeNotesFile(payload([tripMeta("local")], 1), "prompt");
        mocks.notesState = { id: "global", handle: previous.handle, access: "file" };
        initAnnotationsSidecar();

        await mergeNotesFilesFromBatch([vendorNotes(local.read())], {
            handle: folderHandle("next-folder", [local.handle]),
            folderId: "next-folder",
        });

        await expect(mocks.connector!.status()).resolves.toEqual({
            state: "connected",
            fileName: "notes.dashcamigo",
        });
        expect(previous.writes()).toBe(0);
        expect(local.writes()).toBe(0);
        expect(mocks.ensureFileReadwritePermission).not.toHaveBeenCalled();
        await expect(mocks.connector!.prepareWrite()).resolves.toBe("connect");

        mocks.openPicker.mockResolvedValue([local.handle]);
        await expect(mocks.connector!.useExisting(true)).resolves.toBe("connected");
        expect(mocks.ensureFileReadwritePermission).toHaveBeenCalledWith(local.handle);
        expect(previous.writes()).toBe(0);
        expect(local.writes()).toBe(1);
        expect(JSON.parse(local.read()).version).toBe(2);
    });

    it("keeps the last-used file when the opened folder has no notes file", async () => {
        const previous = fakeNotesFile(
            payload([{ ...tripMeta("previous"), folderId: undefined }], 2),
            "granted",
            "report.dashcamigo",
        );
        mocks.notesState = { id: "global", handle: previous.handle, access: "file" };
        initAnnotationsSidecar();

        await mergeNotesFilesFromBatch([], { handle: folderHandle("empty"), folderId: "" });

        await expect(mocks.connector!.status()).resolves.toEqual({
            state: "ready",
            fileName: "report.dashcamigo",
        });
    });

    it("flushes a pending edit before merging records from a newly discovered file", async () => {
        const previous = fakeNotesFile(
            payload([{ ...tripMeta("previous"), folderId: undefined }], 2),
            "granted",
            "report.dashcamigo",
        );
        const local = fakeNotesFile(payload([tripMeta("local")], 1), "prompt");
        mocks.notesState = { id: "global", handle: previous.handle, access: "file" };
        mocks.records.set("pending", tripMeta("pending", "folder-1", 200));
        initAnnotationsSidecar();
        mocks.annotationHook?.();

        await mergeNotesFilesFromBatch([vendorNotes(local.read())], {
            handle: folderHandle("next-folder", [local.handle]),
            folderId: "next-folder",
        });

        const previousIds = (JSON.parse(previous.read()) as { annotations: Array<{ id: string }> }).annotations.map(
            ({ id }) => id,
        );
        expect(previous.writes()).toBe(1);
        expect(previousIds).toContain("pending");
        expect(previousIds).not.toContain("local");
        expect(local.writes()).toBe(0);
    });

    it("connects an existing v1 file read-only until a write action", async () => {
        const notes = fakeNotesFile(payload([tripMeta("old")], 1), "prompt");
        mocks.openPicker.mockResolvedValue([notes.handle]);
        initAnnotationsSidecar();

        await expect(mocks.connector!.useExisting()).resolves.toBe("connected");
        expect(notes.writes()).toBe(0);
        expect(mocks.ensureFileReadwritePermission).not.toHaveBeenCalled();
        expect(mocks.notify).not.toHaveBeenCalledWith(expect.objectContaining({ messageKey: "sidecar.enabled" }));
        await expect(mocks.connector!.status()).resolves.toEqual({
            state: "connected",
            fileName: "notes.dashcamigo",
        });
    });

    it("upgrades a connected v1 file to global v2 on the first explicit write", async () => {
        const notes = fakeNotesFile(payload([tripMeta("remote", "old-folder")], 1), "prompt");
        mocks.notesState = { id: "global", handle: notes.handle, access: "file" };
        mocks.records.set("local", tripMeta("local", "folder-2", 200));
        initAnnotationsSidecar();

        await expect(mocks.connector!.prepareWrite()).resolves.toBe("authorize");
        await expect(mocks.connector!.authorize()).resolves.toBe("connected");

        const written = JSON.parse(notes.read()) as { version: number; annotations: Record<string, unknown>[] };
        expect(written.version).toBe(2);
        expect(written.annotations.map((record) => record.id).sort()).toEqual(["local", "remote"]);
        expect(written.annotations.every((record) => !("folderId" in record))).toBe(true);
    });

    it("merges an existing Save target before replacing it", async () => {
        const notes = fakeNotesFile(payload([{ ...tripMeta("remote"), folderId: undefined }], 2));
        mocks.records.set("local", tripMeta("local", "folder-2", 200));
        mocks.savePicker.mockResolvedValue(notes.handle);
        initAnnotationsSidecar();

        await expect(mocks.connector!.create()).resolves.toBe("connected");
        const ids = (JSON.parse(notes.read()) as { annotations: { id: string }[] }).annotations.map(({ id }) => id);
        expect(ids.sort()).toEqual(["local", "remote"]);
    });

    it("never attaches or overwrites a partially readable file", async () => {
        const partial = fakeNotesFile(payload([tripMeta("valid"), { id: "future", kind: "future" }], 1));
        mocks.openPicker.mockResolvedValue([partial.handle]);
        initAnnotationsSidecar();

        await expect(mocks.connector!.useExisting(true)).resolves.toBe("failed");
        expect(mocks.records.has("valid")).toBe(true);
        expect(mocks.setNotesFileHandle).not.toHaveBeenCalled();
        expect(partial.writes()).toBe(0);
    });

    it("writes every folder's annotations through the same handle", async () => {
        const notes = fakeNotesFile("");
        mocks.notesState = { id: "global", handle: notes.handle, access: "file" };
        mocks.records.set("a", tripMeta("a", "folder-a"));
        mocks.records.set("b", tripMeta("b", "folder-b"));
        initAnnotationsSidecar();

        mocks.annotationHook?.();
        await flushPendingSidecarWrites();

        const written = JSON.parse(notes.read()) as { annotations: { id: string; folderId?: string }[] };
        expect(written.annotations.map(({ id }) => id).sort()).toEqual(["a", "b"]);
        expect(written.annotations.every((record) => record.folderId === undefined)).toBe(true);
    });

    it("requests reconnection after the first queued write finds the file unreadable", async () => {
        const notes = fakeNotesFile(payload([], 2));
        const attention = vi.fn();
        mocks.notesState = { id: "global", handle: notes.handle, access: "file" };
        mocks.records.set("pending", tripMeta("pending", "folder-1", 200));
        initAnnotationsSidecar();
        registerNotesWriteAttentionHook(attention);
        notes.setReadFailure(true);

        mocks.annotationHook?.();
        await flushPendingSidecarWrites();

        expect(attention).toHaveBeenCalledOnce();
        await expect(mocks.connector!.status()).resolves.toEqual({
            state: "needsAttention",
            fileName: "notes.dashcamigo",
        });
    });

    it("reports a notes write outage once and reports a later outage after recovery", async () => {
        const capture = vi.spyOn(sentry, "captureSentryMessage");
        const notes = fakeNotesFile(payload([], 2));
        mocks.notesState = { id: "global", handle: notes.handle, access: "file" };
        mocks.records.set("pending", tripMeta("pending", "folder-1", 200));
        initAnnotationsSidecar();
        notes.setWriteFailure(new DOMException("private note contents", "UnknownError"));

        mocks.annotationHook?.();
        await flushPendingSidecarWrites();
        mocks.annotationHook?.();
        await flushPendingSidecarWrites();
        expect(capture).toHaveBeenCalledExactlyOnceWith("notes file write failed", {
            level: "error",
            fingerprint: ["notes_file_write_failed"],
            tags: { feature: "annotations", storage: "sidecar" },
        });

        notes.setWriteFailure(null);
        mocks.annotationHook?.();
        await flushPendingSidecarWrites();
        expect(notes.writes()).toBe(1);
        notes.setWriteFailure(new Error("another private note"));
        mocks.annotationHook?.();
        await flushPendingSidecarWrites();
        expect(capture).toHaveBeenCalledTimes(2);
        expect(JSON.stringify(capture.mock.calls)).not.toContain("private note");
    });

    it.each(["AbortError", "NotAllowedError", "SecurityError"])("keeps a notes write %s local", async (errorKind) => {
        const capture = vi.spyOn(sentry, "captureSentryMessage");
        const notes = fakeNotesFile(payload([], 2));
        mocks.notesState = { id: "global", handle: notes.handle, access: "file" };
        initAnnotationsSidecar();
        notes.setWriteFailure(new DOMException("unavailable", errorKind));

        mocks.annotationHook?.();
        await flushPendingSidecarWrites();
        expect(capture).not.toHaveBeenCalled();
        await expect(mocks.connector!.status()).resolves.toEqual({
            state: "needsAttention",
            fileName: "notes.dashcamigo",
        });
    });

    it("reports storage globally, without requiring a recording folder", async () => {
        initAnnotationsSidecar();
        await expect(annotationStorageState()).resolves.toMatchObject({ backupAction: "create" });
    });

    it("reports session-only storage when file pickers and browser persistence are unavailable", async () => {
        mocks.storeAvailable = false;
        vi.stubGlobal("window", { addEventListener: vi.fn(), setTimeout: globalThis.setTimeout.bind(globalThis) });

        initAnnotationsSidecar();

        expect(mocks.connector!.canSelectFile()).toBe(false);
        await expect(mocks.connector!.status()).resolves.toEqual({ state: "session" });
    });

    it("does not offer or invoke a non-callable save picker", async () => {
        Object.defineProperty(window, "showSaveFilePicker", { value: {} });
        initAnnotationsSidecar();

        expect(mocks.connector!.canSelectFile()).toBe(false);
        await expect(mocks.connector!.create()).resolves.toBe("failed");
        expect(mocks.savePicker).not.toHaveBeenCalled();
        expect(mocks.setNotesFileHandle).not.toHaveBeenCalled();
    });
});
