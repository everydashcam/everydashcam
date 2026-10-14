#!/usr/bin/env node
// Generate two independent synthetic Follow regressions without changing motion fixtures.
// Usage: node scripts/make-tracker-reliability-fixture.mjs

import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = resolve(repoRoot, "tests/testdata/tracker-reliability");
const width = 640;
const height = 360;
const fps = 15;
const frameCount = 36;
const durationSec = frameCount / fps;
const occlusionStartSec = 0.8;
const occlusionFullSec = 1.1;
const palette = [
    [215, 224, 235],
    [26, 35, 45],
];

function normalized(rect) {
    return { xPct: rect.x / width, yPct: rect.y / height, wPct: rect.w / width, hPct: rect.h / height };
}

mkdirSync(outputDir, { recursive: true });
const scenarios = [];
for (const id of ["smooth-occlusion", "illumination-change"]) {
    const name = `${id}.mp4`;
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
            resolve(outputDir, name),
        ],
        { stdio: ["pipe", "ignore", "inherit"] },
    );
    const completion = once(encoder, "close");
    const frames = [];
    for (let index = 0; index < frameCount; index++) {
        const contentSec = index / fps;
        const target = { x: Math.round(105 + contentSec * 40), y: 160, w: 48, h: 36 };
        const progress = Math.max(
            0,
            Math.min(1, (contentSec - occlusionStartSec) / (occlusionFullSec - occlusionStartSec)),
        );
        const cover =
            id === "smooth-occlusion" && progress > 0
                ? { x: target.x - 6, y: Math.round(target.y - 50 + progress * 44), w: 60, h: 50 }
                : null;
        const cycle = Math.sin((Math.PI * index) / (frameCount - 1)) ** 2;
        const brightness = id === "illumination-change" ? 1 - cycle * 0.25 : 1;
        const contrast = id === "illumination-change" ? 1 - cycle * 0.35 : 1;
        const pixels = Buffer.alloc(width * height * 3);
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const offset = (y * width + x) * 3;
                const background = 29 + Math.floor((8 * x) / width) + Math.floor((6 * y) / height);
                let rgb = [background, background + 6, background + 12];
                if (x >= target.x && x < target.x + target.w && y >= target.y && y < target.y + target.h) {
                    const u = (x - target.x) / target.w;
                    const v = (y - target.y) / target.h;
                    const cell = (Math.floor(u * 16) + Math.floor(v * 12)) % 2 ? 0 : 1;
                    rgb = palette[cell];
                    if (u < 0.05 || u > 0.95 || v < 0.06 || v > 0.94) rgb = [240, 240, 240];
                }
                if (cover && x >= cover.x && x < cover.x + cover.w && y >= cover.y && y < cover.y + cover.h) {
                    const smooth = Math.round(70 + (8 * (x - cover.x)) / cover.w + (5 * (y - cover.y)) / cover.h);
                    rgb = [smooth, smooth + 3, smooth + 5];
                }
                for (let channel = 0; channel < 3; channel++) {
                    pixels[offset + channel] = Math.max(
                        0,
                        Math.min(255, Math.round(((rgb[channel] - 100) * contrast + 100) * brightness)),
                    );
                }
            }
        }
        const hiddenHeight = cover
            ? Math.max(0, Math.min(target.y + target.h, cover.y + cover.h) - Math.max(target.y, cover.y))
            : 0;
        const visibleFraction = 1 - hiddenHeight / target.h;
        frames.push({
            contentSec,
            rect: visibleFraction > 0 ? normalized(target) : null,
            targetRect: normalized(target),
            visible: visibleFraction > 0,
            visibleFraction,
            occluderRect: cover ? normalized(cover) : null,
            brightness,
            contrast,
        });
        if (!encoder.stdin.write(pixels)) await once(encoder.stdin, "drain");
    }
    encoder.stdin.end();
    const [exitCode] = await completion;
    if (exitCode !== 0) throw new Error(`ffmpeg failed with exit code ${exitCode}`);
    writeFileSync(
        resolve(outputDir, `${name}.source.md`),
        "# Synthetic tracking reliability fixture\n\n" +
            "Source: [fixture generator](../../../scripts/make-tracker-reliability-fixture.mjs).\n\n" +
            "Generated entirely from mathematical colors, gradients and shapes. Contains no camera footage, people, plates, GPS, private data or external source material. The repository license applies.\n",
    );
    scenarios.push({
        id,
        name,
        width,
        height,
        fps,
        durationSec,
        ...(id === "smooth-occlusion"
            ? { occlusionStartSec, occlusionFullSec: frames.find((frame) => !frame.visible).contentSec }
            : {}),
        frames,
    });
}
const metadataPath = resolve(outputDir, "reliability.json");
writeFileSync(metadataPath, `${JSON.stringify({ fps, scenarios }, null, 2)}\n`);
execFileSync(resolve(repoRoot, "node_modules/.bin/biome"), ["format", "--write", metadataPath], { stdio: "inherit" });
