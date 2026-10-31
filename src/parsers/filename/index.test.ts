// Smoke tests for the per-field filename walks.
// Specific-pattern correctness is exercised by the higher-level
// pipeline / fixture tests; here we just verify the walk picks the right
// technique by matchedId and that classify* shortcuts return the value.

import { describe, expect, it } from "vitest";

import { cameraFingerprint } from "../camera-fingerprint.js";
import type { VendorFile } from "../types.js";
import {
    RX_70MAI,
    RX_DDPAI_NORMAL,
    RX_E_ACE,
    RX_FITCAMX_MP4,
    RX_FORD,
    RX_HPIM,
    RX_LIGOGPS_TRAILER_TS,
    RX_MIVUE,
    RX_MOV_SEQ_FRI,
    RX_NAVITEL,
    RX_NEOLINE,
    RX_NOVATEK_NVT_MOV,
    RX_REC_SINGLE,
    RX_REDTIGER,
    RX_VUEROID,
    mai70NameCore,
} from "./_patterns.js";
import {
    classifyFilenameChannel,
    classifyFilenameClockTimelapse,
    classifyFilenameMode,
    classifyFilenameSequence,
    classifyFilenameTime,
    classifyFilenameTimelapse,
    matchFilenameChannel,
    matchFilenameMode,
    matchFilenameSequence,
    matchFilenameTime,
} from "./index.js";

function vf(name: string, relativePath: string = name): VendorFile {
    return { file: new File([new Uint8Array(0)], name), relativePath };
}

describe("date-sequence-cam filenames", () => {
    it.each([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])("recognizes CAM%s and uses the folder for its mount", (index) => {
        const name = `20260923_0134_CAM${index}.MP4`;
        const file = vf(name, `card/Normal_Front/${name}`);
        expect(classifyFilenameSequence(file)).toBe(134);
        expect(classifyFilenameTime(file)).toBeNull();
        expect(classifyFilenameChannel(file)).toEqual({ channel: "front", confident: true });
        expect(classifyFilenameMode(file)).toBe("normal");
        expect(cameraFingerprint(file)).toBe(
            cameraFingerprint(vf("20260923_0134_CAM1.MP4", "card/Normal_Front/20260923_0134_CAM1.MP4")),
        );
    });

    it("preserves unknown channel indices without inventing mounts or merging their streams", () => {
        const fingerprints = [0, 3, 4, 5, 6, 7, 8, 9].map((index) => {
            const file = vf(`20260923_0134_CAM${index}.MP4`);
            const next = vf(`20260923_0135_CAM${index}.MP4`);
            expect(classifyFilenameChannel(file)).toBeNull();
            expect(cameraFingerprint(file)).toBe(cameraFingerprint(next));
            expect(cameraFingerprint(file)).not.toBe(cameraFingerprint(vf("20260923_0134_CAM1.MP4")));
            return cameraFingerprint(file);
        });
        expect(new Set(fingerprints).size).toBe(fingerprints.length);
    });

    it.each(["CAM10", "CAMA"])("does not claim the unsupported %s suffix", (suffix) => {
        const file = vf(`20260923_0134_${suffix}.MP4`, `Normal_Front/20260923_0134_${suffix}.MP4`);
        expect(classifyFilenameSequence(file)).toBeNull();
        expect(classifyFilenameChannel(file)).toBeNull();
        expect(classifyFilenameMode(file)).toBeNull();
    });

    it.each(["0060", "0134", "2359"])("reads %s as a sequence without inventing a clock", (counter) => {
        const file = vf(`20260923_${counter}_CAM1.MP4`, `card/Normal_Front/20260923_${counter}_CAM1.MP4`);
        expect(matchFilenameTime(file)).toEqual({ value: null, matchedId: null });
        expect(matchFilenameSequence(file)).toEqual({
            value: Number(counter),
            matchedId: "date-sequence-cam-sequence",
        });
        expect(matchFilenameChannel(file)).toEqual({
            value: { channel: "front", confident: true },
            matchedId: "date-sequence-cam-channel",
        });
        expect(matchFilenameMode(file)).toEqual({ value: "normal", matchedId: "date-sequence-cam-mode" });
    });

    it("keeps channels and modes in one camera key while preserving enclosing camera roots", () => {
        const roots = ["card", "card/Front", "card/Rear", "card/Normal_Front"];
        const fingerprints = roots.map((root) => {
            const front = vf("20260923_0134_CAM1.MP4", `${root}/Normal_Front/20260923_0134_CAM1.MP4`);
            const rear = vf("20260923_0135_CAM2.MP4", `${root}/Event_Rear/20260923_0135_CAM2.MP4`);
            expect(cameraFingerprint(front)).toBe(cameraFingerprint(rear));
            expect(classifyFilenameMode(rear)).toBe("event");
            expect(classifyFilenameChannel(rear)).toEqual({ channel: "rear", confident: true });
            return cameraFingerprint(front);
        });
        expect(new Set(fingerprints).size).toBe(roots.length);
    });

    it("recognizes a flat CAM1 file without guessing a recording mode", () => {
        const file = vf("20260923_0134_cam1.mp4");
        expect(classifyFilenameChannel(file)).toEqual({ channel: "front", confident: true });
        expect(classifyFilenameMode(file)).toBeNull();
        expect(classifyFilenameChannel(vf("20260923_0134_CAM2.MP4"))).toEqual({ channel: "rear", confident: false });
    });

    it("leaves unnumbered CAM clocks and unrelated folder contents unchanged", () => {
        const legacy = vf("20260511_0016_CAM.MP4");
        expect(matchFilenameTime(legacy).matchedId).toBe("escort-time");
        expect(classifyFilenameSequence(legacy)).toBeNull();
        const other = vf("random.mp4", "Normal_Front/random.mp4");
        expect(classifyFilenameChannel(other)).toBeNull();
        expect(classifyFilenameMode(other)).toBeNull();
    });
});

describe("matchFilenameTime", () => {
    it("70mai-time wins on NO-prefix", () => {
        const r = matchFilenameTime(vf("NO20240429-182640F.MP4"));
        expect(r.matchedId).toBe("70mai-time");
        expect(r.value?.getUTCFullYear()).toBe(2024);
        expect(r.value?.getUTCMonth()).toBe(3); // April
        expect(r.value?.getUTCDate()).toBe(29);
    });

    it("blackvue-time on YYYYMMDD_HHMMSS_NF pattern", () => {
        const r = matchFilenameTime(vf("20211011_141314_NF.mp4"));
        expect(r.matchedId).toBe("blackvue-time");
        expect(r.value?.getUTCHours()).toBe(14);
    });

    it("generic-datetime is the last fallback", () => {
        // Filename that matches no specific family but contains a datetime token.
        const r = matchFilenameTime(vf("clip-2024-04-29-18-26-40.bin"));
        expect(r.matchedId).toBe("generic-datetime");
    });

    it("rejects impossible calendar dates instead of rolling them into March", () => {
        const r = matchFilenameTime(vf("20260231_120000_NF.mp4"));
        expect(r.value).toBeNull();
        expect(r.matchedId).toBeNull();
    });

    it("null + null matchedId for unrecognised name", () => {
        const r = matchFilenameTime(vf("random.bin"));
        expect(r.value).toBeNull();
        expect(r.matchedId).toBeNull();
    });
});

describe("matchFilenameChannel", () => {
    it("70mai F suffix -> front, confident (vendor-specific mnemonic)", () => {
        const r = matchFilenameChannel(vf("NO20240429-182640F.MP4"));
        expect(r.matchedId).toBe("70mai-channel");
        expect(r.value).toEqual({ channel: "front", confident: true });
    });

    it("70mai B suffix -> rear (B=rear is 70mai mapping), confident", () => {
        const r = matchFilenameChannel(vf("NO20240429-182640B.MP4"));
        expect(r.value).toEqual({ channel: "rear", confident: true });
    });

    it("Carcam A suffix -> front but NOT confident (index letter, vendor convention)", () => {
        const r = matchFilenameChannel(vf("REC20250607-180617-527-A.mp4"));
        expect(r.matchedId).toBe("carcam-channel");
        expect(r.value).toEqual({ channel: "front", confident: false });
    });

    it("Carcam D suffix -> side, not confident", () => {
        expect(matchFilenameChannel(vf("REC20250607-180617-527-D.mp4")).value).toEqual({
            channel: "side",
            confident: false,
        });
    });

    it("Carcam path Normal/A -> front, confident (named folder is a deliberate signal)", () => {
        // Unknown filename, so the unscoped path fallback decides.
        const r = matchFilenameChannel(vf("clip.mp4", "Normal/A/clip.mp4"));
        expect(r.matchedId).toBe("carcam-channel");
        expect(r.value).toEqual({ channel: "front", confident: true });
    });

    it("SStar CH1/CH2/CH3 -> front/rear/interior, NOT confident (index, mount is a guess)", () => {
        const c1 = matchFilenameChannel(vf("CH1-20260618-130336.TS"));
        expect(c1.matchedId).toBe("sstar-chn-channel");
        expect(c1.value).toEqual({ channel: "front", confident: false });
        expect(matchFilenameChannel(vf("CH2-20260618-130336.TS")).value).toEqual({ channel: "rear", confident: false });
        expect(matchFilenameChannel(vf("CH3-20260618-130336.TS")).value).toEqual({
            channel: "interior",
            confident: false,
        });
    });

    it("SStar CHn negative: a plain digit-prefixed .ts is not claimed (disjoint from novatek-ts/juscar)", () => {
        expect(matchFilenameChannel(vf("20260618130336_000001.ts")).matchedId).toBeNull();
        expect(matchFilenameChannel(vf("20260618_130336F.ts")).matchedId).toBe("juscar-channel");
    });

    it("Vantrue B -> interior but NOT confident (B=cabin, index letter)", () => {
        const r = matchFilenameChannel(vf("20250607_180617_0001_N_B.mp4"));
        expect(r.matchedId).toBe("novatek-vantrue-channel");
        expect(r.value).toEqual({ channel: "interior", confident: false });
    });

    it("Tesla path -> confident (camera spelled out)", () => {
        const r = matchFilenameChannel(
            vf("2025-06-07_18-06-17-back.mp4", "TeslaCam/RecentClips/2025-06-07_18-06-17-back.mp4"),
        );
        expect(r.matchedId).toBe("tesla-channel");
        expect(r.value).toEqual({ channel: "rear", confident: true });
    });
});

describe("matchFilenameMode", () => {
    it("blackvue N letter -> normal", () => {
        const r = matchFilenameMode(vf("20211011_141314_NF.mp4"));
        expect(r.matchedId).toBe("blackvue-mode");
        expect(r.value).toBe("normal");
    });

    it("blackvue P letter -> parking", () => {
        expect(matchFilenameMode(vf("20211011_141314_PF.mp4")).value).toBe("parking");
    });

    it("70mai mode from folder", () => {
        const r = matchFilenameMode(vf("NO20240429-182640F.MP4", "Movie/Lapse/Front/NO20240429-182640F.MP4"));
        expect(r.matchedId).toBe("70mai-mode");
        expect(r.value).toBe("parking"); // Lapse folder = time-lapse parking
    });
});

describe("wolfbox techniques", () => {
    const NAME = "2026_03_15_173951_02_I.MP4";

    it("wolfbox-time parses YYYY_MM_DD_HHMMSS (beats generic-datetime)", () => {
        const r = matchFilenameTime(vf(NAME));
        expect(r.matchedId).toBe("wolfbox-time");
        expect(r.value?.getUTCFullYear()).toBe(2026);
        expect(r.value?.getUTCMonth()).toBe(2); // March
        expect(r.value?.getUTCHours()).toBe(17);
        expect(r.value?.getUTCSeconds()).toBe(51);
    });

    it("wolfbox-channel from the trailing letter, confident", () => {
        expect(matchFilenameChannel(vf(NAME)).value).toEqual({ channel: "interior", confident: true });
        expect(matchFilenameChannel(vf("2026_03_15_173951_00_F.MP4")).value).toEqual({
            channel: "front",
            confident: true,
        });
    });

    it("wolfbox-channel from the SD folder when the name does not match", () => {
        const r = matchFilenameChannel(vf("clip001.mp4", "extra_norm/clip001.mp4"));
        expect(r.matchedId).toBe("wolfbox-channel");
        expect(r.value).toEqual({ channel: "interior", confident: true });
    });

    it("wolfbox-mode from the EE code, folder as fallback", () => {
        expect(matchFilenameMode(vf(NAME)).value).toBe("event"); // EE=02
        expect(matchFilenameMode(vf("2026_03_15_173951_00_F.MP4")).value).toBe("normal");
        // Unknown EE code falls through to the folder signal.
        const r = matchFilenameMode(vf("2026_03_15_173951_05_F.MP4", "front_emer/2026_03_15_173951_05_F.MP4"));
        expect(r.matchedId).toBe("wolfbox-mode");
        expect(r.value).toBe("event");
    });
});

