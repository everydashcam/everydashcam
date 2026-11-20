// Lightweight replacements for MapLibre's built-in ScaleControl and
// NavigationControl. MapLibre's ScaleControl rewrites element.style.width on
// every `move` event (even for sub-micrometer latitude shifts), forcing a flex
// relayout on every follow frame; its NavigationControl recomputes and writes
// zoom button attributes on every `move` and rewrites the compass transform on
// every rotation. Both controls keep MapLibre's CSS classes so existing styles
// and selectors apply.

import type { IControl, Map as MapLibreMap } from "maplibre-gl";

import { t } from "../i18n/index.js";
import type { Units } from "../units-pref.js";
import { FEET_PER_METER, FEET_PER_MILE, formatNumber } from "./format.js";
import { attachPointerDrag, type PointerDragController } from "./pointer-drag.js";

export interface MapScaleControlOptions {
    maxWidth?: number;
    unit?: Units;
}

// A latitude change of 0.02 deg (~2.2 km) alters cos(lat) by under 0.1% up to
// 70 deg latitude (<0.12 px on a 120 px bar); skipping unproject/distanceTo
// inside this band avoids per-frame trig and allocation during straight-line
// playback.
const SCALE_ZOOM_EPS = 0.005;
const SCALE_LAT_EPS = 0.02;
const SCALE_PITCH_EPS = 0.5;
const DEFAULT_SCALE_MAX_WIDTH = 100;

/** Rounds a scale distance down to the standard 1 / 2 / 3 / 5 / 10 cartographic step. */
export function roundScaleDistance(value: number): number {
    if (!Number.isFinite(value) || value <= 0) return 0;
    if (value < 1) {
        const factor = 10 ** Math.ceil(-Math.log(value) / Math.LN10);
        return Math.round(value * factor) / factor;
    }
    const pow10 = 10 ** (String(Math.floor(value)).length - 1);
    const scaled = value / pow10;
    const step = scaled >= 10 ? 10 : scaled >= 5 ? 5 : scaled >= 3 ? 3 : scaled >= 2 ? 2 : 1;
    return pow10 * step;
}

function formatScaleBar(maxWidth: number, maxMeters: number, units: Units): { widthPx: number; label: string } | null {
    if (!Number.isFinite(maxMeters) || maxMeters <= 0 || maxWidth <= 0) return null;
    let maxDistance: number;
    let unitLabel: string;
    if (units === "imperial") {
        const feet = FEET_PER_METER * maxMeters;
        if (feet > FEET_PER_MILE) {
            maxDistance = feet / FEET_PER_MILE;
            unitLabel = t("units.mi");
        } else {
            maxDistance = feet;
            unitLabel = t("units.foot");
        }
    } else if (maxMeters >= 1000) {
        maxDistance = maxMeters / 1000;
        unitLabel = t("units.km");
    } else {
        maxDistance = maxMeters;
        unitLabel = t("units.meter");
    }
    const distance = roundScaleDistance(maxDistance);
    if (distance <= 0) return null;
    const widthPx = Math.max(1, Math.round(maxWidth * (distance / maxDistance)));
    // Fractional steps only occur below one unit at extreme zoom.
    return { widthPx, label: `${formatNumber(distance, 2, 0)}\u00a0${unitLabel}` };
}

/** Dirty-checked scale bar that avoids layout thrashing during continuous follow moves. */
export class MapScaleControl implements IControl {
    private map: MapLibreMap | null = null;
    private root: HTMLDivElement | null = null;
    private readonly maxWidth: number;
    private unit: Units;
    private cachedWidth = 0;
    private cachedHeight = 0;
    private lastZoom = Number.NaN;
    private lastLat = Number.NaN;
    private lastPitch = Number.NaN;
    private lastWidthPx = -1;
    private lastLabel = "";

    constructor(options: MapScaleControlOptions = {}) {
        this.maxWidth = options.maxWidth ?? DEFAULT_SCALE_MAX_WIDTH;
        this.unit = options.unit ?? "metric";
    }

    getDefaultPosition(): "bottom-left" {
        return "bottom-left";
    }

    onAdd(map: MapLibreMap): HTMLElement {
        this.map = map;
        const root = document.createElement("div");
        root.className = "maplibregl-ctrl maplibregl-ctrl-scale";
        this.root = root;
        this.refreshContainerSize();
        map.on("move", this.onMove);
        map.on("resize", this.onResize);
        map.on("projectiontransition", this.onForcedUpdate);
        this.update(true);
        return root;
    }

