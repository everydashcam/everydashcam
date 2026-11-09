// At a far zoom a trip spanning a few pixels is unreadable as a line. Such trips
// fold into counted dots; clicking a dot zooms to its trips. This is a drawing
// level only: a dot is not a place or a route the user can name or keep.

import { worldUnitsPerPixel, type WorldBounds } from "./world.js";

export interface FarDotTrip {
    id: number;
    bounds: WorldBounds;
}

export interface FarDot {
    /** Mean centre of the folded trips, world coordinates. */
    x: number;
    y: number;
    tripIds: number[];
    /** Union of the folded trips' bounds, for the zoom-in on click. */
    bounds: WorldBounds;
}

/** A trip folds into a dot when its bounding-box diagonal is below this. */
const FOLD_BELOW_DIAGONAL_PX = 9;
/** Dots group on a world-anchored grid of this size, so they stay put while panning. */
const GROUP_CELL_PX = 34;
const SINGLE_DOT_RADIUS_PX = 5;
const GROUP_RADIUS_BASE_PX = 8;
const GROUP_RADIUS_PER_DOUBLING_PX = 1.6;
const GROUP_RADIUS_MIN_PX = 9;
const GROUP_RADIUS_MAX_PX = 20;

/**
 * Folds the trips too small to read at `step` (a bundle zoom step) into dots.
 * Deterministic: dots and their trips keep the input order.
 */
export function foldFarTrips(trips: readonly FarDotTrip[], step: number): FarDot[] {
    const unit = worldUnitsPerPixel(step);
    const foldDiagonal = FOLD_BELOW_DIAGONAL_PX * unit;
    const groupCell = GROUP_CELL_PX * unit;
    const groups = new Map<string, { sumX: number; sumY: number; dot: FarDot }>();
    for (const trip of trips) {
        const { bounds } = trip;
        if (Math.hypot(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY) >= foldDiagonal) continue;
        const x = (bounds.minX + bounds.maxX) / 2;
        const y = (bounds.minY + bounds.maxY) / 2;
        const key = `${Math.floor(x / groupCell)}|${Math.floor(y / groupCell)}`;
        let group = groups.get(key);
        if (!group) {
            group = { sumX: 0, sumY: 0, dot: { x, y, tripIds: [], bounds: { ...bounds } } };
            groups.set(key, group);
        }
        group.sumX += x;
        group.sumY += y;
        group.dot.tripIds.push(trip.id);
        const union = group.dot.bounds;
        union.minX = Math.min(union.minX, bounds.minX);
        union.minY = Math.min(union.minY, bounds.minY);
        union.maxX = Math.max(union.maxX, bounds.maxX);
        union.maxY = Math.max(union.maxY, bounds.maxY);
    }
    const dots: FarDot[] = [];
    for (const { sumX, sumY, dot } of groups.values()) {
        dot.x = sumX / dot.tripIds.length;
        dot.y = sumY / dot.tripIds.length;
        dots.push(dot);
    }
    return dots;
}

/** Screen radius of a dot: a single trip is small, a group grows with its count. */
export function farDotRadiusPx(tripCount: number): number {
    if (tripCount <= 1) return SINGLE_DOT_RADIUS_PX;
    const radius = GROUP_RADIUS_BASE_PX + GROUP_RADIUS_PER_DOUBLING_PX * Math.log2(tripCount);
    return Math.max(GROUP_RADIUS_MIN_PX, Math.min(GROUP_RADIUS_MAX_PX, radius));
}