// Viofo E (impact event) / T (telephoto) letters - implemented from foreign
// source (viofosync scanner.py:48-66, naming.py:99-107), no real E/T sample
// in the corpus; synthetic names follow the documented shape.
describe("viofo E/T letters", () => {
    it("EF: time via novatek-viofo-time (off the generic-datetime fallback)", () => {
        const r = matchFilenameTime(vf("2023_0412_111213_0042EF.MP4"));
        expect(r.matchedId).toBe("novatek-viofo-time");
        expect(r.value?.toISOString()).toBe("2023-04-12T11:12:13.000Z");
    });

    it("EF: channel front confident, mode event, sequence 42", () => {
        const ch = matchFilenameChannel(vf("2023_0412_111213_0042EF.MP4"));
        expect(ch.matchedId).toBe("novatek-viofo-channel");
        expect(ch.value).toEqual({ channel: "front", confident: true });
        const mode = matchFilenameMode(vf("2023_0412_111213_0042EF.MP4"));
        expect(mode.matchedId).toBe("novatek-mode");
        expect(mode.value).toBe("event");
        const seq = matchFilenameSequence(vf("2023_0412_111213_0042EF.MP4"));
        expect(seq.matchedId).toBe("novatek-sequence");
        expect(seq.value).toBe(42);
    });

    it("PT: channel side NOT confident (telephoto -> positional slot), mode parking", () => {
        const ch = matchFilenameChannel(vf("2023_0412_111213_0042PT.MP4"));
        expect(ch.matchedId).toBe("novatek-viofo-channel");
        expect(ch.value).toEqual({ channel: "side", confident: false });
        expect(matchFilenameMode(vf("2023_0412_111213_0042PT.MP4")).value).toBe("parking");
    });

    it("plain T: side guess, mode normal (empty optional mode group)", () => {
        expect(matchFilenameChannel(vf("2023_0412_111213_0042T.MP4")).value).toEqual({
            channel: "side",
            confident: false,
        });
        const mode = matchFilenameMode(vf("2023_0412_111213_0042T.MP4"));
        expect(mode.matchedId).toBe("novatek-mode");
        expect(mode.value).toBe("normal");
    });

    it("existing P/F behavior unchanged", () => {
        expect(matchFilenameChannel(vf("2023_0821_180010_062F.MP4")).value).toEqual({
            channel: "front",
            confident: true,
        });
        expect(matchFilenameMode(vf("2023_0821_180010_062PF.MP4")).value).toBe("parking");
    });

    it("negative: unknown X mode letter stays unclaimed by novatek techniques", () => {
        expect(matchFilenameChannel(vf("2023_0412_111213_0042XF.MP4")).matchedId).toBeNull();
        expect(matchFilenameMode(vf("2023_0412_111213_0042XF.MP4")).matchedId).toBeNull();
        expect(matchFilenameSequence(vf("2023_0412_111213_0042XF.MP4")).matchedId).toBeNull();
        // Time still recoverable via the generic fallback - only the
        // novatek-specific claim must not fire.
        expect(matchFilenameTime(vf("2023_0412_111213_0042XF.MP4")).matchedId).toBe("generic-datetime");
    });

    it("negative: Vantrue still resolves via its own technique", () => {
        const ch = matchFilenameChannel(vf("20230412_111213_0042_N_A.mp4"));
        expect(ch.matchedId).toBe("novatek-vantrue-channel");
        expect(matchFilenameMode(vf("20230412_111213_0042_N_A.mp4")).value).toBe("normal");
    });
});

// Viofo/Novatek RO locked-clip folder: firmware moves locked clips into
// DCIM/Movie/RO/ with unchanged filenames (viofosync scanner.py:57-63,
// a119_join.py:86-96).
describe("viofo RO locked folder", () => {
    it("Viofo name under Movie/RO/ -> event via novatek-mode", () => {
        const r = matchFilenameMode(vf("2023_0412_111213_0042F.MP4", "DCIM/Movie/RO/2023_0412_111213_0042F.MP4"));
        expect(r.matchedId).toBe("novatek-mode");
        expect(r.value).toBe("event");
    });

    it("same name under Movie/ -> normal via novatek-mode (not shadowed by fitcamx-mode)", () => {
        // matchedId is load-bearing: before the novatek-above-fitcamx reorder
        // the path-only fitcamx Movie/ claim returned "normal" first and the
        // RO/parking letters never got a chance.
        const r = matchFilenameMode(vf("2023_0412_111213_0042F.MP4", "DCIM/Movie/2023_0412_111213_0042F.MP4"));
        expect(r.matchedId).toBe("novatek-mode");
        expect(r.value).toBe("normal");
    });

    it("regression: parking letter under Movie/ -> parking (fitcamx used to shadow it)", () => {
        const r = matchFilenameMode(vf("2023_0412_111213_0042PF.MP4", "DCIM/Movie/2023_0412_111213_0042PF.MP4"));
        expect(r.matchedId).toBe("novatek-mode");
        expect(r.value).toBe("parking");
    });

    it("single-channel A119 under RO -> event (real name from a119_join.py:22)", () => {
        const r = matchFilenameMode(vf("2016_1224_094105_116.MP4", "DCIM/Movie/RO/2016_1224_094105_116.MP4"));
        expect(r.matchedId).toBe("novatek-mode");
        expect(r.value).toBe("event");
    });

    it("negative: non-Novatek name under ro/ gets no mode claim", () => {
        const r = matchFilenameMode(vf("IMG_1234.mp4", "ro/IMG_1234.mp4"));
        expect(r.value).toBeNull();
        expect(r.matchedId).toBeNull();
    });

    it("negative: Vantrue under Movie/RO/ keeps mode from its own letter", () => {
        const r = matchFilenameMode(vf("20230412_111213_0042_N_A.mp4", "DCIM/Movie/RO/20230412_111213_0042_N_A.mp4"));
        expect(r.matchedId).toBe("novatek-mode");
        expect(r.value).toBe("normal");
    });
});

// Novatek NVT-IM single-camera MOV. Some firmware uses A for realtime driving
// and no suffix for parking time-lapse; legacy realtime firmware has no suffix,
// so timing evidence decides the ambiguous spelling after metadata arrives.
describe("novatek NVT-IM MOV techniques", () => {
    const drivingName = "2026_0809_222334_654A.MOV";
    const drivingPath = `MOVIE/${drivingName}`;
    const parkingName = "2026_0826_070216_437.MOV";
    const parkingPath = `MOVIE/${parkingName}`;

    it("reuses the single-camera time, channel, mode, and sequence capabilities", () => {
        expect(RX_NOVATEK_NVT_MOV.test(drivingName)).toBe(true);

        const time = matchFilenameTime(vf(drivingName, drivingPath));
        expect(time.matchedId).toBe("novatek-single-time");
        expect(time.value?.toISOString()).toBe("2026-08-09T22:23:34.000Z");

        const channel = matchFilenameChannel(vf(drivingName, drivingPath));
        expect(channel.matchedId).toBe("novatek-single-channel");
        expect(channel.value).toEqual({ channel: "front", confident: true });

        const mode = matchFilenameMode(vf(drivingName, drivingPath));
        expect(mode.matchedId).toBe("novatek-mode");
        expect(mode.value).toBe("normal");

        const sequence = matchFilenameSequence(vf(drivingName, drivingPath));
        expect(sequence.matchedId).toBe("novatek-sequence");
        expect(sequence.value).toBe(654);
    });

    it("gates no-suffix MOV for clock-proven time-lapse without claiming it from the name alone", () => {
        expect(RX_NOVATEK_NVT_MOV.test(parkingName)).toBe(true);
        expect(classifyFilenameTimelapse(vf(parkingName, parkingPath))).toBe(false);
        expect(classifyFilenameClockTimelapse(vf(parkingName, parkingPath))).toBe(true);
        expect(classifyFilenameClockTimelapse(vf(drivingName, drivingPath))).toBe(false);
        // Until the container clocks prove compression, legacy no-suffix MOV
        // stays on the safe realtime default.
        expect(matchFilenameMode(vf(parkingName, parkingPath)).value).toBe("normal");
    });

    it("normalizes the mode marker out of camera identity", () => {
        expect(cameraFingerprint(vf(drivingName, drivingPath))).toBe(cameraFingerprint(vf(parkingName, parkingPath)));
    });

    it("RO protected clips stay with normal clips under one camera key", () => {
        expect(matchFilenameMode(vf(drivingName, `MOVIE/RO/${drivingName}`)).value).toBe("event");
        expect(cameraFingerprint(vf(drivingName, drivingPath))).toBe(
            cameraFingerprint(vf("2026_0809_222437_655A.MOV", "MOVIE/RO/2026_0809_222437_655A.MOV")),
        );
    });

    it("does not infer semantics for other suffixes or extensions", () => {
        expect(RX_NOVATEK_NVT_MOV.test("2026_0809_222334_654B.MOV")).toBe(false);
        expect(RX_NOVATEK_NVT_MOV.test("2026_0809_222334_654A.MP4")).toBe(false);
        expect(matchFilenameChannel(vf("2026_0809_222334_654B.MOV")).matchedId).toBeNull();
        expect(matchFilenameSequence(vf("2026_0809_222334_654B.MOV")).matchedId).toBeNull();
    });
});

// Nextbase yyMMdd_HHmmss_NNN_<channel><quality>.MP4 - implemented from
// foreign source (nb-dashcam-tools clipmergewidget.cpp:194-218); the FH shape
// is validated against a real 322GW-family clip, the other letters remain
// foreign-source-only. Fixture date matches the verbatim 512GW freeGPS
// hexdump in ExifTool QuickTimeStream.pl (~1717-1741): ASCII
// "20180919100959" -> 2018-09-19 10:09:59.
describe("nextbase techniques", () => {
    it("nextbase-time: unconditional 20yy pivot", () => {
        const r = matchFilenameTime(vf("180919_100959_001_FH.MP4"));
        expect(r.matchedId).toBe("nextbase-time");
        expect(r.value?.toISOString()).toBe("2018-09-19T10:09:59.000Z");
    });

    it("regression: name where generic-datetime parses a VALID WRONG date", () => {
        // generic-datetime aligns 201001_051213 as 2010-01-05T12:13:00 -
        // a plausible-looking wrong date. nextbase-time must win with the
        // correct 2020-10-01 05:12:13.
        const r = matchFilenameTime(vf("201001_051213_001_FH.MP4"));
        expect(r.matchedId).toBe("nextbase-time");
        expect(r.value?.toISOString()).toBe("2020-10-01T05:12:13.000Z");
    });

    it("channel: F sure front, R sure rear, B guess interior", () => {
        const f = matchFilenameChannel(vf("180919_100959_001_FH.MP4"));
        expect(f.matchedId).toBe("nextbase-channel");
        expect(f.value).toEqual({ channel: "front", confident: true });
        expect(matchFilenameChannel(vf("180919_100959_001_RL.MP4")).value).toEqual({
            channel: "rear",
            confident: true,
        });
        expect(matchFilenameChannel(vf("180919_100959_001_BH.MP4")).value).toEqual({
            channel: "interior",
            confident: false,
        });
    });

    it("sequence: 3-digit counter", () => {
        const r = matchFilenameSequence(vf("180919_100959_001_FH.MP4"));
        expect(r.matchedId).toBe("nextbase-sequence");
        expect(r.value).toBe(1);
    });

    it("no mode technique: the name carries no mode field", () => {
        const r = matchFilenameMode(vf("180919_100959_001_FH.MP4"));
        expect(r.value).toBeNull();
        expect(r.matchedId).toBeNull();
    });

    it("negative: near-miss names are not claimed by nextbase", () => {
        // Invalid quality letter.
        expect(matchFilenameChannel(vf("180919_100959_001_FX.MP4")).matchedId).toBeNull();
        // 7-digit date.
        expect(matchFilenameChannel(vf("1809245_100959_001_FH.MP4")).matchedId).toBeNull();
        // BlackVue (8-digit date) keeps resolving via its own techniques.
        expect(matchFilenameTime(vf("20190919_100959_NF.mp4")).matchedId).toBe("blackvue-time");
        expect(matchFilenameChannel(vf("20190919_100959_NF.mp4")).matchedId).toBe("blackvue-channel");
        // E-Ace (8-digit date, no counter) untouched.
        expect(matchFilenameChannel(vf("20240429_182640F.mp4")).matchedId).toBe("e-ace-channel");
        // Vantrue untouched.
        expect(matchFilenameChannel(vf("20230412_111213_0042_N_A.mp4")).matchedId).toBe("novatek-vantrue-channel");
    });
});

