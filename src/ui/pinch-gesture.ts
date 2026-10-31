import { capturePointer, releasePointer } from "./pointer-drag.js";

export interface PinchGeometry {
    centerX: number;
    centerY: number;
    distance: number;
}

interface PinchHandlers {
    accepts(event: PointerEvent): boolean;
    /** Snapshot application geometry; false leaves the contacts unclaimed. */
    onStart(geometry: PinchGeometry): boolean;
    onMove(geometry: PinchGeometry): void;
    onEnd(): void;
}

export interface PinchGesture {
    readonly active: boolean;
    reset(): void;
}

/** Two-touch contact/capture lifecycle shared by timeline and video zoom.
 * Geometry remains in client pixels; each surface owns its content transform. */
export function attachPinchGesture(host: HTMLElement, handlers: PinchHandlers): PinchGesture {
    const contacts = new Map<number, { x: number; y: number }>();
    const document = host.ownerDocument;
    let active = false;
    const geometry = (): PinchGeometry | null => {
        const [a, b] = contacts.values();
        if (!a || !b) return null;
        return {
            centerX: (a.x + b.x) / 2,
            centerY: (a.y + b.y) / 2,
            distance: Math.hypot(a.x - b.x, a.y - b.y) || 1,
        };
    };
    const detach = (): void => {
        document.removeEventListener("pointermove", move);
        document.removeEventListener("pointerup", end);
        document.removeEventListener("pointercancel", end);
        document.defaultView?.removeEventListener("blur", reset);
    };
    const reset = (): void => {
        const ids = [...contacts.keys()];
        contacts.clear();
        const wasActive = active;
        active = false;
        detach();
        for (const id of ids) releasePointer(host, id);
        if (wasActive) handlers.onEnd();
    };
    const move = (event: PointerEvent): void => {
        if (!contacts.has(event.pointerId)) return;
        contacts.set(event.pointerId, { x: event.clientX, y: event.clientY });
        const current = active ? geometry() : null;
        if (!current) return;
        event.preventDefault();
        handlers.onMove(current);
    };
    const end = (event: PointerEvent): void => {
        if (!contacts.delete(event.pointerId)) return;
        if (active) {
            active = false;
            releasePointer(host, event.pointerId);
            for (const id of contacts.keys()) releasePointer(host, id);
            handlers.onEnd();
        }
        if (!contacts.size) detach();
    };
    host.addEventListener("pointerdown", (event) => {
        if (event.pointerType !== "touch" || event.button !== 0 || !handlers.accepts(event)) return;
        // A third contact must not replace either member of the current pair.
        if (contacts.size >= 2 || contacts.has(event.pointerId)) return;
        if (!contacts.size) {
            // Observe uncaptured first contacts and capture failures too, so
            // a finger lifted outside the host cannot poison the next gesture.
            document.addEventListener("pointermove", move, { passive: false });
            document.addEventListener("pointerup", end);
            document.addEventListener("pointercancel", end);
            document.defaultView?.addEventListener("blur", reset);
        }
        contacts.set(event.pointerId, { x: event.clientX, y: event.clientY });
        const initial = geometry();
        if (!initial || !handlers.onStart(initial)) return;
        active = true;
        for (const id of contacts.keys()) capturePointer(host, id);
    });
    host.addEventListener("lostpointercapture", (event) => {
        // A child's implicit capture moving to the host is expected. Loss of
        // the host's capture while pinching is an interruption of the pair.
        if (active && event.target === host && contacts.has(event.pointerId)) reset();
    });
    return {
        get active() {
            return active;
        },
        reset,
    };
}
