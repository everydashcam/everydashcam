import type { Map as MapLibreMap } from "maplibre-gl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MapNavigationControl, MapScaleControl, roundScaleDistance } from "./map-controls.js";

class FakeStyle {
    widthWrites = 0;
    transformWrites = 0;
    private widthValue = "";
    private transformValue = "";

    get width(): string {
        return this.widthValue;
    }

    set width(value: string) {
        this.widthValue = value;
        this.widthWrites++;
    }

    get transform(): string {
        return this.transformValue;
    }

    set transform(value: string) {
        this.transformValue = value;
        this.transformWrites++;
    }
}

interface FakePointer {
    pointerId?: number;
    pointerType?: "mouse" | "touch";
    clientX: number;
    clientY: number;
}

class FakeEventTarget {
    listeners = new Map<string, Array<(event: unknown) => void>>();

    addEventListener(type: string, handler: (event: unknown) => void): void {
        const list = this.listeners.get(type) ?? [];
        list.push(handler);
        this.listeners.set(type, list);
    }

    removeEventListener(type: string, handler: (event: unknown) => void): void {
        const list = this.listeners.get(type) ?? [];
        this.listeners.set(
            type,
            list.filter((entry) => entry !== handler),
        );
    }

    dispatch(type: string, event: unknown): void {
        for (const handler of [...(this.listeners.get(type) ?? [])]) handler(event);
    }
}

// The window and document a drag listens on while its pointer is down.
let fakeWindow = new FakeEventTarget();
let fakeOwnerDocument = Object.assign(new FakeEventTarget(), { defaultView: fakeWindow });

class FakeElement extends FakeEventTarget {
    className = "";
    type = "";
    title = "";
    disabled = false;
    isConnected = true;
    clientWidth = 800;
    clientHeight = 600;
    children: FakeElement[] = [];
    attributes = new Map<string, string>();
    textWrites = 0;
    attrWrites = 0;
    readonly style = new FakeStyle();
    private textValue = "";

    constructor(public readonly tagName: string) {
        super();
    }

    get ownerDocument(): typeof fakeOwnerDocument {
        return fakeOwnerDocument;
    }

    get textContent(): string {
        return this.textValue;
    }

    set textContent(value: string) {
        this.textValue = value;
        this.textWrites++;
    }

    append(...nodes: FakeElement[]): void {
        this.children.push(...nodes);
    }

    remove(): void {}

    setAttribute(name: string, value: string): void {
        this.attributes.set(name, value);
        this.attrWrites++;
    }

    getAttribute(name: string): string | null {
        return this.attributes.get(name) ?? null;
    }

    getBoundingClientRect(): { left: number; top: number; width: number; height: number } {
        return { left: 0, top: 0, width: 30, height: 30 };
    }

    setPointerCapture(_pointerId: number): void {}

    hasPointerCapture(_pointerId: number): boolean {
        return true;
    }

    releasePointerCapture(_pointerId: number): void {}

    /** A pointer click has detail >= 1; keyboard activation has detail 0. */
    click(detail = 1): void {
        this.dispatch("click", { detail });
    }

    pointer(
        type: "pointerdown" | "pointermove" | "pointerup",
        { pointerId = 1, pointerType = "mouse", ...position }: FakePointer,
    ): void {
        this.dispatch(type, { pointerId, isPrimary: true, pointerType, button: 0, ...position });
    }
}

