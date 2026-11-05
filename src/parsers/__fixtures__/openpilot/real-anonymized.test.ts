// End-to-end parse of two anonymized real openpilot segments (comma four,
// openpilot 0.11.2, comma connect download). The qlogs keep the real
// frame-index events of the first three seconds and GPS and clock events of the
// first ten, byte for byte, with coordinates rounded to whole degrees and
// altitude zeroed, in a streamed zstd frame like loggerd's; videos are ffmpeg
// test patterns with the frame count the log indexes. Regenerate with:
//   node scripts/anonymize-openpilot-segment.mjs <...--19--qlog.zst> \
//     src/parsers/__fixtures__/openpilot 0123456789abcdef_00000001--0000000000--19
//   node scripts/anonymize-openpilot-segment.mjs <...--20--qlog.zst> \
//     src/parsers/__fixtures__/openpilot 0123456789abcdef_00000001--0000000000--20 --videos qcamera

import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
    associateRecordsWithVideos,
    bindRecordsByFilename,
    type LogVideoTimingHint,
    resolveLogVideoTimingHints,
} from "../../../gps-association.js";
import { mergeIntoGpsLog } from "../../../parser.js";
import { vendorFileKey } from "../../../vendor-file-key.js";
import { cameraFingerprint } from "../../camera-fingerprint.js";
import {
    classifyFilenameChannel,
    classifyFilenameRecordingKey,
    classifyFilenameSequence,
    classifyFilenameTime,
} from "../../filename/index.js";
import { classifyGpsSource, shouldTryEmbeddedGps } from "../../gps-source-hints.js";
import { openpilotLogPrimitive } from "../../primitives/openpilot-log.js";
import type { PrimitiveVideoRef } from "../../primitives/types.js";
import { isVideoFile, splitVideosByExtension } from "../../registry-light.js";
import type { VendorFile } from "../../types.js";
import { expectPlausibleGpsTrack } from "../helpers.js";

const DIR = dirname(fileURLToPath(import.meta.url));
const PREFIX = "0123456789abcdef_00000001--0000000000";
const FIXTURE_NAMES = readdirSync(DIR).filter((name) => name.startsWith(PREFIX));

function fixture(name: string): VendorFile {
    return { file: new File([readFileSync(resolve(DIR, name))], name), relativePath: `comma/${name}` };
}

function knownVideos(segment: number): PrimitiveVideoRef[] {
    return FIXTURE_NAMES.filter((name) => name.includes(`--${segment}--`) && !name.endsWith(".zst")).map((name) => ({
        name,
        relativePath: `comma/${name}`,
        videoKey: `key:${name}`,
    }));
}

async function parseSegment(segment: number) {
    return await openpilotLogPrimitive.parse(fixture(`${PREFIX}--${segment}--qlog.zst`), undefined, undefined, {
        knownVideos: knownVideos(segment),
    });
}

// Frame 0 of segment 19, from the full real qlog: the anonymized window must
// not move it.
const SEGMENT_19_START = Date.parse("2026-11-03T08:57:23.943Z") / 1000;