describe("matchFilenameSequence", () => {
    it("70mai counter extracted", () => {
        const r = matchFilenameSequence(vf("NO20240429-182640-000897F.mp4"));
        expect(r.matchedId).toBe("70mai-sequence");
        expect(r.value).toBe(897);
    });

    it("tesla camera-id sequence", () => {
        const r = matchFilenameSequence(vf("front.mp4", "TeslaCam/SentryClips/2026-04-29_18-30-15/front.mp4"));
        expect(r.matchedId).toBe("tesla-sequence");
        expect(r.value).toBe(0); // front = 0 in Tesla camera-id mapping
    });

    it("recording-scoped NMEA camera counter", () => {
        const r = matchFilenameSequence(vf("MAH00384.MP4"));
        expect(r.matchedId).toBe("sectioned-nmea-sequence");
        expect(r.value).toBe(384);
    });

    it("no sequence in filename - null", () => {
        const r = matchFilenameSequence(vf("clip.mp4"));
        expect(r.value).toBeNull();
        expect(r.matchedId).toBeNull();
    });
});

describe("ford built-in dashcam techniques", () => {
    // Real sample name from a FordFootage drop.
    it("ford-time parses YYYY-MM-DD_HH_MM_SS (beats generic-datetime)", () => {
        const r = matchFilenameTime(vf("2026-06-14_16_16_18_f.ts"));
        expect(r.matchedId).toBe("ford-time");
        expect(r.value?.getUTCFullYear()).toBe(2026);
        expect(r.value?.getUTCMonth()).toBe(5); // June
        expect(r.value?.getUTCDate()).toBe(14);
        expect(r.value?.getUTCHours()).toBe(16);
        expect(r.value?.getUTCMinutes()).toBe(16);
        expect(r.value?.getUTCSeconds()).toBe(18);
    });

    it("ford-mode: name match asserts normal (like e-ace/carcam/ibox), not null", () => {
        const r = matchFilenameMode(vf("2026-06-14_16_16_18_f.ts"));
        expect(r.matchedId).toBe("ford-mode");
        expect(r.value).toBe("normal");
    });

    it("ford-channel: f -> front, confident (confirmed on a real sample)", () => {
        const r = matchFilenameChannel(vf("2026-06-14_16_16_18_f.ts"));
        expect(r.matchedId).toBe("ford-channel");
        expect(r.value).toEqual({ channel: "front", confident: true });
    });

    it("ford-channel: mnemonic letters r/b -> rear, i -> interior, confident", () => {
        expect(classifyFilenameChannel(vf("2026-06-14_16_16_18_r.ts"))).toEqual({ channel: "rear", confident: true });
        expect(classifyFilenameChannel(vf("2026-06-14_16_16_18_b.ts"))).toEqual({ channel: "rear", confident: true });
        expect(classifyFilenameChannel(vf("2026-06-14_16_16_18_i.ts"))).toEqual({
            channel: "interior",
            confident: true,
        });
    });

    it("ford-channel: an unconfirmed letter goes to the FREE side slot, not rear (guessed)", () => {
        // Any non-`f` letter must NOT default to "front" (would collide with the
        // real front file) NOR to "rear" (would collide with a real `_r`/`_b` and
        // spawn a dup frame). It takes the free "side" slot so it still pairs into
        // one frame. Guessed mount -> confident:false (positional UI label).
        expect(classifyFilenameChannel(vf("2026-06-14_16_16_18_x.ts"))).toEqual({ channel: "side", confident: false });
    });

    it("negative: RX_FORD rejects other .ts family name shapes (pins the regex boundary)", () => {
        // Direct on the regex, not just via walk order: a contiguous-digit date is
        // NOT Ford, so the family can never poach Juscar/FitCamX names even if the
        // walk order or a path signal changes later.
        expect(RX_FORD.test("20260614_161618F.ts")).toBe(false); // Juscar (8-digit date)
        expect(RX_FORD.test("20260614161618_000123A.ts")).toBe(false); // FitCamX (14-digit ts)
        expect(RX_FORD.test("2026-06-14_16_16_18.ts")).toBe(false); // no channel letter
        expect(RX_FORD.test("2026-06-14_16_16_18_ff.ts")).toBe(false); // two-letter token
        expect(RX_FORD.test("2026-06-14_16_16_18_f.mp4")).toBe(false); // wrong extension
        // And the families still resolve via their own techniques.
        expect(matchFilenameTime(vf("20260614_161618F.ts")).matchedId).toBe("juscar-time");
        expect(matchFilenameChannel(vf("20260614_161618F.ts")).matchedId).toBe("juscar-channel");
        expect(matchFilenameChannel(vf("20260614161618_000123A.ts", "Movie/20260614161618_000123A.ts")).matchedId).toBe(
            "fitcamx-channel",
        );
    });
});

describe("mio/navman mivue techniques", () => {
    // Real sample name from the Navman MiVue 150 Safety drop. FILE<YYMMDD>-<HHMMSS>,
    // no channel letter, no sequence - what separates it from iBox and Navitel.
    it("mivue-time parses FILE<YYMMDD>-<HHMMSS> (YYMMDD, beats generic-datetime)", () => {
        const r = matchFilenameTime(vf("FILE260625-144859.MP4"));
        expect(r.matchedId).toBe("mivue-time");
        expect(r.value?.getUTCFullYear()).toBe(2026); // "26" is the year, not the day
        expect(r.value?.getUTCMonth()).toBe(5); // June
        expect(r.value?.getUTCDate()).toBe(25);
        expect(r.value?.getUTCHours()).toBe(14);
        expect(r.value?.getUTCMinutes()).toBe(48);
        expect(r.value?.getUTCSeconds()).toBe(59);
    });

    it("mivue-mode reads the Normal/Event/Parking folder, defaults to normal when flat", () => {
        expect(matchFilenameMode(vf("FILE260625-144859.MP4", "Normal/FILE260625-144859.MP4")).matchedId).toBe(
            "mivue-mode",
        );
        expect(classifyFilenameMode(vf("FILE260625-144859.MP4", "Normal/FILE260625-144859.MP4"))).toBe("normal");
        expect(classifyFilenameMode(vf("FILE260625-144859.MP4", "Event/FILE260625-144859.MP4"))).toBe("event");
        expect(classifyFilenameMode(vf("FILE260625-144859.MP4", "Parking/FILE260625-144859.MP4"))).toBe("parking");
        // Flat drop (user copied the videos out of their folders) -> normal.
        expect(classifyFilenameMode(vf("FILE260625-144859.MP4"))).toBe("normal");
    });

    it("negative: RX_MIVUE is disjoint from iBox and Navitel FILE-patterns", () => {
        expect(RX_MIVUE.test("FILE260625-144859.MP4")).toBe(true);
        expect(RX_MIVUE.test("FILE251231-235959F.mp4")).toBe(false); // iBox: trailing channel letter
        expect(RX_MIVUE.test("FILE251231-235959-000001.mov")).toBe(false); // Navitel: -sequence
        // ...and those names still resolve through their own techniques, not mivue.
        expect(matchFilenameTime(vf("FILE251231-235959F.mp4")).matchedId).toBe("ibox-time");
        expect(matchFilenameTime(vf("FILE251231-235959-000001.mov")).matchedId).toBe("navitel-time");
    });
});

// Navitel .TS spelling: a 2-channel motorcycle-cam firmware writes plain
// ISO-BMFF (same IDIT/gps0 tail as the .mov/.mp4 R-series) under a .TS
// extension, card layout `<Mode>/<channel letter>/` (Normal/F/, Normal/R/).
describe("navitel .TS variant", () => {
    const frontPath = "0817/CARD/Normal/F/FILE260817-180301-000004F.TS";
    const rearPath = "0817/CARD/Normal/R/FILE260817-180301-000004R.TS";

    it("time, channel and sequence resolve via the navitel techniques", () => {
        const t = matchFilenameTime(vf("FILE260817-180301-000004F.TS", frontPath));
        expect(t.matchedId).toBe("navitel-time");
        expect(t.value?.toISOString()).toBe("2026-08-17T18:03:01.000Z");
        expect(matchFilenameChannel(vf("FILE260817-180301-000004F.TS")).matchedId).toBe("navitel-channel");
        expect(classifyFilenameChannel(vf("FILE260817-180301-000004F.TS"))).toEqual({
            channel: "front",
            confident: true,
        });
        expect(classifyFilenameChannel(vf("FILE260817-180301-000004R.TS"))).toEqual({
            channel: "rear",
            confident: true,
        });
        expect(matchFilenameSequence(vf("FILE260817-180301-000004F.TS")).matchedId).toBe("navitel-sequence");
        expect(classifyFilenameSequence(vf("FILE260817-180301-000004F.TS"))).toBe(4);
    });

    it("camera-key: channel letter, letter folder and mode folder all converge", () => {
        const front = cameraFingerprint(vf("FILE260817-180301-000004F.TS", frontPath));
        expect(front, "rear in its own letter folder shares the key").toBe(
            cameraFingerprint(vf("FILE260817-180301-000004R.TS", rearPath)),
        );
        expect(front, "an event clip of the same camera shares the key").toBe(
            cameraFingerprint(vf("FILE260817-181000-000005F.TS", "0817/CARD/Event/F/FILE260817-181000-000005F.TS")),
        );
        expect(front, "a different card root is a different camera").not.toBe(
            cameraFingerprint(vf("FILE260817-180301-000004F.TS", "0818/OTHER/Normal/F/FILE260817-180301-000004F.TS")),
        );
    });

    it("the classic .mov spelling keeps resolving and shares nothing with foreign .ts families", () => {
        expect(matchFilenameTime(vf("FILE201104-163014-000429F.mov")).matchedId).toBe("navitel-time");
        expect(RX_NAVITEL.test("FILE260817-180301F.TS")).toBe(false); // no sequence -> not navitel
        expect(RX_NAVITEL.test("HPIM20260817-180301F.TS")).toBe(false); // hpim prefix
        expect(matchFilenameChannel(vf("HPIM20260817-180301F.TS")).matchedId).toBe("hpim-channel");
        expect(matchFilenameChannel(vf("20260817_180301F.ts")).matchedId).toBe("juscar-channel");
    });
});

