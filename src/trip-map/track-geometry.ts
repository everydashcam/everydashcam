// Simplified, session-only geometry of one trip for the trip map: few enough
// vertices to aggregate a whole library, with the time of every vertex kept so
// a place query can name the second the trip passed it.

import { unwrapLongitude } from "../coordinates.js";
import type { PackedTripTrack } from "./track-input.js";
import { emptyBounds, groundMetersPerWorldUnit, worldX, worldY, type WorldBounds } from "./world.js";

/**
 * Trip geometry in normalized Web Mercator (see world.ts). A segment runs from
 * vertex i to i+1; `breaks[i] === 1` marks a gap that is neither drawn nor
 * queried. One vertex is a trip that never moved: it is a point, not a line.
 */
export interface TripMapTrack {
    /** Interleaved x,y per vertex. */
    points: Float64Array;
    /** unixSeconds per vertex, already in the trip's synchronized GPS clock. */
    times: Float64Array;
    /** One flag per segment, length max(0, vertexCount - 1). */
    breaks: Uint8Array;
    bounds: WorldBounds;
}

// Douglas-Peucker tolerance. Well under a lane width, so the line still sits on
// its road at street zoom, while straight stretches lose almost every vertex.
const SIMPLIFY_TOLERANCE_M = 5;
// A segment is a gap rather than a drive when the points are far apart in
// space, far apart after a long pause (lost signal, tunnel exit), or would need
// an impossible speed. Matches the reference prototype.
const GAP_MAX_DISTANCE_M = 1500;
const GAP_PAUSE_SEC = 30;
const GAP_PAUSE_DISTANCE_M = 150;
const GAP_SPEED_DISTANCE_M = 200;
const GAP_MAX_SPEED_MS = 80;
// A stop becomes an arrival/departure vertex pair at one place. Collapsing it to
// a single vertex would spread the waiting time over the next segment, and the
// interpolated pass time after a red light would be off by the whole wait.
const DWELL_RADIUS_M = 8;
const DWELL_MIN_SEC = 10;

export function vertexCount(track: TripMapTrack): number {
    return track.times.length;
}

/**
 * Builds the simplified geometry from a trip's packed fixes. Segments are cut
 * at source-declared track restarts and at implausible jumps; each continuous
 * piece is simplified separately, with stop arrival and departure pinned so
 * their times survive. Returns an empty track for a trip without fixes.
 */
export function buildTripMapTrack(packed: PackedTripTrack): TripMapTrack {
    const count = packed.lat.length;
    const xs = new Float64Array(count);
    const ys = new Float64Array(count);
    let previousLon = count > 0 ? packed.lon[0]! : 0;
    for (let i = 0; i < count; i++) {
        previousLon = unwrapLongitude(packed.lon[i]!, previousLon);
        xs[i] = worldX(previousLon);
        ys[i] = worldY(packed.lat[i]!);
    }

    const outX: number[] = [];
    const outY: number[] = [];
    const outT: number[] = [];
    const outBreaks: number[] = [];
    let pieceStart = 0;
    for (let i = 1; i <= count; i++) {
        if (i < count && !isGap(xs, ys, packed.unixSeconds, packed.cutBefore, i)) continue;
        const firstOut = outT.length;
        appendSimplifiedPiece(xs, ys, packed.unixSeconds, pieceStart, i - 1, outX, outY, outT);
        // The segment joining this piece to the previous one is the gap.
        if (firstOut > 0) outBreaks[firstOut - 1] = 1;
        pieceStart = i;
    }

    const vertices = outT.length;
    const points = new Float64Array(vertices * 2);
    const times = new Float64Array(vertices);
    const breaks = new Uint8Array(Math.max(0, vertices - 1));
    const bounds = emptyBounds();
    for (let i = 0; i < vertices; i++) {
        const x = outX[i]!;
        const y = outY[i]!;
        points[i * 2] = x;
        points[i * 2 + 1] = y;
        times[i] = outT[i]!;
        if (i < vertices - 1 && outBreaks[i] === 1) breaks[i] = 1;
        if (x < bounds.minX) bounds.minX = x;
        if (x > bounds.maxX) bounds.maxX = x;
        if (y < bounds.minY) bounds.minY = y;
        if (y > bounds.maxY) bounds.maxY = y;
    }
    return { points, times, breaks, bounds };
}

