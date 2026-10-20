// Tests for the declarative GPS-source-hints registry.
//
// Guarantees:
//  - Escort/DDPai files (basename-sidecar) DO NOT trigger embedded extraction
//    even when no records exist yet (no sidecar -> embedded won't help either;
//    the point is not to read 16 MB for nothing).
//  - Tesla/FitCamX files (none formats) DO NOT trigger embedded.
//  - GoPro/Novatek/Carcam/Navitel/iBox/BlackVue/Juscar/Thinkware/70mai (embedded
//    formats) DO trigger embedded. 70mai is embedded because newer 4K models
//    (A810/M500) embed a 70mai freeGPS block; older $V02-CSV models are caught
//    first by the csv-70mai log-sidecar pass (records exist -> embedded skipped).
//  - Generic .mp4 with no recognised pattern -> unknown -> try (safe default).
//  - Files that already have records (from any source) skip embedded.

import { describe, expect, it } from "vitest";

import { classifyGpsSource, resolveSourceCollision, shouldTryEmbeddedGps } from "./gps-source-hints.js";
import type { VendorFile } from "./types.js";

function vf(name: string, relativePath: string = name): VendorFile {
    return { file: new File([new Uint8Array(0)], name), relativePath };
}

describe("classifyGpsSource", () => {
    it.each(["F", "R"])("probes embedded GPS in INNOVV K3 channel %s", (suffix) => {
        const name = `20260101_120000_${suffix}.MP4`;
        for (const file of [vf(name), vf(name, `card/VIDEO/${name}`)]) {
            expect(classifyGpsSource(file)).toBe("embedded");
            expect(shouldTryEmbeddedGps(file, false)).toBe(true);
            expect(shouldTryEmbeddedGps(file, true)).toBe(false);
        }
    });

    it.each(["20260904_202849F.ts", "20260904_235813R_SOS.ts", "20260902_174435F_PARK.ts"])(
        "keeps embedded probing enabled for %s",
        (name) => {
            expect(classifyGpsSource(vf(name))).toBe("embedded");
            expect(shouldTryEmbeddedGps(vf(name), false)).toBe(true);
        },
    );

    it("basename-sidecar formats", () => {
        expect(classifyGpsSource(vf("20240429_1830_CAM.mp4"))).toBe("basename-sidecar"); // Escort
        expect(classifyGpsSource(vf("20190719161640_0060.mp4"))).toBe("basename-sidecar"); // DDPai normal
        expect(classifyGpsSource(vf("S_20190719161640_120_30.mp4"))).toBe("basename-sidecar"); // DDPai timelapse
        expect(classifyGpsSource(vf("G_20190719161640_0060_L.mp4"))).toBe("basename-sidecar"); // DDPai event
        expect(classifyGpsSource(vf("FILE260625-144859.MP4"))).toBe("basename-sidecar"); // Mio/Navman MiVue (.NMEA)
    });

    it("mivue single and F/R-folder dual variants use the NMEA sidecar hint", () => {
        expect(classifyGpsSource(vf("FILE260625-144859.MP4"))).toBe("basename-sidecar"); // MiVue
        expect(classifyGpsSource(vf("FILE260819-071804F.mp4", "F/FILE260819-071804F.mp4"))).toBe("basename-sidecar");
        expect(classifyGpsSource(vf("FILE260819-071804R.mp4", "R/FILE260819-071804R.mp4"))).toBe("basename-sidecar");
        // A flat channel-suffixed name stays ambiguous and therefore keeps the
        // permissive iBox embedded hint; exact NMEA records still win before it.
        expect(classifyGpsSource(vf("FILE230422-154515F.MOV"))).toBe("embedded"); // iBox
        expect(classifyGpsSource(vf("FILE201104-163014-000429F.mov"))).toBe("embedded"); // Navitel
    });

    it("embedded formats", () => {
        expect(classifyGpsSource(vf("080546_828_023_D.mp4"))).toBe("embedded");
        expect(shouldTryEmbeddedGps(vf("080546_828_023_D.mp4"), false)).toBe(true);
        expect(classifyGpsSource(vf("2026-08-03_11_34_53_f.mp4"))).toBe("embedded"); // Beferich J18 (ligogps trailer)
        expect(classifyGpsSource(vf("2026-08-03_11_34_53_r.mp4"))).toBe("embedded"); // Beferich rear suffix
        expect(classifyGpsSource(vf("20211011_141314_NF.mp4"))).toBe("embedded"); // BlackVue X
        expect(classifyGpsSource(vf("REC20250607-180617-527-A.mp4"))).toBe("embedded"); // Carcam
        expect(classifyGpsSource(vf("REC20260902-231922-661.mp4"))).toBe("embedded"); // iZEEKER KTRX ssmd
        expect(classifyGpsSource(vf("FILE201104-163014-000429F.mov"))).toBe("embedded"); // Navitel
        expect(classifyGpsSource(vf("FILE260817-180301-000004F.TS"))).toBe("embedded"); // Navitel .TS spelling
        expect(classifyGpsSource(vf("FILE230422-154515F.MOV"))).toBe("embedded"); // iBox (gps0 tail-atoms)
        expect(classifyGpsSource(vf("2023_0821_180010_062F.MP4"))).toBe("embedded"); // Novatek VIOFO
        // Viofo E (impact) / T (telephoto) letters ride the same novatek hint.
        expect(classifyGpsSource(vf("2023_0412_111213_0042EF.MP4"))).toBe("embedded");
        expect(classifyGpsSource(vf("2023_0412_111213_0042PT.MP4"))).toBe("embedded");
        // Nextbase: subtitle-track NMEA (322GW+) / freeGPS (512GW).
        expect(classifyGpsSource(vf("180919_100959_001_FH.MP4"))).toBe("embedded");
        expect(classifyGpsSource(vf("20211011_141314_0001_N_A.MP4"))).toBe("embedded"); // Vantrue
        expect(classifyGpsSource(vf("20260429_182640F.ts"))).toBe("embedded"); // Juscar
        expect(classifyGpsSource(vf("20260825093511_001359F.MP4"))).toBe("embedded"); // RedTiger YOUQINGGPS
        expect(classifyGpsSource(vf("REC_20210101_120000_F.mp4"))).toBe("embedded"); // Thinkware
        // 70mai: embedded for newer 4K models (A810/M500). Older $V02-CSV models
        // are handled first by the csv-70mai log-sidecar pass.
        expect(classifyGpsSource(vf("NO20240702-094820-000029F.MP4"))).toBe("embedded"); // 70mai A810
        expect(classifyGpsSource(vf("NO20260101-120000-000042C.MP4"))).toBe("embedded"); // 70mai T800 cabin
        expect(classifyGpsSource(vf("NO20260428-200501-000897-20260429120347.mp4"))).toBe("embedded"); // 70mai M500
    });

    it.each(["REC20260913-125420-1370.mp4", "SOS20260913-125521-1371.mp4", "PAR20260913-120859-0.mp4"])(
        "keeps the embedded probe available for the REC family %s",
        (name) => {
            for (const file of [vf(name), vf(name, `card/Normal/F/${name}`)]) {
                expect(classifyGpsSource(file)).toBe("embedded");
                expect(shouldTryEmbeddedGps(file, false)).toBe(true);
                expect(shouldTryEmbeddedGps(file, true)).toBe(false);
            }
        },
    );

    it("70mai A510 LA/PA prefixes and the pre-stamp channel letter ride the same embedded hint", () => {
        // The hint gates on the shared RX_70MAI, so the widened regex (LA/PA
        // parking prefixes, channel letter BEFORE the app-export trailing
        // stamp) must reach the embedded probe with no hint-side change.
        expect(classifyGpsSource(vf("LA20260101-120000-000495F.MP4"))).toBe("embedded");
        expect(classifyGpsSource(vf("PA20260101-120000-001496F.MP4"))).toBe("embedded");
        expect(classifyGpsSource(vf("NO20260101-120000-000195R-20260101120642.mp4"))).toBe("embedded");
    });

    it("neoline / vueroid / novatek-ts filename shapes classify embedded", () => {
        expect(classifyGpsSource(vf("INF20260520-214526-1-F.mp4"))).toBe("embedded"); // Neoline Spectrum (sstar-ssmd)
        expect(classifyGpsSource(vf("20251111_085423_INF_F_N.mp4"))).toBe("embedded"); // Vueroid (vueroid-txet)
        expect(classifyGpsSource(vf("20210318153933_000188.TS"))).toBe("embedded"); // Novatek PES in MPEG-TS
        // The lowercase-extension twin must ride the same case-insensitive regex.
        expect(classifyGpsSource(vf("20210318153933_000188.ts"))).toBe("embedded");
    });

    it("seq-fri family: the .ts shape is embedded (LigoGPS trailer), the .mov trio stays unknown", () => {
        expect(classifyGpsSource(vf("20260813211138_0000002F.ts", "video/F/20260813211138_0000002F.ts"))).toBe(
            "embedded",
        );
        expect(classifyGpsSource(vf("20260813211138_0000002R.ts"))).toBe("embedded");
        // No GPS-carrying .mov sample yet - the default embedded probe stays on.
        expect(classifyGpsSource(vf("20260811083704_0000826F.mov"))).toBe("unknown");
    });

    it("ligogps trailer TS suffix family classifies embedded", () => {
        expect(classifyGpsSource(vf("2026081822373512_f.ts", "VIDEO_F/2026081822373512_f.ts"))).toBe("embedded");
        expect(classifyGpsSource(vf("2026081822373512_r.TS", "VIDEO_R/2026081822373512_r.TS"))).toBe("embedded");
    });

    it("recording-scoped NMEA camera path classifies as log-sidecar", () => {
        expect(classifyGpsSource(vf("MAH00384.MP4", "H:/MP_ROOT/100ANV01/MAH00384.MP4"))).toBe("log-sidecar");
        expect(classifyGpsSource(vf("MAH00384.MP4", "H:\\MP_ROOT\\100ANV01\\MAH00384.MP4"))).toBe("log-sidecar");
        expect(classifyGpsSource(vf("MAH00384.MP4"))).toBe("unknown");
    });

    it("360CARDVR MP4 uses the whole-session JSONL log only inside its card layout", () => {
        const file = vf("20260824205434_000001AAN.MP4", "G300H/360CARDVR/REC/20260824205434_000001AAN.MP4");
        expect(classifyGpsSource(file)).toBe("log-sidecar");
        expect(shouldTryEmbeddedGps(file, false)).toBe(false);
        expect(classifyGpsSource(vf("20260824205434_000001AAN.MP4"))).toBe("unknown");
    });

    it("viofo names with no sequence counter keep the novatek embedded hint", () => {
        // T130 parking clips and some OEM firmwares drop the counter
        // (`..._F.mp4` / `..._PR.mp4`); freeGPS is real-sample-validated in
        // them, so the optional-seq RX_NOVATEK_VIOFO must stay inside
        // isNovatekFamilyFilename's embedded gate.
        expect(classifyGpsSource(vf("2026_0708_180332_F.MP4"))).toBe("embedded");
        expect(classifyGpsSource(vf("2022_0224_132829_PR.MP4"))).toBe("embedded");
    });

    it("Novatek NVT-IM MOV keeps the probe enabled for GPS hardware variants", () => {
        for (const name of ["2026_0809_222334_654A.MOV", "2026_0826_070216_437.MOV"]) {
            const file = vf(name, `MOVIE/${name}`);
            expect(classifyGpsSource(file)).toBe("embedded");
            expect(shouldTryEmbeddedGps(file, false)).toBe(true);
        }
    });

    it("none formats (no embedded GPS / not yet implemented)", () => {
        expect(classifyGpsSource(vf("20260511134011_073648A.TS"))).toBe("none"); // FitCamX
        expect(classifyGpsSource(vf("front.mp4", "TeslaCam/SentryClips/2026-04-29_18-30-15/front.mp4"))).toBe("none");
        // Ford: claimed only inside FordFootage/ (the generic name alone is not enough).
        expect(classifyGpsSource(vf("2026-04-29_18_26_00_f.ts", "FordFootage/2026-04-29_18_26_00_f.ts"))).toBe("none");
        // HP f969x: OSD-only GPS, the declared private data streams stay empty.
        expect(classifyGpsSource(vf("HPIM20260811-170040F.TS", "Normal/F/HPIM20260811-170040F.TS"))).toBe("none");
    });

    it("ford lookalike name outside FordFootage/ is unclaimed (generic .ts shape)", () => {
        expect(classifyGpsSource(vf("2026-04-29_18_26_00_f.ts"))).toBe("unknown");
        expect(classifyGpsSource(vf("2026-04-29_18_26_00_f.ts", "SomeOtherCam/2026-04-29_18_26_00_f.ts"))).toBe(
            "unknown",
        );
    });

    it("E-Ace flipped to embedded once the freeGPS Type-4 RC4 variant landed", () => {
        expect(classifyGpsSource(vf("20240429_182640F.mp4"))).toBe("embedded");
        expect(classifyGpsSource(vf("20260101_120000I.mp4"))).toBe("embedded");
        expect(classifyGpsSource(vf("20260101_120000X.mp4"))).toBe("embedded");
    });

    it("Tesla RecentClips - timestamp in the filename", () => {
        expect(
            classifyGpsSource(
                vf("2026-04-29_18-26-00-front.mp4", "TeslaCam/RecentClips/2026-04-29_18-26-00-front.mp4"),
            ),
        ).toBe("none");
    });

    it("unknown for generic .mp4 without a recognised pattern", () => {
        expect(classifyGpsSource(vf("random.mp4"))).toBe("unknown");
        expect(classifyGpsSource(vf("GH010001.MP4"))).toBe("unknown"); // GoPro (no distinctive name)
        expect(classifyGpsSource(vf("clip.mp4"))).toBe("unknown");
    });
});

