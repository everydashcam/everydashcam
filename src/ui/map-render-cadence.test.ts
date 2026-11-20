import { getVersion } from "maplibre-gl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installMapRenderCadence, isFollowFrameTooSoon } from "./map-render-cadence.js";

function renderTarget(version = getVersion()) {
    const listeners = new Map<string, Set<() => void>>();
    let paints = 0;
    let scheduled = false;
    const map = {
        version,
        triggerRepaint(): void {
            scheduled = true;
        },
        on(type: string, listener: () => void): void {
            const entries = listeners.get(type) ?? new Set();
            entries.add(listener);
            listeners.set(type, entries);
        },
        off(type: string, listener: () => void): void {
            listeners.get(type)?.delete(listener);
        },
    };
    const emit = (type: string): void => {
        for (const listener of listeners.get(type) ?? []) listener();
    };
    return {
        map,
        emit,
        get paints() {
            return paints;
        },
        paint(beforeRender?: () => void): void {
            if (!scheduled) return;
            scheduled = false;
            paints++;
            beforeRender?.();
            emit("render");
        },
    };
}

describe("map render cadence", () => {
    let callbacks: Map<number, FrameRequestCallback>;
    beforeEach(() => {
        callbacks = new Map();
        let nextId = 0;
        vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
            callbacks.set(++nextId, callback);
            return nextId;
        });
        vi.stubGlobal("cancelAnimationFrame", (id: number) => callbacks.delete(id));
    });
    afterEach(() => vi.unstubAllGlobals());

    const tick = (): void => {
        const pending = [...callbacks.values()];
        callbacks.clear();
        for (const callback of pending) callback(0);
    };

    it("enables frame pacing for the installed MapLibre release", () => {
        const target = renderTarget();
        const cadence = installMapRenderCadence(target.map, () => ({}));
        expect(cadence.enabled).toBe(true);
    });

    it("coalesces repeated requests until another camera frame is applied", () => {
        const target = renderTarget();
        let frame = {};
        const cadence = installMapRenderCadence(target.map, () => frame);
        target.map.triggerRepaint();
        target.paint();
        for (let i = 0; i < 20; i++) target.map.triggerRepaint();
        expect(callbacks.size).toBe(1);
        tick();
        target.paint();
        expect(target.paints).toBe(1);

        frame = {};
        cadence.refresh();
        expect(callbacks.size).toBe(0);
        expect(target.paints, "native paint remains asynchronous").toBe(1);
        target.paint();
        expect(target.paints).toBe(2);
    });

    it("consumes applied camera frames independently of newer video observations", () => {
        const target = renderTarget();
        let observed = {};
        let applied = observed;
        const cadence = installMapRenderCadence(target.map, () => applied);
        target.map.triggerRepaint();
        observed = {};
        target.paint();
        target.map.triggerRepaint();
        target.paint();
        expect(target.paints).toBe(1);

        applied = observed;
        cadence.refresh();
        target.paint();
        expect(target.paints, "the newly applied frame still receives a paint").toBe(2);
    });

    it("coalesces style-triggered requests made inside a paint before its render event", () => {
        const target = renderTarget();
        let frame = {};
        const cadence = installMapRenderCadence(target.map, () => frame);
        target.map.triggerRepaint();
        target.paint(() => target.map.triggerRepaint());
        tick();
        target.paint();
        expect(target.paints, "reentrant style work does not duplicate this camera frame").toBe(1);
        frame = {};
        cadence.refresh();
        target.paint();
        expect(target.paints).toBe(2);
    });

    it("accepts a newer camera frame while a native paint is already queued", () => {
        const target = renderTarget();
        let frame = {};
        installMapRenderCadence(target.map, () => frame);
        target.map.triggerRepaint();
        target.paint();
        frame = {};
        target.map.triggerRepaint();
        frame = {};
        target.map.triggerRepaint();
        target.paint(() => target.map.triggerRepaint());
        tick();
        target.paint();
        expect(target.paints, "the pending native paint includes the latest pose exactly once").toBe(2);
    });

    it("releases a pending paint when playback or its frame clock becomes unavailable", () => {
        const target = renderTarget();
        let frame: object | null = {};
        installMapRenderCadence(target.map, () => frame);
        target.map.triggerRepaint();
        target.paint();
        target.map.triggerRepaint();
        frame = null;
        tick();
        target.paint();
        expect(target.paints).toBe(2);
        expect(callbacks.size).toBe(0);
        target.map.triggerRepaint();
        target.paint();
        expect(target.paints, "ordinary rendering remains available").toBe(3);
    });

    it("does not introduce paints while the map is idle", () => {
        const target = renderTarget();
        let frame = {};
        const cadence = installMapRenderCadence(target.map, () => frame);
        frame = {};
        cadence.refresh();
        tick();
        target.paint();
        expect(target.paints).toBe(0);
        expect(callbacks.size).toBe(0);
    });

    it("cancels pending work and restores native scheduling on removal", () => {
        const target = renderTarget();
        const native = target.map.triggerRepaint;
        const frame = {};
        const cadence = installMapRenderCadence(target.map, () => frame);
        target.map.triggerRepaint();
        target.paint();
        target.map.triggerRepaint();
        expect(callbacks.size).toBe(1);
        const queued = [...callbacks.values()];
        target.emit("remove");
        expect(target.map.triggerRepaint).toBe(native);
        expect(callbacks.size).toBe(0);
        for (const callback of queued) callback(0);
        cadence.refresh();
        target.paint();
        expect(target.paints).toBe(1);
    });

    it("leaves an unreviewed engine version on native scheduling", () => {
        const target = renderTarget("7.0.0");
        const native = target.map.triggerRepaint;
        const cadence = installMapRenderCadence(target.map, () => ({}));
        expect(cadence.enabled).toBe(false);
        expect(target.map.triggerRepaint).toBe(native);
        target.map.triggerRepaint();
        target.paint();
        expect(target.paints).toBe(1);
        expect(callbacks.size).toBe(0);
    });
});

