/** Shortest signed angle, shared by headings and longitude differences. */
export function wrapDegrees(degrees: number): number {
    if (degrees >= -180 && degrees < 180) return degrees;
    return ((((degrees + 180) % 360) + 360) % 360) - 180;
}

/** Selects the world copy nearest the reference without moving through Greenwich. */
export function unwrapLongitude(lon: number, reference: number): number {
    return reference + wrapDegrees(lon - reference);
}

export function unwrapTrackCoordinates(coords: readonly [number, number][]): [number, number][] {
    let previousLon = coords[0]?.[0] ?? 0;
    return coords.map(([lon, lat]) => {
        previousLon = unwrapLongitude(lon, previousLon);
        return [previousLon, lat];
    });
}

const MERCATOR_MAX_LAT_DEG = 85.051129;

/** Web-Mercator Y increases southward, in the same degree-equivalent units as longitude. */
export function mercatorY(latDeg: number): number {
    const lat = Math.max(-MERCATOR_MAX_LAT_DEG, Math.min(MERCATOR_MAX_LAT_DEG, latDeg));
    return 180 - (180 / Math.PI) * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
}

/** Fits a local route without stretching either projected axis. */
export function projectTrackToViewport(
    coords: readonly [number, number][],
    width: number,
    height: number,
    padding: number,
): [number, number][] {
    const projected = unwrapTrackCoordinates(coords).map(([lon, lat]) => [lon, mercatorY(lat)] as const);
    const first = projected[0];
    if (!first) return [];
    let minX = first[0];
    let maxX = minX;
    let minY = first[1];
    let maxY = minY;
    for (const [x, y] of projected) {
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
    }
    const spanX = maxX - minX;
    const spanY = maxY - minY;
    const scaleX = spanX > 0 ? Math.max(0, width - padding * 2) / spanX : Number.POSITIVE_INFINITY;
    const scaleY = spanY > 0 ? Math.max(0, height - padding * 2) / spanY : Number.POSITIVE_INFINITY;
    const scale = Number.isFinite(Math.min(scaleX, scaleY)) ? Math.min(scaleX, scaleY) : 1;
    const offsetX = (width - spanX * scale) / 2;
    const offsetY = (height - spanY * scale) / 2;
    return projected.map(([x, y]) => [offsetX + (x - minX) * scale, offsetY + (y - minY) * scale]);
}

/**
 * Haversine great-circle distance in km. Mean Earth radius 6371 km.
 * Ellipsoidal model is unnecessary given GPS fix accuracy.
 */
export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R_KM = 6371;
    const toRad = (deg: number): number => (deg * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * R_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Great-circle distance in meters, using the same mean radius as trip distances. */
export function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
    return haversineKm(lat1, lon1, lat2, lon2) * 1000;
}

/** Computes a maplibre zoom level so the visible diameter (across viewportWidthPx)
 *  is ~diameterKm. Uses 78271.5, the meters-per-pixel-at-zoom-0 for MapLibre's
 *  512 px tiles - NOT the 256-tile 156543.03. With the 256 constant the zoom came
 *  out one level too high (2x too zoomed in), so a "100 m" slot actually showed
 *  ~50 m. */
export function zoomForDiameterKm(lat: number, diameterKm: number, viewportWidthPx: number): number {
    // Floor the DIAMETER at 1 metre (not 1 km). Clamping the kilometre value
    // collapsed the entire 100 m..1 km slider range to a single 1 km zoom.
    const diameterM = Math.max(1, diameterKm * 1000);
    const cosLat = Math.max(Math.cos((lat * Math.PI) / 180), 0.01);
    const metersPerPx = diameterM / viewportWidthPx;
    return Math.log2((78271.5 * cosLat) / metersPerPx);
}