describe("openpilot real-anonymized segments", () => {
    it("holds both segments' files", () => {
        expect(FIXTURE_NAMES.sort()).toEqual([
            `${PREFIX}--19--dcamera.hevc`,
            `${PREFIX}--19--ecamera.hevc`,
            `${PREFIX}--19--fcamera.hevc`,
            `${PREFIX}--19--qcamera.TS`,
            `${PREFIX}--19--qlog.zst`,
            `${PREFIX}--20--qcamera.TS`,
            `${PREFIX}--20--qlog.zst`,
        ]);
    });

    it("claims both qlogs by marker", async () => {
        for (const segment of [19, 20]) {
            expect(await openpilotLogPrimitive.marker(fixture(`${PREFIX}--${segment}--qlog.zst`))).toBe(true);
        }
    });

    it("turns the 1 Hz fixes into a track of the full-res road video", async () => {
        const { records } = await parseSegment(19);
        expectPlausibleGpsTrack(records, { minCount: 9 });
        expect(records).toHaveLength(9);
        for (const record of records) {
            expect(record).toMatchObject({
                lat: 39,
                lon: -77,
                speedSource: "measured",
                mp4Filename: `${PREFIX}--19--fcamera.hevc`,
                videoKey: `key:${PREFIX}--19--fcamera.hevc`,
            });
            expect(record.speedMs).toBeGreaterThan(19);
            expect(record.speedMs).toBeLessThan(20);
        }
        const steps = records.slice(1).map((record, i) => record.unixSeconds - records[i]!.unixSeconds);
        for (const step of steps) expect(step).toBeCloseTo(1, 0);
        expect(records[0]!.unixSeconds).toBeCloseTo(SEGMENT_19_START + 1.156, 3);
    });

    it("dates every camera's frame 0 and counts the raw streams' frames", async () => {
        const hints = (await parseSegment(19)).videoTimingHints ?? [];
        expect(hints.map((hint) => [hint.mp4Filename, hint.videoKey, hint.durationSec])).toEqual([
            [`${PREFIX}--19--fcamera.hevc`, `key:${PREFIX}--19--fcamera.hevc`, 3],
            [`${PREFIX}--19--ecamera.hevc`, `key:${PREFIX}--19--ecamera.hevc`, 3],
            [`${PREFIX}--19--dcamera.hevc`, `key:${PREFIX}--19--dcamera.hevc`, 3],
            [`${PREFIX}--19--qcamera.TS`, `key:${PREFIX}--19--qcamera.TS`, null],
        ]);
        const [front, wide, driver, preview] = hints.map((hint) => hint.startUtc!);
        // The reference is rounded to the millisecond; the median over the
        // window's fixes may differ from the full log's by a fraction of one.
        expect(Math.abs(front! - SEGMENT_19_START)).toBeLessThan(0.002);
        // The road cameras share a sensor trigger; the driver camera runs on its own.
        expect(Math.abs(wide! - front!)).toBeLessThan(0.001);
        expect(preview).toBe(front);
        expect(Math.abs(driver! - front!)).toBeLessThan(0.05);
    });

    it("places the next segment one minute later", async () => {
        const [first, next] = await Promise.all([parseSegment(19), parseSegment(20)]);
        const nextPreview = next.videoTimingHints!.find((hint) => hint.mp4Filename.endsWith("--20--qcamera.TS"))!;
        expect(nextPreview.videoKey).toBe(`key:${PREFIX}--20--qcamera.TS`);
        expect(nextPreview.startUtc! - first.videoTimingHints![0]!.startUtc!).toBeCloseTo(60, 2);
        // No fcamera in segment 20: its GPS belongs to the preview.
        expect(next.records[0]!.mp4Filename).toBe(`${PREFIX}--20--qcamera.TS`);
    });

    it("classifies every camera file by its name", () => {
        const expected: Record<string, [string, boolean]> = {
            fcamera: ["front", true],
            ecamera: ["side", false],
            dcamera: ["interior", true],
            qcamera: ["front", true],
        };
        const videos = FIXTURE_NAMES.filter((name) => !name.endsWith(".zst")).map(fixture);
        for (const video of videos) {
            const stream = video.file.name.match(/--(\w+camera)\./)![1]!;
            const channel = classifyFilenameChannel(video);
            expect([channel?.channel, channel?.confident], video.file.name).toEqual(expected[stream]);
            expect(classifyFilenameTime(video), video.file.name).toBeNull();
            expect(classifyGpsSource(video)).toBe("log-sidecar");
            expect(shouldTryEmbeddedGps(video, false)).toBe(false);
        }
        const segment19 = videos.filter((video) => video.file.name.includes("--19--"));
        expect(new Set(segment19.map(classifyFilenameSequence))).toEqual(new Set([19]));
        expect(new Set(segment19.map(classifyFilenameRecordingKey))).toEqual(new Set(["00000001--0000000000--19"]));
        expect(new Set(videos.map(cameraFingerprint))).toEqual(new Set(["openpilot|comma"]));
    });

    it("loads the full-res road video instead of its preview, and the preview where it is alone", () => {
        const files = FIXTURE_NAMES.map(fixture);
        expect(files.filter(isVideoFile).map((file) => file.file.name)).toHaveLength(5);
        const { videoEntries, nonVideo } = splitVideosByExtension(files);
        expect(videoEntries.map((entry) => entry.file.file.name).sort()).toEqual([
            `${PREFIX}--19--dcamera.hevc`,
            `${PREFIX}--19--ecamera.hevc`,
            `${PREFIX}--19--fcamera.hevc`,
            `${PREFIX}--20--qcamera.TS`,
        ]);
        // The superseded preview is left to classification, which finds no role for it.
        expect(nonVideo.map((file) => file.file.name).sort()).toEqual([
            `${PREFIX}--19--qcamera.TS`,
            `${PREFIX}--19--qlog.zst`,
            `${PREFIX}--20--qlog.zst`,
        ]);
    });
});

