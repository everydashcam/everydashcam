#!/usr/bin/env node
import { parseArgs } from "node:util";
// Trims an MP4 to the first N seconds via ffmpeg stream-copy. Unlike
// scripts/anonymize-mp4.mjs (which rewrites the container from scratch via
// testsrc2 + sine), trim-mp4 KEEPS all original tracks including custom
// data tracks (gpmd for GoPro, PNDM for Garmin, freeGPS for Novatek-in-MP4,
// etc.) - parser tests for embedded GPS need them.
//
// When to use it:
//  - For public samples under an explicit open-source license (gopro/gpmf-parser
//    samples under Apache 2.0) - content already isn't sensitive, we just need
//    it more compact. Trim yields a fixture ~10x smaller.
//  - For personal samples - DO NOT USE. Original video frames and audio stay
//    untouched; private files need anonymize-mp4.mjs (full re-encode to a
//    test pattern).
//
// Run:
//   node scripts/trim-mp4.mjs <input.mp4> <output.mp4> [duration_sec] [--keep-data-tag <fourcc>]
//
// duration_sec defaults to 2.
//
// By default only video + audio streams are copied (ffmpeg can't re-mux
// data tracks like tmcd/fdsc into an mp4 output without re-encoding). To
// keep a specific data track (e.g. gpmd for GoPro GPMF, PNDM for Garmin),
// pass --keep-data-tag gpmd - the script finds the stream index via ffprobe
// and adds it to -map.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { exit } from "node:process";

function usage() {
    console.error("usage: node scripts/trim-mp4.mjs <input> <output> [duration_sec=2]");
    exit(1);
}

function ensureBinary(name) {
    const r = spawnSync(name, ["-version"], { stdio: "ignore" });
    if (r.error || r.status !== 0) {
        console.error(`${name} not found in PATH`);
        exit(1);
    }
}

function main() {
    const { values, positionals } = parseArgs({
        allowPositionals: true,
        options: {
            "keep-data-tag": { type: "string" },
        },
    });
    if (positionals.length < 2 || positionals.length > 3) usage();
    const [input, output] = positionals.slice(0, 2).map((path) => resolve(path));
    const duration = Number(positionals[2] ?? 2);
    const keepDataTag = values["keep-data-tag"] ?? null;
    if (!Number.isFinite(duration) || duration <= 0) usage();

    if (!existsSync(input)) {
        console.error(`input not found: ${input}`);
        exit(1);
    }

    ensureBinary("ffmpeg");
    ensureBinary("ffprobe");

    // Find the index of the data stream with the requested codec_tag via ffprobe.
    let dataStreamIndex = null;
    if (keepDataTag) {
        const r = spawnSync(
            "ffprobe",
            ["-v", "error", "-show_entries", "stream=index,codec_tag_string", "-of", "json", input],
            { encoding: "utf8" },
        );
        if (r.status !== 0) {
            console.error("ffprobe failed:", r.stderr);
            exit(1);
        }
        const data = JSON.parse(r.stdout);
        for (const s of data.streams ?? []) {
            if (s.codec_tag_string === keepDataTag) {
                dataStreamIndex = s.index;
                break;
            }
        }
        if (dataStreamIndex === null) {
            console.error(`no data stream with codec_tag '${keepDataTag}' found`);
            exit(1);
        }
    }

    // -map 0:v -map 0:a - all video + audio. Optionally + 0:<idx> for data.
    // Without this (instead of a bare -map 0) ffmpeg complains about
    // tmcd/fdsc it can't remux into mp4.
    const mapArgs = ["-map", "0:v", "-map", "0:a"];
    if (dataStreamIndex !== null) {
        mapArgs.push("-map", `0:${dataStreamIndex}`);
    }
    const ffArgs = [
        "-y",
        "-i",
        input,
        "-t",
        String(duration),
        ...mapArgs,
        "-c",
        "copy",
        "-movflags",
        "+faststart",
        output,
    ];
    const r = spawnSync("ffmpeg", ffArgs, { stdio: "inherit" });
    if (r.status !== 0) {
        console.error("ffmpeg failed");
        exit(1);
    }
    console.log(`trimmed ${duration}s to ${output}`);
}

main();
