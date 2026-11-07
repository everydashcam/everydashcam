import { describe, expect, it } from "vitest";

import {
    type CameraLayout,
    type CameraLayoutRequest,
    computeCameraLayout,
    type LayoutCamera,
    outputMinThumbHeight,
    scaleCameraLayout,
    snapLayoutRect,
    THUMB_SCALE_MIN,
    thumbScaleForMainExtent,
    thumbScaleForOverlayHeight,
    VIEWER_MIN_THUMB_HEIGHT_PX,
    VIEWER_TILE_GAP_PX,
} from "./camera-layout.js";
import type { Channel } from "./parsers/types.js";

const WIDE = 16 / 9;
const CHANNELS: Channel[] = ["front", "rear", "interior", "side"];

function cameras(...aspects: number[]): LayoutCamera[] {
    return aspects.map((aspect, index) => ({ channel: CHANNELS[index]!, aspect }));
}

function viewer(
    width: number,
    height: number,
    cams: LayoutCamera[],
    overrides: Partial<CameraLayoutRequest> = {},
): CameraLayout {
    return computeCameraLayout({
        width,
        height,
        cameras: cams,
        mode: "main",
        thumbScale: null,
        allowOverlay: false,
        gap: VIEWER_TILE_GAP_PX,
        minThumbHeight: VIEWER_MIN_THUMB_HEIGHT_PX,
        ...overrides,
    });
}

function output(
    width: number,
    height: number,
    cams: LayoutCamera[],
    overrides: Partial<CameraLayoutRequest> = {},
): CameraLayout {
    return viewer(width, height, cams, { gap: 0, minThumbHeight: outputMinThumbHeight(width, height), ...overrides });
}

function tile(layout: CameraLayout, channel: Channel) {
    const found = layout.tiles.find((t) => t.channel === channel);
    if (!found) throw new Error(`no tile for ${channel}`);
    return found;
}

function overlaps(a: { x: number; y: number; w: number; h: number }, b: typeof a): boolean {
    const EPS = 1e-6;
    return a.x + a.w > b.x + EPS && b.x + b.w > a.x + EPS && a.y + a.h > b.y + EPS && b.y + b.h > a.y + EPS;
}

function expectInvariants(layout: CameraLayout, width: number, height: number): void {
    const EPS = 1e-6;
    for (const t of layout.tiles) {
        expect(t.x).toBeGreaterThanOrEqual(-EPS);
        expect(t.y).toBeGreaterThanOrEqual(-EPS);
        expect(t.x + t.w).toBeLessThanOrEqual(width + EPS);
        expect(t.y + t.h).toBeLessThanOrEqual(height + EPS);
    }
    const flat = layout.tiles.filter((t) => !t.overlay);
    for (let i = 0; i < flat.length; i++) {
        for (let j = i + 1; j < flat.length; j++) expect(overlaps(flat[i]!, flat[j]!)).toBe(false);
    }
    expect(layout.bounds.x).toBeCloseTo(width - layout.bounds.x - layout.bounds.w, 6);
    expect(layout.bounds.y).toBeCloseTo(height - layout.bounds.y - layout.bounds.h, 6);
}

