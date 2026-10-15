import { isPlausibleStep, seedSizeCap, type SizeCap, type TrackBox } from "./track-guards.js";

/** Geometry and timing stay together: a rejected prediction leaves both the
 *  reference box and its age intact until a later prediction is accepted. */
export class TrackGeometry {
    private currentBox: TrackBox;
    private cap: SizeCap;
    private sinceInit = 0;
    private sinceAcceptedSec = 0;

    constructor(
        box: TrackBox,
        private frameW: number,
        private frameH: number,
    ) {
        this.currentBox = { ...box };
        this.cap = seedSizeCap(box, frameW, frameH);
    }

    get box(): TrackBox {
        return { ...this.currentBox };
    }

    /** Rebase before cropping the next frame. Scaling the original cap, rather
     *  than deriving one from the current box, preserves the balloon defense. */
    advanceFrame(frameW: number, frameH: number, dtSec: number): void {
        this.resizeFrame(frameW, frameH);
        this.sinceInit++;
        this.sinceAcceptedSec += dtSec;
    }

    private resizeFrame(frameW: number, frameH: number): void {
        if (frameW !== this.frameW || frameH !== this.frameH) {
            const sx = frameW / this.frameW;
            const sy = frameH / this.frameH;
            this.currentBox = {
                x: this.currentBox.x * sx,
                y: this.currentBox.y * sy,
                w: this.currentBox.w * sx,
                h: this.currentBox.h * sy,
            };
            this.cap = { maxW: this.cap.maxW * sx, maxH: this.cap.maxH * sy };
            this.frameW = frameW;
            this.frameH = frameH;
        }
    }

    acceptCandidate(candidate: TrackBox): boolean {
        if (
            !isPlausibleStep(
                this.currentBox,
                candidate,
                this.cap,
                this.frameW,
                this.frameH,
                this.sinceInit,
                this.sinceAcceptedSec,
            )
        ) {
            return false;
        }
        this.currentBox = { ...candidate };
        this.sinceAcceptedSec = 0;
        return true;
    }
}
