import { t, type I18nKey } from "../i18n/index.js";
import { createMapProviderSelect } from "./map-provider-control.js";
import {
    getMapProviderPreference,
    setMapProviderPreference,
    subscribeMapProvider,
    subscribeMapProviderPreference,
} from "./map-provider.js";
import { MAP_PROVIDER_REGISTRY } from "./map-provider-registry.js";
import { isYandexMapAvailable } from "./yandex-map.js";
import {
    getMapViewPreferences,
    MAP_STYLE_PRESETS,
    MAP_THEME_CHOICES,
    type MapStylePreset,
    type MapThemeChoice,
    type MapViewPreferences,
    setMapViewPreferences,
    setViewerMiniMapShape,
    viewerMiniMapShape,
    viewerRadarTheme,
    subscribeMapViewPreferences,
} from "./map-view-pref.js";

const STYLE_LABEL_KEYS = {
    classic: "settings.map.style.classic",
    road: "settings.map.style.road",
    minimal: "settings.map.style.minimal",
} as const satisfies Record<MapStylePreset, I18nKey>;

const THEME_LABEL_KEYS = {
    auto: "settings.map.theme.auto",
    light: "settings.map.theme.light",
    "san-andreas": "settings.map.theme.san-andreas",
    "vice-city": "settings.map.theme.vice-city",
    "underground-2": "settings.map.theme.underground-2",
    dark: "settings.map.theme.dark",
} as const satisfies Record<MapThemeChoice, I18nKey>;

function createSelect<Value extends string>(
    host: HTMLElement,
    id: string,
    labelKey: I18nKey,
    values: readonly Value[],
    labelKeys: Record<Value, I18nKey>,
    onChange: (value: Value) => void,
): HTMLSelectElement {
    const row = document.createElement("label");
    row.className = "map-view-controls__row";
    const label = document.createElement("span");
    label.textContent = t(labelKey);
    const select = document.createElement("select");
    select.id = id;
    select.className = "settings-select map-view-controls__select";
    for (const value of values) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = t(labelKeys[value]);
        select.append(option);
    }
    select.addEventListener("change", () => {
        if (select.disabled) return;
        const value = values.find((value) => value === select.value);
        if (value !== undefined) onChange(value);
    });
    row.append(label, select);
    host.append(row);
    return select;
}

/** Both hosts live for the page lifetime; syncing values preserves keyboard focus. */
export function initMapViewControls(host: HTMLElement, idPrefix: string, onAppearanceChange: () => void): void {
    host.classList.add("map-view-controls");
    const providerRow = document.createElement("label");
    providerRow.className = "map-view-controls__row";
    const providerLabel = document.createElement("span");
    providerLabel.textContent = t("settings.map.provider.label");
    const provider = createMapProviderSelect({
        id: `${idPrefix}-provider-select`,
        value: getMapProviderPreference(),
        isYandexDisabled: !isYandexMapAvailable(),
        onChange: setMapProviderPreference,
    });
    provider.classList.add("map-view-controls__select");
    providerRow.append(providerLabel, provider);
    const providerHint = document.createElement("span");
    providerHint.id = `${idPrefix}-provider-description`;
    providerHint.className = "map-view-controls__hint";
    providerHint.textContent = t(__PORTABLE__ ? "portable.map.description" : "settings.map.provider.description");
    provider.setAttribute("aria-describedby", providerHint.id);
    host.append(providerRow, providerHint);
    if (!__PORTABLE__ && !isYandexMapAvailable()) {
        const unavailableHint = document.createElement("span");
        unavailableHint.id = `${idPrefix}-provider-unavailable`;
        unavailableHint.className = "map-view-controls__hint";
        unavailableHint.textContent = t("settings.map.provider.unavailable");
        provider.setAttribute("aria-describedby", `${providerHint.id} ${unavailableHint.id}`);
        host.append(unavailableHint);
    }
    const styleHint = document.createElement("span");
    styleHint.id = `${idPrefix}-style-unavailable`;
    styleHint.className = "map-view-controls__hint";
    styleHint.textContent = t("settings.map.styleUnavailable");
    styleHint.hidden = true;
    host.append(styleHint);
    const style = createSelect(
        host,
        `${idPrefix}-style-select`,
        "settings.map.style.label",
        MAP_STYLE_PRESETS,
        STYLE_LABEL_KEYS,
        (value) => setMapViewPreferences({ ...getMapViewPreferences(), style: value }),
    );
    const theme = createSelect(
        host,
        `${idPrefix}-theme-select`,
        "settings.map.theme.label",
        MAP_THEME_CHOICES,
        THEME_LABEL_KEYS,
        (value) => setMapViewPreferences({ ...getMapViewPreferences(), theme: value }),
    );
    const shape = createSelect(
        host,
        `${idPrefix}-minimap-shape-select`,
        "settings.map.miniMapShape",
        ["rect", "circle"] as const,
        { rect: "export.overlays.shape.rect", circle: "export.overlays.shape.circle" },
        setViewerMiniMapShape,
    );
    const buildingsRow = document.createElement("label");
    buildingsRow.className = "map-view-controls__buildings";
    const buildings = document.createElement("input");
    buildings.id = `${idPrefix}-buildings3d-toggle`;
    buildings.type = "checkbox";
    const copy = document.createElement("span");
    const title = document.createElement("span");
    title.id = `${idPrefix}-buildings3d-label`;
    title.textContent = t("settings.map.buildings3d.label");
    const description = document.createElement("span");
    description.id = `${idPrefix}-buildings3d-description`;
    description.className = "map-view-controls__hint";
    description.textContent = t("settings.map.buildings3d.description");
    buildings.setAttribute("aria-describedby", description.id);
    buildings.setAttribute("aria-labelledby", title.id);
    buildings.addEventListener("change", () => {
        if (buildings.disabled) return;
        setMapViewPreferences({ ...getMapViewPreferences(), buildings3d: buildings.checked });
    });
    copy.append(title, description);
    buildingsRow.append(buildings, copy);
    host.append(buildingsRow);

    let lastTheme = viewerRadarTheme();
    let wasDisabled = false;
    const sync = (prefs: MapViewPreferences): void => {
        style.value = style.disabled ? "" : prefs.style;
        theme.value = theme.disabled ? "" : prefs.theme;
        const activeTheme = viewerRadarTheme();
        if (lastTheme !== activeTheme || wasDisabled !== theme.disabled) {
            wasDisabled = theme.disabled;
            lastTheme = activeTheme;
            onAppearanceChange();
        }
        shape.value = viewerMiniMapShape();
        buildings.checked = !buildings.disabled && prefs.buildings3d;
    };
    sync(getMapViewPreferences());
    subscribeMapViewPreferences(sync);
    subscribeMapProviderPreference((preference) => {
        provider.value = preference;
    });
    subscribeMapProvider((activeProvider) => {
        const unavailable = !MAP_PROVIDER_REGISTRY[activeProvider].supportsAppearanceSettings;
        for (const control of [style, theme]) {
            control.disabled = unavailable;
            if (unavailable) control.setAttribute("aria-describedby", styleHint.id);
            else control.removeAttribute("aria-describedby");
        }
        buildings.disabled = unavailable;
        buildings.setAttribute("aria-describedby", unavailable ? `${description.id} ${styleHint.id}` : description.id);
        styleHint.hidden = !unavailable;
        sync(getMapViewPreferences());
    });
}
