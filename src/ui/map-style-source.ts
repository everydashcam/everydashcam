import type { StyleSpecification } from "maplibre-gl";
import type { MapStyleId } from "./theme.js";

// The portable build aliases this module to bundled JSON imports.
declare const __DC_MAP_STYLES__: Record<MapStyleId, string>;
const MAP_STYLE_URLS = __DC_MAP_STYLES__;

export async function loadMapStyleSource(theme: MapStyleId, signal: AbortSignal): Promise<StyleSpecification> {
    const response = await fetch(MAP_STYLE_URLS[theme], { signal });
    if (!response.ok) throw new Error(`http ${response.status}`);
    return response.json() as Promise<StyleSpecification>;
}
