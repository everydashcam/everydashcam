// One line per corridor instead of a pile of jittered tracks. Hundreds of drives
// along one road are sampled into a grid, the samples of a cell average into a
// node, parallel strands are pulled onto a shared line, and the number of trips
// is smoothed along the graph so a branch narrows gradually. The width encodes
// how many different trips used a stretch; colour never does.
//
// The algorithm and its constants come from the reference prototype
// (private/plans/trip-map-search-reference, getBundle). The grid here is sparse
// and covers the whole library, so panning never needs a recomputation.

import { worldToLat, worldToLon, worldUnitsPerPixel, type WorldBounds } from "./world.js";

/** Input geometry of one trip; `id` must be unique within one call. */
export interface BundleTrack {
    id: number;
    points: Float64Array;
    breaks: Uint8Array;
    bounds: WorldBounds;
}

/** Polylines of one line width, as lon/lat pairs. */
export interface BundleLines {
    /** Core line width in CSS pixels. */
    width: number;
    /** Interleaved lon,lat of every vertex of every polyline. */
    coords: Float64Array;
    /** Vertex index where each polyline starts, followed by the total vertex count. */
    starts: Uint32Array;
}

export interface TripBundle {
    /** Zoom step the geometry was computed for. */
    step: number;
    /** Width groups, thinnest first, so wider corridors draw on top. */
    lines: BundleLines[];
}

/** Grid cell edge in screen pixels at the zoom step. */
const CELL_PX = 6;
/** Zoom steps are half zoom levels: the line is recomputed twice per level. */
const STEPS_PER_ZOOM = 2;
/**
 * Above this zoom the geometry is reused: a cell is then about 18 m at 52°N,
 * and splitting it further would only chase GPS noise.
 */
export const BUNDLE_MAX_STEP = 14;
const MEAN_SHIFT_PASSES = 3;
/** Neighbours farther than this (squared, in cells) do not pull a node. */
const MEAN_SHIFT_MAX_D2 = 3.2;
const MEAN_SHIFT_FALLOFF = 1.1;
const WIDTH_SMOOTHING_PASSES = 3;
const WIDTH_BASE_PX = 1.8;
const WIDTH_PER_DOUBLING_PX = 1.05;

// Cell keys pack signed integer coordinates into one exact double. Unwrapped
// tracks can leave the 0..1 world, so the offset leaves room on both sides.
const KEY_OFFSET = 2 ** 22;
const KEY_SPAN = 2 ** 23;
// Edge keys pack two cell indices; far above any library's distinct cells.
const MAX_CELLS = 2 ** 26;

/** Zoom step for a map zoom: half levels, clamped to the reusable range. */
export function bundleStepForZoom(zoom: number): number {
    const step = Math.round(zoom * STEPS_PER_ZOOM) / STEPS_PER_ZOOM;
    return Math.max(0, Math.min(BUNDLE_MAX_STEP, step));
}

/** Core width for log2 of the trip count, before rounding to half pixels. */
export function bundleWidthForLogCount(logCount: number): number {
    return WIDTH_BASE_PX + WIDTH_PER_DOUBLING_PX * logCount;
}

/** Sparse grid with column storage; cells are created on first touch. */
class CellGrid {
    readonly index = new Map<number, number>();
    readonly cellX: number[] = [];
    readonly cellY: number[] = [];
    readonly sumX: number[] = [];
    readonly sumY: number[] = [];
    readonly hits: number[] = [];
    readonly count: number[] = [];
    readonly stamp: number[] = [];

    get size(): number {
        return this.cellX.length;
    }

    find(cx: number, cy: number): number {
        return this.index.get((cy + KEY_OFFSET) * KEY_SPAN + cx + KEY_OFFSET) ?? -1;
    }

    obtain(cx: number, cy: number): number {
        const key = (cy + KEY_OFFSET) * KEY_SPAN + cx + KEY_OFFSET;
        const found = this.index.get(key);
        if (found !== undefined) return found;
        const created = this.cellX.length;
        if (created >= MAX_CELLS) throw new Error("trip bundle grid exceeds its cell limit");
        this.index.set(key, created);
        this.cellX.push(cx);
        this.cellY.push(cy);
        this.sumX.push(0);
        this.sumY.push(0);
        this.hits.push(0);
        this.count.push(0);
        this.stamp.push(-1);
        return created;
    }
}

/**
 * Computes the corridor lines of `tracks` at a zoom step. Deterministic for a
 * given input order; trips without a non-zero segment contribute nothing (they
 * are shown as points elsewhere).
 */
