#!/usr/bin/env node
// Derive a native-resolution small-plate case from the existing synthetic scene.
// Usage: node scripts/make-small-plate-motion-fixture.mjs [--slow] [--crisp]

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const outputDir = resolve(dirname(fileURLToPath(import.meta.url)), "../tests/testdata/detector-motion");
const source = JSON.parse(readFileSync(resolve(outputDir, "long-motion.json"), "utf8"));
const width = 1920;
const height = 1080;
const sceneWidth = 256;
const sceneHeight = 144;
const sceneX = 780;
const sceneY = 600;
const repeatFrames = process.argv.includes("--slow") ? 2 : 1;
const crisp = process.argv.includes("--crisp");
const resizeFilter = crisp ? "neighbor" : "lanczos";
const filename = `small-plate${crisp ? "-crisp" : ""}${repeatFrames === 2 ? "-slow" : ""}-motion.mp4`;
const annotationFilename = filename.replace(/\.mp4$/, ".json");

execFileSync("ffmpeg", [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    resolve(outputDir, source.filename),
    "-vf",
    `scale=${sceneWidth}:${sceneHeight}:flags=${resizeFilter},pad=${width}:${height}:${sceneX}:${sceneY}:color=0x4d4d4d` +
        (repeatFrames === 1 ? "" : `,setpts=${repeatFrames}*PTS,fps=${source.fps}`),
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
    String(source.fps),
    "-bf",
    "0",
    "-movflags",
    "+faststart",
    resolve(outputDir, filename),
]);
const frames = source.frames.flatMap((frame, frameIndex) =>
    Array.from({ length: repeatFrames }, (_, duplicateIndex) => ({
        contentSec: (frameIndex * repeatFrames + duplicateIndex) / source.fps,
        plates: frame.plates.map((box) => ({
            xPct: (sceneX + box.xPct * sceneWidth) / width,
            yPct: (sceneY + box.yPct * sceneHeight) / height,
            wPct: (box.wPct * sceneWidth) / width,
            hPct: (box.hPct * sceneHeight) / height,
        })),
    })),
);
writeFileSync(
    resolve(outputDir, annotationFilename),
    `${JSON.stringify({ filename, width, height, fps: source.fps, durationSec: source.durationSec * repeatFrames, frames }, null, 2)}\n`,
);
execFileSync(process.execPath, [
    resolve(outputDir, "../../../node_modules/@biomejs/biome/bin/biome"),
    "format",
    resolve(outputDir, annotationFilename),
    "--write",
]);
writeFileSync(
    resolve(outputDir, `${filename}.source.md`),
    "# Synthetic small-plate detection fixture\n\n" +
        "Source: [fixture generator](../../../scripts/make-small-plate-motion-fixture.mjs), derived solely from [the synthetic plate scene](plate-motion-long.mp4.source.md).\n\n" +
        `The mathematical scene is resized to 256×144 using ${crisp ? "nearest-neighbor sampling to preserve the procedural glyph contrast" : "Lanczos filtering"} and placed at (780, 600) on a uniform 1920×1080 canvas. The invented plate is 48×12 source pixels and moves 16 pixels every ${repeatFrames} frame(s), including across a detector tile overlap. It appears from ${1.2 * repeatFrames} to ${1.6 * repeatFrames} seconds. ${repeatFrames > 1 ? "Each original frame is repeated twice; this exercises reverse tracking through multiple bounded frame-buffer blocks. " : ""}Annotation coordinates describe the exact continuous resize transform. This is a resolution and tracking regression, not a natural dashcam accuracy benchmark.\n\n` +
        "Contains no real footage, person, vehicle, GPS, private data or external source material. The repository license applies.\n",
);
