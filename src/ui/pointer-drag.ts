// Shared pointer-drag scaffolding. Every drag surface in the player (PiP
// move/resize, crop rect/handles, overlay/watermark drags, map resize, column
// divider) needs the same boilerplate: a primary-button pointerdown that
// captures the pointer, a pointerId-filtered move, and a single finish on
// pointerup, pointercancel or lost capture. Hand-rolled copies drifted apart -
// some missed the primary-button check (right-click started a resize), some
// called setPointerCapture unguarded (throws NotFoundError for an
// already-inactive pointer), one tracked a bare boolean so a second touch
// mid-drag corrupted the gesture. One implementation, one set of fixes.

export interface PointerDragHandlers {
    /**
     * Gesture preconditions + per-drag state capture. Runs on a primary-button
     * pointerdown while no drag is active. Return false to ignore the event
     * (e.g. wrong target, mode not active) - nothing is captured then.
     */
    onStart: (e: PointerEvent) => boolean;
    /** Pointer moved while THIS drag's pointer is down (other pointers are
     *  filtered out, so a second touch cannot corrupt the gesture). */
    onMove: (e: PointerEvent) => void;
    /** Fired exactly once. Cancellation keeps the last known pointer position. */
    onEnd?: (e: PointerEvent, reason: "up" | "cancel") => void;
}

export interface PointerDragController {
    /** Finish an active gesture, e.g. when a second touch takes over as a pinch. */
    cancel(): void;
}

/** Capture can fail when a pointer ended before a deferred handler ran. */
export function capturePointer(el: HTMLElement, pointerId: number): boolean {
    try {
        el.setPointerCapture(pointerId);
        return true;
    } catch {
        return false;
    }
}

export function releasePointer(el: HTMLElement, pointerId: number): void {
    try {
        if (el.hasPointerCapture(pointerId)) el.releasePointerCapture(pointerId);
    } catch {
        // The browser may have already released or removed this pointer.
    }
}

/**
 * Wires one-pointer drags with capture, lost-capture and window-blur cleanup.
 * Handlers receive the raw events; geometry math stays at the call site.
 */
export function attachPointerDrag(el: HTMLElement, handlers: PointerDragHandlers): PointerDragController {
    let lastEvent: PointerEvent | null = null;
    let fallbackTarget: Document | null = null;
    const document = el.ownerDocument;
    const view = document.defaultView;
    const move = (e: PointerEvent): void => {
        if (!lastEvent || e.pointerId !== lastEvent.pointerId) return;
        lastEvent = e;
        handlers.onMove(e);
    };
    const finish = (e: PointerEvent, reason: "up" | "cancel"): void => {
        if (!lastEvent || e.pointerId !== lastEvent.pointerId) return;
        const finalEvent = reason === "up" ? e : lastEvent;
        lastEvent = null;
        fallbackTarget?.removeEventListener("pointermove", move);
        fallbackTarget = null;
        document.removeEventListener("pointerup", up, true);
        document.removeEventListener("pointercancel", cancelEvent, true);
        document.removeEventListener("lostpointercapture", lostCapture, true);
        view?.removeEventListener("blur", cancel);
        releasePointer(el, e.pointerId);
        handlers.onEnd?.(finalEvent, reason);
    };
    const up = (e: PointerEvent): void => finish(e, "up");
    const cancelEvent = (e: PointerEvent): void => finish(e, "cancel");
    const cancel = (): void => {
        if (lastEvent) finish(lastEvent, "cancel");
    };
    const lostCapture = (e: PointerEvent): void => {
        // A removed capture target reports its loss on the document instead.
        if (e.target === el || !el.isConnected) cancelEvent(e);
    };
    el.addEventListener("pointerdown", (e) => {
        // Primary button / touch only - right-click must not start a drag.
        if (e.button !== 0) return;
        // One drag at a time: a second touch mid-drag is ignored, not adopted.
        if (lastEvent) return;
        if (!handlers.onStart(e)) return;
        lastEvent = e;
        view?.addEventListener("blur", cancel);
        document.addEventListener("pointerup", up, true);
        document.addEventListener("pointercancel", cancelEvent, true);
        document.addEventListener("lostpointercapture", lostCapture, true);
        if (!capturePointer(el, e.pointerId)) {
            // Synthetic events and a pointer ending in this tick may have no
            // capture. Still observe its release outside the original target.
            fallbackTarget = el.ownerDocument;
            fallbackTarget.addEventListener("pointermove", move);
        }
    });
    el.addEventListener("pointermove", (e) => {
        if (!fallbackTarget) move(e);
    });
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", cancelEvent);
    el.addEventListener("lostpointercapture", (e) => {
        // Descendant captures can transfer to this surface (e.g. a pinch).
        if (e.target === el) cancelEvent(e);
    });
    return { cancel };
}

/**
 * Suppresses iOS history swipe-back/forward for drags starting on `el` near a
 * screen edge. iOS arms the swipe on touches that START within the edge strip,
 * and the only page-side lever against it is preventDefault on a NON-PASSIVE
 * touchstart - pointer-event preventDefault does not reach that gesture. Only
 * edge-starting touches are cancelled, so taps elsewhere on `el` keep their
 * synthetic click. Android's system back-swipe ignores this entirely - there
 * the layout gutter is the mitigation (chart.ts TIMELINE_EDGE_GUTTER_*).
 */
export function suppressEdgeSwipeNav(el: HTMLElement, edgePx = 36): void {
    el.addEventListener(
        "touchstart",
        (ev) => {
            const x = ev.touches[0]?.clientX;
            if (x === undefined) return;
            if (x < edgePx || x > window.innerWidth - edgePx) ev.preventDefault();
        },
        { passive: false },
    );
}
