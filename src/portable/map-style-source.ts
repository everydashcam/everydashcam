import type { StyleSpecification } from "maplibre-gl";
import type { MapStyleId } from "../ui/theme.js";

const MAP_STYLE_LOADERS = {
    light: () => import("../../public/styles/light.json"),
    dark: () => import("../../public/styles/dark.json"),
    "la-92": () => import("../../public/styles/la-92.json"),
    "miami-86": () => import("../../public/styles/miami-86.json"),
    "tuner-04": () => import("../../public/styles/tuner-04.json"),
    neon: () => import("../../public/styles/neon.json"),
};

export async function loadMapStyleSource(theme: MapStyleId, signal: AbortSignal): Promise<StyleSpecification> {
    signal.throwIfAborted();
    const source = await MAP_STYLE_LOADERS[theme]();
    signal.throwIfAborted();
    // Style validation runs before builds. Each map may mutate its own style.
    const style = structuredClone(source.default) as unknown as StyleSpecification;
    style.sprite = "dcasset://assets/sprite";
    return style;
}