describe("shouldTryEmbeddedGps", () => {
    it("embedded source without records - try", () => {
        const carcam = vf("REC20250607-180617-527-A.mp4");
        expect(shouldTryEmbeddedGps(carcam, false)).toBe(true);
    });

    it("embedded source with records - skip (avoid duplicates)", () => {
        const carcam = vf("REC20250607-180617-527-A.mp4");
        expect(shouldTryEmbeddedGps(carcam, true)).toBe(false);
    });

    it("redtiger uses embedded YOUQINGGPS", () => {
        const redtiger = vf("20260825093511_001359F.MP4");
        expect(classifyGpsSource(redtiger)).toBe("embedded");
        expect(shouldTryEmbeddedGps(redtiger, false)).toBe(true);
        expect(shouldTryEmbeddedGps(redtiger, true)).toBe(false);
    });

    it("70mai - embedded probe when no CSV records, skipped once CSV records exist", () => {
        // Newer 4K 70mai (A810/M500) embed freeGPS: probe when nothing parsed yet.
        // Older $V02-CSV models produce records first, which short-circuits the probe.
        const mai70 = vf("NO20240702-094820-000029F.MP4");
        expect(shouldTryEmbeddedGps(mai70, false)).toBe(true);
        expect(shouldTryEmbeddedGps(mai70, true)).toBe(false);
        // A510 parking clips (LA/PA prefixes) carry the same embedded freeGPS.
        const mai70Parking = vf("LA20260101-120000-000495F.MP4");
        expect(shouldTryEmbeddedGps(mai70Parking, false)).toBe(true);
    });

    it("precisely-shaped basename-sidecar source - skip regardless of records", () => {
        // Escort's `<8>_<4>_CAM.mp4` is distinctive, so the hard skip stands even
        // without records (no sidecar -> embedded won't help, don't read 16 MB).
        const escort = vf("20240429_1830_CAM.mp4");
        expect(shouldTryEmbeddedGps(escort, false)).toBe(false);
        expect(shouldTryEmbeddedGps(escort, true)).toBe(false);
    });

    it("recording-scoped NMEA path skips an unnecessary embedded probe", () => {
        const sony = vf("MAH00384.MP4", "MP_ROOT/100ANV01/MAH00384.MP4");
        expect(shouldTryEmbeddedGps(sony, false)).toBe(false);
        expect(shouldTryEmbeddedGps(sony, true)).toBe(false);
    });

    it("generic-shaped basename-sidecar (ddpai-normal, mivue) - probe when no records, skip once records exist", () => {
        // `<14>_<counter>.mp4` and `FILE<yymmdd>-<hhmmss>` are shared with cameras
        // that DO embed GPS, so a lookalike must still be probed when its sidecar
        // is absent/unparsed (no records). Once records exist the skip is trusted.
        const ddpaiNormal = vf("20190719161640_0060.mp4");
        expect(shouldTryEmbeddedGps(ddpaiNormal, false)).toBe(true);
        expect(shouldTryEmbeddedGps(ddpaiNormal, true)).toBe(false);
        const ddpaiNewChannel = vf("20190719161640_0060_X.mp4");
        expect(shouldTryEmbeddedGps(ddpaiNewChannel, false)).toBe(true);

        const mivue = vf("FILE260625-144859.MP4");
        expect(shouldTryEmbeddedGps(mivue, false)).toBe(true);
        expect(shouldTryEmbeddedGps(mivue, true)).toBe(false);

        const mivueDualRear = vf("FILE260819-071804R.mp4", "R/FILE260819-071804R.mp4");
        expect(shouldTryEmbeddedGps(mivueDualRear, false)).toBe(true);
        expect(shouldTryEmbeddedGps(mivueDualRear, true)).toBe(false);

        // The distinctive ddpai variants (timelapse S_/Q_, event G_..._L) keep the
        // unconditional skip - only the generic "normal" shape was demoted.
        const ddpaiTimelapse = vf("S_20190719161640_120_30.mp4");
        expect(shouldTryEmbeddedGps(ddpaiTimelapse, false)).toBe(false);
        const ddpaiEvent = vf("G_20190719161640_0060_L.mp4");
        expect(shouldTryEmbeddedGps(ddpaiEvent, false)).toBe(false);
    });

    it("ddpai-normal 6/7-digit counters (Novatek-family OEMs) keep the embedded probe alive", () => {
        // Fujida Karma / Roadgid Tube name their clips `<14>_<6-7 digit
        // counter>` and keep freeGPS INSIDE the MP4 - the widened
        // RX_DDPAI_NORMAL must stay on the probeIfNoRecords path, or their
        // embedded GPS would be silently skipped.
        const sixDigit = vf("20260101120000_000551.MP4");
        expect(classifyGpsSource(sixDigit)).toBe("basename-sidecar");
        expect(shouldTryEmbeddedGps(sixDigit, false)).toBe(true);
        expect(shouldTryEmbeddedGps(sixDigit, true)).toBe(false);

        const sevenDigit = vf("20260101120000_0000013.MP4");
        expect(classifyGpsSource(sevenDigit)).toBe("basename-sidecar");
        expect(shouldTryEmbeddedGps(sevenDigit, false)).toBe(true);
    });

    it("ford is claimed only inside FordFootage/ - a lookalike .ts elsewhere is probed", () => {
        // The name shape `YYYY-MM-DD_HH_MM_SS_x.ts` is generic; the folder is the
        // real signal. Inside FordFootage/ the file is a known GPS-less .ts (skip);
        // the identical name outside is unclaimed -> probe when no records.
        const fordInside = vf("2026-04-29_18_26_00_f.ts", "FordFootage/2026-04-29_18_26_00_f.ts");
        expect(shouldTryEmbeddedGps(fordInside, false)).toBe(false);
        expect(shouldTryEmbeddedGps(fordInside, true)).toBe(false);

        const lookalikeOutside = vf("2026-04-29_18_26_00_f.ts");
        expect(shouldTryEmbeddedGps(lookalikeOutside, false)).toBe(true);
    });

    it("none source - skip always", () => {
        const tesla = vf("front.mp4", "TeslaCam/SentryClips/2026-04-29_18-30-15/front.mp4");
        expect(shouldTryEmbeddedGps(tesla, false)).toBe(false);
        expect(shouldTryEmbeddedGps(tesla, true)).toBe(false);
    });

    it("unknown source - try when no records yet, skip otherwise", () => {
        const generic = vf("GH010001.MP4");
        expect(shouldTryEmbeddedGps(generic, false)).toBe(true);
        expect(shouldTryEmbeddedGps(generic, true)).toBe(false);
    });

    it("keeps the enciphered LigoGPS PES clip probe-able for when its TXT log is missing", () => {
        const clip = vf("2026_10_18_130426_00.TS");
        expect(classifyGpsSource(clip)).toBe("unknown");
        expect(shouldTryEmbeddedGps(clip, false)).toBe(true);
        expect(shouldTryEmbeddedGps(clip, true), "the TXT twin already supplied records").toBe(false);
    });
});