function createFakeMap() {
    const listeners = new Map<string, Set<() => void>>();
    const container = new FakeElement("div");
    let zoom = 16;
    let lat = 55.75;
    let bearing = 0;
    let pitch = 0;
    let constrainedMinZoom = 0;
    let unprojectCalls = 0;
    let resetNorthCalls = 0;
    let zoomInCalls = 0;
    let zoomOutCalls = 0;
    let lastBearingEventData: unknown = null;

    const emit = (type: string): void => {
        for (const fn of listeners.get(type) ?? []) fn();
    };

    const map = {
        getContainer: () => container,
        getZoom: () => zoom,
        getMaxZoom: () => 22,
        getMinZoom: (constrained = false) => (constrained ? constrainedMinZoom : 0),
        getCenter: () => ({ lat, lng: 37.62 }),
        getBearing: () => bearing,
        setBearing: (next: number, eventData?: unknown) => {
            bearing = next;
            lastBearingEventData = eventData ?? null;
            emit("rotate");
        },
        getPitch: () => pitch,
        unproject: ([x]: [number, number]) => {
            unprojectCalls++;
            const metersPerPx = (78271.5 * Math.cos((lat * Math.PI) / 180)) / 2 ** zoom;
            return {
                x,
                distanceTo: (other: { x: number }) => Math.abs(other.x - x) * metersPerPx,
            };
        },
        project: (point: { x: number }) => ({ x: point.x, y: 300 }),
        zoomIn: () => {
            zoomInCalls++;
        },
        zoomOut: () => {
            zoomOutCalls++;
        },
        resetNorth: () => {
            resetNorthCalls++;
        },
        on(type: string, fn: () => void) {
            const set = listeners.get(type) ?? new Set();
            set.add(fn);
            listeners.set(type, set);
        },
        off(type: string, fn: () => void) {
            listeners.get(type)?.delete(fn);
        },
    };

    return {
        map: map as unknown as MapLibreMap,
        container,
        emit,
        setCamera(next: { zoom?: number; lat?: number; bearing?: number; pitch?: number }) {
            if (next.zoom !== undefined) zoom = next.zoom;
            if (next.lat !== undefined) lat = next.lat;
            if (next.bearing !== undefined) bearing = next.bearing;
            if (next.pitch !== undefined) pitch = next.pitch;
        },
        setConstrainedMinZoom(next: number) {
            constrainedMinZoom = next;
        },
        get bearing() {
            return bearing;
        },
        get lastBearingEventData() {
            return lastBearingEventData;
        },
        get unprojectCalls() {
            return unprojectCalls;
        },
        get resetNorthCalls() {
            return resetNorthCalls;
        },
        get zoomInCalls() {
            return zoomInCalls;
        },
        get zoomOutCalls() {
            return zoomOutCalls;
        },
    };
}

function addNavigationControl(options: ConstructorParameters<typeof MapNavigationControl>[0]) {
    const fake = createFakeMap();
    const control = new MapNavigationControl(options);
    const root = control.onAdd(fake.map) as unknown as FakeElement;
    const [zoomIn, zoomOut, compass] = root.children as [FakeElement, FakeElement, FakeElement];
    return { fake, control, zoomIn, zoomOut, compass, compassIcon: compass.children[0]! };
}

