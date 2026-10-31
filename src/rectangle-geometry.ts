/** Intersection-over-union is independent of coordinate units. Numeric fields
 * let both pixel and normalized rectangles share it without allocating adapters
 * inside detector suppression loops. Empty/inverted rectangles do not overlap. */
export function rectangleIou(
    ax: number,
    ay: number,
    aw: number,
    ah: number,
    bx: number,
    by: number,
    bw: number,
    bh: number,
): number {
    const width = Math.min(ax + aw, bx + bw) - Math.max(ax, bx);
    const height = Math.min(ay + ah, by + bh) - Math.max(ay, by);
    if (width <= 0 || height <= 0) return 0;
    const intersection = width * height;
    const union = aw * ah + bw * bh - intersection;
    return union > 0 ? intersection / union : 0;
}
