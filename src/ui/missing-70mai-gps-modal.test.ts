import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ClassifiedFile } from "../parsers/registry-light.js";
import type { VendorFile } from "../parsers/types.js";
import type { VideoCandidate } from "../trips.js";
import { vendorFileKey } from "../vendor-file-key.js";

const mockDom = vi.hoisted(() => {
    const makeButton = () => {
        const listeners = new Map<string, Array<() => void>>();
        return {
            addEventListener(type: string, fn: () => void) {
                const list = listeners.get(type) ?? [];
                list.push(fn);
                listeners.set(type, list);
            },
            click() {
                for (const fn of listeners.get("click") ?? []) fn();
            },
            reset() {
                listeners.clear();
            },
        };
    };
    return {
        missing70maiGpsModal: { hidden: true },
        missing70maiGpsAddFiles: makeButton(),
        missing70maiGpsOpenCard: makeButton(),
        missing70maiGpsDismiss: makeButton(),
        sidebarCta: {},
    };
});

const modalHelper = vi.hoisted(() => ({
    isOpen: false,
    onClose: null as (() => void) | null,
    backdropClose: null as (() => void) | null,
    activateModal: vi.fn((_el: unknown, opts: { onClose: () => void }) => {
        modalHelper.onClose = opts.onClose;
    }),
    deactivateModal: vi.fn(() => {
        modalHelper.onClose = null;
    }),
    isAnyModalOpen: vi.fn(() => modalHelper.isOpen),
    wireBackdropDismiss: vi.fn((_el: unknown, onClose: () => void) => {
        modalHelper.backdropClose = onClose;
    }),
}));

// DOM roots and focus-trap wiring belong to the browser; the decision and
// modal lifecycle run directly in Node.
vi.mock("./dom.js", () => ({ dom: mockDom }));
vi.mock("./modal-helper.js", () => ({
    activateModal: modalHelper.activateModal,
    deactivateModal: modalHelper.deactivateModal,
    isAnyModalOpen: modalHelper.isAnyModalOpen,
    wireBackdropDismiss: modalHelper.wireBackdropDismiss,
}));

import {
    _resetForTests,
    hideMissing70maiGpsModal,
    initMissing70maiGpsModal,
    is70maiGpsLog,
    maybeShowMissing70maiGps,
} from "./missing-70mai-gps-modal.js";
import { state } from "./state.js";

const originalDocument = globalThis.document;
const mockDocument = {
    activeElement: null as unknown,
    body: {},
    fullscreenElement: null as unknown,
    querySelector: vi.fn(() => null as unknown),
};

function makeFile(relativePath: string, sourceKey = "drop:1"): VendorFile {
    const name = relativePath.split(/[\\/]/).pop() ?? relativePath;
    return {
        file: new File(["x"], name, { lastModified: 1 }),
        relativePath,
        sourceKey,
    };
}

function makeCandidate(
    relativePath = "A500S/Normal/Front/NO20260101-120000-000001F.MP4",
    overrides: Partial<VideoCandidate> = {},
): VideoCandidate {
    const vf = makeFile(relativePath, overrides.sourceKey ?? "drop:1");
    return {
        ...vf,
        fingerprint: "70mai|A500S|NO#-#-#.MP#",
        appliedExtractors: [],
        classifierMatches: { time: null, channel: null, mode: null, sequence: null },
        channel: "front",
        channelConfident: true,
        sequence: null,
        recordingMode: "normal",
        isTimelapse: false,
        startUtc: 1767268800,
        durationSec: 60,
        wallDurationSec: null,
        driftLeadSec: null,
        startSource: "name",
        cameraTzSec: null,
        createdUtc: null,
        records: [],
        codec: "avc",
        codecParam: "avc1",
        videoCodecString: null,
        rotation: 0,
        width: 1920,
        height: 1080,
        fps: 30,
        audio: null,
        canPlay: true,
        metadataReady: true,
        needsHevcRemux: false,
        isTransportStream: false,
        isMatroska: false,
        audioNeedsTranscode: false,
        embeddedStartUtcHint: null,
        localClockOffsetHintSec: null,
        ...overrides,
    };
}

