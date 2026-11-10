// Place queries over simplified trip tracks: which trips cross the visible map
// area, when a trip passed through a chosen circle, and where it was at a given
// moment. Cheap enough for the main thread: the area and circle queries first
// reject trips by their bounding box.

import { segmentDistanceSquared, type TripMapTrack } from "./track-geometry.js";
import { groundMetersPerWorldUnit, type WorldBounds } from "./world.js";

// A turn sharper than 120 degrees at a vertex outside the circle is a drive
// back the way it came; a right-angle corner is not.
const TURN_BACK_COS = -0.5;

/** One continuous stay of a trip inside the circle, at its closest approach. */
export interface TripPass {
    /** unixSeconds at the closest point, interpolated between vertices. */
    unixSeconds: number;
    /** Closest point in world coordinates. */
    x: number;
    y: number;
}

export interface PlaceCircle {
    x: number;
    y: number;
    radiusMeters: number;
}

/**
 * Where the trip was at `unixSeconds` on its drawn route: interpolated along
 * the segment that spans the moment, at the nearer vertex across a gap, and
 * at the route's end outside the recorded span. Null for a track without
 * vertices.
 */
export function trackPositionAt(track: TripMapTrack, unixSeconds: number): { x: number; y: number } | null {
    const { times, points, breaks } = track;
    const count = times.length;
    if (count === 0) return null;
    const vertex = (index: number) => ({ x: points[index * 2]!, y: points[index * 2 + 1]! });
    if (unixSeconds <= times[0]!) return vertex(0);
    if (unixSeconds >= times[count - 1]!) return vertex(count - 1);
    // First vertex at or after the moment; times are non-decreasing.
    let low = 1;
    let high = count - 1;
    while (low < high) {
        const middle = (low + high) >> 1;
        if (times[middle]! < unixSeconds) low = middle + 1;
        else high = middle;
    }
    const before = low - 1;
    const startSec = times[before]!;
    const endSec = times[low]!;
    // A gap has no drawn line between its ends: stay on the nearer one.
    if (breaks[before] === 1 || endSec <= startSec) {
        return unixSeconds - startSec <= endSec - unixSeconds ? vertex(before) : vertex(low);
    }
    const share = (unixSeconds - startSec) / (endSec - startSec);
    const from = vertex(before);
    const to = vertex(low);
    return { x: from.x + (to.x - from.x) * share, y: from.y + (to.y - from.y) * share };
}

/** The circle's radius in world units at its own latitude. */
export function placeRadiusWorld(place: PlaceCircle): number {
    return place.radiusMeters / groundMetersPerWorldUnit(place.y);
}

/**
 * True when a vertex lies inside `area` or a drawn segment crosses it. The
 * area may extend past the world's edges; the track is also tested one world
 * to either side, the way the map repeats it.
 */
export function trackIntersectsArea(track: TripMapTrack, area: WorldBounds): boolean {
    for (const shift of [0, -1, 1]) {
        const minX = area.minX + shift;
        const maxX = area.maxX + shift;
        const { bounds } = track;
        if (bounds.maxX < minX || bounds.minX > maxX || bounds.maxY < area.minY || bounds.minY > area.maxY) continue;
        if (bounds.minX >= minX && bounds.maxX <= maxX && bounds.minY >= area.minY && bounds.maxY <= area.maxY)
            return true;
        if (trackCrossesBox(track, minX, area.minY, maxX, area.maxY)) return true;
    }
    return false;
}

function trackCrossesBox(track: TripMapTrack, minX: number, minY: number, maxX: number, maxY: number): boolean {
    const points = track.points;
    const vertices = track.times.length;
    for (let i = 0; i < vertices; i++) {
        const x = points[i * 2]!;
        const y = points[i * 2 + 1]!;
        if (x >= minX && x <= maxX && y >= minY && y <= maxY) return true;
    }
    for (let i = 0; i < vertices - 1; i++) {
        if (track.breaks[i] === 1) continue;
        if (
            segmentCrossesBox(
                points[i * 2]!,
                points[i * 2 + 1]!,
                points[i * 2 + 2]!,
                points[i * 2 + 3]!,
                minX,
                minY,
                maxX,
                maxY,
            )
        )
            return true;
    }
    return false;
}

/** Liang-Barsky clip test: whether segment AB has any part inside the box. */
function segmentCrossesBox(
    ax: number,
    ay: number,
    bx: number,
    by: number,
    minX: number,
    minY: number,
    maxX: number,
    maxY: number,
): boolean {
    const dx = bx - ax;
    const dy = by - ay;
    let enter = 0;
    let exit = 1;
    const edges: [number, number][] = [
        [-dx, ax - minX],
        [dx, maxX - ax],
        [-dy, ay - minY],
        [dy, maxY - ay],
    ];
    for (const [p, q] of edges) {
        if (p === 0) {
            if (q < 0) return false;
            continue;
        }
        const r = q / p;
        if (p < 0) {
            if (r > exit) return false;
            if (r > enter) enter = r;
        } else {
            if (r < enter) return false;
            if (r < exit) exit = r;
        }
    }
    return enter <= exit;
}