export function buildTripBundle(tracks: readonly BundleTrack[], step: number): TripBundle {
    const cell = CELL_PX * worldUnitsPerPixel(step);
    const grid = new CellGrid();
    const edges = new Set<number>();
    for (let trackIndex = 0; trackIndex < tracks.length; trackIndex++) {
        sampleTrack(tracks[trackIndex]!, trackIndex, cell, grid, edges);
    }

    const size = grid.size;
    const nodes: number[] = [];
    for (let c = 0; c < size; c++) if (grid.hits[c]! > 0) nodes.push(c);
    let nodeX = new Float64Array(size);
    let nodeY = new Float64Array(size);
    for (const c of nodes) {
        nodeX[c] = grid.sumX[c]! / grid.hits[c]!;
        nodeY[c] = grid.sumY[c]! / grid.hits[c]!;
    }

    // Pull parallel strands of one corridor onto a shared line: a count-weighted
    // mean shift over the 5x5 neighbourhood of every node.
    const { offsets: nearOffsets, cells: nearCells } = neighbourhood(grid, nodes, 2);
    const cellSquared = cell * cell;
    for (let pass = 0; pass < MEAN_SHIFT_PASSES; pass++) {
        const nextX = new Float64Array(size);
        const nextY = new Float64Array(size);
        for (let n = 0; n < nodes.length; n++) {
            const c = nodes[n]!;
            let weightedX = 0;
            let weightedY = 0;
            let weightSum = 0;
            for (let k = nearOffsets[n]!; k < nearOffsets[n + 1]!; k++) {
                const j = nearCells[k]!;
                const d2 = ((nodeX[j]! - nodeX[c]!) ** 2 + (nodeY[j]! - nodeY[c]!) ** 2) / cellSquared;
                if (d2 > MEAN_SHIFT_MAX_D2) continue;
                const weight = grid.count[j]! * Math.exp(-d2 / MEAN_SHIFT_FALLOFF);
                weightedX += nodeX[j]! * weight;
                weightedY += nodeY[j]! * weight;
                weightSum += weight;
            }
            nextX[c] = weightedX / weightSum;
            nextY[c] = weightedY / weightSum;
        }
        nodeX = nextX;
        nodeY = nextY;
    }

    // Smooth log2(count) along the graph so the width tapers instead of stepping.
    const adjacency = edgeAdjacency(edges, size);
    let logCount = new Float64Array(size);
    for (const c of nodes) logCount[c] = Math.log2(Math.max(1, grid.count[c]!));
    for (let pass = 0; pass < WIDTH_SMOOTHING_PASSES; pass++) {
        const next = new Float64Array(size);
        for (const c of nodes) {
            let sum = logCount[c]! * 2;
            for (let k = adjacency.offsets[c]!; k < adjacency.offsets[c + 1]!; k++)
                sum += logCount[adjacency.cells[k]!]!;
            next[c] = sum / (2 + adjacency.offsets[c + 1]! - adjacency.offsets[c]!);
        }
        logCount = next;
    }

    const byWidth = new Map<number, number[]>();
    for (const edge of edges) {
        const a = Math.floor(edge / MAX_CELLS);
        const b = edge - a * MAX_CELLS;
        const width = Math.round(bundleWidthForLogCount((logCount[a]! + logCount[b]!) / 2) * 2) / 2;
        let group = byWidth.get(width);
        if (!group) {
            group = [];
            byWidth.set(width, group);
        }
        group.push(a, b);
    }
    const lines = [...byWidth.entries()]
        .sort((left, right) => left[0] - right[0])
        .map(([width, pairs]) => chainEdges(width, pairs, nodeX, nodeY));
    return { step, lines };
}

/** Walks one track at half-cell steps, filling cell sums, distinct-trip counts and edges. */
function sampleTrack(track: BundleTrack, stampId: number, cell: number, grid: CellGrid, edges: Set<number>): void {
    const points = track.points;
    const segments = track.breaks.length;
    const stepLength = cell * 0.5;
    let previous = -1;
    for (let i = 0; i < segments; i++) {
        if (track.breaks[i] === 1) {
            previous = -1;
            continue;
        }
        const ax = points[i * 2]!;
        const ay = points[i * 2 + 1]!;
        const bx = points[i * 2 + 2]!;
        const by = points[i * 2 + 3]!;
        const length = Math.hypot(bx - ax, by - ay);
        // A stop is an arrival/departure pair at one place: nothing to draw.
        if (length === 0) continue;
        const steps = Math.max(1, Math.ceil(length / stepLength));
        for (let q = previous < 0 ? 0 : 1; q <= steps; q++) {
            const x = ax + ((bx - ax) * q) / steps;
            const y = ay + ((by - ay) * q) / steps;
            const cx = Math.floor(x / cell);
            const cy = Math.floor(y / cell);
            const c = grid.obtain(cx, cy);
            grid.sumX[c]! += x;
            grid.sumY[c]! += y;
            grid.hits[c]!++;
            // Count a trip in the 3x3 neighbourhood: a road running along a
            // cell border still forms one corridor.
            for (let dy = -1; dy <= 1; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                    const near = dx === 0 && dy === 0 ? c : grid.obtain(cx + dx, cy + dy);
                    if (grid.stamp[near] !== stampId) {
                        grid.stamp[near] = stampId;
                        grid.count[near]!++;
                    }
                }
            }
            if (previous >= 0 && previous !== c) {
                edges.add(previous < c ? previous * MAX_CELLS + c : c * MAX_CELLS + previous);
            }
            previous = c;
        }
    }
}

