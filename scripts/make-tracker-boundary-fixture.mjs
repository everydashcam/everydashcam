#!/usr/bin/env node
// Generate class-agnostic boundary tracking scenes from mathematical pixels only.
// Usage: node scripts/make-tracker-boundary-fixture.mjs [scenario-id ...]

import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(root, "tests/testdata/tracker-boundary");
const width = 640;
const height = 360;
const fps = 15;
const frameCount = 60;
const durationSec = frameCount / fps;
mkdirSync(output, { recursive: true });

function normalized(rect) {
    return { xPct: rect.x / width, yPct: rect.y / height, wPct: rect.w / width, hPct: rect.h / height };
}

function contains(rect, x, y) {
    return x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h;
}

function cardPixel(rect, x, y, target, similar = false) {
    const u = x - rect.x;
    const v = y - rect.y;
    if (u < 2 || u >= rect.w - 2 || v < 2 || v >= rect.h - 2) return [15, 18, 21];
    const bar = Math.floor(u / (target || similar ? 7 : 9)) % 3;
    if (v > 7 && v < 26 && (bar === 0 || (bar === 1 && v < 13))) return [25, 29, 33];
    if (u > (similar ? 55 : 10) && u < (similar ? 67 : 22) && v > 5 && v < 23)
        return target ? [211, 62, 39] : [42, 74, 116];
    return target || similar ? [237, 207, 58] : [195, 200, 204];
}

function targetX(id, index) {
    if (id.startsWith("card-exits-")) return 165 - index * 6;
    if (id === "card-stays-at-edge") return 2;
    if (id === "card-stops-at-edge") return Math.max(3, 165 - index * 6);
    if (id === "card-reverses-at-edge") return index <= 27 ? 165 - index * 6 : 3 + (index - 27) * 6;
    if (id === "card-reverses-after-clipping") return index <= 29 ? 165 - index * 6 : -9 + (index - 29) * 12;
    return 2 + index * 3;
}

const scenarios = [];
const scenarioIds = [
    "card-exits-left",
    "card-exits-to-similar-card",
    "card-stays-at-edge",
    "card-enters-from-edge",
    "card-stops-at-edge",
    "card-reverses-at-edge",
    "card-reverses-after-clipping",
];
const selected = new Set(process.argv.slice(2));
for (const id of selected) if (!scenarioIds.includes(id)) throw new Error(`unknown scenario: ${id}`);
for (const id of scenarioIds) {
    const name = `${id}.mp4`;
    const shouldEncode = selected.size === 0 || selected.has(id);
    if (!shouldEncode && !existsSync(resolve(output, name))) throw new Error(`missing fixture: ${name}`);
    const encoder = shouldEncode
        ? spawn(
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
                  resolve(output, name),
              ],
              { stdio: ["pipe", "ignore", "inherit"] },
          )
        : null;
    const completion = encoder ? once(encoder, "close") : null;
    const frames = [];
    for (let index = 0; index < frameCount; index++) {
        const x = targetX(id, index);
        const target = { x, y: 132, w: 80, h: 34 };
        const distractor = { x: 20, y: 139, w: 82, h: 33 };
        const pixels = Buffer.alloc(width * height * 3);
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const seam = (Math.floor((x + (Math.floor(y / 11) % 2) * 12) / 24) + Math.floor(y / 11)) % 2;
                const grain = ((x * 13 + y * 7 + Math.floor(x / 9) * 19) % 17) - 8;
                let rgb =
                    y < 90
                        ? [116 + grain, 143 + grain, 159 + grain]
                        : [58 + seam * 18 + grain, 47 + seam * 13 + grain, 42 + seam * 9 + grain];
                if (contains(distractor, x, y))
                    rgb = cardPixel(distractor, x, y, false, id === "card-exits-to-similar-card");
                if (contains(target, x, y)) rgb = cardPixel(target, x, y, true);
                const offset = (y * width + x) * 3;
                for (let c = 0; c < 3; c++) pixels[offset + c] = rgb[c];
            }
        }
        const visibleX = Math.max(0, target.x);
        const visibleW = Math.max(0, Math.min(width, target.x + target.w) - visibleX);
        const visibleFraction = visibleW / target.w;
        frames.push({
            contentSec: index / fps,
            targetRect: normalized(target),
            visibleRect: visibleW > 0 ? normalized({ ...target, x: visibleX, w: visibleW }) : null,
            visibleFraction,
            distractorRect: normalized(distractor),
        });
        if (encoder && !encoder.stdin.write(pixels)) await once(encoder.stdin, "drain");
    }
    if (encoder && completion) {
        encoder.stdin.end();
        const [exitCode] = await completion;
        if (exitCode !== 0) throw new Error(`ffmpeg failed with exit code ${exitCode}`);
        writeFileSync(
            resolve(output, `${name}.source.md`),
            "# Synthetic boundary tracking fixture\n\n" +
                "Source: [fixture generator](../../../scripts/make-tracker-boundary-fixture.mjs).\n\n" +
                "All pixels are generated from mathematical colors, patterns and rectangles. There is no camera footage, external source image, person, real sign, license plate, GPS or private material. The repository license applies.\n",
        );
    }
    scenarios.push({
        id,
        name,
        width,
        height,
        fps,
        durationSec,
        exitSec: frames.find((frame) => frame.visibleFraction === 0)?.contentSec ?? null,
        frames,
    });
}
const metadataPath = resolve(output, "boundary.json");
writeFileSync(metadataPath, `${JSON.stringify({ fps, scenarios }, null, 2)}\n`);
execFileSync(resolve(root, "node_modules/.bin/biome"), ["format", "--write", metadataPath], { stdio: "inherit" });
