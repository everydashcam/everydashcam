#!/usr/bin/env node
import { parseArgs } from "node:util";
// Anonymizes an MP4 file from any dashcam for use as a test fixture. Goal:
// keep the structural properties the parser depends on (codec, resolution,
// fps, ISOBMFF container, overall MP4 structure), and strip location, time,
// and user identity (video frames, audio, embedded GPS if present).
//
// This is NOT a pass-through anonymization of the original. The script builds
// a brand new MP4 via ffmpeg testsrc2 + a sine source, matching the exact
// codec/resolution/fps of the original. The original's embedded GPS boxes do
// not carry over into the output - if the vendor writes GPS inside the MP4,
// parser tests need it reinjected separately via --embedded-gps-handler
// (see below).
//
// What it does:
//  1. Reads codec/resolution/fps of the original via ffprobe.
//  2. Builds a 2-second MP4 via ffmpeg: video = testsrc2 (SMPTE bars + a
//     running frame counter - unambiguously identifiable as a test signal),
//     audio = 1kHz sine -20dB. Encoded with the same codec/resolution/fps as
//     the original.
//  3. Optionally calls a vendor-specific embedded-gps-handler to reinject
//     zeroed GPS boxes.
//
// What it does NOT do:
//  - Does not shift creation_time/timestamps. These fields aren't sensitive
//    without coordinates and real video content (see SKILL.md).
//  - Does not modify the filename - it's given as the second argument and
//    carries no sensitive data.
//
// Run:
//   node scripts/anonymize-mp4.mjs <input.mp4> <output.mp4>
//   node scripts/anonymize-mp4.mjs <input.mp4> <output.mp4> --embedded-gps-handler <path-to-handler.mjs>
//
// Dependencies: ffmpeg + ffprobe in PATH. On macOS - "brew install ffmpeg".

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { exit } from "node:process";

const FIXTURE_DURATION_SEC = 2;
const AUDIO_FREQ_HZ = 1000;
const AUDIO_VOLUME_DB = -20;

function usage() {
    console.error(
        "usage: node scripts/anonymize-mp4.mjs <input.mp4> <output.mp4> [--embedded-gps-handler <path>] [--crf <n>]",
    );
    exit(1);
}

function ensureBinary(name) {
    const r = spawnSync(name, ["-version"], { stdio: "ignore" });
    if (r.error || r.status !== 0) {
        console.error(
            `${name} not found in PATH. install via "brew install ffmpeg" (macOS) or distro package manager.`,
        );
        exit(1);
    }
}

// Returns video properties plus the non-sensitive container creation time.
// fps as a number (rounded to an integer if ffprobe returns a fraction like 30000/1001).
function probeVideo(input) {
    const r = spawnSync(
        "ffprobe",
        [
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=codec_name,width,height,r_frame_rate:format_tags=creation_time",
            "-of",
            "json",
            input,
        ],
        { encoding: "utf8" },
    );
    if (r.status !== 0) {
        console.error("ffprobe failed:", r.stderr);
        exit(1);
    }
    const data = JSON.parse(r.stdout);
    const stream = data.streams?.[0];
    if (!stream) {
        console.error("no video stream in input");
        exit(1);
    }
    const [num, den] = (stream.r_frame_rate || "30/1").split("/").map(Number);
    const fps = den ? num / den : 30;
    const creationTime = typeof data.format?.tags?.creation_time === "string" ? data.format.tags.creation_time : null;
    return {
        codec: stream.codec_name,
        width: stream.width,
        height: stream.height,
        fps: Math.round(fps),
        creationTime,
    };
}

// Maps ffprobe codec_name -> ffmpeg encoder. Covers codecs that actually
// show up in dashcam recorders.
function pickEncoder(codecName) {
    switch (codecName) {
        case "h264":
            return "libx264";
        case "hevc":
            return "libx265";
        case "mpeg4":
            return "mpeg4";
        default:
            console.error(`unsupported source codec ${codecName}. add mapping in pickEncoder.`);
            exit(1);
    }
}

function buildFfmpegArgs(probe, output, crf) {
    const encoder = pickEncoder(probe.codec);
    // CRF is meaningful for the libx26x encoders only; mpeg4 ignores it.
    const quality = crf !== null && encoder !== "mpeg4" ? ["-crf", String(crf)] : [];
    return [
        "-y",
        // Video source: testsrc2 gives color bars + a running frame counter -
        // unambiguously identifiable as a test signal.
        "-f",
        "lavfi",
        "-i",
        `testsrc2=size=${probe.width}x${probe.height}:rate=${probe.fps}:duration=${FIXTURE_DURATION_SEC}`,
        // Audio source: 1kHz sine. -20dB so whoever accidentally opens the
        // fixture doesn't blow their speakers.
        "-f",
        "lavfi",
        "-i",
        `sine=frequency=${AUDIO_FREQ_HZ}:sample_rate=48000:duration=${FIXTURE_DURATION_SEC}`,
        "-filter:a",
        `volume=${AUDIO_VOLUME_DB}dB`,
        "-c:v",
        encoder,
        ...quality,
        "-preset",
        "ultrafast",
        "-c:a",
        "aac",
        "-b:a",
        "64k",
        "-t",
        String(FIXTURE_DURATION_SEC),
        ...(probe.creationTime ? ["-metadata", `creation_time=${probe.creationTime}`] : []),
        output,
    ];
}

async function main() {
    const { values, positionals } = parseArgs({
        allowPositionals: true,
        options: {
            "embedded-gps-handler": { type: "string" },
            crf: { type: "string" },
        },
    });
    if (positionals.length !== 2) usage();
    const [input, output] = positionals.map((path) => resolve(path));
    const embeddedGpsHandler = values["embedded-gps-handler"] ? resolve(values["embedded-gps-handler"]) : null;
    // High-resolution synthetic fixtures may need a higher CRF to fit the fixture budget.
    const crf = values.crf === undefined ? null : Number(values.crf);

    if (!existsSync(input)) {
        console.error(`input not found: ${input}`);
        exit(1);
    }

    ensureBinary("ffmpeg");
    ensureBinary("ffprobe");

    const probe = probeVideo(input);
    console.log(`source: ${probe.codec} ${probe.width}x${probe.height} @ ${probe.fps}fps`);

    const ffmpegArgs = buildFfmpegArgs(probe, output, crf);
    console.log("ffmpeg", ffmpegArgs.join(" "));
    const r = spawnSync("ffmpeg", ffmpegArgs, { stdio: "inherit" });
    if (r.status !== 0) {
        console.error("ffmpeg failed");
        exit(1);
    }
    console.log(`wrote synthetic mp4 to ${output}`);

    if (embeddedGpsHandler) {
        if (!existsSync(embeddedGpsHandler)) {
            console.error(`embedded gps handler not found: ${embeddedGpsHandler}`);
            exit(1);
        }
        // Handler contract: default export = async function ({ originalInput, fixtureOutput }) -> void.
        // The handler reads the original itself, zeroes coordinates in the embedded structures, and reinjects into fixtureOutput.
        const mod = await import(embeddedGpsHandler);
        if (typeof mod.default !== "function") {
            console.error("embedded gps handler must default-export an async function");
            exit(1);
        }
        await mod.default({ originalInput: input, fixtureOutput: output });
        console.log(`embedded gps reinjected via ${embeddedGpsHandler}`);
    }
}

main().catch((err) => {
    console.error(err);
    exit(1);
});