    onRemove(): void {
        if (this.map) {
            this.map.off("move", this.onMove);
            this.map.off("resize", this.onResize);
            this.map.off("projectiontransition", this.onForcedUpdate);
            this.map = null;
        }
        this.root?.remove();
        this.root = null;
        this.resetCache();
    }

    setUnit(unit: Units): void {
        if (this.unit === unit) return;
        this.unit = unit;
        this.update(true);
    }

    private resetCache(): void {
        this.cachedWidth = 0;
        this.cachedHeight = 0;
        this.lastZoom = Number.NaN;
        this.lastLat = Number.NaN;
        this.lastPitch = Number.NaN;
        this.lastWidthPx = -1;
        this.lastLabel = "";
    }

    private refreshContainerSize(): void {
        const map = this.map;
        if (!map) return;
        const container = map.getContainer();
        this.cachedWidth = container.clientWidth;
        this.cachedHeight = container.clientHeight;
    }

    private onMove = (): void => {
        this.update(false);
    };

    private onResize = (): void => {
        this.refreshContainerSize();
        this.update(true);
    };

    private onForcedUpdate = (): void => {
        this.update(true);
    };

    private update(force: boolean): void {
        const map = this.map;
        const root = this.root;
        if (!map || !root) return;
        if (this.cachedWidth <= 0 || this.cachedHeight <= 0) {
            this.refreshContainerSize();
            if (this.cachedWidth <= 0 || this.cachedHeight <= 0) return;
        }
        const zoom = map.getZoom();
        const center = map.getCenter();
        const pitch = map.getPitch();
        if (
            !force &&
            Math.abs(zoom - this.lastZoom) < SCALE_ZOOM_EPS &&
            Math.abs(center.lat - this.lastLat) < SCALE_LAT_EPS &&
            Math.abs(pitch - this.lastPitch) < SCALE_PITCH_EPS
        ) {
            return;
        }
        this.lastZoom = zoom;
        this.lastLat = center.lat;
        this.lastPitch = pitch;

        const halfWidth = this.cachedWidth / 2;
        const halfHeight = this.cachedHeight / 2;
        const halfBar = this.maxWidth / 2;
        const left = map.unproject([halfWidth - halfBar, halfHeight]);
        const right = map.unproject([halfWidth + halfBar, halfHeight]);
        if (!left || !right) return;
        const projectedSpan = Math.round(map.project(right).x - map.project(left).x);
        const barMaxWidth = Math.min(this.maxWidth, projectedSpan, this.cachedWidth);
        const formatted = formatScaleBar(barMaxWidth, left.distanceTo(right), this.unit);
        if (!formatted) return;
        if (formatted.widthPx !== this.lastWidthPx) {
            this.lastWidthPx = formatted.widthPx;
            root.style.width = `${formatted.widthPx}px`;
        }
        if (formatted.label !== this.lastLabel) {
            this.lastLabel = formatted.label;
            root.textContent = formatted.label;
        }
    }
}

export interface MapNavigationControlOptions {
    /** Returns whether the compass button can reset bearing to north right now. */
    canResetBearing?: () => boolean;
    /** Returns whether dragging the compass may rotate the map right now. */
    canDragRotate?: () => boolean;
}

// 0.5 deg quantization avoids sub-degree style recalcs on gentle bearing drift.
const COMPASS_STEP_DEG = 0.5;
// Pointer travel before a compass press turns into a rotation drag, so a
// slightly shaky press still resets north. A finger slides further during a
// tap than a mouse does; both distances are the ones MapLibre's compass uses.
const COMPASS_DRAG_TOLERANCE_PX = 3;
const COMPASS_TOUCH_DRAG_TOLERANCE_PX = 10;
// Float noise between the constrained minimum and the zoom MapLibre clamps to.
const ZOOM_LIMIT_EPS = 1e-6;

interface CompassDrag {
    readonly centerX: number;
    readonly centerY: number;
    readonly startX: number;
    readonly startY: number;
    readonly tolerancePx: number;
    /** Pointer angle around the button center at the previous rotation step;
     *  meaningful only while isRotating. */
    lastAngleRad: number;
    isRotating: boolean;
}

/** Zoom +/- and north-reset compass that skip redundant DOM writes during follow moves. */
export class MapNavigationControl implements IControl {
    private map: MapLibreMap | null = null;
    private root: HTMLDivElement | null = null;
    private zoomInBtn: HTMLButtonElement | null = null;
    private zoomOutBtn: HTMLButtonElement | null = null;
    private compassBtn: HTMLButtonElement | null = null;
    private compassIcon: HTMLSpanElement | null = null;
    private readonly canResetBearing: () => boolean;
    private readonly canDragRotate: () => boolean;
    private isZoomInDisabled: boolean | null = null;
    private isZoomOutDisabled: boolean | null = null;
    private isCompassDisabled: boolean | null = null;
    private lastCompassDeg = Number.NaN;
    private constrainedMinZoom = Number.NEGATIVE_INFINITY;
    private compassDrag: CompassDrag | null = null;
    private compassDragController: PointerDragController | null = null;
    private shouldSuppressCompassClick = false;