describe("70mai T800 cabin channel", () => {
    it.each(["NO", "EV"])("%s cabin files resolve through all 70mai filename techniques", (prefix) => {
        const file = vf(`${prefix}20260101-120000-000042C.MP4`);
        expect(matchFilenameTime(file)).toEqual({
            matchedId: "70mai-time",
            value: new Date("2026-01-01T12:00:00Z"),
        });
        expect(matchFilenameChannel(file)).toEqual({
            matchedId: "70mai-channel",
            value: { channel: "interior", confident: true },
        });
        expect(matchFilenameSequence(file)).toEqual({ matchedId: "70mai-sequence", value: 42 });
        expect(classifyFilenameMode(file)).toBe(prefix === "NO" ? "normal" : "event");
    });

    it("handles a lowercase cabin suffix and both app-export suffix positions", () => {
        for (const name of [
            "NO20260101-120000-000042c.mp4",
            "NO20260101-120000-000042C-20260101120300.mp4",
            "NO20260101-120000-000042-20260101120300C.mp4",
        ]) {
            expect(classifyFilenameChannel(vf(name))).toEqual({ channel: "interior", confident: true });
            expect(cameraFingerprint(vf(name))).toBe(cameraFingerprint(vf(name.replace(/c(?=[-.])/i, "F"))));
        }
    });

    it("preserves the cabin channel in the log rebinding key", () => {
        expect(mai70NameCore("EV20260101-120000-000042C.MP4")).toBe("20260101-120000-000042C");
        expect(mai70NameCore("NO20260101-120000-000042C.MP4G4")).toBe("20260101-120000-000042C");
    });

    it("does not claim unrelated C-suffixed files or Cabin folders", () => {
        for (const name of ["clipC.MP4", "NO20260101-120000-000042XX.MP4", "PH20260101-120000-000042C.JPG"]) {
            expect(matchFilenameChannel(vf(name, `Cabin/${name}`)).matchedId).not.toBe("70mai-channel");
        }
    });
});

describe("70mai A810 lite rear (R) + event (EV) variants", () => {
    it("normal rear NO...R: 70mai-time + rear channel (confident) + sequence", () => {
        const name = "NO20260101-120000-000042R.MP4";
        const t = matchFilenameTime(vf(name));
        expect(t.matchedId).toBe("70mai-time");
        expect(t.value?.getUTCFullYear()).toBe(2026);
        expect(t.value?.getUTCMonth()).toBe(0); // January
        expect(t.value?.getUTCDate()).toBe(1);
        const ch = matchFilenameChannel(vf(name));
        expect(ch.matchedId).toBe("70mai-channel");
        expect(ch.value).toEqual({ channel: "rear", confident: true });
        const seq = matchFilenameSequence(vf(name));
        expect(seq.matchedId).toBe("70mai-sequence");
        expect(seq.value).toBe(42);
    });

    it("event front EV...F: 70mai time/channel/sequence + mode=event from prefix (flat, no folder)", () => {
        const name = "EV20260101-120000-000042F.MP4";
        expect(matchFilenameTime(vf(name)).matchedId).toBe("70mai-time");
        const ch = matchFilenameChannel(vf(name));
        expect(ch.matchedId).toBe("70mai-channel");
        expect(ch.value).toEqual({ channel: "front", confident: true });
        expect(matchFilenameSequence(vf(name)).value).toBe(42);
        // relativePath == name -> no folder, so the mode comes from the EV prefix.
        const mode = matchFilenameMode(vf(name));
        expect(mode.matchedId).toBe("70mai-mode");
        expect(mode.value).toBe("event");
    });

    it("event rear EV...R: rear channel + mode=event from prefix (flat, no folder)", () => {
        const name = "EV20260101-120000-000042R.MP4";
        expect(matchFilenameChannel(vf(name)).value).toEqual({ channel: "rear", confident: true });
        expect(classifyFilenameMode(vf(name))).toBe("event");
    });

    it("normal prefix NO -> mode normal on a flat drop", () => {
        expect(classifyFilenameMode(vf("NO20260101-120000-000042F.MP4"))).toBe("normal");
    });

    it("path folder wins over the prefix and keeps parking/manual granularity", () => {
        // NO prefix but a Lapse folder -> parking: the folder is the richer signal
        // (four modes vs the prefix's two), so it takes precedence.
        const r = matchFilenameMode(
            vf("NO20260101-120000-000042F.MP4", "Movie/Lapse/Front/NO20260101-120000-000042F.MP4"),
        );
        expect(r.matchedId).toBe("70mai-mode");
        expect(r.value).toBe("parking");
    });

    it("rear resolves via the R letter with a matching channel folder", () => {
        const r = matchFilenameChannel(
            vf("NO20260101-120000-000042R.MP4", "Movie/Normal/Rear/NO20260101-120000-000042R.MP4"),
        );
        expect(r.matchedId).toBe("70mai-channel");
        expect(r.value).toEqual({ channel: "rear", confident: true });
    });

    it("negative: a DDPai-shaped 14-digit leading token does not match RX_70MAI", () => {
        expect(RX_70MAI.test("20260101120000_0042.mp4")).toBe(false);
        // ...and it still resolves through DDPai, never 70mai.
        expect(matchFilenameChannel(vf("20260101120000_0042.mp4")).matchedId).toBe("ddpai-channel");
    });

    it("negative: the NO/EV prefix regex does not claim a non-70mai name", () => {
        // "NOTES.mp4" starts with NO but is not a 70mai name - the RX_70MAI gate
        // in 70mai-mode keeps the prefix branch from claiming it.
        expect(matchFilenameMode(vf("NOTES.mp4")).matchedId).not.toBe("70mai-mode");
    });
});

// 70mai A510 parking prefixes (LA = parking timelapse, PA = parking event)
// and the app-export shape with the channel letter BEFORE the trailing
// 14-digit wall-clock stamp. Both ride the shared RX_70MAI, so time/channel/
// sequence/camera-key and the embedded-GPS hint all follow from the regex.
describe("70mai A510 LA/PA prefixes + channel-before-stamp", () => {
    it("LA front: 70mai time/channel/sequence, mode parking from the prefix", () => {
        const name = "LA20260101-120000-000495F.MP4";
        const t = matchFilenameTime(vf(name));
        expect(t.matchedId).toBe("70mai-time");
        expect(t.value?.toISOString()).toBe("2026-01-01T12:00:00.000Z");
        expect(matchFilenameChannel(vf(name)).value).toEqual({ channel: "front", confident: true });
        const seq = matchFilenameSequence(vf(name));
        expect(seq.matchedId).toBe("70mai-sequence");
        expect(seq.value).toBe(495);
        const mode = matchFilenameMode(vf(name));
        expect(mode.matchedId).toBe("70mai-mode");
        expect(mode.value).toBe("parking");
    });

    it("LA rear uses the B letter (A510 is a B-rear model)", () => {
        expect(classifyFilenameChannel(vf("LA20260101-120000-000495B.MP4"))).toEqual({
            channel: "rear",
            confident: true,
        });
    });

    it("PA prefix -> mode event (parking g-sensor capture mirrors EV)", () => {
        const mode = matchFilenameMode(vf("PA20260101-120000-001496F.MP4"));
        expect(mode.matchedId).toBe("70mai-mode");
        expect(mode.value).toBe("event");
    });

    it("channel letter BEFORE the trailing stamp: time/channel/sequence still resolve", () => {
        const name = "NO20260101-120000-000195R-20260101120642.mp4";
        const t = matchFilenameTime(vf(name));
        expect(t.matchedId).toBe("70mai-time");
        // The leading 8+6 digits are the clip start; the trailing stamp is a
        // second wall-clock value the app appends and must be ignored.
        expect(t.value?.toISOString()).toBe("2026-01-01T12:00:00.000Z");
        const ch = matchFilenameChannel(vf(name));
        expect(ch.matchedId).toBe("70mai-channel");
        expect(ch.value).toEqual({ channel: "rear", confident: true });
        const seq = matchFilenameSequence(vf(name));
        expect(seq.matchedId).toBe("70mai-sequence");
        expect(seq.value).toBe(195);
        expect(classifyFilenameMode(vf(name))).toBe("normal");
    });

    it("channel letter AFTER the trailing stamp keeps working (older layout)", () => {
        expect(classifyFilenameChannel(vf("NO20260101-120000-000897-20260101120642F.mp4"))).toEqual({
            channel: "front",
            confident: true,
        });
    });

    it("M500 stamp with no channel letter: no channel claim, counter still rejected as sequence", () => {
        expect(matchFilenameChannel(vf("NO20260101-120000-000897-20260101120642.mp4")).matchedId).toBeNull();
        // No counter at all: the greedy counter group swallows the stamp and
        // the length guard must reject it.
        expect(matchFilenameSequence(vf("NO20260101-120000-20260101120642F.mp4")).value).toBeNull();
    });

    it("camera-key: LA/PA fold to NO, and the pre-stamp letter strips (front/rear converge)", () => {
        // Prefix folding: a parking clip is the same camera as its normal twin.
        expect(cameraFingerprint(vf("LA20260101-120000-000495F.MP4"))).toBe(
            cameraFingerprint(vf("NO20260101-120100-000496F.MP4")),
        );
        expect(cameraFingerprint(vf("PA20260101-120200-001496F.MP4"))).toBe(
            cameraFingerprint(vf("NO20260101-120100-000496F.MP4")),
        );
        // Pre-stamp letter: R and F of one app export converge (the terminal
        // `<letter>.` search cannot see this position - a dedicated strip does).
        expect(cameraFingerprint(vf("NO20260101-120000-000195R-20260101120642.mp4"))).toBe(
            cameraFingerprint(vf("NO20260101-120100-000196F-20260101120442.mp4")),
        );
    });

    it("negative: LA/PA lookalike words are not claimed by 70mai-mode", () => {
        expect(matchFilenameMode(vf("LAPSE-VIDEO.mp4")).matchedId).toBeNull();
        expect(matchFilenameMode(vf("PANORAMA.mp4")).matchedId).toBeNull();
    });
});

describe("specific filename evidence outranks generic folder heuristics", () => {
    it("keeps BlackVue normal mode under a foreign Event folder", () => {
        const result = matchFilenameMode(vf("20260822_120000_NF.mp4", "Event/20260822_120000_NF.mp4"));
        expect(result.matchedId).toBe("blackvue-mode");
        expect(result.value).toBe("normal");
    });

    it("keeps the BlackVue rear suffix under a foreign Front folder", () => {
        const result = matchFilenameChannel(vf("20260822_120000_NR.mp4", "Front/20260822_120000_NR.mp4"));
        expect(result.matchedId).toBe("blackvue-channel");
        expect(result.value).toEqual({ channel: "rear", confident: true });
    });

    it("retains a path heuristic for an otherwise unrecognized renamed file", () => {
        const result = matchFilenameMode(vf("renamed.mp4", "Event/renamed.mp4"));
        expect(result.matchedId).toBe("70mai-mode");
        expect(result.value).toBe("event");
    });

    it("does not infer 70mai time-lapse from a foreign Lapse folder alone", () => {
        expect(classifyFilenameTimelapse(vf("20260822_120000_NF.mp4", "Lapse/20260822_120000_NF.mp4"))).toBe(false);
    });
});

describe("70mai VL protected clips", () => {
    const name = "VL20260428-192844-000413F.MP4";

    it("uses the same time, channel, sequence and event classifiers as EV clips", () => {
        expect(matchFilenameTime(vf(name)).matchedId).toBe("70mai-time");
        expect(matchFilenameChannel(vf(name)).value).toEqual({ channel: "front", confident: true });
        expect(matchFilenameSequence(vf(name)).value).toBe(413);
        expect(matchFilenameMode(vf(name)).value).toBe("event");
    });
});

// Viofo/Novatek multi-channel names with NO sequence counter (T130 parking
// clips, some OEM firmwares): `YYYY_MMDD_HHMMSS_<P|E?><F|R|T|I>.mp4`.
describe("viofo optional sequence", () => {
    it("seq-less F: novatek time/channel/mode, sequence null (not NaN/0)", () => {
        const name = "2026_0708_180332_F.MP4";
        const t = matchFilenameTime(vf(name));
        expect(t.matchedId).toBe("novatek-viofo-time");
        expect(t.value?.toISOString()).toBe("2026-07-08T18:03:32.000Z");
        const ch = matchFilenameChannel(vf(name));
        expect(ch.matchedId).toBe("novatek-viofo-channel");
        expect(ch.value).toEqual({ channel: "front", confident: true });
        expect(classifyFilenameMode(vf(name))).toBe("normal");
        const seq = matchFilenameSequence(vf(name));
        expect(seq.value).toBeNull();
        expect(seq.matchedId).toBeNull();
    });

    it("seq-less parking rear PR: mode parking, channel rear", () => {
        const name = "2022_0224_132829_PR.MP4";
        expect(matchFilenameTime(vf(name)).matchedId).toBe("novatek-viofo-time");
        expect(classifyFilenameChannel(vf(name))).toEqual({ channel: "rear", confident: true });
        const mode = matchFilenameMode(vf(name));
        expect(mode.matchedId).toBe("novatek-mode");
        expect(mode.value).toBe("parking");
    });

    it("camera-key: seq-less PF and PR converge (T130 front+rear pair)", () => {
        expect(cameraFingerprint(vf("2022_0224_132830_PF.MP4"))).toBe(cameraFingerprint(vf("2022_0224_132829_PR.MP4")));
    });

    it("negative: RX_NOVATEK_SINGLE (no channel letter) is untouched by the optional group", () => {
        const seq = matchFilenameSequence(vf("2016_1224_094105_116.MP4"));
        expect(seq.matchedId).toBe("novatek-sequence");
        expect(seq.value).toBe(116);
        expect(matchFilenameChannel(vf("2016_1224_094105_116.MP4")).matchedId).toBe("novatek-single-channel");
    });
});

