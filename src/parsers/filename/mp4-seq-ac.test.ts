import { describe, expect, it } from "vitest";

import { groupTrips, tripAllCandidates, tripCandidatesByChannel } from "../../trips.js";
import { buildProvisionalCandidate } from "../../ui/ingest-candidate.js";
import { cameraFingerprint } from "../camera-fingerprint.js";
import { classifyGpsSource, shouldTryEmbeddedGps } from "../gps-source-hints.js";
import type { VendorFile } from "../types.js";
import { RX_MP4_SEQ_AC } from "./_patterns.js";
import {
    classifyFilenameTime,
    matchFilenameChannel,
    matchFilenameMode,
    matchFilenameSequence,
    matchFilenameTime,
} from "./index.js";

function fileAt(path: string): VendorFile {
    return { file: new File([], path.split("/").at(-1)!), relativePath: path };
}

// Original front/rear filenames from the author's labeled WonVon W4K pair:
// https://dashcamtalk.com/forum/threads/wonvon-w4k.43180/ (post #3).
const FRONT = "20200927182649_0000015A.MP4";
const REAR = "20200927182649_0000016C.MP4";

describe("seven-digit MP4 sequence with A/C channels", () => {
    it.each([
        [FRONT, "front", 15],
        [REAR, "rear", 16],
    ] as const)("extracts the verified local clock, channel and counter from %s", (name, channel, sequence) => {
        const file = fileAt(name);
        expect(matchFilenameTime(file)).toEqual({
            matchedId: "mp4-seq-ac-time",
            value: new Date(Date.UTC(2020, 8, 27, 18, 26, 49)),
        });
        expect(matchFilenameChannel(file)).toEqual({
            matchedId: "mp4-seq-ac-channel",
            value: { channel, confident: true },
        });
        expect(matchFilenameSequence(file)).toEqual({ matchedId: "mp4-seq-ac-sequence", value: sequence });
        expect(matchFilenameMode(file)).toEqual({ matchedId: null, value: null });
    });

    it("pairs the real front and rear names despite their different counters", () => {
        const files = [FRONT, REAR].map((name) => fileAt(`card/${name}`));
        expect(cameraFingerprint(files[0]!)).toBe(cameraFingerprint(files[1]!));
        const candidates = files.map((file) =>
            buildProvisionalCandidate({
                file,
                fingerprint: cameraFingerprint(file),
                startUtc: classifyFilenameTime(file)!.getTime() / 1000,
                startSource: "name",
                cameraTzSec: null,
                durationSec: 60,
                records: [],
                appliedExtractors: [],
            }),
        );
        const trips = groupTrips(candidates);
        expect(trips).toHaveLength(1);
        const trip = trips[0]!;
        expect(tripAllCandidates(trip)).toHaveLength(2);
        expect(tripCandidatesByChannel(trip, "front")).toHaveLength(1);
        expect(tripCandidatesByChannel(trip, "rear")).toHaveLength(1);
        expect(trip.confidentChannels).toEqual(new Set(["front", "rear"]));
    });

    it("keeps separate camera roots including roots named A and C", () => {
        const keys = ["camera-a", "camera-b", "A", "C"].map((root) => cameraFingerprint(fileAt(`${root}/${FRONT}`)));
        expect(new Set(keys).size).toBe(keys.length);
    });

    it("accepts case variants and keeps other channel letters usable without certainty", () => {
        expect(matchFilenameChannel(fileAt(REAR.toLowerCase())).value).toEqual({ channel: "rear", confident: true });
        const unknown = fileAt("20200927182649_0000017X.MP4");
        expect(matchFilenameChannel(unknown).value).toEqual({ channel: "side", confident: false });
        expect(cameraFingerprint(unknown)).toBe(cameraFingerprint(fileAt(FRONT)));
        expect(matchFilenameSequence(unknown).value).toBe(17);
        expect(matchFilenameTime(unknown).value).not.toBeNull();
        expect(classifyGpsSource(unknown)).toBe("embedded");
        expect(shouldTryEmbeddedGps(unknown, false)).toBe(true);
    });

    it.each([
        ["F", "front"],
        ["R", "rear"],
        ["I", "interior"],
    ] as const)("uses %s as an uncertain mnemonic channel", (letter, channel) => {
        const file = fileAt(`20200927182649_0000017${letter}.MP4`);
        expect(matchFilenameChannel(file).value).toEqual({ channel, confident: false });
        expect(cameraFingerprint(file)).toBe(cameraFingerprint(fileAt(FRONT)));
        expect(shouldTryEmbeddedGps(file, false)).toBe(true);
    });

    it.each(["20200230182649_0000015A.MP4", "20200927242649_0000015A.MP4"])(
        "rejects an impossible local calendar clock in %s",
        (name) => expect(matchFilenameTime(fileAt(name)).value).toBeNull(),
    );

    it.each([
        "20200927182649_000015A.MP4",
        "20200927182649_00000015A.MP4",
        "20200927182649_0000015.MP4",
        "20200927182649_0000015_A.MP4",
        "20200927182649_0000015AA.MP4",
        "20200927182649_0000015A.MOV",
        "20200927182649_0000015A.TS",
    ])("leaves neighboring filename shape %s outside this family", (name) => {
        expect(RX_MP4_SEQ_AC.test(name)).toBe(false);
        expect(matchFilenameChannel(fileAt(name)).matchedId).not.toBe("mp4-seq-ac-channel");
    });

    it("preserves neighboring families' channel and mode rules", () => {
        expect(matchFilenameChannel(fileAt("20200927182649_0000015I.MOV")).value).toEqual({
            channel: "interior",
            confident: true,
        });
        expect(matchFilenameChannel(fileAt("20200927182649_0000015R.TS")).value).toEqual({
            channel: "rear",
            confident: true,
        });
        const redtiger = fileAt("20200927182649_000015F.MP4");
        expect(matchFilenameChannel(redtiger).matchedId).toBe("redtiger-channel");
        expect(matchFilenameMode(redtiger).value).toBe("normal");
        expect(matchFilenameTime(fileAt("20200927182649_0000015.MP4")).matchedId).toBe("ddpai-time");
    });
});