describe("computeCameraLayout - main camera with the others", () => {
    it("puts two cameras of a tall laptop frame in a full-width main with a row under it", () => {
        const layout = viewer(667, 565, cameras(WIDE, WIDE));
        expect(layout.strip).toBe("bottom");
        const main = tile(layout, "front");
        expect(main.role).toBe("main");
        expect(main.w).toBeCloseTo(667, 6);
        expect(main.h).toBeCloseTo(375.2, 1);
        // The row grows into the free space instead of leaving it black.
        const thumb = tile(layout, "rear");
        expect(thumb.role).toBe("thumb");
        expect(thumb.h).toBeCloseTo(187.6, 1);
        expect(thumb.w).toBeCloseTo(333.5, 1);
        expect(thumb.y).toBeCloseTo(main.y + main.h + VIEWER_TILE_GAP_PX, 6);
        expectInvariants(layout, 667, 565);
    });

    it("fits two smaller cameras side by side under the main one in the laptop frame", () => {
        const layout = viewer(667, 565, cameras(WIDE, WIDE, WIDE));
        expect(layout.strip).toBe("bottom");
        expect(tile(layout, "front").w).toBeCloseTo(667, 6);
        const rear = tile(layout, "rear");
        const interior = tile(layout, "interior");
        expect(rear.h).toBeCloseTo((665 / 2) * (9 / 16), 1);
        expect(interior.x).toBeCloseTo(rear.x + rear.w + VIEWER_TILE_GAP_PX, 6);
        expectInvariants(layout, 667, 565);
    });

    it("prefers the bottom row when a 16:9 frame loses the same area either way", () => {
        const layout = viewer(1920, 1080, cameras(WIDE, WIDE));
        expect(layout.strip).toBe("bottom");
        expect(tile(layout, "front").h).toBeCloseTo((1080 - VIEWER_TILE_GAP_PX) / 1.25, 6);
        expectInvariants(layout, 1920, 1080);
    });

    it("moves the smaller cameras to a right column in a wide frame", () => {
        const layout = viewer(2560, 1080, cameras(WIDE, WIDE));
        expect(layout.strip).toBe("right");
        const main = tile(layout, "front");
        expect(main.h).toBeCloseTo(1080, 6);
        expect(tile(layout, "rear").x).toBeCloseTo(main.x + main.w + VIEWER_TILE_GAP_PX, 6);
        expectInvariants(layout, 2560, 1080);
    });

    it("lays windows over the main picture only when a strip would cost it area", () => {
        const fullscreen = viewer(1920, 1080, cameras(WIDE, WIDE), { allowOverlay: true });
        expect(fullscreen.strip).toBe("overlay");
        const main = tile(fullscreen, "front");
        expect(main.w).toBeCloseTo(1920, 6);
        const window = tile(fullscreen, "rear");
        expect(window.overlay).toBe(true);
        expect(window.h).toBeCloseTo(270, 6);
        // Bottom-right corner of the main picture.
        expect(window.x + window.w).toBeLessThan(1920);
        expect(window.x).toBeGreaterThan(1920 / 2);
        expect(window.y).toBeGreaterThan(1080 / 2);

        const laptop = viewer(667, 565, cameras(WIDE, WIDE), { allowOverlay: true });
        expect(laptop.strip).toBe("bottom");
        expect(laptop.tiles.every((t) => !t.overlay)).toBe(true);
    });

    it("keeps windows at their stored positions within the main picture", () => {
        const layout = viewer(1920, 1080, cameras(WIDE, WIDE), {
            allowOverlay: true,
            overlayPositions: { rear: { x: 0.1, y: 0.2 } },
        });
        const window = tile(layout, "rear");
        expect(window.x).toBeCloseTo(192, 6);
        expect(window.y).toBeCloseTo(216, 6);
        const clamped = viewer(1920, 1080, cameras(WIDE, WIDE), {
            allowOverlay: true,
            overlayPositions: { rear: { x: 1, y: 1 } },
        });
        const corner = tile(clamped, "rear");
        expect(corner.x + corner.w).toBeCloseTo(1920, 6);
        expect(corner.y + corner.h).toBeCloseTo(1080, 6);
    });

    it("stacks three windows without overlapping each other", () => {
        const layout = viewer(1920, 1080, cameras(WIDE, WIDE, WIDE, WIDE), { allowOverlay: true, thumbScale: 0.3 });
        const windows = layout.tiles.filter((t) => t.overlay);
        expect(windows).toHaveLength(3);
        for (let i = 0; i < windows.length; i++) {
            for (let j = i + 1; j < windows.length; j++) expect(overlaps(windows[i]!, windows[j]!)).toBe(false);
        }
        expectInvariants(layout, 1920, 1080);
    });

    it("honours an explicit thumb scale", () => {
        const layout = viewer(1920, 1080, cameras(WIDE, WIDE), { thumbScale: 0.5 });
        const main = tile(layout, "front");
        expect(main.h).toBeCloseTo((1080 - VIEWER_TILE_GAP_PX) / 1.5, 6);
        expect(tile(layout, "rear").h).toBeCloseTo(main.h * 0.5, 6);
    });

    it("inverts a divider position into the thumb scale that produces it", () => {
        const mainHeight = 700;
        const scale = thumbScaleForMainExtent("bottom", 1920, 1080, VIEWER_TILE_GAP_PX, mainHeight);
        const layout = viewer(1920, 1080, cameras(WIDE, WIDE), { thumbScale: scale });
        expect(tile(layout, "front").h).toBeCloseTo(mainHeight, 6);
        expect(thumbScaleForMainExtent("bottom", 1920, 1080, 0, 10_000)).toBe(THUMB_SCALE_MIN);
        expect(thumbScaleForOverlayHeight(1000, 300)).toBeCloseTo(0.3, 6);
    });

    it("does not let a divider shrink the row below the free space of a tall frame", () => {
        const auto = viewer(667, 565, cameras(WIDE, WIDE));
        const dragged = viewer(667, 565, cameras(WIDE, WIDE), {
            thumbScale: thumbScaleForMainExtent("bottom", 667, 565, VIEWER_TILE_GAP_PX, 500),
        });
        expect(dragged.tiles).toEqual(auto.tiles);
    });

    it("keeps the minimum thumb height while it fits", () => {
        const layout = viewer(640, 360, cameras(WIDE, WIDE));
        expect(tile(layout, "rear").h).toBeGreaterThanOrEqual(VIEWER_MIN_THUMB_HEIGHT_PX - 1e-6);
        expectInvariants(layout, 640, 360);
    });

    it("drops the minimum when no strip can keep it and never overlaps instead", () => {
        const layout = viewer(320, 180, cameras(WIDE, WIDE, WIDE, WIDE));
        expect(layout.strip === "bottom" || layout.strip === "right").toBe(true);
        const main = tile(layout, "front");
        for (const channel of ["rear", "interior", "side"] as const) {
            const thumb = tile(layout, channel);
            expect(thumb.h).toBeLessThan(VIEWER_MIN_THUMB_HEIGHT_PX);
            expect(thumb.h / main.h).toBeGreaterThanOrEqual(0.25 - 1e-6);
        }
        expectInvariants(layout, 320, 180);
    });

    it("sizes a 4:3 camera next to 16:9 ones by its own shape", () => {
        const layout = viewer(1280, 900, cameras(WIDE, 4 / 3, WIDE));
        const rear = tile(layout, "rear");
        const interior = tile(layout, "interior");
        expect(rear.w / rear.h).toBeCloseTo(4 / 3, 6);
        expect(interior.w / interior.h).toBeCloseTo(WIDE, 6);
        expectInvariants(layout, 1280, 900);
    });

    it("reaches a fixed point when the frame height follows the composition", () => {
        const ceiling = viewer(390, 600, cameras(WIDE, WIDE));
        expect(ceiling.bounds.h).toBeLessThan(600);
        const fitted = viewer(390, ceiling.bounds.h, cameras(WIDE, WIDE));
        expect(fitted.tiles.map(snapLayoutRect)).toEqual(
            ceiling.tiles.map((t) => snapLayoutRect({ ...t, y: t.y - ceiling.bounds.y })),
        );
    });

    it("shows a single camera as large as the frame allows", () => {
        const layout = viewer(667, 565, cameras(WIDE));
        expect(layout.strip).toBeNull();
        expect(tile(layout, "front")).toMatchObject({ role: "main", w: 667 });
    });
});