/**
 * Passes of one trip through the circle. A pass is a continuous run of drawn
 * segments closer than the radius; a gap ends it. Each pass reports its
 * closest point and the time there. A vertex with a gap or the track's end on
 * both sides is a point of its own and passes when it is inside. Returns
 * passes in time order, empty when the trip never enters.
 */
export function tripPassesThroughCircle(track: TripMapTrack, place: PlaceCircle): TripPass[] {
    const radius = placeRadiusWorld(place);
    return passesWithinRadius(track, place.x, place.y, radius);
}

/** tripPassesThroughCircle with the radius already in world units. */
export function passesWithinRadius(track: TripMapTrack, cx: number, cy: number, radius: number): TripPass[] {
    const passes: TripPass[] = [];
    const vertices = track.times.length;
    if (vertices === 0) return passes;
    for (const shift of [0, -1, 1]) {
        const x = cx + shift;
        const { bounds } = track;
        if (
            x + radius < bounds.minX ||
            x - radius > bounds.maxX ||
            cy + radius < bounds.minY ||
            cy - radius > bounds.maxY
        )
            continue;
        collectPasses(track, x, cy, radius, passes);
        if (passes.length > 0) {
            // Report positions in the circle's own world copy.
            for (const pass of passes) pass.x -= shift;
            return passes;
        }
    }
    return passes;
}

function collectPasses(track: TripMapTrack, cx: number, cy: number, radius: number, out: TripPass[]): void {
    const points = track.points;
    const times = track.times;
    const vertices = times.length;
    const radiusSquared = radius * radius;
    // Long simplified segments can touch the circle on both legs of an
    // out-and-back drive, with the turn outside it: there the pass ends at
    // the shared vertex. A plain corner can leave its vertex outside a circle
    // on the inside of the turn as well, and that stays one pass.
    let current: TripPass | null = null;
    let currentDistance = Infinity;
    let isInsideAtVertex = false;
    let previousDx = 0;
    let previousDy = 0;
    for (let i = 0; i < vertices; i++) {
        const ax = points[i * 2]!;
        const ay = points[i * 2 + 1]!;
        // A lone fix between gaps (or a parked trip's only one) has no
        // segment to be near; the gaps around it already ended any pass.
        const isLoneVertex = (i === 0 || track.breaks[i - 1] === 1) && (i === vertices - 1 || track.breaks[i] === 1);
        if (isLoneVertex && (ax - cx) ** 2 + (ay - cy) ** 2 <= radiusSquared)
            out.push({ unixSeconds: times[i]!, x: ax, y: ay });
        if (i === vertices - 1) break;
        const bx = points[i * 2 + 2]!;
        const by = points[i * 2 + 3]!;
        const distance = track.breaks[i] === 1 ? Infinity : segmentDistanceSquared(cx, cy, ax, ay, bx, by);
        if (distance > radiusSquared) {
            if (current) out.push(current);
            current = null;
            isInsideAtVertex = false;
            continue;
        }
        const dx = bx - ax;
        const dy = by - ay;
        if (current && !isInsideAtVertex && turnsBack(previousDx, previousDy, dx, dy)) {
            out.push(current);
            current = null;
        }
        // A stop's arrival/departure pair has no direction of its own.
        if (dx !== 0 || dy !== 0) {
            previousDx = dx;
            previousDy = dy;
        }
        if (!current || distance < currentDistance) {
            current = closestOnSegment(cx, cy, ax, ay, bx, by, times[i]!, times[i + 1]!);
            currentDistance = distance;
        }
        isInsideAtVertex = (bx - cx) ** 2 + (by - cy) ** 2 <= radiusSquared;
    }
    if (current) out.push(current);
}

/** Whether the heading turns by more than TURN_BACK_COS allows: the drive heads back the way it came. */
function turnsBack(fromDx: number, fromDy: number, toDx: number, toDy: number): boolean {
    const lengths = Math.hypot(fromDx, fromDy) * Math.hypot(toDx, toDy);
    if (lengths === 0) return true;
    return (fromDx * toDx + fromDy * toDy) / lengths < TURN_BACK_COS;
}

function closestOnSegment(
    px: number,
    py: number,
    ax: number,
    ay: number,
    bx: number,
    by: number,
    ta: number,
    tb: number,
): TripPass {
    const dx = bx - ax;
    const dy = by - ay;
    const lengthSquared = dx * dx + dy * dy;
    const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared));
    return { unixSeconds: ta + (tb - ta) * t, x: ax + dx * t, y: ay + dy * t };
}
