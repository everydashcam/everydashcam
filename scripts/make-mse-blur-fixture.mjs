#!/usr/bin/env node
// Regenerate the procedural MSE timestamp fixture; ffmpeg is not needed by tests.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const directory = resolve(dirname(fileURLToPath(import.meta.url)), "../tests/testdata/mse-blur");
const width = 640;
const height = 360;
const frames = Array.from({ length: 16 }, (_, index) => ({
    contentSec: index === 0 ? 0 : (index * 40 - 1) / 1000,
    box: { x: 50 + index * 28, y: 130, w: 80, h: 64 },
}));
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
        "25",
        "-i",
        "pipe:0",
        "-an",
        "-vf",
        "settb=1/1000,setpts=if(eq(N\\,0)\\,0\\,N*40-1)",
        "-fps_mode",
        "passthrough",
        "-enc_time_base",
        "1:1000",
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
        "-threads",
        "1",
        "-g",
        "25",
        "-bf",
        "0",
        "-muxdelay",
        "0",
        "-mpegts_copyts",
        "1",
        "-f",
        "mpegts",
        resolve(directory, "moving-card.mpegts"),
    ],
    { stdio: ["pipe", "ignore", "inherit"] },
);
const completion = once(encoder, "close");
for (const { box } of frames) {
    const pixels = Buffer.alloc(width * height * 3);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const inside = x >= box.x && x < box.x + box.w && y >= box.y && y < box.y + box.h;
            const stripe = Math.floor((x - box.x) / 8) % 2 === 0;
            const color = inside ? (stripe ? [240, 210, 40] : [180, 70, 210]) : [50, 75, 105];
            pixels.set(color, (y * width + x) * 3);
        }
    }
    if (!encoder.stdin.write(pixels)) await once(encoder.stdin, "drain");
}
encoder.stdin.end();
const [exitCode] = await completion;
if (exitCode !== 0) throw new Error(`ffmpeg failed with exit code ${exitCode}`);
writeFileSync(
    resolve(directory, "motion.json"),
    `${JSON.stringify({ width, height, durationSec: 0.639, frames }, null, 4)}\n`,
);
writeFileSync(
    resolve(directory, "moving-card.mpegts.source.md"),
    "# Synthetic MSE blur fixture\n\n" +
        "Source: [generator](../../../scripts/make-mse-blur-fixture.mjs).\n\n" +
        "Generated from mathematical colors and shapes; no camera footage or external material. The repository license applies.\n\n" +
        "H.264 MPEG-TS, 640×360, 25 fps after the first 39 ms interval. Exact source PTS are 0, 0.039, 0.079, … seconds; the MSE MP4 remux quantizes these to its 57600 Hz clock.\n",
);