    constructor(options: MapNavigationControlOptions = {}) {
        this.canResetBearing = options.canResetBearing ?? (() => true);
        this.canDragRotate = options.canDragRotate ?? (() => false);
    }

    getDefaultPosition(): "top-right" {
        return "top-right";
    }

    onAdd(map: MapLibreMap): HTMLElement {
        this.map = map;
        const root = document.createElement("div");
        root.className = "maplibregl-ctrl maplibregl-ctrl-group";
        root.addEventListener("contextmenu", (event) => event.preventDefault());

        const zoomIn = createNavButton("maplibregl-ctrl-zoom-in", (event) => {
            this.map?.zoomIn({}, { originalEvent: event });
        });
        const zoomOut = createNavButton("maplibregl-ctrl-zoom-out", (event) => {
            this.map?.zoomOut({}, { originalEvent: event });
        });
        const compass = createNavButton("maplibregl-ctrl-compass", (event) => {
            // A rotation drag that ends over the button still produces a click;
            // it must not snap the map back north. Keyboard clicks have detail 0.
            if (this.shouldSuppressCompassClick && event.detail !== 0) {
                this.shouldSuppressCompassClick = false;
                return;
            }
            if (!this.map || this.isCompassDisabled || !this.canResetBearing()) return;
            this.map.resetNorth({}, { originalEvent: event });
        });
        this.compassDragController = attachPointerDrag(compass.button, {
            onStart: this.onCompassDragStart,
            onMove: this.onCompassDragMove,
            onEnd: this.onCompassDragEnd,
        });

        root.append(zoomIn.button, zoomOut.button, compass.button);
        this.root = root;
        this.zoomInBtn = zoomIn.button;
        this.zoomOutBtn = zoomOut.button;
        this.compassBtn = compass.button;
        this.compassIcon = compass.icon;

        this.localize();
        this.refreshConstrainedMinZoom();
        map.on("zoom", this.updateZoomButtons);
        map.on("resize", this.onResize);
        map.on("rotate", this.updateCompassArrow);
        this.updateZoomButtons();
        this.updateCompassArrow();
        return root;
    }

    onRemove(): void {
        if (this.map) {
            this.map.off("zoom", this.updateZoomButtons);
            this.map.off("resize", this.onResize);
            this.map.off("rotate", this.updateCompassArrow);
            this.map = null;
        }
        this.root?.remove();
        this.root = null;
        this.zoomInBtn = null;
        this.zoomOutBtn = null;
        this.compassBtn = null;
        this.compassIcon = null;
        this.isZoomInDisabled = null;
        this.isZoomOutDisabled = null;
        this.isCompassDisabled = null;
        this.lastCompassDeg = Number.NaN;
        this.constrainedMinZoom = Number.NEGATIVE_INFINITY;
        this.compassDragController?.cancel();
        this.compassDragController = null;
        this.compassDrag = null;
        this.shouldSuppressCompassClick = false;
    }

    /** Applies localized button labels; the compass label also tracks availability. */
    localize(): void {
        setButtonLabel(this.zoomInBtn, t("map.ctrl.zoomIn"));
        setButtonLabel(this.zoomOutBtn, t("map.ctrl.zoomOut"));
        this.syncCompass(true);
    }

    /** Updates compass availability; refreshLabel rewrites the label even if unchanged. */
    syncCompass(refreshLabel = false): void {
        const button = this.compassBtn;
        if (!button) return;
        const isDisabled = !this.canResetBearing();
        if (!refreshLabel && this.isCompassDisabled === isDisabled) return;
        this.isCompassDisabled = isDisabled;
        button.disabled = isDisabled;
        button.setAttribute("aria-disabled", String(isDisabled));
        setButtonLabel(button, t(isDisabled ? "map.ctrl.resetBearingFlatOnly" : "map.ctrl.resetBearing"));
    }

    private onResize = (): void => {
        this.refreshConstrainedMinZoom();
        this.updateZoomButtons();
    };

    /**
     * Caches the zoom MapLibre actually allows: a tall container cannot zoom out
     * past the point where the world fills its height. Without maxBounds the
     * limit depends only on the container size and zoom limits, never on the
     * camera, so a resize refreshes it and follow frames skip the constrain math.
     */
    private refreshConstrainedMinZoom(): void {
        this.constrainedMinZoom = this.map?.getMinZoom(true) ?? Number.NEGATIVE_INFINITY;
    }