// DDPai-normal counter widened to 6-7 digits: the `<14-digit>_<counter>` shape
// is shared with Novatek-family OEMs (Fujida Karma, Roadgid Tube) that embed
// freeGPS - name classification still routes through the ddpai techniques.
describe("ddpai 6/7-digit counters", () => {
    it("6-digit counter: ddpai time/channel/mode/sequence", () => {
        const name = "20260101120000_000551.MP4";
        expect(matchFilenameTime(vf(name)).matchedId).toBe("ddpai-time");
        expect(matchFilenameChannel(vf(name)).matchedId).toBe("ddpai-channel");
        expect(classifyFilenameMode(vf(name))).toBe("normal");
        const seq = matchFilenameSequence(vf(name));
        expect(seq.matchedId).toBe("ddpai-sequence");
        expect(seq.value).toBe(551);
    });

    it("7-digit counter: sequence 13", () => {
        expect(classifyFilenameSequence(vf("20260101120000_0000013.MP4"))).toBe(13);
    });

    it("negative: an 8-digit counter is NOT ddpai", () => {
        expect(RX_DDPAI_NORMAL.test("20260101120000_00000001.mp4")).toBe(false);
        expect(matchFilenameChannel(vf("20260101120000_00000001.mp4")).matchedId).toBeNull();
        expect(matchFilenameSequence(vf("20260101120000_00000001.mp4")).matchedId).toBeNull();
    });
});

// Neoline Spectrum: INF<date>-<time>-<unpadded seq>-<F|R>.mp4. R = rear is an
// assumption (front-only corpus). The name carries no mode.
describe("neoline techniques", () => {
    it("time/channel/sequence resolve, mode stays null", () => {
        const name = "INF20260101-120000-14-F.mp4";
        const t = matchFilenameTime(vf(name));
        expect(t.matchedId).toBe("neoline-time");
        expect(t.value?.toISOString()).toBe("2026-01-01T12:00:00.000Z");
        const ch = matchFilenameChannel(vf(name));
        expect(ch.matchedId).toBe("neoline-channel");
        expect(ch.value).toEqual({ channel: "front", confident: true });
        const seq = matchFilenameSequence(vf(name));
        expect(seq.matchedId).toBe("neoline-sequence");
        expect(seq.value).toBe(14);
        expect(matchFilenameMode(vf(name)).matchedId).toBeNull();
    });

    it("unpadded single-digit sequence", () => {
        expect(classifyFilenameSequence(vf("INF20260101-120000-1-F.mp4"))).toBe(1);
    });

    it("R channel (assumed rear) and camera-key convergence with front", () => {
        expect(classifyFilenameChannel(vf("INF20260101-120000-14-R.mp4"))).toEqual({
            channel: "rear",
            confident: true,
        });
        expect(cameraFingerprint(vf("INF20260101-120000-14-R.mp4"))).toBe(
            cameraFingerprint(vf("INF20260101-120000-14-F.mp4")),
        );
    });

    it("negative: near-miss names are not claimed", () => {
        expect(RX_NEOLINE.test("INFO20260101-120000-14-F.mp4")).toBe(false); // INF is a strict prefix
        expect(RX_NEOLINE.test("INF20260101-120000-14.mp4")).toBe(false); // channel letter mandatory
        expect(RX_NEOLINE.test("INF20260101-120000-14-AA.mp4")).toBe(false); // one channel letter
    });
});

// Vueroid S1 4K Infinite: <date>_<time>_INF_<F|R>_<N|E|P>.mp4. N is the
// validated shape; E/P modes and the R channel are mnemonic assumptions.
describe("vueroid techniques", () => {
    it("F_N: time/channel/mode resolve, no sequence in the name", () => {
        const name = "20260101_120000_INF_F_N.mp4";
        const t = matchFilenameTime(vf(name));
        expect(t.matchedId).toBe("vueroid-time");
        expect(t.value?.toISOString()).toBe("2026-01-01T12:00:00.000Z");
        const ch = matchFilenameChannel(vf(name));
        expect(ch.matchedId).toBe("vueroid-channel");
        expect(ch.value).toEqual({ channel: "front", confident: true });
        const mode = matchFilenameMode(vf(name));
        expect(mode.matchedId).toBe("vueroid-mode");
        expect(mode.value).toBe("normal");
        expect(matchFilenameSequence(vf(name)).matchedId).toBeNull();
    });

    it("E -> event, P -> parking (assumed letters)", () => {
        expect(classifyFilenameMode(vf("20260101_120000_INF_F_E.mp4"))).toBe("event");
        expect(classifyFilenameMode(vf("20260101_120000_INF_R_P.mp4"))).toBe("parking");
    });

    it("camera-key: channel AND mode letters fold - all clips of one camera converge", () => {
        expect(cameraFingerprint(vf("20260101_120000_INF_R_N.mp4"))).toBe(
            cameraFingerprint(vf("20260101_120000_INF_F_N.mp4")),
        );
        // Mode is a per-clip attribute, not camera identity (the mai70
        // EV/LA/PA rationale): an event clip written mid-loop must chain into
        // the same trip as its N siblings.
        expect(cameraFingerprint(vf("20260101_120000_INF_F_E.mp4"))).toBe(
            cameraFingerprint(vf("20260101_120000_INF_F_N.mp4")),
        );
    });

    it.each([
        ["INF", "normal"],
        ["Event", "event"],
        ["Pevent", "event"],
        ["PARK", "parking"],
        ["USER", "manual"],
    ])("uses the %s card folder for mode and keeps one camera identity", (folder, mode) => {
        const name = "20260101_120000_INF_F_N.mp4";
        const file = vf(name, `card/${folder}/${name}`);
        expect(matchFilenameMode(file)).toEqual({ value: mode, matchedId: "vueroid-mode" });
        expect(classifyFilenameMode(vf(name, `card/${folder.toLowerCase()}/${name}`))).toBe(mode);
        expect(cameraFingerprint(file)).toBe(cameraFingerprint(vf(name, `card/INF/${name}`)));
        expect(cameraFingerprint(file)).not.toBe(cameraFingerprint(vf(name, `other-card/INF/${name}`)));
    });

    it("prefers the card folder over an assumed suffix and ignores archive ancestors", () => {
        const name = "20260101_120000_INF_F_P.mp4";
        expect(classifyFilenameMode(vf(name, `card/Pevent/${name}`))).toBe("event");
        expect(classifyFilenameMode(vf(name, `USER/archive/${name}`))).toBe("parking");
        expect(classifyFilenameMode(vf(name, `card/USER-backup/${name}`))).toBe("parking");
        expect(matchFilenameMode(vf("clip.mp4", "card/USER/clip.mp4")).matchedId).not.toBe("vueroid-mode");
        expect(matchFilenameMode(vf("image.jpg", "card/Bookmark/image.jpg")).matchedId).not.toBe("vueroid-mode");
    });

    it("negative: underscore families with no INF literal stay on their own techniques", () => {
        expect(RX_VUEROID.test("20260101_120000_NF.mp4")).toBe(false);
        expect(matchFilenameChannel(vf("20260101_120000_NF.mp4")).matchedId).toBe("blackvue-channel");
        expect(matchFilenameChannel(vf("20230412_111213_0042_N_A.mp4")).matchedId).toBe("novatek-vantrue-channel");
        expect(matchFilenameChannel(vf("20260101_120000F.mp4")).matchedId).toBe("e-ace-channel");
    });
});

// SigmaStar mode-prefix + date - time - sequence; channel lives in the path.
describe("rec-single techniques", () => {
    it("time/sequence resolve; no channel or mode in the name", () => {
        const name = "REC20260101-120000-228.mp4";
        const t = matchFilenameTime(vf(name));
        expect(t.matchedId).toBe("rec-single-time");
        expect(t.value?.toISOString()).toBe("2026-01-01T12:00:00.000Z");
        const seq = matchFilenameSequence(vf(name));
        expect(seq.matchedId).toBe("rec-single-sequence");
        expect(seq.value).toBe(228);
        expect(matchFilenameChannel(vf(name)).matchedId).toBeNull();
        expect(matchFilenameMode(vf(name)).matchedId).toBeNull();
    });

    it("camera-key is stable across timestamps", () => {
        expect(cameraFingerprint(vf("REC20260101-120000-228.mp4"))).toBe(
            cameraFingerprint(vf("REC20260101-120100-229.mp4")),
        );
    });

    it("camera-key converges matching clips from A/B channel folders", () => {
        const name = "REC20260101-120000-228.mp4";
        const frontFile = vf(name, `card/Normal/A/${name}`);
        const rearFile = vf(name, `card/Normal/B/${name}`);
        expect(matchFilenameChannel(frontFile)).toEqual({
            value: { channel: "front", confident: false },
            matchedId: "rec-single-channel",
        });
        expect(matchFilenameChannel(rearFile)).toEqual({
            value: { channel: "rear", confident: false },
            matchedId: "rec-single-channel",
        });
        expect(cameraFingerprint(frontFile)).toBe(cameraFingerprint(rearFile));
        expect(cameraFingerprint(frontFile)).not.toBe(
            cameraFingerprint(vf("REC20260101-120000-228.mp4", "other/Normal/A/REC20260101-120000-228.mp4")),
        );
    });

    it("camera-key keeps arbitrary bare A/B directories separate", () => {
        const name = "REC20260101-120000-228.mp4";
        const cameraA = vf(name, `card/A/${name}`);
        const cameraB = vf(name, `card/B/${name}`);
        expect(matchFilenameChannel(cameraA).matchedId).toBeNull();
        expect(matchFilenameChannel(cameraB).matchedId).toBeNull();
        expect(cameraFingerprint(cameraA)).not.toBe(cameraFingerprint(cameraB));
    });

    it.each([
        ["Normal", "F", "REC20260913-125420-1370.mp4", "normal", "front", 1370, "2026-09-13T12:54:20.000Z"],
        ["Normal", "R", "REC20260913-125420-1334.mp4", "normal", "rear", 1334, "2026-09-13T12:54:20.000Z"],
        ["Event", "F", "SOS20260913-125521-1371.mp4", "event", "front", 1371, "2026-09-13T12:55:21.000Z"],
        ["Event", "R", "SOS20260913-125521-1335.mp4", "event", "rear", 1335, "2026-09-13T12:55:21.000Z"],
        ["Parking", "F", "PAR20260913-120859-0.mp4", "parking", "front", 0, "2026-09-13T12:08:59.000Z"],
        ["Parking", "R", "PAR20260913-120859-0.mp4", "parking", "rear", 0, "2026-09-13T12:08:59.000Z"],
    ])("resolves %s/%s/%s with independent channel counters", (folder, letter, name, mode, channel, sequence, time) => {
        const file = vf(name, `card/${folder}/${letter}/${name}`);
        expect(matchFilenameTime(file).matchedId).toBe("rec-single-time");
        expect(matchFilenameTime(file).value?.toISOString()).toBe(time);
        expect(matchFilenameSequence(file)).toEqual({ value: sequence, matchedId: "rec-single-sequence" });
        expect(matchFilenameChannel(file)).toEqual({
            value: { channel, confident: true },
            matchedId: "rec-single-channel",
        });
        expect(matchFilenameMode(file)).toEqual({ value: mode, matchedId: "rec-single-mode" });
    });

    it.each([
        ["SOS20260913-125521-1371.mp4", "event", 1371],
        ["PAR20260913-120859-0.mp4", "parking", 0],
    ])("retains time, sequence and explicit mode for a flat %s drop", (name, mode, sequence) => {
        const file = vf(name);
        expect(matchFilenameTime(file).matchedId).toBe("rec-single-time");
        expect(matchFilenameSequence(file)).toEqual({ value: sequence, matchedId: "rec-single-sequence" });
        expect(matchFilenameMode(file)).toEqual({ value: mode, matchedId: "rec-single-mode" });
        expect(matchFilenameChannel(file)).toEqual({ value: null, matchedId: null });
    });

    it("recognizes the mode/channel layout case-insensitively", () => {
        const name = "sos20260913-125521-1335.MP4";
        const file = vf(name, `card/eVeNt/r/${name}`);
        expect(matchFilenameChannel(file).value).toEqual({ channel: "rear", confident: true });
        expect(matchFilenameMode(file)).toEqual({ value: "event", matchedId: "rec-single-mode" });
    });

    it.each(["F", "R", "Unknown/F", "Normal/F/edited"])(
        "keeps channel unknown in an unrelated %s directory",
        (path) => {
            const name = "REC20260913-125420-1370.mp4";
            expect(matchFilenameChannel(vf(name, `card/${path}/${name}`))).toEqual({ value: null, matchedId: null });
        },
    );

    it.each(["clip.mp4", "SOS20260913-125521-1371-A.mp4", "PAR20260913-120859-123.456.mp4"])(
        "does not claim foreign %s names based on F/R folders",
        (name) => {
            const file = vf(name, `card/Event/R/${name}`);
            expect(matchFilenameChannel(file).matchedId).not.toBe("rec-single-channel");
            expect(matchFilenameMode(file).matchedId).not.toBe("rec-single-mode");
            expect(matchFilenameTime(file).matchedId).not.toBe("rec-single-time");
            expect(matchFilenameSequence(file).matchedId).not.toBe("rec-single-sequence");
        },
    );

    it("negative: a REC name WITH a channel letter is still carcam, not rec-single", () => {
        expect(RX_REC_SINGLE.test("REC20260101-120000-228-A.mp4")).toBe(false);
        expect(matchFilenameTime(vf("REC20260101-120000-228-A.mp4")).matchedId).toBe("carcam-time");
        expect(matchFilenameChannel(vf("REC20260101-120000-228-A.mp4")).matchedId).toBe("carcam-channel");
    });

    it("keeps Thinkware REC_ names separate", () => {
        expect(matchFilenameTime(vf("REC_20210101_120000_F.mp4")).matchedId).not.toBe("rec-single-time");
        expect(matchFilenameChannel(vf("REC_20210101_120000_F.mp4")).matchedId).toBe("thinkware-channel");
    });
});

