import { describe, expect, it } from "vitest";
import { attachPinchGesture, type PinchGeometry } from "./pinch-gesture.js";
import { attachPointerDrag } from "./pointer-drag.js";

/** Minimal platform endpoints: test real listener ownership without a DOM emulator. */
function surface() {
    const view = new EventTarget();
    const document = Object.assign(new EventTarget(), { defaultView: view });
    const captured = new Set<number>();
    const target = Object.assign(new EventTarget(), {
        ownerDocument: document,
        isConnected: true,
        setPointerCapture: (id: number) => captured.add(id),
        hasPointerCapture: (id: number) => captured.has(id),
        releasePointerCapture: (id: number) => captured.delete(id),
    });
    return { target, element: target as unknown as HTMLElement, document, view, captured };
}

function pointer(target: EventTarget, type: string, id: number, x = 0, y = 0, pointerType = "touch", button = 0) {
    const event = Object.assign(new Event(type, { cancelable: true }), {
        pointerId: id,
        clientX: x,
        clientY: y,
        pointerType,
        button,
    });
    target.dispatchEvent(event);
    return event;
}

describe("pointer drag lifecycle", () => {
    it("ignores secondary contacts and finishes once after capture loss", () => {
        const { target, element, document, captured } = surface();
        const moves: number[] = [];
        const ends: string[] = [];
        attachPointerDrag(element, {
            onStart: () => true,
            onMove: (event) => moves.push(event.clientX),
            onEnd: (event, reason) => ends.push(`${reason}:${event.clientX}`),
        });
        pointer(target, "pointerdown", 1, 10);
        pointer(target, "pointerdown", 2, 99);
        pointer(target, "pointermove", 2, 99);
        pointer(target, "pointermove", 1, 20);
        pointer(target, "lostpointercapture", 1);
        pointer(document, "pointerup", 1, 30);
        pointer(target, "pointermove", 1, 40);
        expect(moves).toEqual([20]);
        expect(ends).toEqual(["cancel:20"]);
        expect(captured.size).toBe(0);
        pointer(target, "pointerdown", 3, 50);
        pointer(document, "pointerup", 3, 60);
        expect(ends).toEqual(["cancel:20", "up:60"]);
    });

    it("observes release outside the target when capture is unavailable", () => {
        const { target, element, document, view } = surface();
        target.setPointerCapture = () => {
            throw new DOMException("inactive pointer", "NotFoundError");
        };
        const moves: number[] = [];
        const ends: string[] = [];
        attachPointerDrag(element, {
            onStart: () => true,
            onMove: (event) => moves.push(event.clientX),
            onEnd: (_event, reason) => ends.push(reason),
        });
        pointer(target, "pointerdown", 1);
        pointer(document, "pointermove", 1, 30);
        pointer(document, "pointerup", 1);
        pointer(document, "pointermove", 1, 50);
        view.dispatchEvent(new Event("blur"));
        expect(moves).toEqual([30]);
        expect(ends).toEqual(["up"]);
    });

    it("cancels on blur, explicit takeover and removal without committing a release", () => {
        const { target, element, document, view } = surface();
        const ends: string[] = [];
        const drag = attachPointerDrag(element, {
            onStart: () => true,
            onMove: () => {},
            onEnd: (_event, reason) => ends.push(reason),
        });
        pointer(target, "pointerdown", 1);
        view.dispatchEvent(new Event("blur"));
        pointer(target, "pointerdown", 2);
        drag.cancel();
        drag.cancel();
        pointer(target, "pointerdown", 3);
        target.isConnected = false;
        pointer(document, "lostpointercapture", 3);
        pointer(document, "pointerup", 3);
        expect(ends).toEqual(["cancel", "cancel", "cancel"]);
    });

    it("does not acquire a right-button drag or rejected start", () => {
        const { target, element, captured } = surface();
        let starts = 0;
        attachPointerDrag(element, {
            onStart: () => {
                starts++;
                return false;
            },
            onMove: () => {},
        });
        pointer(target, "pointerdown", 1, 0, 0, "mouse", 2);
        pointer(target, "pointerdown", 2);
        expect(starts).toBe(1);
        expect(captured.size).toBe(0);
    });
});

describe("shared pinch contacts", () => {
    it("tracks two accepted contacts, preserves their centroid and ignores a third finger", () => {
        const { target, element, document, captured } = surface();
        const starts: PinchGeometry[] = [];
        const moves: PinchGeometry[] = [];
        let ends = 0;
        const pinch = attachPinchGesture(element, {
            accepts: (event) => event.clientY >= 0,
            onStart: (geometry) => {
                starts.push(geometry);
                return true;
            },
            onMove: (geometry) => moves.push(geometry),
            onEnd: () => {
                ends++;
            },
        });
        pointer(target, "pointerdown", 99, 0, -1);
        pointer(target, "pointerdown", 1, 10, 10);
        pointer(target, "pointerdown", 2, 30, 10);
        expect(pinch.active).toBe(true);
        expect([...captured]).toEqual([1, 2]);
        pointer(target, "pointerdown", 3, 500, 500);
        pointer(document, "pointermove", 3, 1000, 1000);
        const move = pointer(document, "pointermove", 2, 50, 10);
        expect(move.defaultPrevented).toBe(true);
        expect(starts).toEqual([{ centerX: 20, centerY: 10, distance: 20 }]);
        expect(moves).toEqual([{ centerX: 30, centerY: 10, distance: 40 }]);
        pointer(document, "pointerup", 2);
        expect(pinch.active).toBe(false);
        expect(captured.size).toBe(0);
        pointer(document, "pointerup", 1);
        expect(ends).toBe(1);
    });

    it("cleans up lost capture and can start a fresh pair after cancellation", () => {
        const { target, element, document, view } = surface();
        let starts = 0;
        let ends = 0;
        const pinch = attachPinchGesture(element, {
            accepts: () => true,
            onStart: () => {
                starts++;
                return true;
            },
            onMove: () => {},
            onEnd: () => {
                ends++;
            },
        });
        pointer(target, "pointerdown", 1);
        pointer(target, "pointerdown", 2, 20);
        pointer(target, "lostpointercapture", 1);
        pointer(document, "pointerup", 2);
        pointer(target, "pointerdown", 3);
        pointer(target, "pointerdown", 4, 20);
        view.dispatchEvent(new Event("blur"));
        pinch.reset();
        expect(starts).toBe(2);
        expect(ends).toBe(2);
        expect(pinch.active).toBe(false);
    });

    it("drops a lone uncaptured contact released outside the host", () => {
        const { target, element, document } = surface();
        let starts = 0;
        attachPinchGesture(element, {
            accepts: () => true,
            onStart: () => {
                starts++;
                return true;
            },
            onMove: () => {},
            onEnd: () => {},
        });
        pointer(target, "pointerdown", 1);
        pointer(document, "pointerup", 1);
        pointer(target, "pointerdown", 2);
        expect(starts).toBe(0);
        pointer(target, "pointerdown", 3);
        expect(starts).toBe(1);
    });
});
