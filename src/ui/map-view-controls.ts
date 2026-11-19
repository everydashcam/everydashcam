import { OPENFREEMAP_CREDITS } from "./map-credits.js";
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
    MAP_STYLE_PRESET_LABEL_KEYS,
    MAP_STYLE_PRESETS,
    MAP_THEME_CHOICES,
    MAP_THEME_LABEL_KEYS,
    type MapThemeChoice,
    type MapViewPreferences,
    setMapViewPreferences,
    setViewerMiniMapShape,
    viewerMiniMapShape,
    viewerRadarTheme,
    subscribeMapViewPreferences,
} from "./map-view-pref.js";

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

function createThemeGallery(host: HTMLElement, onChange: (value: MapThemeChoice) => void): HTMLFieldSetElement {
    const gallery = document.createElement("fieldset");
    gallery.id = "settings-map-themes";
    gallery.className = "settings-themes";
    const legend = document.createElement("legend");
    legend.textContent = t("settings.map.theme.label");
    const grid = document.createElement("div");
    grid.className = "settings-themes__grid";
    grid.style.setProperty("--theme-preview-count", String(MAP_THEME_CHOICES.length));
    for (const [index, value] of MAP_THEME_CHOICES.entries()) {
        const card = document.createElement("label");
        const input = document.createElement("input");
        input.type = "radio";
        input.name = "settings-map-theme";
        input.id = `settings-map-theme-${value}`;
        input.value = value;
        input.addEventListener("change", () => {
            if (input.checked) onChange(value);
        });
        const preview = document.createElement("span");
        preview.className = "settings-themes__preview";
        preview.dataset.theme = value;
        // The cell order of scripts/build-map-theme-previews.mjs.
        preview.style.setProperty("--theme-preview-index", String(index));
        const caption = document.createElement("span");
        caption.textContent = t(MAP_THEME_LABEL_KEYS[value]);
        card.append(preview, input, caption);
        grid.append(card);
    }
    const credits = document.createElement("small");
    credits.className = "settings-themes__credits";
    credits.innerHTML = OPENFREEMAP_CREDITS;
    gallery.append(legend, grid, credits);
    host.append(gallery);
    return gallery;
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
    const changeTheme = (theme: MapThemeChoice) => setMapViewPreferences({ ...getMapViewPreferences(), theme });
    const gallery = idPrefix === "settings-map" ? createThemeGallery(host, changeTheme) : null;
    const style = createSelect(
        host,
        `${idPrefix}-style-select`,
        "settings.map.style.label",
        MAP_STYLE_PRESETS,
        MAP_STYLE_PRESET_LABEL_KEYS,
        (value) => setMapViewPreferences({ ...getMapViewPreferences(), style: value }),
    );
    const theme =
        gallery ??
        createSelect(
            host,
            `${idPrefix}-theme-select`,
            "settings.map.theme.label",
            MAP_THEME_CHOICES,
            MAP_THEME_LABEL_KEYS,
            changeTheme,
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
        if (theme instanceof HTMLSelectElement) theme.value = theme.disabled ? "" : prefs.theme;
        else
            for (const input of theme.querySelectorAll("input"))
                input.checked = !theme.disabled && input.value === prefs.theme;
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
