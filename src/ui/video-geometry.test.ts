import { describe, expect, it } from "vitest";

import { containRect, zoomedVisibleShare } from "./video-geometry.js";

describe("zoomedVisibleShare", () => {
    it("returns the whole picture at scale 1 with no offset", () => {
        const displayed = containRect(16 / 9, 1600, 900);
        const share = zoomedVisibleShare(displayed, 1600, 900, 1, 0, 0);
        expect(share).not.toBeNull();
        expect(share!.x).toBeCloseTo(0);
        expect(share!.y).toBeCloseTo(0);
        expect(share!.w).toBeCloseTo(1);
        expect(share!.h).toBeCloseTo(1);
    });

    it("returns the quarter the tile shows at 2x zoomed into the centre", () => {
        // Picture fills the tile; translate(-400,-225) scale(2) centres it.
        const displayed = containRect(16 / 9, 800, 450);
        const share = zoomedVisibleShare(displayed, 800, 450, 2, -400, -225);
        expect(share!.x).toBeCloseTo(0.25);
        expect(share!.y).toBeCloseTo(0.25);
        expect(share!.w).toBeCloseTo(0.5);
        expect(share!.h).toBeCloseTo(0.5);
    });

    it("keeps the part of a letterboxed picture that has not reached the tile edges yet", () => {
        // 16:9 picture in a 4:3 tile: 1000x562.5 at y=93.75. At 1.1x without
        // offset its top edge is still inside the tile, so the whole picture
        // height stays visible while the right side is cut by the tile.
        const displayed = containRect(16 / 9, 1000, 750);
        const share = zoomedVisibleShare(displayed, 1000, 750, 1.1, 0, 0);
        expect(share!.x).toBeCloseTo(0);
        expect(share!.y).toBeCloseTo(0);
        expect(share!.w).toBeCloseTo(1000 / 1100);
        expect(share!.h).toBeCloseTo(1);
    });

    it("returns null when the picture is panned out of the tile", () => {
        const displayed = containRect(16 / 9, 800, 450);
        expect(zoomedVisibleShare(displayed, 800, 450, 2, -2000, 0)).toBeNull();
    });
});
