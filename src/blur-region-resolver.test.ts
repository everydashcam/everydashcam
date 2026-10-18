import { describe, expect, it } from "vitest";

import { createRegionBlurResolver } from "./blur-region-resolver.js";
import { createBlurRegion, resolveRegionBlursAt, upsertKeyframe } from "./blur-regions.js";
import type { Channel } from "./parsers/types.js";

const channels: Channel[] = ["front", "rear", "interior", "side"];

describe("createRegionBlurResolver", () => {
    it.each([
        { start: 0, firstFrame: -0.000001 },
        { start: 1, firstFrame: 1 },
        { start: 1.0005, firstFrame: 1 },
        { start: 1.01, firstFrame: 1 },
        { start: 1.4, firstFrame: 1 },
        { start: 2.0005, firstFrame: 2 },
    ])("covers retained frames and preserves the end for an export starting at $start", ({ start, firstFrame }) => {
        const rect = { xPct: 0.2, yPct: 0.3, wPct: 0.2, hPct: 0.2 };
        const region = createBlurRegion("front", "fill", start, start + 1, start + 0.5, rect);
        const original = structuredClone(region);
        const resolve = createRegionBlurResolver([region], "front", start);
        for (const sec of [firstFrame, start, start + 0.5, start + 1]) {
            expect(resolve(sec), `covered at ${sec}`).toEqual([{ rect, style: "fill" }]);
            expect(resolve(sec), `preview and export agree at ${sec}`).toEqual(
                resolveRegionBlursAt([region], "front", sec, start),
            );
        }
        expect(resolve(start + 1.000001), "the zone still ends at its original boundary").toEqual([]);
        expect(resolve(firstFrame), "a backward timestamp jump retains boundary coverage").toEqual([
            { rect, style: "fill" },
        ]);
        expect(region, "export does not change the editor's span or geometry").toEqual(original);
    });

    it("uses the retained frame's moving geometry instead of the fractional trim time", () => {
        const region = createBlurRegion("front", "fill", 1.01, 2, 0.9, {
            xPct: 0.2,
            yPct: 0.3,
            wPct: 0.2,
            hPct: 0.2,
        });
        upsertKeyframe(region, 1.1, { xPct: 0.6, yPct: 0.3, wPct: 0.2, hPct: 0.2 }, false);
        const resolve = createRegionBlurResolver([region], "front", 1.01);
        expect(resolve(1)[0]?.rect.xPct).toBeCloseTo(0.4);
        for (const sec of [1.01, 1.1, 2, 2.000001]) {
            expect(resolve(sec), `unchanged after the trim at ${sec}`).toEqual(
                resolveRegionBlursAt([region], "front", sec),
            );
        }
    });

    it("keeps existing frame masks and paint order without pulling future or detector masks backward", () => {
        const rect = { xPct: 0.2, yPct: 0.3, wPct: 0.2, hPct: 0.2 };
        const whole = createBlurRegion("front", "fill", 1.01, 2, 1.5, rect);
        const ended = createBlurRegion("front", "pixelate", 0, 1.005, 0, rect);
        const future = createBlurRegion("front", "blur", 1.02, 2, 1.02, rect);
        const observed = createBlurRegion("front", "blur", 1, 1 + 1 / 30, 1, rect);
        observed.interpolation = "hold";
        const boundaryObserved = { ...observed, startSec: 1.005 };
        const nextObserved = { ...observed, startSec: 1 + 1 / 30, endSec: 2 };
        const regions = [whole, ended, future, observed, boundaryObserved, nextObserved];
        const resolve = createRegionBlurResolver(regions, "front", 1.01);
        expect(resolve(1)).toEqual([
            { rect, style: "blur" },
            { rect, style: "pixelate" },
            { rect, style: "fill" },
        ]);
        expect(resolve(1), "preview and indexed export use the same boundary policy").toEqual(
            resolveRegionBlursAt(regions, "front", 1, 1.01),
        );
        for (const sec of [1.01, 1.02, 1 + 1 / 30, 2, 2.000001]) {
            expect(resolve(sec), `unchanged at ${sec}`).toEqual(resolveRegionBlursAt(regions, "front", sec));
        }
        expect(createRegionBlurResolver(regions, "rear", 1.01)(1)).toEqual([]);
    });

    it("activates held masks on rounded browser timestamps without changing manual boundaries", () => {
        const held = createBlurRegion("front", "fill", 7 / 30, 10 / 30, 7 / 30, {
            xPct: 0.1,
            yPct: 0.2,
            wPct: 0.2,
            hPct: 0.1,
        });
        held.interpolation = "hold";
        upsertKeyframe(held, 8 / 30, { xPct: 0.4, yPct: 0.2, wPct: 0.2, hPct: 0.1 }, false);
        const manual = { ...held, interpolation: "linear" as const };
        const resolve = createRegionBlurResolver([manual, held], "front");
        expect(resolve(0.233333)).toEqual([{ rect: held.keyframes[0]!.rect, style: "fill" }]);
        expect(resolve(0.266667).at(-1)?.rect).toEqual(held.keyframes[1]!.rect);
        expect(resolve(0.333333)).toHaveLength(1);
        expect(resolve(0.333334)).toEqual([]);
        expect(resolve(0.233333)).toHaveLength(1);
    });

    it("matches preview on quantized MSE frames across starts, keyframes, ends and backward seeks", () => {
        const first = { xPct: 0.4, yPct: 0.3, wPct: 0.2, hPct: 0.1 };
        const next = { xPct: 0.2, yPct: 0.4, wPct: 0.2, hPct: 0.1 };
        const held = createBlurRegion("front", "fill", 10.679, 10.759, 10.679, first);
        held.interpolation = "hold";
        upsertKeyframe(held, 10.719, next, false);
        const manual = { ...held, interpolation: "linear" as const };
        const regions = [manual, held];
        const resolve = createRegionBlurResolver(regions, "front");

        expect(resolve(10.678979)).toEqual([]);
        expect(resolve(10.678993)).toEqual([{ rect: first, style: "fill" }]);
        expect(resolve(10.718979).at(-1)?.rect).toEqual(first);
        expect(resolve(10.718993).at(-1)?.rect).toEqual(next);
        expect(resolve(10.758993)).toEqual([{ rect: next, style: "fill" }]);
        expect(resolve(10.759001)).toEqual([]);
        expect(resolve(10.678993)).toEqual([{ rect: first, style: "fill" }]);

        for (const time of [
            10.678979, 10.678993, 10.679, 10.718979, 10.718993, 10.758993, 10.759, 10.759001, 10.718993,
        ]) {
            expect(resolve(time), `at ${time}`).toEqual(resolveRegionBlursAt(regions, "front", time));
        }
    });

    it("preserves interpolation, inclusive edges and paint order across held frames and backward jumps", () => {
        // Creation order deliberately differs from start time. Equal-style
        // overlapping patches must retain their original relative paint order.
        const regions = Array.from({ length: 240 }, (_, i) => {
            const start = ((i * 37) % 80) / 2;
            const region = createBlurRegion(
                channels[i % channels.length]!,
                i % 5 === 0 ? "fill" : i % 3 === 0 ? "blur" : "pixelate",
                start,
                start + (i % 9),
                start + 0.25,
                { xPct: (i % 7) / 10, yPct: 0.2, wPct: 0.12, hPct: 0.1 },
            );
            upsertKeyframe(region, start + 4, { xPct: 0.1, yPct: 0.7, wPct: 0.2, hPct: 0.15 }, false);
            if (i % 2 === 0) region.interpolation = "hold";
            return region;
        });
        const original = structuredClone(regions);
        const resolvers = channels.map((channel) => createRegionBlurResolver(regions, channel));
        const times = [
            -1,
            ...Array.from({ length: 201 }, (_, i) => i / 4),
            18.25,
            18.25,
            18.25,
            19,
            0,
            40,
            7,
            100,
            0,
            0.25,
            0.5,
        ];
        for (const sec of times) {
            for (const [i, channel] of channels.entries()) {
                expect(resolvers[i]!(sec), `${channel} at ${sec}`).toEqual(resolveRegionBlursAt(regions, channel, sec));
            }
        }
        expect(regions).toEqual(original);
    });

    it("keeps channel clocks independent when another slot holds its last frame", () => {
        const regions = channels.map((channel) =>
            createBlurRegion(channel, "fill", 2, 3, 2, { xPct: 0.2, yPct: 0.3, wPct: 0.2, hPct: 0.2 }),
        );
        const front = createRegionBlurResolver(regions, "front");
        const rear = createRegionBlurResolver(regions, "rear");
        expect(front(2)).toHaveLength(1);
        expect(rear(3)).toHaveLength(1);
        expect(front(4)).toEqual([]);
        expect(rear(3)).toHaveLength(1);
        expect(rear(3.01)).toEqual([]);
        expect(front(2)).toHaveLength(1);
    });

    it("handles empty channels, empty tracks and invalid timestamps without losing later masks", () => {
        const region = createBlurRegion("front", "fill", 0, 2, 0, { xPct: 0.2, yPct: 0.3, wPct: 0.2, hPct: 0.2 });
        const empty = { ...region, keyframes: [] };
        const resolve = createRegionBlurResolver([empty, region], "front");
        expect(createRegionBlurResolver([region], "rear")(0)).toEqual([]);
        expect(resolve(Number.NaN)).toEqual([]);
        expect(resolve(1)).toEqual(resolveRegionBlursAt([region], "front", 1));
        expect(resolve(Infinity)).toEqual([]);
        expect(resolve(2)).toHaveLength(1);
    });
});