// Both suites replace the global document, so they cannot run concurrently.
beforeEach(() => {
    fakeWindow = new FakeEventTarget();
    fakeOwnerDocument = Object.assign(new FakeEventTarget(), { defaultView: fakeWindow });
    vi.stubGlobal("document", {
        createElement: (tag: string) => new FakeElement(tag),
    });
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("roundScaleDistance", () => {
    it("rounds distances to standard cartographic 1/2/3/5/10 steps", () => {
        expect(roundScaleDistance(84)).toBe(50);
        expect(roundScaleDistance(140)).toBe(100);
        expect(roundScaleDistance(270)).toBe(200);
        expect(roundScaleDistance(420)).toBe(300);
        expect(roundScaleDistance(0.74)).toBeCloseTo(0.7, 5);
        expect(roundScaleDistance(0)).toBe(0);
    });
});

describe("MapScaleControl", () => {
    it("skips DOM writes and projections on small follow-mode camera moves", () => {
        const fake = createFakeMap();
        const control = new MapScaleControl({ maxWidth: 120, unit: "metric" });
        const root = control.onAdd(fake.map) as unknown as FakeElement;

        expect(root.style.widthWrites).toBe(1);
        expect(root.textWrites).toBe(1);
        expect(root.textContent).toMatch(/^\d+\u00a0m$/);
        const initialUnprojects = fake.unprojectCalls;

        // Simulate 30 steady-cruise follow frames moving a few meters per frame.
        for (let i = 1; i <= 30; i++) {
            fake.setCamera({ lat: 55.75 + i * 0.0001, zoom: 16 + i * 0.00005 });
            fake.emit("move");
        }
        expect(fake.unprojectCalls, "small shifts stay inside the tolerance band").toBe(initialUnprojects);
        expect(root.style.widthWrites, "steady moves never dirty layout width").toBe(1);
        expect(root.textWrites, "steady moves never rewrite label text").toBe(1);

        // A real zoom change updates the bar immediately.
        fake.setCamera({ zoom: 13 });
        fake.emit("move");
        expect(root.style.widthWrites).toBe(2);
        expect(root.textWrites).toBe(2);

        control.setUnit("imperial");
        expect(root.textContent).toMatch(/\u00a0(?:ft|mi)$/);
        control.onRemove();
    });
});

describe("MapNavigationControl", () => {
    it("keeps the disabled compass pointing north without per-move button writes", () => {
        let canReset = false;
        const { fake, control, zoomIn, zoomOut, compass, compassIcon } = addNavigationControl({
            canResetBearing: () => canReset,
        });
        const initialZoomInAttrs = zoomIn.attrWrites;
        const initialZoomOutAttrs = zoomOut.attrWrites;
        expect(compass.disabled).toBe(true);

        // Continuous follow moves and Chase rotations leave the zoom buttons alone.
        for (let i = 1; i <= 20; i++) {
            fake.setCamera({ bearing: i * 4.5 });
            fake.emit("move");
            fake.emit("rotate");
        }
        expect(zoomIn.attrWrites).toBe(initialZoomInAttrs);
        expect(zoomOut.attrWrites).toBe(initialZoomOutAttrs);
        expect(compassIcon.style.transform, "the dimmed compass still shows north").toBe("rotate(-90deg)");
        const transformWrites = compassIcon.style.transformWrites;
        compass.click();
        expect(fake.resetNorthCalls).toBe(0);

        // Sub-0.25 deg jitter does not rewrite the transform.
        fake.setCamera({ bearing: 90.1 });
        fake.emit("rotate");
        expect(compassIcon.style.transformWrites).toBe(transformWrites);

        canReset = true;
        control.syncCompass();
        expect(compass.disabled).toBe(false);
        compass.click();
        expect(fake.resetNorthCalls).toBe(1);
        zoomIn.click();
        zoomOut.click();
        expect(fake.zoomInCalls).toBe(1);
        expect(fake.zoomOutCalls).toBe(1);

        control.onRemove();
    });

    it("disables zoom out at the minimum the container size allows", () => {
        const fake = createFakeMap();
        fake.setConstrainedMinZoom(1.5);
        fake.setCamera({ zoom: 1.5 });
        const control = new MapNavigationControl();
        const root = control.onAdd(fake.map) as unknown as FakeElement;
        const zoomOut = root.children[1]!;
        expect(zoomOut.disabled, "constrained minimum above the configured one").toBe(true);

        fake.setCamera({ zoom: 2 });
        fake.emit("zoom");
        expect(zoomOut.disabled).toBe(false);

        // A smaller container lowers the reachable minimum.
        fake.setConstrainedMinZoom(0.5);
        fake.emit("resize");
        fake.setCamera({ zoom: 0.5 });
        fake.emit("zoom");
        expect(zoomOut.disabled).toBe(true);
        control.onRemove();
    });

    it("rotates the map by dragging the compass without resetting north on release", () => {
        const { fake, control, compass } = addNavigationControl({
            canResetBearing: () => true,
            canDragRotate: () => true,
        });

        // Leaving the press tolerance starts the rotation; then a quarter turn
        // clockwise around the button center (15, 15).
        compass.pointer("pointerdown", { clientX: 25, clientY: 12 });
        compass.pointer("pointermove", { clientX: 25, clientY: 15 });
        expect(fake.bearing, "the move that starts the drag does not rotate").toBe(0);
        compass.pointer("pointermove", { clientX: 15, clientY: 25 });
        compass.pointer("pointerup", { clientX: 15, clientY: 25 });
        compass.click();
        expect(fake.bearing).toBeCloseTo(-90, 6);
        expect(fake.lastBearingEventData, "drag counts as a user gesture").toHaveProperty("originalEvent");
        expect(fake.resetNorthCalls, "the click closing a drag is swallowed").toBe(0);

        // A press within the drag tolerance stays a click.
        compass.pointer("pointerdown", { clientX: 25, clientY: 15 });
        compass.pointer("pointermove", { clientX: 26, clientY: 16 });
        compass.pointer("pointerup", { clientX: 26, clientY: 16 });
        compass.click();
        expect(fake.bearing).toBeCloseTo(-90, 6);
        expect(fake.resetNorthCalls).toBe(1);
        control.onRemove();
    });

    it("starts a compass drag from the button center without a jump", () => {
        const { fake, control, compass } = addNavigationControl({
            canResetBearing: () => true,
            canDragRotate: () => true,
        });

        // The center (15, 15) has no angle: leaving it must not count as a turn.
        compass.pointer("pointerdown", { clientX: 15, clientY: 15 });
        compass.pointer("pointermove", { clientX: 15, clientY: 11 });
        expect(fake.bearing).toBe(0);
        compass.pointer("pointermove", { clientX: 19, clientY: 11 });
        expect(fake.bearing, "an eighth of a turn clockwise from straight up").toBeCloseTo(-45, 6);
        compass.pointer("pointerup", { clientX: 19, clientY: 11 });
        compass.click();
        expect(fake.resetNorthCalls, "the click closing a drag is swallowed").toBe(0);
        control.onRemove();
    });

    it("keeps a finger tap that slides a little a north reset", () => {
        const { fake, control, compass } = addNavigationControl({
            canResetBearing: () => true,
            canDragRotate: () => true,
        });

        // 6 px would start a mouse drag; a finger moves that much during a tap.
        compass.pointer("pointerdown", { pointerType: "touch", clientX: 25, clientY: 12 });
        compass.pointer("pointermove", { pointerType: "touch", clientX: 25, clientY: 18 });
        compass.pointer("pointerup", { pointerType: "touch", clientX: 25, clientY: 18 });
        compass.click();
        expect(fake.bearing).toBe(0);
        expect(fake.resetNorthCalls).toBe(1);

        compass.pointer("pointerdown", { pointerType: "touch", clientX: 25, clientY: 5 });
        compass.pointer("pointermove", { pointerType: "touch", clientX: 25, clientY: 15 });
        compass.pointer("pointermove", { pointerType: "touch", clientX: 15, clientY: 25 });
        compass.pointer("pointerup", { pointerType: "touch", clientX: 15, clientY: 25 });
        expect(fake.bearing, "a longer slide rotates").toBeCloseTo(-90, 6);
        control.onRemove();
    });

    it("ends a compass drag when the window loses focus", () => {
        const { fake, control, compass } = addNavigationControl({
            canResetBearing: () => true,
            canDragRotate: () => true,
        });

        compass.pointer("pointerdown", { clientX: 25, clientY: 12 });
        compass.pointer("pointermove", { clientX: 25, clientY: 15 });
        fakeWindow.dispatch("blur", {});
        // The release never arrived: later moves must not keep turning the map.
        compass.pointer("pointermove", { clientX: 15, clientY: 25 });
        expect(fake.bearing).toBe(0);
        compass.click();
        expect(fake.resetNorthCalls, "the next click is not swallowed").toBe(1);
        control.onRemove();
    });

    it("ignores compass drags where manual rotation is unavailable", () => {
        const { fake, control, compass } = addNavigationControl({
            canResetBearing: () => true,
            canDragRotate: () => false,
        });

        compass.pointer("pointerdown", { clientX: 25, clientY: 12 });
        compass.pointer("pointermove", { clientX: 25, clientY: 15 });
        compass.pointer("pointermove", { clientX: 15, clientY: 25 });
        compass.pointer("pointerup", { clientX: 15, clientY: 25 });
        compass.click();
        expect(fake.bearing).toBe(0);
        expect(fake.resetNorthCalls).toBe(1);
        control.onRemove();
    });
});
