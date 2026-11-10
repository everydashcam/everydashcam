import { beforeEach, describe, expect, it } from "vitest";
import { _resetForTests as resetLog, getLogBuffer } from "../log.js";
import {
    _resetForTests,
    admitImportBatch,
    canReloadWithoutAsking,
    claimImportGesture,
    ensureImportGestureClaimed,
    isRestartLocked,
    type LiveWork,
    restartLockReason,
    subscribeRestartLock,
    tryLockRestart,
    unlockRestart,
} from "./restart-gate.js";

const IDLE: LiveWork = { hasOpenTrips: false, isIngesting: false, isModalOpen: false };

function warnings(): string[] {
    return getLogBuffer()
        .filter((record) => record.ns === "restart-gate" && record.level === "warn")
        .map((record) => record.msg);
}

beforeEach(() => {
    _resetForTests();
    resetLog();
});

describe("import gate", () => {
    it("lets an import start and records it for good", () => {
        expect(canReloadWithoutAsking(IDLE), "fresh page").toBe(true);

        expect(claimImportGesture()).toBe(true);

        expect(canReloadWithoutAsking(IDLE), "after the gesture").toBe(false);
        expect(warnings()).toEqual([]);
    });

    it("refuses an import while a restart runs and leaves the page unmarked", () => {
        expect(tryLockRestart("auto")).toBe(true);

        expect(claimImportGesture()).toBe(false);

        unlockRestart();
        expect(canReloadWithoutAsking(IDLE)).toBe(true);
    });

    it("drops an import batch while a restart runs", () => {
        tryLockRestart("user");

        expect(admitImportBatch("ingestFiles")).toBe(false);

        expect(warnings()).toEqual(["import batch dropped during restart"]);
    });

    it("admits a batch after a claimed gesture without a warning", () => {
        claimImportGesture();

        expect(admitImportBatch("ingestFiles")).toBe(true);

        expect(warnings()).toEqual([]);
    });

    it("marks the page and warns when a batch arrives without a claimed gesture", () => {
        expect(admitImportBatch("ingestFiles")).toBe(true);

        expect(canReloadWithoutAsking(IDLE)).toBe(false);
        expect(warnings()).toEqual(["import started without a claimed gesture"]);
    });

    it("marks the page and warns when pre-ingest reading starts without a claimed gesture", () => {
        ensureImportGestureClaimed("beginPreIngestReading");
        ensureImportGestureClaimed("beginPreIngestReading");

        expect(canReloadWithoutAsking(IDLE)).toBe(false);
        expect(warnings(), "warns once; the flag is up afterwards").toEqual([
            "import started without a claimed gesture",
        ]);
    });
});

describe("restart lock", () => {
    it("is held by one restart at a time and reports its reason", () => {
        const changes: Array<string | null> = [];
        subscribeRestartLock((reason) => changes.push(reason));

        expect(tryLockRestart("user")).toBe(true);
        expect(tryLockRestart("auto"), "second restart").toBe(false);
        expect(restartLockReason()).toBe("user");
        unlockRestart();
        unlockRestart();

        expect(isRestartLocked()).toBe(false);
        expect(changes).toEqual(["user", null]);
    });
});

describe("reload without asking", () => {
    it("refuses with an open dialog", () => {
        expect(canReloadWithoutAsking({ ...IDLE, isModalOpen: true })).toBe(false);
        expect(warnings()).toEqual([]);
    });

    it("refuses and warns when trips are open without an import gesture", () => {
        expect(canReloadWithoutAsking({ ...IDLE, hasOpenTrips: true })).toBe(false);
        expect(warnings()).toEqual(["work found without an import gesture"]);
    });

    it("refuses and warns when an ingest runs without an import gesture", () => {
        expect(canReloadWithoutAsking({ ...IDLE, isIngesting: true })).toBe(false);
        expect(warnings()).toEqual(["work found without an import gesture"]);
    });
});