// Novatek MPEG-TS OEMs: <14-digit>_<6-digit>.ts - the ddpai-normal name
// scheme in a TS container. Disjoint from FitCamX (trailing letter there).
describe("novatek-ts techniques", () => {
    it.each([
        ["", "normal"],
        ["DCIM/VIDEO/", "normal"],
        ["DCIM/Movie/RO/", "event"],
        ["DCIM/Movie/ro/", "event"],
    ])("resolves the recording mode under %s", (folder, mode) => {
        const name = "20260101120000_000188.TS";
        expect(matchFilenameMode(vf(name, `${folder}${name}`))).toEqual({
            value: mode,
            matchedId: "novatek-mode",
        });
    });

    it("time/sequence resolve via the dedicated technique, not the generic fallback", () => {
        const name = "20260101120000_000188.TS";
        const t = matchFilenameTime(vf(name));
        expect(t.matchedId).toBe("novatek-ts-time");
        expect(t.value?.toISOString()).toBe("2026-01-01T12:00:00.000Z");
        const seq = matchFilenameSequence(vf(name));
        expect(seq.matchedId).toBe("novatek-ts-sequence");
        expect(seq.value).toBe(188);
        expect(matchFilenameChannel(vf(name)).matchedId).toBeNull();
        expect(matchFilenameMode(vf(name, `DCIM/VIDEO/${name}`))).toEqual({
            value: "normal",
            matchedId: "novatek-mode",
        });
    });

    it("camera-key is stable across timestamps", () => {
        expect(cameraFingerprint(vf("20260101120000_000188.TS"))).toBe(
            cameraFingerprint(vf("20260101125000_000192.TS")),
        );
    });

    it("negative: FitCamX (trailing letter) and ddpai (.mp4) stay on their own techniques", () => {
        expect(matchFilenameChannel(vf("20260101120000_000188A.ts", "Movie/20260101120000_000188A.ts")).matchedId).toBe(
            "fitcamx-channel",
        );
        expect(matchFilenameTime(vf("20260101120000_000188A.ts")).matchedId).toBe("fitcamx-time");
        expect(matchFilenameTime(vf("20260101120000_000188.mp4")).matchedId).toBe("ddpai-time");
    });
});

// HP (f969x, SigmaStar CarDV): HPIM<8-digit>-<6-digit><letter>.TS under
// <Mode>/<channel letter>/ folders. Front-only corpus; other letters are
// mnemonic assumptions.
describe("hpim techniques", () => {
    const path = "0811/f969x/Normal/F/HPIM20260811-170040F.TS";

    it("F letter -> front confident; unknown letter -> side guess", () => {
        const ch = matchFilenameChannel(vf("HPIM20260811-170040F.TS", path));
        expect(ch.matchedId).toBe("hpim-channel");
        expect(ch.value).toEqual({ channel: "front", confident: true });
        expect(classifyFilenameChannel(vf("HPIM20260811-170040R.TS"))).toEqual({ channel: "rear", confident: true });
        expect(classifyFilenameChannel(vf("HPIM20260811-170040X.TS"))).toEqual({ channel: "side", confident: false });
    });

    it("mode from the folder above the channel letter; flat drop defaults to normal", () => {
        const mode = matchFilenameMode(vf("HPIM20260811-170040F.TS", path));
        expect(mode.matchedId).toBe("hpim-mode");
        expect(mode.value).toBe("normal");
        expect(classifyFilenameMode(vf("HPIM20260811-170040F.TS", "Event/F/HPIM20260811-170040F.TS"))).toBe("event");
        expect(classifyFilenameMode(vf("HPIM20260811-170040F.TS", "Parking/F/HPIM20260811-170040F.TS"))).toBe(
            "parking",
        );
        expect(classifyFilenameMode(vf("HPIM20260811-170040F.TS"))).toBe("normal");
    });

    it("time stays on the generic fallback; no sequence in the name", () => {
        const t = matchFilenameTime(vf("HPIM20260811-170040F.TS", path));
        expect(t.matchedId).toBe("generic-datetime");
        expect(t.value?.toISOString()).toBe("2026-08-11T17:00:40.000Z");
        expect(matchFilenameSequence(vf("HPIM20260811-170040F.TS")).matchedId).toBeNull();
    });

    it("camera-key: channels and mode folders converge, the card root above them stays", () => {
        const front = cameraFingerprint(vf("HPIM20260811-170040F.TS", path));
        expect(front, "rear in its own letter folder shares the key").toBe(
            cameraFingerprint(vf("HPIM20260811-170040R.TS", "0811/f969x/Normal/R/HPIM20260811-170040R.TS")),
        );
        expect(front, "an event clip of the same camera shares the key").toBe(
            cameraFingerprint(vf("HPIM20260811-171000F.TS", "0811/f969x/Event/F/HPIM20260811-171000F.TS")),
        );
        expect(front, "a different card root is a different camera").not.toBe(
            cameraFingerprint(vf("HPIM20260811-170040F.TS", "0812/other/Normal/F/HPIM20260811-170040F.TS")),
        );
    });

    it("negative: prefix-less and foreign .ts families are not claimed", () => {
        expect(RX_HPIM.test("20260811-170040F.TS")).toBe(false); // HPIM literal mandatory
        expect(RX_HPIM.test("HPIM20260811-170040.TS")).toBe(false); // letter mandatory
        expect(RX_HPIM.test("HPIM20260811-170040F.mp4")).toBe(false); // .ts only
        expect(matchFilenameChannel(vf("20260811_170040F.ts")).matchedId).toBe("juscar-channel");
        expect(matchFilenameChannel(vf("CH1-20260811-170040.ts")).matchedId).toBe("sstar-chn-channel");
    });
});

// Unknown-vendor <14-digit>_<7-digit><F|R|I> family. Two corpora: the
// 3-channel .mov trio (filename-only diagnostic report, mnemonics
// content-unvalidated) and the 2-channel .ts card (real files with a
// LigoGPS/LCAI trailer; channels in single-letter F/ R/ folders).
describe("mov-seq-fri techniques", () => {
    it("F/R/I letters map to mnemonic mounts, confident", () => {
        const front = matchFilenameChannel(vf("20260811083704_0000826F.mov"));
        expect(front.matchedId).toBe("mov-seq-fri-channel");
        expect(front.value).toEqual({ channel: "front", confident: true });
        expect(classifyFilenameChannel(vf("20260811083704_0000826R.mov"))).toEqual({
            channel: "rear",
            confident: true,
        });
        expect(classifyFilenameChannel(vf("20260811083706_0000826I.mov"))).toEqual({
            channel: "interior",
            confident: true,
        });
    });

    it("sequence resolves; time stays on the generic fallback; no mode", () => {
        const seq = matchFilenameSequence(vf("20260811083704_0000826F.mov"));
        expect(seq.matchedId).toBe("mov-seq-fri-sequence");
        expect(seq.value).toBe(826);
        const t = matchFilenameTime(vf("20260811083704_0000826F.mov"));
        expect(t.matchedId).toBe("generic-datetime");
        expect(t.value?.toISOString()).toBe("2026-08-11T08:37:04.000Z");
        expect(matchFilenameMode(vf("20260811083704_0000826F.mov")).matchedId).toBeNull();
    });

    it("camera-key: all three channels converge on one fingerprint despite the interior's later stamp", () => {
        const front = cameraFingerprint(vf("20260811083704_0000826F.mov", "dash/20260811083704_0000826F.mov"));
        expect(front, "rear shares the key").toBe(
            cameraFingerprint(vf("20260811083704_0000826R.mov", "dash/20260811083704_0000826R.mov")),
        );
        expect(front, "interior shares the key").toBe(
            cameraFingerprint(vf("20260811083706_0000826I.mov", "dash/20260811083706_0000826I.mov")),
        );
    });

    it(".ts shape rides the same techniques: channel, sequence, single-letter folder convergence", () => {
        const ch = matchFilenameChannel(vf("20260813211138_0000002F.ts", "video/F/20260813211138_0000002F.ts"));
        expect(ch.matchedId).toBe("mov-seq-fri-channel");
        expect(ch.value).toEqual({ channel: "front", confident: true });
        expect(classifyFilenameChannel(vf("20260813211138_0000002R.ts"))).toEqual({
            channel: "rear",
            confident: true,
        });
        expect(matchFilenameSequence(vf("20260813211138_0000002F.ts")).value).toBe(2);
        // The channel letter lives in the name AND as a single-letter folder;
        // both are stripped so front/rear converge on one fingerprint.
        const front = cameraFingerprint(vf("20260813211138_0000002F.ts", "video/F/20260813211138_0000002F.ts"));
        expect(front, "rear in its own letter folder shares the key").toBe(
            cameraFingerprint(vf("20260813211138_0000002R.ts", "video/R/20260813211138_0000002R.ts")),
        );
        expect(front, "a different card root is a different camera").not.toBe(
            cameraFingerprint(vf("20260813211138_0000002F.ts", "other/F/20260813211138_0000002F.ts")),
        );
    });

    it("negative: extension/counter-width twins stay off the technique", () => {
        expect(RX_MOV_SEQ_FRI.test("20260811083704_0000826F.mp4")).toBe(false); // .mov/.ts only
        expect(RX_MOV_SEQ_FRI.test("20260811083704_000826F.mov")).toBe(false); // 6-digit counter
        expect(RX_MOV_SEQ_FRI.test("20260811083704_0000826.mov")).toBe(false); // letter mandatory
        expect(RX_MOV_SEQ_FRI.test("20260811083704_0000826AA.mov")).toBe(false); // one channel letter
        expect(RX_MOV_SEQ_FRI.test("20260813211138_000002F.ts")).toBe(false); // 6-digit counter .ts twin
        // The neighbouring stamp+counter families keep their own techniques.
        expect(matchFilenameTime(vf("20260811083704_082606F.ts")).matchedId).toBe("fitcamx-time");
        expect(matchFilenameTime(vf("20260811083704_0000826.mp4")).matchedId).toBe("ddpai-time");
    });
});

