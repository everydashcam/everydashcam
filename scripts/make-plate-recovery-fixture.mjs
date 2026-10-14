#!/usr/bin/env node
// Generate an abrupt-motion/exit sequence from the existing procedural car.
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const directory = resolve(root, "tests/testdata/plate-recovery");
const source = resolve(root, "tests/testdata/detector-motion/plate-motion.mp4");
const width = 1920;
const height = 1080;
const fps = 25;
const sceneY = 540;
const plateXs = [280, 280, 280, 280, 180, 80, -40, -160, -280, -400, -520, -640, -760, -880, -1000, -1120];
const decoded = execFileSync(
    "ffmpeg",
    [
        "-hide_banner",
        "-loglevel",
        "error",
        "-threads",
        "1",
        "-i",
        source,
        "-vf",
        "select=eq(n\\,0)+eq(n\\,12)",
        "-fps_mode",
        "passthrough",
        "-frames:v",
        "2",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        "pipe:1",
    ],
    { maxBuffer: 4 * 1024 * 1024 },
);
const sceneBytes = 640 * 360 * 3;
if (decoded.length !== sceneBytes * 2) throw new Error("procedural source frames missing");
const background = decoded.subarray(0, sceneBytes);
const carFrame = decoded.subarray(sceneBytes);
mkdirSync(directory, { recursive: true });
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
        "12",
        "-preset",
        "slow",
        "-threads",
        "1",
        "-g",
        String(fps),
        "-bf",
        "0",
        "-movflags",
        "+faststart",
        resolve(directory, "motion.mp4"),
    ],
    { stdio: ["pipe", "ignore", "inherit"] },
);
const completion = once(encoder, "close");
const frames = [];
for (const [index, plateX] of plateXs.entries()) {
    const pixels = Buffer.alloc(width * height * 3, 77);
    for (let y = 0; y < 360; y++) background.copy(pixels, (sceneY + y) * width * 3, y * 640 * 3, (y + 1) * 640 * 3);
    // The crop contains only the fictional car from source frame 12. Moving
    // this complete rectangle preserves the invented plate and car context.
    for (let y = 158; y < 299; y++) {
        for (let x = 225; x < 455; x++) {
            const targetX = x + plateX - 280;
            if (targetX < 0 || targetX >= width) continue;
            carFrame.copy(pixels, ((sceneY + y) * width + targetX) * 3, (y * 640 + x) * 3, (y * 640 + x + 1) * 3);
        }
    }
    const left = Math.max(0, plateX);
    const right = Math.min(width, plateX + 120);
    frames.push({
        contentSec: index / fps,
        plates:
            right > left
                ? [
                      {
                          xPct: left / width,
                          yPct: (sceneY + 254) / height,
                          wPct: (right - left) / width,
                          hPct: 30 / height,
                      },
                  ]
                : [],
    });
    if (!encoder.stdin.write(pixels)) await once(encoder.stdin, "drain");
}
encoder.stdin.end();
const [exitCode] = await completion;
if (exitCode !== 0) throw new Error(`ffmpeg failed with exit code ${exitCode}`);
writeFileSync(
    resolve(directory, "motion.json"),
    `${JSON.stringify({ filename: "motion.mp4", width, height, fps, durationSec: frames.length / fps, frames }, null, 4)}\n`,
);
execFileSync(process.execPath, [
    resolve(root, "node_modules/@biomejs/biome/bin/biome"),
    "format",
    resolve(directory, "motion.json"),
    "--write",
]);
writeFileSync(
    resolve(directory, "source.md"),
    "# Synthetic plate recovery fixture\n\n" +
        "Source: [generator](../../../scripts/make-plate-recovery-fixture.mjs), using only [the procedural car scene](../detector-motion/plate-motion.mp4.source.md).\n\n" +
        "The invented AB123CD plate is 120×30 pixels on a 1920×1080 canvas. The car moves left abruptly between discovery scans and exits through the image edge. Frame annotations cover only the visible plate fragment. The sequence contains no real footage or external material; the repository license applies. This is a pipeline regression, not an accuracy benchmark.\n",
);