function isGap(xs: Float64Array, ys: Float64Array, times: Float64Array, cutBefore: Uint8Array, index: number): boolean {
    if (cutBefore[index] === 1) return true;
    const scale = groundMetersPerWorldUnit((ys[index]! + ys[index - 1]!) / 2);
    const distanceM = Math.hypot(xs[index]! - xs[index - 1]!, ys[index]! - ys[index - 1]!) * scale;
    const dt = times[index]! - times[index - 1]!;
    if (distanceM > GAP_MAX_DISTANCE_M) return true;
    if (dt > GAP_PAUSE_SEC && distanceM > GAP_PAUSE_DISTANCE_M) return true;
    // Duplicate or reversed timestamps cannot justify a long jump either.
    return distanceM > GAP_SPEED_DISTANCE_M && (dt <= 0 || distanceM / dt > GAP_MAX_SPEED_MS);
}

/**
 * Appends the simplified vertices of the continuous piece [first, last]:
 * stops become pinned arrival/departure pairs, consecutive identical points
 * collapse, and Douglas-Peucker runs between pinned vertices.
 */
function appendSimplifiedPiece(
    xs: Float64Array,
    ys: Float64Array,
    times: Float64Array,
    first: number,
    last: number,
    outX: number[],
    outY: number[],
    outT: number[],
): void {
    const scale = groundMetersPerWorldUnit((ys[first]! + ys[last]!) / 2);
    const dwellRadius = DWELL_RADIUS_M / scale;
    const px: number[] = [];
    const py: number[] = [];
    const pt: number[] = [];
    const pinned: boolean[] = [];
    let i = first;
    while (i <= last) {
        const ax = xs[i]!;
        const ay = ys[i]!;
        let runEnd = i;
        while (
            runEnd + 1 <= last &&
            (xs[runEnd + 1]! - ax) ** 2 + (ys[runEnd + 1]! - ay) ** 2 <= dwellRadius * dwellRadius
        )
            runEnd++;
        if (runEnd > i && times[runEnd]! - times[i]! >= DWELL_MIN_SEC) {
            px.push(ax, ax);
            py.push(ay, ay);
            pt.push(times[i]!, times[runEnd]!);
            pinned.push(true, true);
            i = runEnd + 1;
            continue;
        }
        const previous = px.length - 1;
        if (previous < 0 || px[previous] !== ax || py[previous] !== ay) {
            px.push(ax);
            py.push(ay);
            pt.push(times[i]!);
            pinned.push(false);
        }
        i++;
    }
    const keep = new Uint8Array(px.length);
    const tolerance = SIMPLIFY_TOLERANCE_M / scale;
    let anchor = 0;
    for (let k = 1; k < px.length; k++) {
        if (!pinned[k] && k < px.length - 1) continue;
        markDouglasPeucker(px, py, anchor, k, tolerance * tolerance, keep);
        anchor = k;
    }
    keep[0] = 1;
    keep[px.length - 1] = 1;
    for (let k = 0; k < px.length; k++) {
        if (!keep[k]) continue;
        outX.push(px[k]!);
        outY.push(py[k]!);
        outT.push(pt[k]!);
    }
}

/** Marks the vertices Douglas-Peucker keeps in [from, to]; iterative for long pieces. */
function markDouglasPeucker(
    xs: readonly number[],
    ys: readonly number[],
    from: number,
    to: number,
    toleranceSquared: number,
    keep: Uint8Array,
): void {
    keep[from] = 1;
    keep[to] = 1;
    const stack: number[] = [from, to];
    while (stack.length > 0) {
        const end = stack.pop()!;
        const start = stack.pop()!;
        let farthest = -1;
        let farthestDistance = toleranceSquared;
        for (let k = start + 1; k < end; k++) {
            const distance = segmentDistanceSquared(xs[k]!, ys[k]!, xs[start]!, ys[start]!, xs[end]!, ys[end]!);
            if (distance > farthestDistance) {
                farthestDistance = distance;
                farthest = k;
            }
        }
        if (farthest < 0) continue;
        keep[farthest] = 1;
        stack.push(start, farthest, farthest, end);
    }
}

/** Squared distance from point P to segment AB, all in one planar space. */
export function segmentDistanceSquared(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
    const dx = bx - ax;
    const dy = by - ay;
    const lengthSquared = dx * dx + dy * dy;
    const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared));
    const ex = px - ax - t * dx;
    const ey = py - ay - t * dy;
    return ex * ex + ey * ey;
}