describe("ligogps-trailer-ts suffix techniques", () => {
    it("extracts the local timestamp and channel but leaves the opaque token unclaimed", () => {
        const file = vf("2026081822373512_f.ts", "VIDEO_F/2026081822373512_f.ts");
        const time = matchFilenameTime(file);
        expect(time.matchedId).toBe("ligogps-trailer-ts-time");
        expect(time.value?.toISOString()).toBe("2026-08-18T22:37:35.000Z");

        const channel = matchFilenameChannel(file);
        expect(channel.matchedId).toBe("ligogps-trailer-ts-channel");
        expect(channel.value).toEqual({ channel: "front", confident: true });
        expect(classifyFilenameChannel(vf("2026081822373512_r.ts"))).toEqual({
            channel: "rear",
            confident: true,
        });
        expect(classifyFilenameChannel(vf("2026081822373512_i.ts"))).toEqual({
            channel: "interior",
            confident: true,
        });
        expect(matchFilenameSequence(file).value).toBeNull();
        expect(matchFilenameMode(file).value).toBeNull();
    });

    it("converges channel suffixes and VIDEO_<channel> folders on one camera key", () => {
        const front = cameraFingerprint(vf("2026081822373512_f.ts", "card/VIDEO_F/2026081822373512_f.ts"));
        expect(front).toBe(cameraFingerprint(vf("2026081822373512_r.ts", "card/VIDEO_R/2026081822373512_r.ts")));
        expect(front).toBe(cameraFingerprint(vf("2026081822373512_i.ts", "card/VIDEO_I/2026081822373512_i.ts")));
        expect(front).not.toBe(cameraFingerprint(vf("2026081822373512_f.ts", "other/VIDEO_F/2026081822373512_f.ts")));
    });

    it("stays disjoint from neighbouring TS timestamp families", () => {
        expect(RX_LIGOGPS_TRAILER_TS.test("2026081822373512_f.ts")).toBe(true);
        expect(RX_LIGOGPS_TRAILER_TS.test("20260818223735_0000002F.ts")).toBe(false);
        expect(RX_LIGOGPS_TRAILER_TS.test("20260818223735_123456F.ts")).toBe(false);
        expect(RX_LIGOGPS_TRAILER_TS.test("2026081822373512_f.mp4")).toBe(false);
    });
});

describe("timestamp plus channel-letter MP4 techniques", () => {
    it.each(["", "_", "-"])("classifies F/R/I siblings with a '%s' channel separator", (separator) => {
        for (const [suffix, channel] of [
            ["F", "front"],
            ["R", "rear"],
            ["I", "interior"],
        ] as const) {
            const file = vf(`20260101_120000${separator}${suffix}.MP4`);
            expect(matchFilenameTime(file).matchedId).toBe("e-ace-time");
            expect(classifyFilenameTime(file)?.toISOString()).toBe("2026-01-01T12:00:00.000Z");
            expect(matchFilenameChannel(file)).toEqual({
                matchedId: "e-ace-channel",
                value: { channel, confident: true },
            });
            expect(matchFilenameMode(file)).toEqual({ matchedId: "e-ace-mode", value: "normal" });
            expect(classifyFilenameSequence(file)).toBeNull();
        }
    });

    it.each(["", "card/VIDEO/", "card/Front/"])("pairs underscored channels under '%s'", (folder) => {
        const front = vf("20260101_120014_F.MP4", `${folder}20260101_120014_F.MP4`);
        const rearFolder = folder.replace("Front/", "Rear/");
        const rear = vf("20260101_120015_R.MP4", `${rearFolder}20260101_120015_R.MP4`);
        expect(cameraFingerprint(front)).toBe(cameraFingerprint(rear));
        expect(matchFilenameChannel(rear).value).toEqual({ channel: "rear", confident: true });
        expect(cameraFingerprint(front)).not.toBe(
            cameraFingerprint(vf("20260101_120014_F.MP4", `other/${folder}20260101_120014_F.MP4`)),
        );
    });

    it("recognizes lowercase underscored channels", () => {
        const front = vf("20260101_120000_f.mp4");
        const rear = vf("20260101_120000_r.mp4");
        expect(matchFilenameChannel(rear).value).toEqual({ channel: "rear", confident: true });
        expect(cameraFingerprint(front)).toBe(cameraFingerprint(rear));
    });

    it.each([
        "20260101_120000_.MP4",
        "20260101_120000__F.MP4",
        "20260101_120000_NF.MP4",
        "20260101_120000_F.TS",
        "20260101_120000_001_F.MP4",
    ])("leaves %s outside the timestamp plus channel MP4/MOV family", (name) => {
        expect(RX_E_ACE.test(name)).toBe(false);
    });

    it("merges Video_<channel> sibling folders into one camera", () => {
        const channelKeys = (root: string) =>
            ["Front", "Inside", "Rear"].map((folder) => {
                const name = `20260927_144534${folder[0]}.MP4`;
                return cameraFingerprint(vf(name, `${root}/Video_${folder}/${name}`));
            });
        const keys = channelKeys("card");
        expect(new Set(keys).size).toBe(1);
        // A Windows drive-root pick surfaces as a `\` top segment.
        expect(new Set(channelKeys("\\")).size, "drive-root pick").toBe(1);
        expect(keys[0]).toBe(cameraFingerprint(vf("20260927_144834F.MP4", "card/Video_Front/20260927_144834F.MP4")));
        expect(keys[0]).not.toBe(
            cameraFingerprint(vf("20260927_144534F.MP4", "other/Video_Front/20260927_144534F.MP4")),
        );
    });

    it("reads Event_<channel> folders as event clips of their own camera key", () => {
        const front = vf("20260927_144534F.MP4", "card/Event_Front/20260927_144534F.MP4");
        const rear = vf("20260927_144534R.MP4", "card/Event_Rear/20260927_144534R.MP4");
        const loop = vf("20260927_144534F.MP4", "card/Video_Front/20260927_144534F.MP4");
        expect(matchFilenameMode(front)).toEqual({ matchedId: "e-ace-mode", value: "event" });
        expect(matchFilenameMode(loop)).toEqual({ matchedId: "e-ace-mode", value: "normal" });
        expect(cameraFingerprint(rear)).toBe(cameraFingerprint(front));
        expect(cameraFingerprint(front)).not.toBe(cameraFingerprint(loop));
    });

    it("keeps an unseen letter in the same camera without claiming its mount", () => {
        const front = vf("20260101_120000F.MP4", "card/Front/20260101_120000F.MP4");
        const cabin = vf("20260101_120000C.MP4", "card/C/20260101_120000C.MP4");
        const other = vf("20260101_120000X.MP4", "card/X/20260101_120000X.MP4");
        expect(matchFilenameChannel(cabin).value).toEqual({ channel: "interior", confident: false });
        expect(matchFilenameChannel(other).value).toEqual({ channel: "side", confident: false });
        expect(cameraFingerprint(cabin)).toBe(cameraFingerprint(front));
        expect(cameraFingerprint(other)).toBe(cameraFingerprint(front));
    });
});

describe("open channel-letter positions", () => {
    const families = [
        ["70mai", "NO20260101-120000F.mp4", "card/Normal/Front", "NO20260101-120000X.mp4", "card/Normal/X"],
        ["blackvue", "20260101_120000_NF.mp4", "card", "20260101_120000_NX.mp4", "card"],
        ["carcam", "REC20260101-120000-1-A.mp4", "card/normal/a", "REC20260101-120000-1-X.mp4", "card/normal/x"],
        ["rec-single", "REC20260101-120000-1.mp4", "card/Normal/F", "REC20260101-120000-1.mp4", "card/Normal/X"],
        ["ddpai", "20260101120000_001_F.mp4", "card", "20260101120000_001_X.mp4", "card"],
        ["e-ace", "20260101_120000F.mp4", "card", "20260101_120000X.mp4", "card"],
        ["e-ace", "20260101_120000_F.mp4", "card/VIDEO", "20260101_120000_X.mp4", "card/VIDEO"],
        ["fitcamx", "20260101120000_000001AAE.mp4", "card/EMR", "20260101120000_000001AXE.mp4", "card/EMR"],
        ["ibox", "FILE260101-120000F.mp4", "card/F", "FILE260101-120000X.mp4", "card/X"],
        ["juscar", "20260101_120000F.ts", "card/video/F", "20260101_120000X.ts", "card/video/X"],
        ["mov-seq-fri", "20260101120000_0000001F.mov", "card", "20260101120000_0000001X.mov", "card"],
        ["ligogps-trailer-ts", "2026010112000001_F.ts", "card/VIDEO_F", "2026010112000001_X.ts", "card/VIDEO_X"],
        ["nextbase", "260101_120000_001_FH.mp4", "card", "260101_120000_001_XH.mp4", "card"],
        ["neoline", "INF20260101-120000-1-F.mp4", "card", "INF20260101-120000-1-X.mp4", "card"],
        ["redtiger", "20260101120000_000001F.mp4", "card/Movie_F", "20260101120000_000001X.mp4", "card/Movie_X"],
        ["wolfbox", "2026_01_01_120000_00_F.mp4", "card", "2026_01_01_120000_00_X.mp4", "card"],
        ["novatek-viofo", "2026_0101_120000_1F.mp4", "card", "2026_0101_120000_1X.mp4", "card"],
        ["novatek-vantrue", "20260101_120000_1_N_A.mp4", "card", "20260101_120000_1_N_X.mp4", "card"],
        ["thinkware", "REC_20260101_120000_F.mp4", "card", "REC_20260101_120000_X.mp4", "card"],
        ["vueroid", "20260101_120000_INF_F_N.mp4", "card", "20260101_120000_INF_X_N.mp4", "card"],
    ] as const;

    it.each(families)(
        "%s accepts a new channel letter and keeps one camera key",
        (id, firstName, firstDir, extraName, extraDir) => {
            const first = vf(firstName, `${firstDir}/${firstName}`);
            const extra = vf(extraName, `${extraDir}/${extraName}`);
            expect(matchFilenameChannel(extra)).toEqual({
                matchedId: `${id}-channel`,
                value: { channel: "side", confident: false },
            });
            expect(cameraFingerprint(extra)).toBe(cameraFingerprint(first));
            expect(classifyFilenameTime(extra)).toEqual(classifyFilenameTime(first));
        },
    );
});