describe("follow frame cadence cap", () => {
    const clip = new File([], "clip.mp4");
    const at = (mediaTime: number, src = "blob:clip", file = clip) => ({ file, src, mediaTime });
    /** Indexes of the frames a camera applies out of `count` consecutive ones. */
    const appliedFrames = (fps: number, count: number, playbackRate = 1): number[] => {
        const applied = [0];
        let last = at(0);
        for (let index = 1; index < count; index++) {
            const frame = at(index / fps);
            if (isFollowFrameTooSoon(last, frame, playbackRate)) continue;
            applied.push(index);
            last = frame;
        }
        return applied;
    };

    it.each([50, 60])("applies every other frame of %i fps footage", (fps) => {
        expect(appliedFrames(fps, 9)).toEqual([0, 2, 4, 6, 8]);
    });

    it.each([25, 30])("applies every frame of %i fps footage", (fps) => {
        expect(appliedFrames(fps, 5)).toEqual([0, 1, 2, 3, 4]);
    });

    it("measures the spacing in playback time", () => {
        expect(appliedFrames(30, 5, 2), "30 fps at double speed presents like 60 fps").toEqual([0, 2, 4]);
        expect(appliedFrames(60, 5, 0.5), "60 fps at half speed presents like 30 fps").toEqual([0, 1, 2, 3, 4]);
    });

    it("always applies the first frame, another source and a frame that is not ahead", () => {
        expect(isFollowFrameTooSoon(null, at(0.01), 1)).toBe(false);
        expect(isFollowFrameTooSoon(at(0), at(0.01, "blob:next"), 1)).toBe(false);
        expect(isFollowFrameTooSoon(at(0), at(0.01, "blob:clip", new File([], "next.mp4")), 1)).toBe(false);
        expect(isFollowFrameTooSoon(at(1), at(0.99), 1), "a seek back").toBe(false);
        expect(isFollowFrameTooSoon(at(1), at(1), 1), "the same frame observed again").toBe(false);
    });
});