// Production regexes are mostly disjoint, so real-world collisions are rare.
// These tests pin the priority logic so a future hint that overlaps cannot
// silently turn an "embedded" file into a "none" skip.
describe("resolveSourceCollision (tie-breaking)", () => {
    it("empty matched list -> unknown", () => {
        expect(resolveSourceCollision([])).toBe("unknown");
    });

    it("embedded beats log-sidecar (most permissive wins)", () => {
        expect(resolveSourceCollision(["log-sidecar", "embedded"])).toBe("embedded");
        expect(resolveSourceCollision(["embedded", "log-sidecar"])).toBe("embedded");
    });

    it("embedded beats basename-sidecar", () => {
        expect(resolveSourceCollision(["basename-sidecar", "embedded"])).toBe("embedded");
    });

    it("embedded beats none", () => {
        expect(resolveSourceCollision(["none", "embedded"])).toBe("embedded");
    });

    it("log-sidecar beats none", () => {
        expect(resolveSourceCollision(["none", "log-sidecar"])).toBe("log-sidecar");
    });

    it("basename-sidecar beats none", () => {
        expect(resolveSourceCollision(["none", "basename-sidecar"])).toBe("basename-sidecar");
    });

    it("log-sidecar and basename-sidecar are siblings - first wins (deterministic)", () => {
        // Equal priority. Behavioral contract: stable order by argument position.
        expect(resolveSourceCollision(["log-sidecar", "basename-sidecar"])).toBe("log-sidecar");
        expect(resolveSourceCollision(["basename-sidecar", "log-sidecar"])).toBe("basename-sidecar");
    });

    it("single matched source returns as-is", () => {
        expect(resolveSourceCollision(["embedded"])).toBe("embedded");
        expect(resolveSourceCollision(["none"])).toBe("none");
        expect(resolveSourceCollision(["log-sidecar"])).toBe("log-sidecar");
    });
});