describe("computeCameraLayout - every camera equal", () => {
    it("puts three cameras of the laptop frame in a row of two over a centred one", () => {
        const layout = viewer(667, 565, cameras(WIDE, WIDE, WIDE), { mode: "equal" });
        const [front, rear, interior] = layout.tiles;
        expect(layout.tiles.every((t) => t.role === "equal")).toBe(true);
        expect(front!.y).toBeCloseTo(rear!.y, 6);
        expect(interior!.y).toBeGreaterThan(front!.y);
        expect(front!.h).toBeCloseTo((665 / 2) * (9 / 16), 6);
        expect(interior!.x + interior!.w / 2).toBeCloseTo(667 / 2, 6);
        expectInvariants(layout, 667, 565);
    });

    it("stacks two cameras in a tall frame and puts them side by side in a wide one", () => {
        const tall = viewer(667, 565, cameras(WIDE, WIDE), { mode: "equal" });
        expect(tile(tall, "rear").y).toBeGreaterThan(tile(tall, "front").y);
        const wide = viewer(1920, 1080, cameras(WIDE, WIDE), { mode: "equal" });
        expect(tile(wide, "rear").x).toBeGreaterThan(tile(wide, "front").x);
        expect(tile(wide, "rear").y).toBeCloseTo(tile(wide, "front").y, 6);
    });

    it("uses a 2x2 grid for four cameras in a 16:9 frame", () => {
        const layout = viewer(1920, 1080, cameras(WIDE, WIDE, WIDE, WIDE), { mode: "equal" });
        const ys = new Set(layout.tiles.map((t) => Math.round(t.y)));
        const xs = new Set(layout.tiles.map((t) => Math.round(t.x)));
        expect(ys.size).toBe(2);
        expect(xs.size).toBe(2);
        expectInvariants(layout, 1920, 1080);
    });

    it("gives a 4:3 camera the shared height", () => {
        const layout = viewer(1600, 600, cameras(WIDE, 4 / 3), { mode: "equal" });
        expect(tile(layout, "rear").h).toBeCloseTo(tile(layout, "front").h, 6);
        expect(tile(layout, "rear").w).toBeLessThan(tile(layout, "front").w);
    });

    it("stacks two cameras in a portrait output", () => {
        const layout = output(1080, 1920, cameras(WIDE, WIDE), { mode: "equal" });
        expect(tile(layout, "rear").y).toBeGreaterThan(tile(layout, "front").y);
        expect(tile(layout, "front").w).toBeCloseTo(1080, 6);
    });
});

