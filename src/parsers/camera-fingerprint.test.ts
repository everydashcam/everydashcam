import { describe, expect, it } from "vitest";

import { cameraFingerprint, _internal } from "./camera-fingerprint.js";
import type { VendorFile } from "./types.js";

function vf(name: string, relativePath: string = name): VendorFile {
    return { file: new File([new Uint8Array(0)], name), relativePath };
}

describe("cameraFingerprint - cross-channel identity", () => {
    it("70mai: front and rear of one camera share a fingerprint", () => {
        const front = cameraFingerprint(vf("NO20260429-182640F.MP4", "Movie/Normal/Front/NO20260429-182640F.MP4"));
        const rear = cameraFingerprint(vf("NO20260429-182640B.MP4", "Movie/Normal/Back/NO20260429-182640B.MP4"));
        const interior = cameraFingerprint(
            vf("NO20260429-182640I.MP4", "Movie/Normal/Interior/NO20260429-182640I.MP4"),
        );
        expect(front).toBe(rear);
        expect(front).toBe(interior);
    });

    it("70mai A810 lite: Normal/Event front & rear all converge to one fingerprint", () => {
        // The A810 lite INTERLEAVES event clips inside the normal loop: an event
        // fires and it writes the EV clip INSTEAD of the normal segment (zero
        // overlap, zero gap). So NO/EV are recording modes of ONE camera, not two
        // cameras - they must share a fingerprint or one continuous drive
        // fragments into NO/EV/NO/EV trips. The NO/EV prefix and the Normal/Event
        // folder both fold away; front and rear converge as before. The sidebar
        // mode chip still distinguishes the segments within the trip.
        const normalFront = cameraFingerprint(
            vf("NO20260101-120000F.MP4", "Movie/Normal/Front/NO20260101-120000F.MP4"),
        );
        const normalRear = cameraFingerprint(vf("NO20260101-120000R.MP4", "Movie/Normal/Rear/NO20260101-120000R.MP4"));
        const eventFront = cameraFingerprint(vf("EV20260101-120000F.MP4", "Movie/Event/Front/EV20260101-120000F.MP4"));
        const eventRear = cameraFingerprint(vf("EV20260101-120000R.MP4", "Movie/Event/Rear/EV20260101-120000R.MP4"));
        expect(normalFront).toBe(normalRear);
        expect(normalFront).toBe(eventFront);
        expect(normalFront).toBe(eventRear);
    });

    it("70mai A810: Lapse/ and Parking/ mode folders fold into the Normal fingerprint", () => {
        // Real A810 card layout: G:/Normal|Event|Lapse|Parking/<Front|Rear>/.
        // Mode folders are per-clip attributes, not camera identity - a PA/LA
        // clip must share the fingerprint of its NO siblings, or the parking
        // captures render as a phantom second camera.
        const normal = cameraFingerprint(
            vf("NO20260716-162456-000635F.MP4", "G:/Normal/Front/NO20260716-162456-000635F.MP4"),
        );
        const lapse = cameraFingerprint(
            vf("LA20260714-145315-000295F.MP4", "G:/Lapse/Front/LA20260714-145315-000295F.MP4"),
        );
        const parking = cameraFingerprint(
            vf("PA20260715-084006-000379F.MP4", "G:/Parking/Front/PA20260715-084006-000379F.MP4"),
        );
        const parkingRear = cameraFingerprint(
            vf("PA20260715-084006-000379R.MP4", "G:/Parking/Rear/PA20260715-084006-000379R.MP4"),
        );
        expect(lapse).toBe(normal);
        expect(parking).toBe(normal);
        expect(parkingRear).toBe(normal);
    });

    it("70mai: same fingerprint across different timestamps from one camera", () => {
        const a = cameraFingerprint(vf("NO20260429-182640F.MP4", "Movie/Normal/Front/NO20260429-182640F.MP4"));
        const b = cameraFingerprint(vf("NO20260429-182645F.MP4", "Movie/Normal/Front/NO20260429-182645F.MP4"));
        expect(a).toBe(b);
    });

    it("70mai: two distinct SDs in one drop stay separate", () => {
        const cam1 = cameraFingerprint(vf("NO20260429-182640F.MP4", "cam1/Movie/Normal/Front/NO20260429-182640F.MP4"));
        const cam2 = cameraFingerprint(vf("NO20260429-182640F.MP4", "cam2/Movie/Normal/Front/NO20260429-182640F.MP4"));
        expect(cam1).not.toBe(cam2);
    });

    it.each([
        ["70mai", "Normal", "NO20260101-120000F.MP4"],
        ["Navitel", "Normal", "FILE260101-120000-000001F.ts"],
        ["Vueroid", "INF", "20260101_120000_INF_F_N.mp4"],
    ])("%s: a mode folder preserves enclosing Front and Rear device roots", (_family, mode, name) => {
        const roots = ["", "Front", "Rear"];
        const fingerprints = roots.map((root) => cameraFingerprint(vf(name, `${root}/${mode}/${name}`)));
        expect(new Set(fingerprints).size).toBe(roots.length);
    });

    it("BlackVue: front, rear, interior share a fingerprint", () => {
        const front = cameraFingerprint(vf("20211011_141314_NF.mp4", "BlackVue/Record/20211011_141314_NF.mp4"));
        const rear = cameraFingerprint(vf("20211011_141314_NR.mp4", "BlackVue/Record/20211011_141314_NR.mp4"));
        const interior = cameraFingerprint(vf("20211011_141314_NI.mp4", "BlackVue/Record/20211011_141314_NI.mp4"));
        expect(front).toBe(rear);
        expect(front).toBe(interior);
    });

    it("BlackVue: timestamp differs but camera key is stable", () => {
        const a = cameraFingerprint(vf("20211011_141314_NF.mp4", "BlackVue/Record/20211011_141314_NF.mp4"));
        const b = cameraFingerprint(vf("20211011_151215_NF.mp4", "BlackVue/Record/20211011_151215_NF.mp4"));
        expect(a).toBe(b);
    });

    it("timestamp plus channel-letter MP4: front, rear and interior share a fingerprint", () => {
        const front = cameraFingerprint(vf("20260101_120000F.MP4"));
        expect(front).toBe(cameraFingerprint(vf("20260101_120000R.MP4")));
        expect(front).toBe(cameraFingerprint(vf("20260101_120000I.MP4")));
        expect(front).toBe(cameraFingerprint(vf("20260101_120300I.MP4")));
    });

    it("timestamp plus channel-letter MP4: channel folders share a fingerprint within one card", () => {
        const front = cameraFingerprint(vf("20260101_120000F.MP4", "card/Front/20260101_120000F.MP4"));
        const rear = cameraFingerprint(vf("20260101_120000R.MP4", "card/Rear/20260101_120000R.MP4"));
        const interior = cameraFingerprint(vf("20260101_120000I.MP4", "card/Inside/20260101_120000I.MP4"));
        expect(front).toBe(rear);
        expect(front).toBe(interior);
        expect(front).not.toBe(cameraFingerprint(vf("20260101_120000I.MP4", "other/Inside/20260101_120000I.MP4")));
    });

    it("timestamp plus channel-letter MP4: preserves a camera root matching one channel letter", () => {
        const front = "20260101_120000F.MP4";
        const rear = "20260101_120000R.MP4";
        const fingerprint = cameraFingerprint(vf(front, `F/Front/${front}`));
        expect(fingerprint).toBe(cameraFingerprint(vf(rear, `F/Rear/${rear}`)));
        expect(fingerprint).not.toBe(cameraFingerprint(vf(front, `Front/${front}`)));
    });

    it("70mai: removes a suffix channel folder without consuming the camera root", () => {
        const front = "NO20260101-120000F.MP4";
        const extra = "NO20260101-120000X.MP4";
        const fingerprint = cameraFingerprint(vf(front, `X/Normal/Front/${front}`));
        expect(fingerprint).toBe(cameraFingerprint(vf(extra, `X/Normal/X/${extra}`)));
        expect(fingerprint).not.toBe(cameraFingerprint(vf(extra, `Normal/X/${extra}`)));
    });

    it.each(["card", "F", "R", "RO"])("VIOFO: locked channel folders retain the %s camera root", (root) => {
        const front = "2026_0101_120000_001F.MP4";
        const rear = "2026_0101_120000_001R.MP4";
        const fingerprint = cameraFingerprint(vf(front, `${root}/F/${front}`));
        expect(fingerprint).toBe(cameraFingerprint(vf(front, `${root}/F/RO/${front}`)));
        expect(fingerprint).toBe(cameraFingerprint(vf(rear, `${root}/R/RO/${rear}`)));
        expect(fingerprint).not.toBe(cameraFingerprint(vf(front, `F/RO/${front}`)));
    });

    it("REC family: every channel folder shares the same card and mode key", () => {
        const name = "REC20260101-120000-228.mp4";
        const fingerprints = ["A", "B", "C", "D", "F", "R", "X"].map((letter) =>
            cameraFingerprint(vf(name, `card/Normal/${letter}/${name}`)),
        );
        expect(new Set(fingerprints).size).toBe(1);
    });

    it("REC family: F/R channels and interleaved modes share a fingerprint", () => {
        const paths = [
            "Normal/F/REC20260913-125420-1370.mp4",
            "Normal/R/REC20260913-125420-1334.mp4",
            "Event/F/SOS20260913-125521-1371.mp4",
            "Event/R/SOS20260913-125521-1335.mp4",
            "Parking/F/PAR20260913-120859-0.mp4",
            "Parking/R/PAR20260913-120859-0.mp4",
        ];
        const fingerprints = paths.map((path) => cameraFingerprint(vf(path.split("/").at(-1)!, `card/${path}`)));
        expect(new Set(fingerprints)).toEqual(new Set(["rec-single|card|REC#-#-#.mp#"]));
    });

    it("REC family: removes only the final mode and channel folders", () => {
        const name = "REC20260913-125420-1370.mp4";
        const roots = ["", "F", "R", "Normal", "other", "card/F", "card/R"];
        const fingerprints = roots.map((root) => cameraFingerprint(vf(name, `${root}/Normal/F/${name}`)));
        expect(new Set(fingerprints).size).toBe(roots.length);
        expect(fingerprints).toEqual(roots.map((root) => `rec-single|${root}|REC#-#-#.mp#`));
    });

    it("REC family: leaves arbitrary F/R directories and flat mode prefixes distinct", () => {
        const normal = "REC20260913-125420-1370.mp4";
        const event = "SOS20260913-125521-1371.mp4";
        expect(cameraFingerprint(vf(normal, `card/F/${normal}`))).not.toBe(
            cameraFingerprint(vf(normal, `card/R/${normal}`)),
        );
        expect(cameraFingerprint(vf(normal))).not.toBe(cameraFingerprint(vf(event)));
        expect(cameraFingerprint(vf("clip.mp4", "card/Normal/F/clip.mp4"))).not.toBe(
            cameraFingerprint(vf("clip.mp4", "card/Normal/R/clip.mp4")),
        );
    });

    it("CarCam 4CH: A/B/C/D channels share a fingerprint", () => {
        const a = cameraFingerprint(vf("REC20250607-180617-527-A.mp4", "normal/a/REC20250607-180617-527-A.mp4"));
        const b = cameraFingerprint(vf("REC20250607-180617-527-B.mp4", "normal/b/REC20250607-180617-527-B.mp4"));
        const c = cameraFingerprint(vf("REC20250607-180617-527-C.mp4", "normal/c/REC20250607-180617-527-C.mp4"));
        const d = cameraFingerprint(vf("REC20250607-180617-515-D.mp4", "normal/d/REC20250607-180617-515-D.mp4"));
        // A/B/C share key (D has an independent sequence counter, but channel-key
        // strips both the letter and the path folder, so the masked name still
        // shares the family pattern).
        expect(a).toBe(b);
        expect(a).toBe(c);
        expect(a).toBe(d);
    });

    it("SStar CHn: CH1/CH2/CH3 across per-channel folders share a fingerprint, distinct from another card", () => {
        // Real card layout from a diagnostic report: E:/Normal/CH<n>/CH<n>-...TS.
        // Digit-masking folds CH1/CH2/CH3 -> CH# in the name; the camera-key
        // strips the per-channel CH<n> folder, so all three converge.
        const ch1 = cameraFingerprint(vf("CH1-20260618-130336.TS", "E:/Normal/CH1/CH1-20260618-130336.TS"));
        const ch2 = cameraFingerprint(vf("CH2-20260618-130336.TS", "E:/Normal/CH2/CH2-20260618-130336.TS"));
        const ch3 = cameraFingerprint(vf("CH3-20260618-130336.TS", "E:/Normal/CH3/CH3-20260618-130336.TS"));
        expect(ch1).toBe(ch2);
        expect(ch1).toBe(ch3);
        // A different clip of the same camera (later timestamp) keeps the key.
        const ch1Later = cameraFingerprint(vf("CH1-20260618-130635.TS", "E:/Normal/CH1/CH1-20260618-130635.TS"));
        expect(ch1Later).toBe(ch1);
        // Event/ is a different mode folder (not stripped) -> its own fingerprint,
        // so event clips form their own trip until interleaving is confirmed.
        const eventCh1 = cameraFingerprint(vf("CH1-20260618-130336.TS", "E:/Event/CH1/CH1-20260618-130336.TS"));
        expect(eventCh1).not.toBe(ch1);
    });

    it("Wolfbox: F/I/R across the per-channel SD folders share a fingerprint", () => {
        const front = cameraFingerprint(vf("2026_03_15_173951_02_F.MP4", "front_emer/2026_03_15_173951_02_F.MP4"));
        const interior = cameraFingerprint(vf("2026_03_15_173951_02_I.MP4", "extra_emer/2026_03_15_173951_02_I.MP4"));
        const rear = cameraFingerprint(vf("2026_03_15_173951_02_R.MP4", "rear_emer/2026_03_15_173951_02_R.MP4"));
        expect(front).toBe(interior);
        expect(front).toBe(rear);
    });

    it("Wolfbox: two SD roots in one drop stay separate", () => {
        const cam1 = cameraFingerprint(vf("2026_03_15_173951_00_F.MP4", "cam1/front_norm/2026_03_15_173951_00_F.MP4"));
        const cam2 = cameraFingerprint(vf("2026_03_15_173951_00_F.MP4", "cam2/front_norm/2026_03_15_173951_00_F.MP4"));
        expect(cam1).not.toBe(cam2);
    });

    it("Tesla SavedClips: all cameras of one event share a fingerprint", () => {
        const front = cameraFingerprint(vf("front.mp4", "TeslaCam/SavedClips/2026-04-29_18-30-15/front.mp4"));
        const back = cameraFingerprint(vf("back.mp4", "TeslaCam/SavedClips/2026-04-29_18-30-15/back.mp4"));
        const repeater = cameraFingerprint(
            vf("left_repeater.mp4", "TeslaCam/SavedClips/2026-04-29_18-30-15/left_repeater.mp4"),
        );
        expect(front).toBe(back);
        expect(front).toBe(repeater);
    });

    it("Tesla SavedClips: different events stay separate", () => {
        const ev1 = cameraFingerprint(vf("front.mp4", "TeslaCam/SavedClips/2026-04-29_18-30-15/front.mp4"));
        const ev2 = cameraFingerprint(vf("front.mp4", "TeslaCam/SavedClips/2026-04-29_20-12-00/front.mp4"));
        expect(ev1).not.toBe(ev2);
    });

    it("Tesla RecentClips: all cameras of the same moment share a fingerprint", () => {
        const front = cameraFingerprint(
            vf("2026-04-29_18-26-00-front.mp4", "TeslaCam/RecentClips/2026-04-29_18-26-00-front.mp4"),
        );
        const back = cameraFingerprint(
            vf("2026-04-29_18-26-00-back.mp4", "TeslaCam/RecentClips/2026-04-29_18-26-00-back.mp4"),
        );
        expect(front).toBe(back);
    });

    it("Juscar: front (folder + F letter) and rear (folder + R letter) share a fingerprint", () => {
        const front = cameraFingerprint(vf("20260429_182640F.ts", "video/front/20260429_182640F.ts"));
        const rear = cameraFingerprint(vf("20260429_182640R.ts", "video/rear/20260429_182640R.ts"));
        expect(front).toBe(rear);
    });

    it("Juscar: retains camera roots named after mode or channel folders", () => {
        const roots = ["", "F", "R", "front", "rear", "video", "event", "park", "card/F", "card/R"];
        for (const [folder, channel, suffix] of [
            ["video", "F", ""],
            ["event", "rear", "_SOS"],
            ["park", "R", "_PARK"],
        ]) {
            const name = `20260904_202849${channel === "F" ? "F" : "R"}${suffix}.ts`;
            const fingerprints = roots.map((root) =>
                cameraFingerprint(vf(name, `${root}/${folder}/${channel}/${name}`)),
            );
            expect(new Set(fingerprints).size, `${folder}/${channel}`).toBe(roots.length);
            expect(fingerprints).toEqual(roots.map((root) => `juscar|${root}|#_#.ts`));
        }
    });

    it("DDPai: normal front and `_A` rear share a fingerprint", () => {
        const front = cameraFingerprint(vf("20190719161640_0060.mp4", "DCIM/100video/20190719161640_0060.mp4"));
        const rear = cameraFingerprint(vf("20190719161640_0060_A.mp4", "DCIM/100video/20190719161640_0060_A.mp4"));
        expect(front).toBe(rear);
    });

    it("DDPai: timelapse S_ (front) and Q_ (rear) share a fingerprint", () => {
        const front = cameraFingerprint(vf("S_20190719161640_120_30.mp4", "DCIM/100video/S_20190719161640_120_30.mp4"));
        const rear = cameraFingerprint(vf("Q_20190719161640_120_30.mp4", "DCIM/100video/Q_20190719161640_120_30.mp4"));
        expect(front).toBe(rear);
    });

    it("iBox: F/R/I channels share a fingerprint", () => {
        const front = cameraFingerprint(vf("FILE201104-163014F.mov", "Movie/Normal/Front/FILE201104-163014F.mov"));
        const rear = cameraFingerprint(vf("FILE201104-163014R.mov", "Movie/Normal/Rear/FILE201104-163014R.mov"));
        expect(front).toBe(rear);
    });

    it("MiVue dual: F/R files in single-letter folders share a fingerprint", () => {
        const front = cameraFingerprint(vf("FILE260819-071804F.mp4", "F/FILE260819-071804F.mp4"));
        const rear = cameraFingerprint(vf("FILE260819-071804R.mp4", "R/FILE260819-071804R.mp4"));
        expect(front).toBe(rear);
    });

    it("Novatek VIOFO: F/R/I channels share a fingerprint", () => {
        const front = cameraFingerprint(vf("2023_0821_180010_062F.MP4", "DCIM/2023_0821_180010_062F.MP4"));
        const rear = cameraFingerprint(vf("2023_0821_180010_062R.MP4", "DCIM/2023_0821_180010_062R.MP4"));
        expect(front).toBe(rear);
    });

    it("Novatek VIOFO: impact-locked EF/ER share a fingerprint, distinct from plain F", () => {
        // The E mode letter stays in the mask (same deliberate choice as P
        // today: cameraKey is not mode-aware) - so EF/ER converge with each
        // other but not with the no-letter normal clip.
        const ef = cameraFingerprint(vf("2023_0412_111213_0042EF.MP4", "DCIM/Movie/2023_0412_111213_0042EF.MP4"));
        const er = cameraFingerprint(vf("2023_0412_111213_0042ER.MP4", "DCIM/Movie/2023_0412_111213_0042ER.MP4"));
        const plain = cameraFingerprint(vf("2023_0412_111213_0042F.MP4", "DCIM/Movie/2023_0412_111213_0042F.MP4"));
        expect(ef).toBe(er);
        expect(ef).not.toBe(plain);
    });

    it("Novatek VIOFO: RO locked clip shares a fingerprint with its Movie/ sibling", () => {
        const locked = cameraFingerprint(vf("2023_0412_111213_0042F.MP4", "DCIM/Movie/RO/2023_0412_111213_0042F.MP4"));
        const normal = cameraFingerprint(vf("2023_0412_111213_0042F.MP4", "DCIM/Movie/2023_0412_111213_0042F.MP4"));
        expect(locked).toBe(normal);
    });

    it.each(["DCIM/Movie", "card/Front", "card/Rear"])(
        "Novatek single-channel: RO locked clips share the %s normal fingerprint",
        (folder) => {
            // Real A119 name from the a119_join.py:22 comment.
            const name = "2016_1224_094105_116.MP4";
            const locked = cameraFingerprint(vf(name, `${folder}/RO/${name}`));
            const normal = cameraFingerprint(vf(name, `${folder}/${name}`));
            expect(locked).toBe(normal);
        },
    );

    it("Vantrue: A/B/C channels share a fingerprint", () => {
        const front = cameraFingerprint(vf("20211011_141314_0001_N_A.MP4", "DCIM/20211011_141314_0001_N_A.MP4"));
        const interior = cameraFingerprint(vf("20211011_141314_0001_N_B.MP4", "DCIM/20211011_141314_0001_N_B.MP4"));
        const rear = cameraFingerprint(vf("20211011_141314_0001_N_C.MP4", "DCIM/20211011_141314_0001_N_C.MP4"));
        expect(front).toBe(interior);
        expect(front).toBe(rear);
    });

    it("Nextbase: F/R/B channels of one quality stream share a fingerprint", () => {
        const front = cameraFingerprint(vf("180919_100959_001_FH.MP4"));
        const rear = cameraFingerprint(vf("180919_100959_001_RH.MP4"));
        const cabin = cameraFingerprint(vf("180919_100959_001_BH.MP4"));
        expect(front).toBe(rear);
        expect(front).toBe(cabin);
    });

    it("Nextbase: H and L parallel streams keep SEPARATE fingerprints (deliberate)", () => {
        // Collapsing H+L would put the low-bitrate stream on the same channel
        // slot as the high one and spawn |dupN frames; two parallel trips is
        // the safe degradation. Quality letter masks literally into the key.
        const high = cameraFingerprint(vf("180919_100959_001_FH.MP4"));
        const low = cameraFingerprint(vf("180919_100959_001_FL.MP4"));
        expect(high).not.toBe(low);
        // Digit-masking also hits the extension digit, hence `.MP#`.
        expect(high).toBe("nextbase||#_#_#_H.MP#");
        expect(low).toBe("nextbase||#_#_#_L.MP#");
    });

    it("Thinkware: F/R share a fingerprint", () => {
        const front = cameraFingerprint(vf("REC_20210101_120000_F.mp4"));
        const rear = cameraFingerprint(vf("REC_20210101_120000_R.mp4"));
        expect(front).toBe(rear);
    });

    it("Navitel: optional channel suffix strips identically", () => {
        const a = cameraFingerprint(vf("FILE201104-163014-000429.mov"));
        const b = cameraFingerprint(vf("FILE201104-163014-000429F.mov"));
        expect(a).toBe(b);
    });

    it("Ford built-in: front and rear (and any other channel letter) share a fingerprint", () => {
        // The reason the family exists: without stripping the channel letter,
        // `_f` and `_r` would mask to different fingerprints and never pair into
        // one multichannel frame (they would instead become two sequential
        // frames of an over-long trip - the exact bug this guards against).
        const front = cameraFingerprint(vf("2026-06-14_16_16_18_f.ts", "FordFootage/2026-06-14_16_16_18_f.ts"));
        const rear = cameraFingerprint(vf("2026-06-14_16_16_18_r.ts", "FordFootage/2026-06-14_16_16_18_r.ts"));
        const other = cameraFingerprint(vf("2026-06-14_16_16_18_x.ts", "FordFootage/2026-06-14_16_16_18_x.ts"));
        expect(front).toBe(rear);
        expect(front).toBe(other);
    });

    it("Ford built-in: same fingerprint across different timestamps from one camera", () => {
        const a = cameraFingerprint(vf("2026-06-14_16_16_18_f.ts", "FordFootage/2026-06-14_16_16_18_f.ts"));
        const b = cameraFingerprint(vf("2026-06-14_16_19_18_f.ts", "FordFootage/2026-06-14_16_19_18_f.ts"));
        expect(a).toBe(b);
    });

    it("unknown filename falls back to mask + parentDir", () => {
        expect(cameraFingerprint(vf("VID20240101_120000.mp4"))).toBe("VID#_#.mp#|");
        expect(cameraFingerprint(vf("random.mp4", "weird/random.mp4"))).toBe("random.mp#|weird");
    });

    it("two different formats with the same masked name do NOT collide", () => {
        // The id prefix in camera-key ensures format isolation. Without it,
        // an unfamiliar "20211011_141314_NF.mp4" outside a BlackVue folder
        // could collide with whatever else masks the same way.
        const blackvue = cameraFingerprint(vf("20211011_141314_NF.mp4"));
        expect(blackvue.startsWith("blackvue|")).toBe(true);
    });
});

describe("parentDir helper", () => {
    it("flat name -> empty string", () => {
        expect(_internal.parentDir("file.mp4")).toBe("");
    });

    it("one folder level -> that folder", () => {
        expect(_internal.parentDir("Movie/file.mp4")).toBe("Movie");
    });

    it("several levels -> the entire enclosing path", () => {
        expect(_internal.parentDir("A/B/C/file.mp4")).toBe("A/B/C");
    });

    it("empty segments are ignored", () => {
        expect(_internal.parentDir("A//B/file.mp4")).toBe("A/B");
        expect(_internal.parentDir("/A/B/file.mp4")).toBe("A/B");
    });

    it("trailing slash does not confuse", () => {
        expect(_internal.parentDir("A/B/file.mp4/")).toBe("A/B");
    });
});