/** For every node, the sampled cells within `radius` cells (itself included), as CSR. */
function neighbourhood(
    grid: CellGrid,
    nodes: readonly number[],
    radius: number,
): { offsets: Uint32Array; cells: Int32Array } {
    const offsets = new Uint32Array(nodes.length + 1);
    const cells: number[] = [];
    for (let n = 0; n < nodes.length; n++) {
        const c = nodes[n]!;
        const cx = grid.cellX[c]!;
        const cy = grid.cellY[c]!;
        for (let dy = -radius; dy <= radius; dy++) {
            for (let dx = -radius; dx <= radius; dx++) {
                const j = grid.find(cx + dx, cy + dy);
                if (j >= 0 && grid.hits[j]! > 0) cells.push(j);
            }
        }
        offsets[n + 1] = cells.length;
    }
    return { offsets, cells: Int32Array.from(cells) };
}

/** Undirected adjacency of the edge set, indexed by cell, as CSR. */
function edgeAdjacency(edges: ReadonlySet<number>, size: number): { offsets: Uint32Array; cells: Int32Array } {
    const degree = new Uint32Array(size + 1);
    for (const edge of edges) {
        const a = Math.floor(edge / MAX_CELLS);
        degree[a]!++;
        degree[edge - a * MAX_CELLS]!++;
    }
    const offsets = new Uint32Array(size + 1);
    for (let c = 0; c < size; c++) offsets[c + 1] = offsets[c]! + degree[c]!;
    const fill = offsets.slice(0, size);
    const cells = new Int32Array(offsets[size]!);
    for (const edge of edges) {
        const a = Math.floor(edge / MAX_CELLS);
        const b = edge - a * MAX_CELLS;
        cells[fill[a]!++] = b;
        cells[fill[b]!++] = a;
    }
    return { offsets, cells };
}

/**
 * Joins the edges of one width into polylines: fewer, longer lines give the
 * renderer proper joins and far fewer features than one feature per edge.
 */
function chainEdges(width: number, pairs: readonly number[], nodeX: Float64Array, nodeY: Float64Array): BundleLines {
    const edgeCount = pairs.length / 2;
    const incident = new Map<number, number[]>();
    for (let e = 0; e < edgeCount; e++) {
        for (const node of [pairs[e * 2]!, pairs[e * 2 + 1]!]) {
            let list = incident.get(node);
            if (!list) {
                list = [];
                incident.set(node, list);
            }
            list.push(e);
        }
    }
    const used = new Uint8Array(edgeCount);
    const coords: number[] = [];
    const starts: number[] = [];
    const push = (node: number): void => {
        coords.push(worldToLon(nodeX[node]!), worldToLat(nodeY[node]!));
    };
    const walk = (startNode: number, firstEdge: number): void => {
        starts.push(coords.length / 2);
        push(startNode);
        let node = startNode;
        let edge = firstEdge;
        for (;;) {
            used[edge] = 1;
            const a = pairs[edge * 2]!;
            node = a === node ? pairs[edge * 2 + 1]! : a;
            push(node);
            const through = incident.get(node)!;
            if (through.length !== 2) return;
            const next = through[0] === edge ? through[1]! : through[0]!;
            if (used[next]) return;
            edge = next;
        }
    };
    // Open chains start at their ends or junctions; what remains are closed loops.
    for (const [node, list] of incident) {
        if (list.length === 2) continue;
        for (const edge of list) if (!used[edge]) walk(node, edge);
    }
    for (let e = 0; e < edgeCount; e++) if (!used[e]) walk(pairs[e * 2]!, e);
    starts.push(coords.length / 2);
    return { width, coords: Float64Array.from(coords), starts: Uint32Array.from(starts) };
}