beforeEach(() => {
    _resetForTests();
    mockDom.missing70maiGpsModal.hidden = true;
    mockDom.missing70maiGpsAddFiles.reset();
    mockDom.missing70maiGpsOpenCard.reset();
    mockDom.missing70maiGpsDismiss.reset();
    modalHelper.isOpen = false;
    modalHelper.onClose = null;
    modalHelper.backdropClose = null;
    modalHelper.activateModal.mockClear();
    modalHelper.deactivateModal.mockClear();
    modalHelper.isAnyModalOpen.mockClear();
    modalHelper.wireBackdropDismiss.mockClear();
    state.exportModeOpen = false;
    state.transcodeInProgress = false;
    state.pendingHeavyEmbeddedGps.clear();
    state.inflightEmbeddedGps.clear();
    state.failedEmbeddedGps.clear();
    mockDocument.activeElement = mockDocument.body;
    mockDocument.fullscreenElement = null;
    mockDocument.querySelector.mockReset().mockReturnValue(null);
    Object.defineProperty(globalThis, "document", { value: mockDocument, configurable: true });
});

afterEach(() => {
    state.exportModeOpen = false;
    state.transcodeInProgress = false;
    state.pendingHeavyEmbeddedGps.clear();
    state.inflightEmbeddedGps.clear();
    state.failedEmbeddedGps.clear();
    Object.defineProperty(globalThis, "document", { value: originalDocument, configurable: true });
});

describe("is70maiGpsLog", () => {
    function classified(name: string, logExtractorId: string | null = null): ClassifiedFile {
        return {
            file: makeFile(name),
            role: logExtractorId ? "gps-log" : "unknown",
            sidecarId: null,
            sidecarMp4: null,
            logExtractorId,
        };
    }

    it("matches GPSData*.txt by filename and recognized 70mai CSV extractors", () => {
        expect(is70maiGpsLog(classified("GPSData000001.txt"))).toBe(true);
        expect(is70maiGpsLog(classified("gpsdata.TXT"))).toBe(true);
        expect(is70maiGpsLog(classified("renamed.txt", "csv-70mai"))).toBe(true);
        expect(is70maiGpsLog(classified("renamed.txt", "csv-70mai-dated"))).toBe(true);
        expect(is70maiGpsLog(classified("notes.txt"))).toBe(false);
        expect(is70maiGpsLog(classified("other.txt", "daily-csv-gps"))).toBe(false);
    });
});