// RedTiger F7NP-4K 2-channel: `<14-digit>_<6-digit><F|R>.MP4` under
// `CARDV/<Mode>_<channel letter>/` folders.
describe("redtiger techniques", () => {
    const path = "NO NAME/CARDV/Movie_F/20260708073453_000002F.MP4";

    it("F/R letters map to mnemonic mounts, confident", () => {
        const ch = matchFilenameChannel(vf("20260708073453_000002F.MP4", path));
        expect(ch.matchedId).toBe("redtiger-channel");
        expect(ch.value).toEqual({ channel: "front", confident: true });
        expect(classifyFilenameChannel(vf("20260708073453_000003R.MP4"))).toEqual({
            channel: "rear",
            confident: true,
        });
    });

    it("mode from the <Mode>_<channel> folder; flat drop defaults to normal", () => {
        const mode = matchFilenameMode(vf("20260708073453_000002F.MP4", path));
        expect(mode.matchedId).toBe("redtiger-mode");
        expect(mode.value).toBe("normal");
        expect(
            classifyFilenameMode(vf("20260708074540_000008R.MP4", "NO NAME/CARDV/Event_R/20260708074540_000008R.MP4")),
        ).toBe("event");
        expect(
            classifyFilenameMode(vf("20260708074540_000009F.MP4", "CARDV/Parking_F/20260708074540_000009F.MP4")),
        ).toBe("parking");
        expect(classifyFilenameMode(vf("20260708073453_000002F.MP4"))).toBe("normal");
    });

    it("sequence resolves; time stays on the generic fallback", () => {
        const seq = matchFilenameSequence(vf("20260708073453_000002F.MP4"));
        expect(seq.matchedId).toBe("redtiger-sequence");
        expect(seq.value).toBe(2);
        const t = matchFilenameTime(vf("20260708073453_000002F.MP4", path));
        expect(t.matchedId).toBe("generic-datetime");
        expect(t.value?.toISOString()).toBe("2026-07-08T07:34:53.000Z");
    });

    it("camera-key: channels and mode folders converge, the card root above them stays", () => {
        const front = cameraFingerprint(vf("20260708073453_000002F.MP4", path));
        expect(front, "rear in its own folder shares the key").toBe(
            cameraFingerprint(vf("20260708073453_000003R.MP4", "NO NAME/CARDV/Movie_R/20260708073453_000003R.MP4")),
        );
        expect(front, "an event clip of the same camera shares the key").toBe(
            cameraFingerprint(vf("20260708074540_000009F.MP4", "NO NAME/CARDV/Event_F/20260708074540_000009F.MP4")),
        );
        expect(front, "a different card root is a different camera").not.toBe(
            cameraFingerprint(vf("20260708073453_000002F.MP4", "other/DASHCAM/Movie_F/20260708073453_000002F.MP4")),
        );
    });

    it("negative: extension/counter-width twins stay off the technique", () => {
        expect(RX_REDTIGER.test("20260708073453_000002F.ts")).toBe(false); // .mp4 only - the .ts twin is FitCamX language
        expect(RX_REDTIGER.test("20260708073453_0000002F.MP4")).toBe(false); // 7-digit counter = mov-seq-fri width
        expect(RX_REDTIGER.test("20260708073453_000002.MP4")).toBe(false); // letter mandatory (ddpai-normal territory)
        expect(RX_REDTIGER.test("20260708073453_000002II.MP4")).toBe(false); // one channel letter
        // The stamp+counter neighbours keep their own techniques.
        expect(matchFilenameTime(vf("20260708073453_000002F.ts")).matchedId).toBe("fitcamx-time");
        expect(matchFilenameTime(vf("20260708073453_000002.MP4")).matchedId).toBe("ddpai-time");
    });
});

// FitCamX MP4 variant: `<14-digit>_<6-digit>A<A|B><mode letter>.MP4`, both
// channels in one mode folder (EMR/), channel = the middle suffix letter (an
// index convention, not a mnemonic). Filename-only corpus (diagnostic report);
// embedded GPS unknown pending a real sample. The .ts variant keeps its
// folder-based channel/mode claims, gated on the name shape.
describe("fitcamx techniques", () => {
    const frontPath = "EMR/20260807191037_000922AAE.MP4";
    const rearPath = "EMR/20260807191037_000923ABE.MP4";

    it("MP4 suffix letters map to guessed channels (A pairs as front, B as rear)", () => {
        const ch = matchFilenameChannel(vf("20260807191037_000922AAE.MP4", frontPath));
        expect(ch.matchedId).toBe("fitcamx-channel");
        expect(ch.value).toEqual({ channel: "front", confident: false });
        expect(classifyFilenameChannel(vf("20260807191037_000923ABE.MP4", rearPath))).toEqual({
            channel: "rear",
            confident: false,
        });
    });

    it("camera-key: the A/B pair in one shared folder converges on one key", () => {
        const front = cameraFingerprint(vf("20260807191037_000922AAE.MP4", frontPath));
        expect(front, "rear shares the key despite the differing suffix").toBe(
            cameraFingerprint(vf("20260807191037_000923ABE.MP4", rearPath)),
        );
        expect(front, "a different card root is a different camera").not.toBe(
            cameraFingerprint(vf("20260807191037_000922AAE.MP4", "other/EMR/20260807191037_000922AAE.MP4")),
        );
    });

    it("mode from the folder: EMR -> event for the MP4 shape; time stays generic", () => {
        expect(classifyFilenameMode(vf("20260807191037_000922AAE.MP4", frontPath))).toBe("event");
        const t = matchFilenameTime(vf("20260807191037_000922AAE.MP4", frontPath));
        expect(t.matchedId).toBe("generic-datetime");
        expect(t.value?.toISOString()).toBe("2026-08-07T19:10:37.000Z");
    });

    it(".ts variant keeps folder channels: Movie -> front, Movie_E -> rear, both sure", () => {
        expect(classifyFilenameChannel(vf("20260101120000_000188A.ts", "Movie/20260101120000_000188A.ts"))).toEqual({
            channel: "front",
            confident: true,
        });
        expect(classifyFilenameChannel(vf("20260101120000_000188A.ts", "Movie_E/20260101120000_000188A.ts"))).toEqual({
            channel: "rear",
            confident: true,
        });
    });

    it("regression: a foreign file inside an EMR/ folder gets no fitcamx claim", () => {
        // The path claims are name-gated: without the gate ANY file in an
        // EMR|Movie folder would be marked sure("front") + a mode, breaking
        // other formats' channel pairing.
        expect(matchFilenameChannel(vf("clip.mp4", "EMR/clip.mp4")).matchedId).toBeNull();
        expect(matchFilenameMode(vf("clip.mp4", "EMR/clip.mp4")).matchedId).toBeNull();
    });

    it("an unseen trailing mode letter still pairs: channel from A/B, mode from the folder", () => {
        // The corpus is EMR-only, so every observed name ends in E; the trailing
        // letter mirrors the mode folder and normal clips will carry another
        // value. Pinning E would un-pair them, hence [A-Z] + folder-decided mode.
        const normalPath = "Movie/20260807191037_000100AAN.MP4";
        expect(classifyFilenameChannel(vf("20260807191037_000100AAN.MP4", normalPath))).toEqual({
            channel: "front",
            confident: false,
        });
        expect(classifyFilenameMode(vf("20260807191037_000100AAN.MP4", normalPath))).toBe("normal");
        expect(cameraFingerprint(vf("20260807191037_000100AAN.MP4", normalPath)), "A/B pair converges").toBe(
            cameraFingerprint(vf("20260807191037_000101ABN.MP4", "Movie/20260807191037_000101ABN.MP4")),
        );
        expect(
            cameraFingerprint(vf("20260807191037_000100AAN.MP4", normalPath)),
            "an event clip of the same camera shares the key (mode letter + folder are per-clip)",
        ).toBe(cameraFingerprint(vf("20260807191037_000922AAE.MP4", frontPath)));
    });

    it("360CARDVR REC clips expose normal mode and the camera counter", () => {
        const file = vf("20260824205434_000001AAN.MP4", "G300H/360CARDVR/REC/20260824205434_000001AAN.MP4");
        expect(matchFilenameMode(file)).toEqual({ value: "normal", matchedId: "fitcamx-mode" });
        expect(matchFilenameSequence(file)).toEqual({ value: 1, matchedId: "fitcamx-sequence" });
        expect(matchFilenameTime(file).matchedId).toBe("generic-datetime");
        expect(matchFilenameChannel(file).matchedId).toBe("fitcamx-channel");
    });

    it("negative: RX_FITCAMX_MP4 pins the suffix language", () => {
        expect(RX_FITCAMX_MP4.test("20260807191037_000922AAE.ts")).toBe(false); // .mp4 only
        expect(RX_FITCAMX_MP4.test("20260807191037_000922ACEE.MP4")).toBe(false); // one mode letter
        expect(RX_FITCAMX_MP4.test("20260807191037_000922BAE.MP4")).toBe(false); // leading letter is literal A
        expect(RX_FITCAMX_MP4.test("20260807191037_000922AA1.MP4")).toBe(false); // trailing slot is a letter
        expect(RX_FITCAMX_MP4.test("20260807191037_000922F.MP4")).toBe(false); // single letter = RedTiger
        // The single-letter .MP4 twin stays with RedTiger.
        expect(matchFilenameChannel(vf("20260807191037_000922F.MP4")).matchedId).toBe("redtiger-channel");
    });
});

describe("classify shortcuts return value only", () => {
    it("classifyFilenameTime returns the Date", () => {
        const time = classifyFilenameTime(vf("NO20240429-182640F.MP4"));
        expect(time).toBeInstanceOf(Date);
    });

    it("classifyFilenameChannel returns the ChannelMatch", () => {
        expect(classifyFilenameChannel(vf("NO20240429-182640B.MP4"))).toEqual({ channel: "rear", confident: true });
    });

    it("classifyFilenameMode returns the RecordingMode", () => {
        expect(classifyFilenameMode(vf("20211011_141314_EF.mp4"))).toBe("event");
    });

    it("classifyFilenameSequence returns the number", () => {
        expect(classifyFilenameSequence(vf("REC20250607-180617-527-A.mp4"))).toBe(527);
    });
});

describe("classifyFilenameTimelapse", () => {
    it("flags 70mai A510 LA clips (flat drop) and the Lapse/ folder (foldered)", () => {
        expect(classifyFilenameTimelapse(vf("LA20240517-113611-000495F.MP4"))).toBe(true);
        expect(
            classifyFilenameTimelapse(
                vf("NO20240509-134909-000016F.MP4", "Movie/Lapse/Front/NO20240509-134909-000016F.MP4"),
            ),
        ).toBe(true);
    });

    it("does not flag other 70mai modes (NO/EV/PA)", () => {
        expect(classifyFilenameTimelapse(vf("NO20240509-134909-000016F.MP4"))).toBe(false);
        expect(classifyFilenameTimelapse(vf("EV20240509-134909-000016F.MP4"))).toBe(false);
        expect(classifyFilenameTimelapse(vf("PA20240522-105412-001496F.MP4"))).toBe(false);
    });

    it("flags DDPai time-lapse (S_/Q_ prefix)", () => {
        expect(classifyFilenameTimelapse(vf("S_20260101120000_0001_0100.mp4"))).toBe(true);
        expect(classifyFilenameTimelapse(vf("Q_20260101120000_0001_0100.mp4"))).toBe(true);
    });

    it("the two-letter LA prefix alone does not claim a foreign name", () => {
        // No 70mai shape (RX_70MAI gates the prefix branch) -> not time-lapse.
        expect(classifyFilenameTimelapse(vf("LATE-night-clip.mp4"))).toBe(false);
        expect(classifyFilenameTimelapse(vf("video.mp4"))).toBe(false);
    });
});

describe("timestamp-channel TS mode suffixes", () => {
    it.each([
        ["", "video", "normal"],
        ["_SOS", "event", "event"],
        ["_PARK", "park", "parking"],
    ])("recognizes both channels with %s suffix", (suffix, folder, mode) => {
        const front = vf(`20260904_202849F${suffix}.ts`, `card/${folder}/F/20260904_202849F${suffix}.ts`);
        const rear = vf(`20260904_202849R${suffix}.ts`, `card/${folder}/R/20260904_202849R${suffix}.ts`);
        expect(matchFilenameTime(front).matchedId).toBe("juscar-time");
        expect(classifyFilenameTime(front)?.getFullYear()).toBe(2026);
        expect(classifyFilenameChannel(front)?.channel).toBe("front");
        expect(classifyFilenameChannel(rear)?.channel).toBe("rear");
        expect(classifyFilenameMode(front)).toBe(mode);
        expect(classifyFilenameMode(vf(front.file.name))).toBe(mode);
        expect(classifyFilenameSequence(front)).toBeNull();
        expect(cameraFingerprint(front)).toBe(cameraFingerprint(rear));
        expect(cameraFingerprint(front)).toBe(
            cameraFingerprint(vf("20260904_202849F.ts", "card/video/F/20260904_202849F.ts")),
        );
        expect(cameraFingerprint(front)).not.toBe(
            cameraFingerprint(vf(rear.file.name, `other/${folder}/R/${rear.file.name}`)),
        );
    });

    it("does not claim unknown suffixes", () => {
        expect(matchFilenameTime(vf("20260904_202849F_OTHER.ts")).matchedId).not.toBe("juscar-time");
    });
});
