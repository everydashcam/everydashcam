#!/usr/bin/env node
// Animate the credited public-domain portrait crop; no external downloads.
// Usage: node scripts/make-face-detector-motion-fixture.mjs [--rotated]

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const outputDir = resolve(dirname(fileURLToPath(import.meta.url)), "../tests/testdata/detector-motion");
if (process.argv.includes("--rotated")) {
    const temporary = mkdtempSync(resolve(tmpdir(), "face-motion-rotation-"));
    const coded = resolve(temporary, "coded.mp4");
    const rotatedFilename = "face-motion-rotated.mp4";
    try {
        execFileSync("ffmpeg", [
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            resolve(outputDir, "face-motion.mp4"),
            "-vf",
            "transpose=clock",
            "-an",
            "-c:v",
            "libx264",
            "-profile:v",
            "main",
            "-pix_fmt",
            "yuv420p",
            "-crf",
            "8",
            "-preset",
            "slow",
            "-g",
            "30",
            "-bf",
            "0",
            "-movflags",
            "+faststart",
            coded,
        ]);
        execFileSync("ffmpeg", [
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-display_rotation",
            "90",
            "-i",
            coded,
            "-c",
            "copy",
            "-movflags",
            "+faststart",
            resolve(outputDir, rotatedFilename),
        ]);
        writeFileSync(
            resolve(outputDir, `${rotatedFilename}.source.md`),
            "# Rotated public-domain portrait motion fixture\n\n" +
                "Derived only from [the credited public portrait motion fixture](face-motion.mp4.source.md) using [the generator](../../../scripts/make-face-detector-motion-fixture.mjs) with `--rotated`. NASA attribution and public-domain provenance remain in the source links. Contains no user recording or private data.\n\n" +
                "The original decoded frames are rotated clockwise before H.264 Main encoding at CRF 8. The MP4 display matrix then rotates 90 degrees counter-clockwise: coded dimensions are 360×640 and displayed dimensions are 640×360. Displayed positions, timing, and all ground-truth boxes are exactly those in `face-motion.json`; re-encoding may introduce small compression differences. The test exercises rotation-aware drawing of native reverse-buffer samples.\n",
        );
    } finally {
        rmSync(temporary, { recursive: true, force: true });
    }
    process.exit(0);
}
const width = 640;
const height = 360;
const portraitWidth = 170;
const portraitHeight = 190;
const fps = 30;
const frameCount = 24;
const filename = "face-motion.mp4";
const decoded = spawnSync("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    resolve(outputDir, "face-source.png"),
    "-frames:v",
    "1",
    "-f",
    "rawvideo",
    "-pix_fmt",
    "rgb24",
    "pipe:1",
]);
if (decoded.status !== 0 || decoded.stdout.length !== portraitWidth * portraitHeight * 3) {
    throw new Error("face source decode failed");
}
const encoder = spawn(
    "ffmpeg",
    [
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "rawvideo",
        "-pixel_format",
        "rgb24",
        "-video_size",
        `${width}x${height}`,
        "-framerate",
        String(fps),
        "-i",
        "pipe:0",
        "-an",
        "-c:v",
        "libx264",
        "-profile:v",
        "main",
        "-pix_fmt",
        "yuv420p",
        "-crf",
        "15",
        "-preset",
        "slow",
        "-g",
        String(fps),
        "-bf",
        "0",
        "-movflags",
        "+faststart",
        resolve(outputDir, filename),
    ],
    { stdio: ["pipe", "ignore", "inherit"] },
);
const completion = once(encoder, "close");
const frames = [];
for (let frame = 0; frame < frameCount; frame++) {
    const pixels = Buffer.alloc(width * height * 3, 76);
    const faces = [];
    if (frame >= 6 && frame < 18) {
        const x = 20 + (frame - 6) * 40;
        const y = 80;
        for (let row = 0; row < portraitHeight; row++) {
            const start = row * portraitWidth * 3;
            decoded.stdout.copy(pixels, ((y + row) * width + x) * 3, start, start + portraitWidth * 3);
        }
        // Manually annotated visible face in face-source.png: forehead through
        // chin and both cheeks. Hair/background do not define the target box.
        faces.push({ xPct: (x + 30) / width, yPct: (y + 52) / height, wPct: 108 / width, hPct: 120 / height });
    }
    frames.push({ contentSec: frame / fps, faces });
    if (!encoder.stdin.write(pixels)) await once(encoder.stdin, "drain");
}
encoder.stdin.end();
const [exitCode] = await completion;
if (exitCode !== 0) throw new Error(`ffmpeg failed with exit code ${exitCode}`);
// The final visible face frame ends at 0.6s, while silent audio owns the file
// through 0.7s. Export holds that measured video frame during the audio tail.
const heldTail = spawnSync(
    "ffmpeg",
    [
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-t",
        "0.6",
        "-i",
        resolve(outputDir, filename),
        "-f",
        "lavfi",
        "-t",
        "0.7",
        "-i",
        "anullsrc=r=48000:cl=mono",
        "-map",
        "0:v:0",
        "-map",
        "1:a:0",
        "-c:v",
        "copy",
        "-c:a",
        "aac",
        "-movflags",
        "+faststart",
        resolve(outputDir, "face-held-tail.mp4"),
    ],
    { stdio: "inherit" },
);
if (heldTail.status !== 0) throw new Error("held-tail fixture encoding failed");
writeFileSync(
    resolve(outputDir, "face-motion.json"),
    `${JSON.stringify({ filename, width, height, fps, durationSec: frameCount / fps, frames }, null, 2)}\n`,
);
execFileSync(process.execPath, [
    resolve(outputDir, "../../../node_modules/@biomejs/biome/bin/biome"),
    "format",
    resolve(outputDir, "face-motion.json"),
    "--write",
]);