describe("maybeShowMissing70maiGps", () => {
    it("opens once for an imported 70mai front clip with no GPS or covering log", () => {
        const clip = makeCandidate();

        expect(maybeShowMissing70maiGps([clip], [clip], [])).toBe(true);
        expect(mockDom.missing70maiGpsModal.hidden).toBe(false);
        expect(modalHelper.activateModal).toHaveBeenCalledOnce();

        hideMissing70maiGpsModal();
        expect(maybeShowMissing70maiGps([clip], [clip], [])).toBe(false);
    });

    it("stays closed when a log covers the recording root, including hidden .GPS folders", () => {
        const clip = makeCandidate("A500S/Normal/Front/NO20260101-120000-000001F.MP4");
        expect(maybeShowMissing70maiGps([clip], [clip], [makeFile("A500S/GPSData000001.txt")])).toBe(false);
        expect(maybeShowMissing70maiGps([clip], [clip], [makeFile("A500S/.GPS/GPSData000001.txt")])).toBe(false);
        expect(maybeShowMissing70maiGps([clip], [clip], [makeFile(".GPS/GPSData000001.txt")])).toBe(false);
        expect(maybeShowMissing70maiGps([clip], [clip], [makeFile("A500S\\Normal\\GPSData.txt")])).toBe(false);
    });

    it("ignores logs from another source or sibling directory", () => {
        const clip = makeCandidate("A500S/Normal/Front/NO20260101-120000-000001F.MP4", { sourceKey: "drop:1" });
        const otherCard = makeFile("A500S/GPSData000001.txt", "drop:2");
        const siblingDir = makeFile("A500S-other/GPSData000001.txt", "drop:1");

        expect(maybeShowMissing70maiGps([clip], [clip], [otherCard, siblingDir])).toBe(true);
    });

    it("stays closed when the same camera already has GPS or unfinished/failed embedded checks", () => {
        const clip = makeCandidate("A500S/Normal/Front/NO20260101-120000-000001F.MP4");
        const sibling = makeCandidate("A500S/Normal/Front/NO20260101-120002-000002F.MP4");
        const siblingKey = vendorFileKey(sibling);

        const withRecord = { ...sibling, records: [{} as VideoCandidate["records"][number]] };
        expect(maybeShowMissing70maiGps([clip, withRecord], [clip], [])).toBe(false);

        state.pendingHeavyEmbeddedGps.set(siblingKey, {} as ClassifiedFile);
        expect(maybeShowMissing70maiGps([clip, sibling], [clip], [])).toBe(false);
        state.pendingHeavyEmbeddedGps.clear();

        state.inflightEmbeddedGps.set(siblingKey, 1);
        expect(maybeShowMissing70maiGps([clip, sibling], [clip], [])).toBe(false);
        state.inflightEmbeddedGps.clear();

        state.failedEmbeddedGps.add(siblingKey);
        expect(maybeShowMissing70maiGps([clip, sibling], [clip], [])).toBe(false);
    });

    it("skips non-70mai, rear-only, timelapse, unready, and previously imported clips", () => {
        const non70mai = makeCandidate("clip.mp4", { fingerprint: "generic|clip.mp#" });
        const rear = makeCandidate("A500S/Normal/Back/NO20260101-120000-000001B.MP4", { channel: "rear" });
        const timelapse = makeCandidate("A500S/Parking/Front/PA20260101-120000-000001F.MP4", { isTimelapse: true });
        const unready = makeCandidate("A500S/Normal/Front/NO20260101-120002-000002F.MP4", { metadataReady: false });
        const oldClip = makeCandidate("A500S/Normal/Front/NO20260101-120004-000003F.MP4");

        expect(
            maybeShowMissing70maiGps(
                [non70mai, rear, timelapse, unready, oldClip],
                [non70mai, rear, timelapse, unready],
                [],
            ),
        ).toBe(false);
    });

    it("stays closed when another modal, export mode, transcode, or fullscreen is active", () => {
        const clip = makeCandidate();

        modalHelper.isOpen = true;
        expect(maybeShowMissing70maiGps([clip], [clip], [])).toBe(false);
        modalHelper.isOpen = false;

        state.exportModeOpen = true;
        expect(maybeShowMissing70maiGps([clip], [clip], [])).toBe(false);
        state.exportModeOpen = false;

        state.transcodeInProgress = true;
        expect(maybeShowMissing70maiGps([clip], [clip], [])).toBe(false);
        state.transcodeInProgress = false;

        mockDocument.fullscreenElement = {};
        expect(maybeShowMissing70maiGps([clip], [clip], [])).toBe(false);
        mockDocument.fullscreenElement = null;

        mockDocument.querySelector.mockReturnValue({});
        expect(maybeShowMissing70maiGps([clip], [clip], [])).toBe(false);
    });

    it("runs onDismiss on user dismissal but not when a new ingest hides the modal", () => {
        initMissing70maiGpsModal(vi.fn(), vi.fn());
        const clip = makeCandidate();
        const onDismiss = vi.fn();

        expect(maybeShowMissing70maiGps([clip], [clip], [], onDismiss)).toBe(true);
        mockDom.missing70maiGpsDismiss.click();
        expect(mockDom.missing70maiGpsModal.hidden).toBe(true);
        expect(onDismiss).toHaveBeenCalledOnce();

        _resetForTests();
        const onIngestDismiss = vi.fn();
        expect(maybeShowMissing70maiGps([clip], [clip], [], onIngestDismiss)).toBe(true);
        hideMissing70maiGpsModal();
        expect(mockDom.missing70maiGpsModal.hidden).toBe(true);
        expect(onIngestDismiss).not.toHaveBeenCalled();
    });
});
