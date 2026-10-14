#!/usr/bin/env node
// Generate an invented moving license plate and exact frame-level annotations.
// Usage: node scripts/make-detector-motion-fixture.mjs

import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const outputDir = resolve(dirname(fileURLToPath(import.meta.url)), "../tests/testdata/detector-motion");
const width = 640;
const height = 360;
const fps = 30;
const glyphs = {
    A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
    B: ["11110", "10001", "10001", "11110", "10001", "10001", "11110"],
    C: ["01111", "10000", "10000", "10000", "10000", "10000", "01111"],
    D: ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
    1: ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
    2: ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
    3: ["11110", "00001", "00001", "01110", "00001", "00001", "11110"],
};
mkdirSync(outputDir, { recursive: true });
async function generateFixture(filename, annotationFilename, frameCount, firstVisibleFrame) {
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
        const pixels = Buffer.alloc(width * height * 3);
        function rect(x, y, w, h, color) {
            for (let yy = Math.max(0, y); yy < Math.min(height, y + h); yy++) {
                for (let xx = Math.max(0, x); xx < Math.min(width, x + w); xx++) {
                    const offset = (yy * width + xx) * 3;
                    pixels[offset] = color[0];
                    pixels[offset + 1] = color[1];
                    pixels[offset + 2] = color[2];
                }
            }
        }
        for (let y = 0; y < height; y++) {
            const value = y < 160 ? 155 + Math.floor(y / 8) : 65 + Math.floor(y / 20);
            rect(0, y, width, 1, y < 160 ? [value - 25, value, value + 35] : [value, value, value]);
        }
        rect(0, 145, width, 20, [73, 93, 56]);
        for (let x = -40; x < width; x += 160) rect(x, 326, 80, 5, [225, 222, 207]);
        const isVisible = frame >= firstVisibleFrame && frame < firstVisibleFrame + 12;
        const boxes = [];
        if (isVisible) {
            const x = 40 + (frame - firstVisibleFrame) * 40;
            const y = 254;
            const w = 120;
            const h = 30;
            // Back of a fictional car, made entirely from rectangles and gradients.
            rect(x - 55, y - 81, 230, 125, [28, 29, 32]);
            rect(x - 42, y - 96, 204, 61, [145, 151, 156]);
            rect(x - 33, y - 88, 186, 48, [37, 50, 61]);
            rect(x - 23, y - 85, 166, 3, [90, 111, 124]);
            for (let row = 0; row < 74; row++) {
                const shade = 204 - Math.floor(row * 0.8);
                rect(x - 55, y - 35 + row, 230, 1, [shade, shade + 3, shade + 5]);
            }
            rect(x - 52, y - 20, 38, 17, [183, 30, 29]);
            rect(x + 134, y - 20, 38, 17, [183, 30, 29]);
            rect(x - 45, y + 29, 210, 8, [62, 64, 66]);
            rect(x - 4, y - 4, w + 8, h + 8, [41, 43, 46]);
            rect(x, y, w, h, [238, 237, 219]);
            rect(x + 2, y + 2, 9, h - 4, [30, 61, 143]);
            for (let star = 0; star < 4; star++) rect(x + 5, y + 4 + star * 3, 2, 1, [238, 218, 92]);
            for (const [index, character] of [..."AB123CD"].entries()) {
                for (let gy = 0; gy < 7; gy++) {
                    for (let gx = 0; gx < 5; gx++) {
                        if (glyphs[character][gy][gx] === "1")
                            rect(x + 16 + index * 14 + gx * 2, y + 5 + gy * 3, 2, 3, [19, 22, 24]);
                    }
                }
            }
            boxes.push({ xPct: x / width, yPct: y / height, wPct: w / width, hPct: h / height });
        }
        frames.push({ contentSec: frame / fps, plates: boxes });
        if (!encoder.stdin.write(pixels)) await once(encoder.stdin, "drain");
    }
    encoder.stdin.end();
    const [exitCode] = await completion;
    if (exitCode !== 0) throw new Error(`ffmpeg failed with exit code ${exitCode}`);
    writeFileSync(
        resolve(outputDir, annotationFilename),
        `${JSON.stringify({ filename, width, height, fps, durationSec: frameCount / fps, frames }, null, 2)}\n`,
    );
    execFileSync(process.execPath, [
        resolve(outputDir, "../../../node_modules/@biomejs/biome/bin/biome"),
        "format",
        resolve(outputDir, annotationFilename),
        "--write",
    ]);
    writeFileSync(
        resolve(outputDir, `${filename}.source.md`),
        "# Synthetic plate detection fixture\n\n" +
            "Source: [fixture generator](../../../scripts/make-detector-motion-fixture.mjs).\n\n" +
            "Generated entirely from mathematical colors, shapes, and hand-defined glyphs. The plate text AB123CD is invented; this contains no real recording, person, vehicle, GPS, or external source material. The repository license applies.\n\n" +
            `The plate appears only between ${firstVisibleFrame / fps} and ${(firstVisibleFrame + 12) / fps} seconds and moves 40 pixels per frame. A once-per-second scan misses the entire appearance. \`${annotationFilename}\` records every frame, including absent-object frames.\n`,
    );
}

await generateFixture("plate-motion.mp4", "motion.json", 24, 6);
await generateFixture("plate-motion-long.mp4", "long-motion.json", 90, 36);
