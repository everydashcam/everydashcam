// Regression test on the real-anonymized Thinkware F200 PRO front+rear PAIR.
//
// Source recording: REC_2026_06_01_21_16_47_{F,R}.MP4 (one 60 s moment, both
// channels). GPS lives ONLY in the front file's tx3g subtitle track; the real
// rear carries NO subtitle track at all (unlike synthetic-rear.mp4, which pins
// the accel-only-cues variant). Fixtures:
//   - real-anonymized.mp4       - front cues, coords scrubbed (see README.md)
//   - rear stand-in: tests/testdata/dashcam-viewer-corpus/MOV_0581.mp4, a
//     scripts/anonymize-mp4.mjs rebuild (testsrc2 H.264 + sine AAC) with no
//     telemetry track, the shape of the real rear
//
// The pair test guards the channel-anchoring symmetry: the GPS-less rear must
// derive the SAME startUtc as the GPS-bearing front, or the 30 s frame snap in
// groupTrips tears the channels into separate frames (the BlackVue DR550DW
// "first minute front, last minute rear" bug class). On this camera symmetry
// holds through the mvhd branches: mvhd is stamped at recording START in the
// camera's LOCAL clock (== filename time), and the RTC tracks GPS to ~1 s, so
// front (mvhd window-validated against GPS) and rear (mvhd + fleet TZ) agree.
//
// mvhd/duration constants below are the REAL values read off the source pair
// via ffprobe (creation_time 2026-06-01T21:16:47Z local-as-UTC on both,
// duration 60 s); the fixture containers themselves carry a synthetic mvhd, so
// the candidates are built with the real metadata explicitly.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildMp4Index } from "../../internal/mp4-index.js";
import { nmeaSubtitlePrimitive } from "../../primitives/nmea-subtitle.js";
import { classifyFiles, dispatchParseVideoEmbeddedGps } from "../../registry.js";
import { cameraFingerprint } from "../../camera-fingerprint.js";
import { classifyFilenameChannel, classifyFilenameTime } from "../../filename/index.js";
import type { GpsRecord, VendorFile } from "../../types.js";
import {
    groupTrips,
    rederiveStartUtcForCandidates,
    tripChannels,
    type VideoCandidate,
} from "../../../trips.js";

const HERE = dirname(fileURLToPath(import.meta.url));

const FRONT = "REC_2026_06_01_21_16_47_F.MP4";
const REAR = "REC_2026_06_01_21_16_47_R.MP4";
// Real container metadata of the source pair (ffprobe): mvhd creation_time is
// the camera's LOCAL clock stored as UTC, stamped at recording start on BOTH
// channels; clips are 60 s.
const REAL_MVHD = "2026-06-01T21:16:47Z";
const REAL_DURATION_SEC = 60;
const REAR_STAND_IN = "../../../../tests/testdata/dashcam-viewer-corpus/MOV_0581.mp4";

function loadVendorFile(fixture: string, name: string): VendorFile {
    const buf = readFileSync(resolve(HERE, fixture));
    return { file: new File([buf], name), relativePath: name };
}

function makeCandidate(vf: VendorFile, records: GpsRecord[]): VideoCandidate {
    const ch = classifyFilenameChannel(vf);
    return {
        file: vf.file,
        relativePath: vf.relativePath,
        fingerprint: cameraFingerprint(vf),
        appliedExtractors: [],
        classifierMatches: { time: null, channel: null, mode: null, sequence: null },
        channel: ch?.channel ?? null,
        channelConfident: ch?.confident ?? false,
        sequence: null,
        recordingMode: null,
        isTimelapse: false,
        startUtc: 0,
        durationSec: REAL_DURATION_SEC,
        wallDurationSec: null,
        driftLeadSec: null,
        startSource: "mtime",
        cameraTzSec: null,
        createdUtc: new Date(REAL_MVHD),
        records,
        codec: null,
        codecParam: null,
        videoCodecString: null,
        rotation: 0,
        width: null,
        height: null,
        fps: null,
        audio: null,
        canPlay: true,
        needsHevcRemux: false,
        isTransportStream: false,
        isMatroska: false,
        audioNeedsTranscode: false,
        embeddedStartUtcHint: null,
        localClockOffsetHintSec: null,
    };
}

describe("real-anonymized Thinkware F200 PRO rear", () => {
    it("carries no telemetry: no extractor claims it, zero records", async () => {
        const vf = loadVendorFile(REAR_STAND_IN, REAR);
        const classified = await classifyFiles([vf]);
        const result = await dispatchParseVideoEmbeddedGps(classified);
        expect(result.records).toHaveLength(0);
        expect(result.errors).toHaveLength(0);
        expect(result.winningExtractorByFileKey.size).toBe(0);
    });
});

describe("real-anonymized Thinkware F200 PRO front+rear pair", () => {
    it("GPS-less rear anchors with the front and both land in one frame", async () => {
        const frontVf = loadVendorFile("real-anonymized.mp4", FRONT);
        const rearVf = loadVendorFile(REAR_STAND_IN, REAR);

        const index = await buildMp4Index(frontVf.file);
        const parsed = await nmeaSubtitlePrimitive.parse(frontVf, index);
        expect(parsed.records.length).toBeGreaterThanOrEqual(5);

        const front = makeCandidate(frontVf, parsed.records);
        const rear = makeCandidate(rearVf, []);
        // Channel letters must resolve, and the fingerprint must be
        // cross-channel (channel marker stripped) - otherwise the frame key
        // can never join the pair regardless of timing.
        expect(front.channel).toBe("front");
        expect(rear.channel).toBe("rear");
        expect(rear.fingerprint).toBe(front.fingerprint);

        rederiveStartUtcForCandidates([front, rear], classifyFilenameTime);

        // Symmetry: the rear's mvhd+fleet-TZ anchor must land on the same
        // startUtc as the front's GPS-validated one, well inside the 15 s
        // frame-snap radius (the tear threshold).
        expect(Math.abs(front.startUtc - rear.startUtc)).toBeLessThan(2);

        const trips = groupTrips([front, rear], 30);
        expect(trips).toHaveLength(1);
        expect(trips[0]!.frames).toHaveLength(1);
        expect(tripChannels(trips[0]!)).toEqual(["front", "rear"]);
    });
});
