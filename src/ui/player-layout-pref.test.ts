import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Channel } from "../parsers/types.js";
import { finalizeTripFromFrames } from "../trips.js";
import { buildProvisionalCandidate } from "./ingest-candidate.js";
import {
    _resetForTests,
    cameraSetKey,
    persistCurrentArrangement,
    reconcileStoredArrangement,
    restoreArrangementForTrip,
    type StoredArrangement,
} from "./player-layout-pref.js";
import { defaultCompositionForChannels, state, updateComposition } from "./state.js";

const storage = new Map<string, string>();

beforeEach(() => {
    storage.clear();
    _resetForTests();
    vi.stubGlobal("localStorage", {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
        removeItem: (key: string) => storage.delete(key),
    });
});
afterEach(() => {
    vi.unstubAllGlobals();
    state.trips = [];
    state.active = null;
    state.composition = defaultCompositionForChannels(["front"]);
});

function arrangement(overrides: Partial<StoredArrangement> = {}): StoredArrangement {
    return {
        mode: "main",
        order: ["front", "rear"],
        hidden: [],
        thumbScale: null,
        allowOverlay: false,
        overlayPositions: {},
        ...overrides,
    };
}

function trip(channels: Channel[]) {
    const frameChannels: Partial<Record<Channel, ReturnType<typeof buildProvisionalCandidate>>> = {};
    for (const channel of channels) {
        const file = new File(["video"], `${channel}.mp4`);
        const candidate = buildProvisionalCandidate({
            file: { file, relativePath: file.name },
            fingerprint: "camera-a",
            startUtc: 1000,
            startSource: "mp4",
            cameraTzSec: null,
            durationSec: 10,
            records: [],
            appliedExtractors: [],
        });
        candidate.channel = channel;
        frameChannels[channel] = candidate;
    }
    return finalizeTripFromFrames([{ startUtc: 1000, durationSec: 10, wallDurationSec: 10, channels: frameChannels }]);
}

describe("cameraSetKey", () => {
    it("prefers fingerprints, sorted and de-duplicated", () => {
        expect(cameraSetKey(["b", "a", "b"], ["front", "rear"])).toBe("fp:a|b");
    });

    it("falls back to the channel set when no fingerprint is present", () => {
        expect(cameraSetKey([], ["rear", "front"])).toBe("ch:front|rear");
    });

    it("ignores empty fingerprints", () => {
        expect(cameraSetKey(["", ""], ["front"])).toBe("ch:front");
    });
});

describe("reconcileStoredArrangement", () => {
    const playable: Channel[] = ["front", "rear"];

    it("returns null without a stored entry or with a single camera", () => {
        expect(reconcileStoredArrangement(null, playable)).toBeNull();
        expect(reconcileStoredArrangement(arrangement(), ["front"])).toBeNull();
    });

    it("keeps a matching arrangement verbatim", () => {
        const stored = arrangement({
            mode: "equal",
            order: ["rear", "front"],
            hidden: ["front"],
            thumbScale: 0.4,
            allowOverlay: true,
            overlayPositions: { front: { x: 0.1, y: 0.2 } },
        });
        expect(reconcileStoredArrangement(stored, playable)).toEqual(stored);
    });

    it("drops a camera the trip no longer has", () => {
        const out = reconcileStoredArrangement(
            arrangement({
                order: ["interior", "rear", "front"],
                hidden: ["interior"],
                overlayPositions: { interior: { x: 0, y: 0 } },
            }),
            playable,
        );
        expect(out).toMatchObject({ order: ["rear", "front"], hidden: [], overlayPositions: {} });
    });

    it("appends a camera the entry does not know", () => {
        const out = reconcileStoredArrangement(arrangement({ order: ["rear", "front"] }), [
            "front",
            "rear",
            "interior",
        ]);
        expect(out?.order).toEqual(["rear", "front", "interior"]);
    });

    it("never restores every camera hidden", () => {
        const out = reconcileStoredArrangement(
            arrangement({ order: ["front", "rear", "interior"], hidden: ["front", "rear"] }),
            playable,
        );
        expect(out?.hidden).toEqual([]);
    });
});

describe("persisted arrangement", () => {
    it("writes the new key, drops the retired one unread and restores per camera set", () => {
        storage.set("everydashcam:player:layoutByCameraSet", JSON.stringify([{ key: "x", layout: "h2" }]));
        const active = trip(["front", "rear"]);
        state.trips = [active];
        state.active = { trip: 0, frame: 0 };
        state.composition = defaultCompositionForChannels(["front", "rear"]);
        updateComposition({ mode: "equal", order: ["rear", "front"], hidden: ["front"], thumbScale: 0.3 });
        persistCurrentArrangement();

        expect(storage.has("everydashcam:player:layoutByCameraSet")).toBe(false);
        expect(JSON.parse(storage.get("everydashcam:player:cameraArrangement")!)).toHaveLength(1);
        expect(restoreArrangementForTrip(active, ["front", "rear"])).toEqual({
            mode: "equal",
            order: ["rear", "front"],
            hidden: ["front"],
            thumbScale: 0.3,
            allowOverlay: false,
            overlayPositions: {},
        });
        expect(
            restoreArrangementForTrip(trip(["front", "rear", "interior"]), ["front", "rear", "interior"])?.order,
            "a third camera joins the same set",
        ).toEqual(["rear", "front", "interior"]);
    });

    it("skips malformed entries", () => {
        storage.set(
            "everydashcam:player:cameraArrangement",
            JSON.stringify([{ key: "fp:camera-a", mode: "grid", order: ["front"], hidden: [] }]),
        );
        expect(restoreArrangementForTrip(trip(["front", "rear"]), ["front", "rear"])).toBeNull();
    });
});
