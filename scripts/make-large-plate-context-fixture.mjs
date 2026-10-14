#!/usr/bin/env node
// Derive a large, genuine synthetic plate for full-frame context verification.
// Usage: node scripts/make-large-plate-context-fixture.mjs

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const outputDir = resolve(dirname(fileURLToPath(import.meta.url)), "../tests/testdata/detector-motion");
const source = JSON.parse(readFileSync(resolve(outputDir, "motion.json"), "utf8"));
const sourceFrameIndex = 10;
const sourceBox = source.frames[sourceFrameIndex].plates[0];
const scale = 10;
const width = 1920;
const height = 1080;
const fps = 30;
const frameCount = 6;
const cropX = 1640;
const cropY = 2150;
const filename = "large-plate-context.mp4";
const annotationFilename = "large-plate-context.json";

execFileSync("ffmpeg", [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    resolve(outputDir, source.filename),
    "-vf",
    `select=eq(n\\,${sourceFrameIndex}),scale=${source.width * scale}:${source.height * scale}:flags=neighbor,` +
        `crop=${width}:${height}:${cropX}:${cropY},loop=loop=-1:size=1:start=0,setpts=N/(${fps}*TB)`,
    "-frames:v",
    String(frameCount),
    "-r",
    String(fps),
    "-an",
    "-c:v",
    "libx264",
    "-profile:v",
    "main",
    "-pix_fmt",
    "yuv420p",
    "-crf",
    "12",
    "-preset",
    "slow",
    "-g",
    String(fps),
    "-bf",
    "0",
    "-movflags",
    "+faststart",
    resolve(outputDir, filename),
]);

const plate = {
    xPct: (sourceBox.xPct * source.width * scale - cropX) / width,
    yPct: (sourceBox.yPct * source.height * scale - cropY) / height,
    wPct: (sourceBox.wPct * source.width * scale) / width,
    hPct: (sourceBox.hPct * source.height * scale) / height,
};
writeFileSync(
    resolve(outputDir, annotationFilename),
    `${JSON.stringify({ filename, width, height, fps, durationSec: frameCount / fps, frames: Array.from({ length: frameCount }, (_, index) => ({ contentSec: index / fps, plates: [plate] })) }, null, 2)}\n`,
);
execFileSync(process.execPath, [
    resolve(outputDir, "../../../node_modules/@biomejs/biome/bin/biome"),
    "format",
    resolve(outputDir, annotationFilename),
    "--write",
]);
writeFileSync(
    resolve(outputDir, `${filename}.source.md`),
    "# Synthetic large-plate context fixture\n\n" +
        "Source: [fixture generator](../../../scripts/make-large-plate-context-fixture.mjs), derived solely from [the synthetic plate scene](plate-motion.mp4.source.md).\n\n" +
        "Frame 10 is enlarged tenfold with nearest-neighbor sampling and cropped at (1640, 2150) to 1920×1080. The invented plate occupies (360, 390), with size 1200×300 source pixels; its full-frame detector projection is 400×100 pixels. Six identical frames at 30 fps exercise context verification of a genuine large plate, which must retain coverage instead of being rejected solely for its size. `large-plate-context.json` records the exact geometric transform.\n\n" +
        "Contains no real footage, person, vehicle, GPS, private data or external source material. The repository license applies.\n",
);
