import type { ExpressionSpecification, Map as MapLibreMap } from "maplibre-gl";
import type { MiniMapData } from "./state.js";
import { unwrapTrackCoordinates } from "../coordinates.js";
import { themeColors } from "./theme.js";

/** Every route line on a viewer map shares this dark edge and white halo. */
export const TRACK_OUTLINE_WIDTH_PX = 1;
export const TRACK_HALO_WIDTH_PX = 0.75;

export function speedTrackOuterWidth(width: number): number {
    return width + 2 * (TRACK_OUTLINE_WIDTH_PX + TRACK_HALO_WIDTH_PX);
}

/** Geometry and gradient must describe the same ordered vertices. */
export function addSpeedTrack(
    map: MapLibreMap,
    data: MiniMapData,
    options: {
        sourceId: string;
        layerId?: string;
        beforeId?: string;
        width: number;
        opacity?: number;
        endpointDots?: boolean;
    },
): void {
    const { sourceId, layerId = sourceId, width, opacity = 1 } = options;
    map.addSource(sourceId, {
        type: "geojson",
        // MapLibre requires line metrics for a line-progress gradient.
        lineMetrics: true,
        data: {
            type: "Feature",
            properties: {},
            geometry: { type: "LineString", coordinates: unwrapTrackCoordinates(data.coords) },
        },
    });
    // Both edges stay distinct on light roads, dark basemaps and raster imagery.
    const colors = themeColors();
    for (const casing of [
        { id: `${layerId}-halo`, width: speedTrackOuterWidth(width), color: colors.trackHalo },
        { id: `${layerId}-outline`, width: width + 2 * TRACK_OUTLINE_WIDTH_PX, color: colors.trackOutline },
    ]) {
        map.addLayer(
            {
                id: casing.id,
                type: "line",
                source: sourceId,
                layout: { "line-join": "round", "line-cap": "round" },
                paint: {
                    "line-width": casing.width,
                    "line-color": casing.color,
                    "line-opacity": opacity,
                },
            },
            options.beforeId,
        );
    }
    map.addLayer(
        {
            id: layerId,
            type: "line",
            source: sourceId,
            layout: { "line-join": "round", "line-cap": "round" },
            paint: {
                "line-width": width,
                "line-opacity": opacity,
                "line-gradient": data.gradient as ExpressionSpecification,
            },
        },
        options.beforeId,
    );
    if (options.endpointDots && data.coords.length >= 2) {
        const endpoints = `${sourceId}-endpoints`;
        map.addSource(endpoints, {
            type: "geojson",
            data: {
                type: "FeatureCollection",
                features: [data.coords[0]!, data.coords[data.coords.length - 1]!].map((coordinates, index) => ({
                    type: "Feature",
                    properties: { start: index === 0 },
                    geometry: { type: "Point", coordinates },
                })),
            },
        });
        map.addLayer(
            {
                id: endpoints,
                type: "circle",
                source: endpoints,
                paint: {
                    "circle-radius": width * 1.45,
                    "circle-stroke-width": width * 0.65,
                    "circle-color": ["case", ["get", "start"], "#5cc8e3", "#f6c26b"],
                    "circle-stroke-color": ["case", ["get", "start"], "#1189ce", "#cb893c"],
                },
            },
            options.beforeId,
        );
    }
}

export function removeSpeedTrack(map: MapLibreMap, sourceId: string, layerId = sourceId): void {
    const endpoints = `${sourceId}-endpoints`;
    if (map.getLayer(endpoints)) map.removeLayer(endpoints);
    if (map.getSource(endpoints)) map.removeSource(endpoints);
    for (const id of [layerId, `${layerId}-outline`, `${layerId}-halo`]) {
        if (map.getLayer(id)) map.removeLayer(id);
    }
    if (map.getSource(sourceId)) map.removeSource(sourceId);
}