describe("computeCameraLayout - output frames", () => {
    const shapes: Array<[number, number]> = [
        [1920, 1080],
        [1080, 1920],
        [1080, 1080],
        [1080, 1350],
        [2560, 1080],
    ];

    it("keeps every invariant across output shapes, camera counts and modes", () => {
        for (const [width, height] of shapes) {
            for (let count = 1; count <= 4; count++) {
                for (const mode of ["main", "equal"] as const) {
                    for (const allowOverlay of [false, true]) {
                        const cams = cameras(...Array.from({ length: count }, (_, i) => (i === 1 ? 4 / 3 : WIDE)));
                        const layout = output(width, height, cams, { mode, allowOverlay });
                        expect(layout.tiles).toHaveLength(count);
                        expectInvariants(layout, width, height);
                    }
                }
            }
        }
    });

    it("lays a 720p export out like a 1080p one", () => {
        for (const mode of ["main", "equal"] as const) {
            const full = output(1920, 1080, cameras(WIDE, WIDE, WIDE), { mode });
            const small = output(1280, 720, cameras(WIDE, WIDE, WIDE), { mode });
            const scaled = scaleCameraLayout(full, 1280 / 1920);
            small.tiles.forEach((t, index) => {
                const expected = scaled.tiles[index]!;
                expect(t.x).toBeCloseTo(expected.x, 6);
                expect(t.y).toBeCloseTo(expected.y, 6);
                expect(t.w).toBeCloseTo(expected.w, 6);
                expect(t.h).toBeCloseTo(expected.h, 6);
            });
        }
    });

    it("shows the file's layout in preview boxes of any size", () => {
        const file = output(1920, 1080, cameras(WIDE, WIDE, WIDE));
        for (const previewWidth of [400, 800, 1280]) {
            const factor = previewWidth / 1920;
            const preview = scaleCameraLayout(file, factor);
            preview.tiles.forEach((t, index) => {
                const source = file.tiles[index]!;
                expect(t.x / factor).toBeCloseTo(source.x, 6);
                expect(t.w / factor).toBeCloseTo(source.w, 6);
                expect(t.role).toBe(source.role);
            });
        }
    });

    it("snaps touching tiles to whole units without opening a seam", () => {
        const layout = viewer(667, 565, cameras(WIDE, WIDE, WIDE), { gap: 0 });
        const rear = snapLayoutRect(tile(layout, "rear"));
        const interior = snapLayoutRect(tile(layout, "interior"));
        expect(rear.x + rear.w).toBe(interior.x);
    });
});