describe("openpilot device layout, log loaded before its videos", () => {
    const SEGMENT = (segment: number) => `realdata/00000001--0000000000--${segment}`;
    const deviceFile = (fixtureName: string, path: string): VendorFile => ({
        file: new File([readFileSync(resolve(DIR, fixtureName))], path.slice(path.lastIndexOf("/") + 1)),
        relativePath: path,
        sourceKey: "card",
    });

    it("binds the segment's GPS to its own preview, not a sibling segment's road video", async () => {
        const log = deviceFile(`${PREFIX}--20--qlog.zst`, `${SEGMENT(20)}/qlog.zst`);
        const parsed = await openpilotLogPrimitive.parse(log, undefined, undefined, { knownVideos: [] });
        expect(parsed.records).toHaveLength(10);
        expect(new Set(parsed.records.map((record) => record.mp4Filename))).toEqual(new Set(["fcamera.hevc"]));
        associateRecordsWithVideos(parsed.records, log, [], openpilotLogPrimitive.id);

        // A later drop brings segment 20's preview and segment 19's road video.
        const preview = deviceFile(`${PREFIX}--20--qcamera.TS`, `${SEGMENT(20)}/qcamera.ts`);
        const sibling = deviceFile(`${PREFIX}--19--fcamera.hevc`, `${SEGMENT(19)}/fcamera.hevc`);
        const bound = bindRecordsByFilename(
            mergeIntoGpsLog(null, { ...parsed, appliedExtractors: [openpilotLogPrimitive.id] }),
            [sibling, preview],
        );
        expect(bound.boundRecords).toBe(10);
        expect(new Set(bound.log.records.map((record) => record.videoKey))).toEqual(new Set([vendorFileKey(preview)]));
    });
});

describe("openpilot connect download, log loaded before a repeated download of its video", () => {
    it("dates and sizes the renamed full-res file from the log", async () => {
        const log = fixture(`${PREFIX}--19--qlog.zst`);
        const parsed = await openpilotLogPrimitive.parse(log, undefined, undefined, { knownVideos: [] });
        const hints: LogVideoTimingHint[] = (parsed.videoTimingHints ?? []).map((hint) => ({
            ...hint,
            sourcePath: log.relativePath,
            extractorId: openpilotLogPrimitive.id,
        }));
        const renamed: VendorFile = {
            file: new File([readFileSync(resolve(DIR, `${PREFIX}--19--fcamera.hevc`))], `${PREFIX}--19--fcamera (1).hevc`),
            relativePath: `comma/${PREFIX}--19--fcamera (1).hevc`,
        };
        const timing = resolveLogVideoTimingHints(hints, [renamed]);
        expect(timing.get(vendorFileKey(renamed))).toMatchObject({ durationSec: 3 });
        expect(Math.abs(timing.get(vendorFileKey(renamed))!.startUtc! - SEGMENT_19_START)).toBeLessThan(0.002);
    });
});
