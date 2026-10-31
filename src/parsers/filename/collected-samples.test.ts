import { describe, expect, it } from "vitest";
import { groupTrips, tripAllCandidates } from "../../trips.js";
import { buildProvisionalCandidate } from "../../ui/ingest-candidate.js";
import { cameraFingerprint } from "../camera-fingerprint.js";
import { shouldTryEmbeddedGps } from "../gps-source-hints.js";
import type { VendorFile } from "../types.js";
import {
    classifyFilenameChannel,
    classifyFilenameMode,
    classifyFilenameSequence,
    classifyFilenameTime,
    classifyFilenameTimelapse,
} from "./index.js";

function vf(path: string): VendorFile {
    return { file: new File([], path.split("/").at(-1)!), relativePath: path };
}

describe("collected recording filenames", () => {
    it.each(["vantrue-n2s-dzien-front.MP4", "vantrue-n2s-dzien-wnetrze.MP4", "vantrue-n2s-noc-front.MP4", "day-a.MP4"])(
        "leaves descriptive review filename %s unclassified while allowing embedded GPS",
        (name) => {
            const file = vf(name);
            expect(classifyFilenameChannel(file)).toBeNull();
            expect(classifyFilenameTime(file)).toBeNull();
            expect(classifyFilenameMode(file)).toBeNull();
            expect(classifyFilenameSequence(file)).toBeNull();
            expect(shouldTryEmbeddedGps(file, false)).toBe(true);
        },
    );

    it.each(["20240812_125341F.MOV", "20241218_095819F.MOV"])(
        "recognizes the Type S MOV clock and front channel in %s",
        (name) => {
            const file = vf(name);
            expect(classifyFilenameChannel(file)).toEqual({ channel: "front", confident: true });
            expect(classifyFilenameTime(file)).not.toBeNull();
            expect(shouldTryEmbeddedGps(file, false)).toBe(true);
            const rear = vf(name.replace("F.MOV", "R.mov"));
            const unknown = vf(name.replace("F.MOV", "X.MOV"));
            expect(classifyFilenameChannel(rear)).toEqual({ channel: "rear", confident: true });
            expect(classifyFilenameChannel(unknown)).toEqual({ channel: "side", confident: false });
            expect(cameraFingerprint(file)).toBe(cameraFingerprint(rear));
            expect(cameraFingerprint(file)).toBe(cameraFingerprint(unknown));
            expect(cameraFingerprint(file)).not.toBe(cameraFingerprint(vf(name.replace(".MOV", ".mp4"))));
        },
    );

    it("reads the documented FineVu clock and stream tokens without inferring a recording mode", () => {
        const file = vf("20200830-17h11m13s_FR_N.mp4");
        expect(classifyFilenameTime(file)?.toISOString()).toBe("2020-08-30T17:11:13.000Z");
        expect(classifyFilenameMode(file)).toBeNull();
        expect(classifyFilenameChannel(file)).toBeNull();
        const other = vf("20200830-17h36m08s_FR_N.mp4");
        expect(classifyFilenameTime(other)?.toISOString()).toBe("2020-08-30T17:36:08.000Z");
        expect(cameraFingerprint(other)).toBe(cameraFingerprint(file));
        const front = vf("20230921-11h17m59s_FO_N.mp4");
        const rear = vf("20230921-11h17m59s_OR_N.mp4");
        expect(classifyFilenameChannel(front)).toEqual({ channel: "front", confident: true });
        expect(classifyFilenameChannel(rear)).toEqual({ channel: "rear", confident: true });
        expect(cameraFingerprint(front)).toBe(cameraFingerprint(rear));
        expect(cameraFingerprint(front)).not.toBe(cameraFingerprint(file));
        for (const mode of ["N", "E", "P", "X"]) {
            expect(classifyFilenameMode(vf(`20230921-11h17m59s_FO_${mode}.mp4`))).toBeNull();
        }
        const unknown = vf("20230921_11h17m59s_XY_N.mp4");
        expect(classifyFilenameTime(unknown)?.toISOString()).toBe("2023-09-21T11:17:59.000Z");
        expect(classifyFilenameChannel(unknown)).toBeNull();
        expect(cameraFingerprint(unknown)).not.toBe(cameraFingerprint(front));
        expect(classifyFilenameTime(vf("20200230-17h11m13s_FR_N.mp4"))).toBeNull();
        expect(classifyFilenameTime(vf("20200830-25h11m13s_FR_N.mp4"))).toBeNull();
        expect(classifyFilenameMode(vf("20200830-17h11m13s_FR_X.mp4"))).toBeNull();
        expect(shouldTryEmbeddedGps(file, false)).toBe(true);
    });

    it("keeps Garmin's counter separate from time and uses only the adjacent card mode folder", () => {
        expect(classifyFilenameSequence(vf("GRMN0240.MP4"))).toBe(240);
        expect(classifyFilenameTime(vf("GRMN0240.MP4"))).toBeNull();
        expect(classifyFilenameMode(vf("GRMN0240.MP4"))).toBeNull();
        const folders = [
            "100EVENT",
            "102SAVED",
            "103PARKM",
            "104TLPSE",
            "104UNSVD",
            "105UNSVD",
            "101SAVED",
            "203PARKM",
            "105TLPSE",
        ];
        const files = folders.map((folder) => vf(`card/DCIM/${folder}/GRMN0240.MP4`));
        expect(files.map(classifyFilenameMode)).toEqual([
            "event",
            "manual",
            "parking",
            "normal",
            "normal",
            "normal",
            "manual",
            "parking",
            "normal",
        ]);
        expect(files.map(classifyFilenameTimelapse)).toEqual([
            false,
            false,
            false,
            true,
            false,
            false,
            false,
            false,
            true,
        ]);
        expect(new Set(files.map(cameraFingerprint)).size).toBe(1);
        expect(classifyFilenameMode(vf("card/DCIM/100EVENT/archive/GRMN0240.MP4"))).toBeNull();
        expect(classifyFilenameSequence(vf("GRMN9007199254740992.MP4"))).toBeNull();
        expect(cameraFingerprint(files[0]!)).not.toBe(cameraFingerprint(vf("other/DCIM/100EVENT/GRMN0240.MP4")));
        expect(classifyFilenameMode(vf("card/DCIM/101SAVED/clip.mp4"))).toBeNull();
        expect(classifyFilenameMode(vf("card/DCIM/101SAVED-extra/GRMN0240.MP4"))).toBeNull();
    });

    it("keeps Kaiser duration suffixes and event folders out of sequence and camera identity", () => {
        const normal = vf("card/DCIM/100video/20240113175633_163.MP4");
        const event = vf("card/DCIM/101video/20240113175916_10.MP4");
        expect(classifyFilenameMode(normal)).toBe("normal");
        expect(classifyFilenameMode(event)).toBe("event");
        expect(classifyFilenameSequence(normal)).toBeNull();
        expect(classifyFilenameSequence(event)).toBeNull();
        expect(cameraFingerprint(normal)).toBe(cameraFingerprint(event));
        const shortEvent = vf("card/DCIM/101video/20240113175916_1.MP4");
        expect(classifyFilenameMode(shortEvent)).toBe("event");
        expect(classifyFilenameSequence(shortEvent)).toBeNull();
        expect(classifyFilenameChannel(shortEvent)).toEqual({ channel: "front", confident: false });
        expect(cameraFingerprint(normal)).toBe(cameraFingerprint(shortEvent));
        expect(cameraFingerprint(normal)).not.toBe(cameraFingerprint(vf("other/DCIM/100video/20240113175633_163.MP4")));
        expect(classifyFilenameSequence(vf("20240113175633_163.MP4"))).toBe(163);
        const ddpaiFront = vf("DCIM/100video/20190719161640_0060.mp4");
        const ddpaiRear = vf("DCIM/100video/20190719161640_0060_A.mp4");
        expect(cameraFingerprint(ddpaiFront)).toBe(cameraFingerprint(ddpaiRear));
        expect(classifyFilenameSequence(ddpaiFront)).toBe(60);
        const unpaddedFront = vf("DCIM/100video/20190719161640_60.mp4");
        const unpaddedRear = vf("DCIM/100video/20190719161640_60_A.mp4");
        expect(cameraFingerprint(unpaddedFront)).toBe(cameraFingerprint(unpaddedRear));
    });

    it.each(["DCIM/100video", "DCIM/101video", "100video", "101video"])(
        "keeps unpadded DDPai siblings together in %s",
        (folder) => {
            const files = ["20190719161640_60.mp4", "20190719161640_60_A.mp4"].map((name) =>
                vf(`card/${folder}/${name}`),
            );
            expect(new Set(files.map(cameraFingerprint)).size).toBe(1);
            expect(files.map(classifyFilenameMode)).toEqual(
                folder.endsWith("101video") ? ["event", "event"] : ["normal", "normal"],
            );
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
            expect(Object.keys(trips[0]!.frames[0]!.channels).sort()).toEqual(["front", "rear"]);
        },
    );

    it.each([
        ["Vantrue S1 Pro Max", ["20250617_133014_00031_N_A.MP4", "20250617_133014_00031_N_B.MP4"]],
        ["Mikavi PQ6", ["20210913120104_0000574A.MP4", "20210913120104_0000575B.MP4", "20210913120104_0000576C.MP4"]],
    ])("groups the collected %s channels into one recording", (_model, names) => {
        const files = names.map((name) => vf(`card/${name}`));
        expect(new Set(files.map(cameraFingerprint)).size).toBe(1);
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
        expect(tripAllCandidates(trips[0]!)).toHaveLength(names.length);
        expect(new Set(candidates.map((candidate) => candidate.channel)).size).toBe(names.length);
        expect(classifyFilenameChannel(files[1]!)?.confident).toBe(false);
    });
});
