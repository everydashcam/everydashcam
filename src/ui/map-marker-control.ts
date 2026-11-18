import type { RadarTheme } from "../map-radar.js";
import { t } from "../i18n/index.js";
import type { I18nKey } from "../i18n/keys.js";
import {
    radarMarkerAppearance,
    MAP_MARKER_SHAPES,
    MAP_MARKER_SIZE_PX,
    MAP_MARKER_SIZES,
    type MapMarkerAppearance,
    type MapMarkerSize,
    type MapMarkerShape,
} from "./map-marker-pref.js";
import { renderMapMarkerIntoCanvas } from "./map-marker-renderer.js";

const SHAPE_LABEL_KEYS = {
    arrow: "settings.map.marker.shape.arrow",
    sedan: "settings.map.marker.shape.sedan",
    suv: "settings.map.marker.shape.suv",
    motorcycle: "settings.map.marker.shape.motorcycle",
    van: "settings.map.marker.shape.van",
    truck: "settings.map.marker.shape.truck",
} as const satisfies Record<MapMarkerShape, I18nKey>;

const COLOR_PRESETS: ReadonlyArray<{ color: string; labelKey: I18nKey }> = [
    { color: "#f4f4f2", labelKey: "settings.map.marker.color.white" },
    { color: "#1c1d1f", labelKey: "settings.map.marker.color.black" },
    { color: "#737a76", labelKey: "settings.map.marker.color.gray" },
    { color: "#b9bec4", labelKey: "settings.map.marker.color.silver" },
    { color: "#2f7ee6", labelKey: "settings.map.marker.color.blue" },
    { color: "#e5484d", labelKey: "settings.map.marker.color.red" },
    { color: "#30a46c", labelKey: "settings.map.marker.color.green" },
    { color: "#ff9000", labelKey: "settings.map.marker.color.orange" },
];

const SIZE_LABEL_KEYS = {
    small: "settings.map.marker.size.small",
    medium: "settings.map.marker.size.medium",
    large: "settings.map.marker.size.large",
} as const satisfies Record<MapMarkerSize, I18nKey>;

export interface MapMarkerControlOptions {
    appearance: MapMarkerAppearance;
    onChange: (appearance: MapMarkerAppearance) => void;
    idPrefix: string;
    /** Icon-first layout for the map gear popover. Full settings keep labels. */
    compact?: boolean;
    radar?: RadarTheme;
}

export function renderMapMarkerControl(host: HTMLElement, options: MapMarkerControlOptions): void {
    let current = { ...options.appearance };
    const root = document.createElement("div");
    root.className = "map-marker-control";
    root.classList.toggle("map-marker-control--compact", options.compact === true);
    root.dataset.markerControl = options.idPrefix;

    const shapeGrid = document.createElement("div");
    shapeGrid.className = "map-marker-control__shapes";
    shapeGrid.setAttribute("role", "radiogroup");
    shapeGrid.setAttribute("aria-label", t("settings.map.marker.shape.label"));
    const canvases = new Map<MapMarkerShape, HTMLCanvasElement>();

    const sync = (paintPreviews: boolean): void => {
        root.style.setProperty("--map-marker-preview-size", `${MAP_MARKER_SIZE_PX[current.size]}px`);
        for (const button of shapeGrid.querySelectorAll<HTMLButtonElement>("button[data-marker-shape]")) {
            button.setAttribute("aria-pressed", String(button.dataset.markerShape === current.shape));
        }
        for (const swatch of colorRow.querySelectorAll<HTMLButtonElement>("button[data-marker-color]")) {
            swatch.setAttribute("aria-pressed", String(swatch.dataset.markerColor === current.color));
        }
        for (const button of sizeSegment.querySelectorAll<HTMLButtonElement>("button[data-marker-size]")) {
            button.setAttribute("aria-pressed", String(button.dataset.markerSize === current.size));
        }
        customInput.value = current.color;
        if (paintPreviews) {
            for (const [shape, canvas] of canvases) {
                void renderMapMarkerIntoCanvas(canvas, { ...current, shape }, "perspective", options.radar);
            }
        }
    };

    const apply = (appearance: MapMarkerAppearance): void => {
        const colorChanged = current.color !== appearance.color.toLowerCase();
        current = { ...appearance, color: appearance.color.toLowerCase() };
        sync(colorChanged);
        options.onChange({ ...current });
    };

    for (const shape of MAP_MARKER_SHAPES) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "map-marker-control__shape";
        button.dataset.markerShape = shape;
        const shapeLabel = t(SHAPE_LABEL_KEYS[shape]);
        button.setAttribute("aria-label", shapeLabel);
        button.title = shapeLabel;
        const canvas = document.createElement("canvas");
        canvas.className = "map-marker-control__preview";
        canvas.width = 192;
        canvas.height = 192;
        canvas.setAttribute("aria-hidden", "true");
        canvases.set(shape, canvas);
        const label = document.createElement("span");
        label.textContent = shapeLabel;
        button.append(canvas, label);
        button.addEventListener("click", () => apply({ ...current, shape }));
        shapeGrid.appendChild(button);
    }
    root.appendChild(shapeGrid);

    const colorRow = document.createElement("div");
    colorRow.className = "map-marker-control__colors";
    colorRow.setAttribute("role", "group");
    colorRow.setAttribute("aria-label", t("settings.map.marker.color.label"));
    for (const preset of COLOR_PRESETS) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "map-marker-control__swatch";
        const color =
            options.radar === "underground-2" && preset.labelKey === "settings.map.marker.color.green"
                ? radarMarkerAppearance(options.radar).color
                : preset.color;
        button.dataset.markerColor = color;
        button.style.setProperty("--marker-swatch", color);
        button.setAttribute("aria-label", t(preset.labelKey));
        button.addEventListener("click", () => apply({ ...current, color }));
        colorRow.appendChild(button);
    }
    const customLabel = document.createElement("label");
    customLabel.className = "map-marker-control__custom";
    const customText = document.createElement("span");
    customText.textContent = t("settings.map.marker.color.custom");
    const customInput = document.createElement("input");
    customInput.type = "color";
    customInput.className = "map-marker-control__color-input";
    customInput.id = `${options.idPrefix}-marker-color`;
    customInput.setAttribute("aria-label", t("settings.map.marker.color.custom"));
    customInput.addEventListener("input", () => apply({ ...current, color: customInput.value }));
    customLabel.append(customText, customInput);
    colorRow.appendChild(customLabel);
    root.appendChild(colorRow);

    const sizeRow = document.createElement("div");
    sizeRow.className = "map-marker-control__size-row";
    const sizeLabel = document.createElement("span");
    sizeLabel.className = "map-marker-control__size-label";
    sizeLabel.textContent = t("settings.map.marker.size.label");
    const sizeSegment = document.createElement("div");
    sizeSegment.className = "map-marker-control__size-segment";
    sizeSegment.setAttribute("role", "radiogroup");
    sizeSegment.setAttribute("aria-label", t("settings.map.marker.size.label"));
    for (const size of MAP_MARKER_SIZES) {
        const button = document.createElement("button");
        button.type = "button";
        button.dataset.markerSize = size;
        button.textContent = t(SIZE_LABEL_KEYS[size]);
        button.addEventListener("click", () => apply({ ...current, size }));
        sizeSegment.appendChild(button);
    }
    sizeRow.append(sizeLabel, sizeSegment);
    root.appendChild(sizeRow);

    host.replaceChildren(root);
    sync(true);
}
