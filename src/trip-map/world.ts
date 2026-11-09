// Shared coordinate space of the trip map: normalized Web Mercator, where one
// unit spans the whole world (MapLibre's MercatorCoordinate). Pixel sizes at a
// zoom level are a plain multiplication, so grids, tolerances and queries all
// work in one space without re-projecting per call.

import { mercatorY } from "../coordinates.js";

/** Web Mercator circumference at the equator in metres (MapLibre's earth radius). */
const EARTH_CIRCUMFERENCE_M = 2 * Math.PI * 6371008.8;
/** MapLibre renders 512 px tiles, so the world is 512 px wide at zoom 0. */
export const WORLD_TILE_PX = 512;

export interface WorldBounds {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
}

/** Normalized x of a longitude; unwrapped longitudes leave the 0..1 range on purpose. */
export function worldX(lonDeg: number): number {
    return (lonDeg + 180) / 360;
}

/** Normalized y of a latitude, growing southward; clamped at the Mercator poles. */
export function worldY(latDeg: number): number {
    return mercatorY(latDeg) / 360;
}

export function worldToLon(x: number): number {
    return x * 360 - 180;
}

export function worldToLat(y: number): number {
    return (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI;
}

/** Ground metres per world unit at a world y: Mercator stretches by 1/cos(lat). */
export function groundMetersPerWorldUnit(y: number): number {
    return EARTH_CIRCUMFERENCE_M / Math.cosh(Math.PI * (1 - 2 * y));
}

/** World units per screen pixel at a zoom level. */
export function worldUnitsPerPixel(zoom: number): number {
    return 1 / (WORLD_TILE_PX * 2 ** zoom);
}

export function emptyBounds(): WorldBounds {
    return { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
}

export function isEmptyBounds(bounds: WorldBounds): boolean {
    return !(bounds.minX <= bounds.maxX && bounds.minY <= bounds.maxY);
}

/** Grows `target` in place to also cover `other`. */
export function extendBounds(target: WorldBounds, other: WorldBounds): WorldBounds {
    if (other.minX < target.minX) target.minX = other.minX;
    if (other.minY < target.minY) target.minY = other.minY;
    if (other.maxX > target.maxX) target.maxX = other.maxX;
    if (other.maxY > target.maxY) target.maxY = other.maxY;
    return target;
}
