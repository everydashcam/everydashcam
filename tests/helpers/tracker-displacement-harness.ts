import type { OrtAssets } from "../../src/tracking/ort-assets.js";
import { VitTrackerSession } from "../../src/tracking/vittrack.js";

export async function trackDisplacements(modelUrl: string, assets: OrtAssets) {
    const session = await VitTrackerSession.create("wasm", modelUrl, assets);
    const width = 1920;
    const height = 1080;
    const box = { x: 700, y: 500, w: 120, h: 90 };
    const frame = new OffscreenCanvas(width, height);
    const ctx = frame.getContext("2d")!;
    const draw = (dx: number, changed = false) => {
        ctx.fillStyle = "rgb(35, 41, 47)";
        ctx.fillRect(0, 0, width, height);
        for (let y = 0; y < box.h; y++) {
            for (let x = 0; x < box.w; x++) {
                const colors = ["#e8c32d", "#2058be", "#e14134", "#d7e0eb", "#1a232d"];
                const cell = (Math.floor(x / 15) * 13 + Math.floor(y / 15) * 7 + (changed ? 2 : 0)) % colors.length;
                ctx.fillStyle = colors[cell]!;
                ctx.fillRect(box.x + dx + x, box.y + y, 1, 1);
            }
        }
    };
    const results = [];
    for (const { dx, changed } of [
        { dx: -160, changed: false },
        { dx: 160, changed: false },
        { dx: 160, changed: true },
    ]) {
        draw(0);
        const tracker = session.newTrack();
        tracker.init(frame, width, height, box);
        draw(dx, changed);
        const result = await tracker.update(frame, width, height, 0.04);
        results.push({ dx, changed, result });
    }
    return { results, seed: box };
}