    private updateZoomButtons = (): void => {
        const map = this.map;
        if (!map || !this.zoomInBtn || !this.zoomOutBtn) return;
        const zoom = map.getZoom();
        const atMax = zoom >= map.getMaxZoom();
        const atMin = zoom <= this.constrainedMinZoom + ZOOM_LIMIT_EPS;
        if (atMax !== this.isZoomInDisabled) {
            this.isZoomInDisabled = atMax;
            this.zoomInBtn.disabled = atMax;
            this.zoomInBtn.setAttribute("aria-disabled", String(atMax));
        }
        if (atMin !== this.isZoomOutDisabled) {
            this.isZoomOutDisabled = atMin;
            this.zoomOutBtn.disabled = atMin;
            this.zoomOutBtn.setAttribute("aria-disabled", String(atMin));
        }
    };

    // The arrow keeps pointing north while the button is disabled, so the
    // dimmed compass never shows a stale heading in Chase.
    private updateCompassArrow = (): void => {
        const map = this.map;
        const icon = this.compassIcon;
        if (!map || !icon) return;
        const deg = Math.round(-map.getBearing() / COMPASS_STEP_DEG) * COMPASS_STEP_DEG;
        if (deg === this.lastCompassDeg) return;
        this.lastCompassDeg = deg;
        icon.style.transform = `rotate(${deg}deg)`;
    };

    private onCompassDragStart = (event: PointerEvent): boolean => {
        // A drag released away from the button leaves no click to consume this.
        this.shouldSuppressCompassClick = false;
        const button = this.compassBtn;
        if (!button || !this.map || !event.isPrimary || !this.canDragRotate()) return false;
        const rect = button.getBoundingClientRect();
        this.compassDrag = {
            centerX: rect.left + rect.width / 2,
            centerY: rect.top + rect.height / 2,
            startX: event.clientX,
            startY: event.clientY,
            tolerancePx: event.pointerType === "touch" ? COMPASS_TOUCH_DRAG_TOLERANCE_PX : COMPASS_DRAG_TOLERANCE_PX,
            lastAngleRad: 0,
            isRotating: false,
        };
        return true;
    };

    private onCompassDragMove = (event: PointerEvent): void => {
        const drag = this.compassDrag;
        const map = this.map;
        if (!drag || !map) return;
        const angleRad = Math.atan2(event.clientY - drag.centerY, event.clientX - drag.centerX);
        if (!drag.isRotating) {
            const travelPx = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY);
            if (travelPx < drag.tolerancePx) return;
            drag.isRotating = true;
            // Rotation is measured from here, not from the press: a press next
            // to the button center has no meaningful angle, so the few pixels
            // of tolerance would otherwise turn the map by up to half a turn.
            drag.lastAngleRad = angleRad;
            return;
        }
        const sweptDeg = ((angleRad - drag.lastAngleRad) * 180) / Math.PI;
        drag.lastAngleRad = angleRad;
        // Screen angles grow clockwise; turning the north arrow clockwise lowers
        // the bearing by the same angle, so the arrow follows the pointer.
        const deltaDeg = sweptDeg - 360 * Math.round(sweptDeg / 360);
        if (deltaDeg === 0 || !this.canDragRotate()) return;
        // originalEvent marks a user gesture, so following pauses as for any
        // other rotation instead of overwriting the bearing on the next frame.
        map.setBearing(map.getBearing() - deltaDeg, { originalEvent: event });
    };

    private onCompassDragEnd = (_event: PointerEvent, reason: "up" | "cancel"): void => {
        const wasRotating = this.compassDrag?.isRotating === true;
        this.compassDrag = null;
        // Only a release can be followed by the click that must not reset north.
        this.shouldSuppressCompassClick = reason === "up" && wasRotating;
    };
}

function createNavButton(
    className: string,
    onClick: (event: MouseEvent) => void,
): { button: HTMLButtonElement; icon: HTMLSpanElement } {
    const button = document.createElement("button");
    button.type = "button";
    button.className = className;
    const icon = document.createElement("span");
    icon.className = "maplibregl-ctrl-icon";
    icon.setAttribute("aria-hidden", "true");
    button.append(icon);
    button.addEventListener("click", onClick);
    return { button, icon };
}

function setButtonLabel(button: HTMLButtonElement | null, label: string): void {
    if (!button) return;
    button.title = label;
    button.setAttribute("aria-label", label);
}
