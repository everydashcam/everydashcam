// Gear popover on the big map: map view preferences at the point of use, so
// the user tweaks label size and street-name density while looking at the
// labels. New map-scoped settings land here as more rows. The settings modal
// carries the same preferences for users who never expand the big map - both
// read the same stored values, and the modal re-syncs its selects on open.
//
// Open/close mirrors the other backdrop-less popovers (lang switcher, overflow
// bar): the hidden attribute, outside click and Escape close.

import { t } from "../i18n/index.js";
import { dom } from "./dom.js";
import { createPopover } from "./popover-lifecycle.js";
import { syncGpsSyncLaunchers } from "./gps-sync-controls.js";
import {
    getMapLabelScale,
    getStreetLabelDensity,
    MAP_LABEL_SCALE_VALUES,
    setMapLabelScale,
    setStreetLabelDensity,
    STREET_LABEL_DENSITY_LABEL_KEYS,
    STREET_LABEL_DENSITY_VALUES,
} from "./map-label-scale.js";
import { renderMapMarkerControl } from "./map-marker-control.js";
import { getMapMarkerAppearance, setMapMarkerAppearance } from "./map-marker-pref.js";
import { getMapProvider, subscribeMapProvider } from "./map-provider.js";
import { MAP_PROVIDER_REGISTRY } from "./map-provider-registry.js";
import { initMapViewControls } from "./map-view-controls.js";
import { reapplyMapLabelPrefs } from "./map.js";

// Segment buttons carry their preset in data-value; a click persists it,
// restyles the live maps, and re-marks the pressed button. Selection keeps
// the popover open: the map behind it restyles immediately, so the user
// compares variants live instead of reopening the menu per attempt.
function renderSegment<Value extends string | number>(
    host: HTMLElement,
    values: readonly Value[],
    current: Value,
    labelOf: (value: Value) => string,
    apply: (value: Value) => void,
): void {
    host.innerHTML = "";
    for (const value of values) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "map-settings-seg-btn";
        btn.dataset.value = String(value);
        btn.textContent = labelOf(value);
        btn.setAttribute("aria-pressed", String(value === current));
        btn.disabled = !MAP_PROVIDER_REGISTRY[getMapProvider()].supportsAppearanceSettings;
        if (btn.disabled) btn.setAttribute("aria-describedby", "map-style-unavailable");
        btn.addEventListener("click", () => {
            if (!MAP_PROVIDER_REGISTRY[getMapProvider()].supportsAppearanceSettings) return;
            apply(value);
            reapplyMapLabelPrefs();
            for (const child of host.children) {
                child.setAttribute("aria-pressed", String((child as HTMLElement).dataset.value === String(value)));
            }
        });
        host.appendChild(btn);
    }
}

// Rendered fresh on every open so the pressed states reflect preferences
// changed elsewhere (the settings modal selects).
function renderRows(): void {
    syncGpsSyncLaunchers();
    renderMapMarkerControl(dom.mapMarkerControl, {
        appearance: getMapMarkerAppearance(),
        onChange: setMapMarkerAppearance,
        idPrefix: "map-popover",
        compact: true,
    });
    renderSegment(
        dom.mapLabelScaleSegment,
        MAP_LABEL_SCALE_VALUES,
        getMapLabelScale(),
        (scale) => `${Math.round(scale * 100)}%`,
        setMapLabelScale,
    );
    renderSegment(
        dom.mapStreetNamesSegment,
        STREET_LABEL_DENSITY_VALUES,
        getStreetLabelDensity(),
        (density) => t(STREET_LABEL_DENSITY_LABEL_KEYS[density]),
        setStreetLabelDensity,
    );
}

const POPOVER_EDGE_MARGIN_PX = 8;

// The splitter can make the clipping pane much narrower than the viewport.
// Keep the flyout inside that pane and scroll its contents on short screens.
function fitPopoverToPane(): void {
    const pop = dom.mapSettingsPopover;
    if (pop.hidden) return;
    pop.classList.remove("map-settings-popover--below", "map-settings-popover--compact");
    pop.style.maxWidth = "";
    pop.style.maxHeight = "";
    pop.style.translate = "0px";
    const paneBox = dom.mapWrap.getBoundingClientRect();
    const viewerBox = dom.viewer.getBoundingClientRect();
    const playerBarBox = dom.playerBar.play.closest(".player-bar")?.getBoundingClientRect();
    const right = paneBox.right - POPOVER_EDGE_MARGIN_PX;
    const top = Math.max(0, viewerBox.top, paneBox.top) + POPOVER_EDGE_MARGIN_PX;
    let bottom = Math.min(window.innerHeight, viewerBox.bottom, paneBox.bottom);
    // The mobile player bar sticks over the map while the viewer scrolls.
    if (
        playerBarBox &&
        playerBarBox.top > top &&
        playerBarBox.left < paneBox.right &&
        playerBarBox.right > paneBox.left
    ) {
        bottom = Math.min(bottom, playerBarBox.top);
    }
    bottom -= POPOVER_EDGE_MARGIN_PX;
    // +1 slop: scrollWidth/clientWidth round differently at fractional zoom.
    if (pop.getBoundingClientRect().right > right || pop.scrollWidth > pop.clientWidth + 1) {
        pop.classList.add("map-settings-popover--below");
    }
    const availableWidth = Math.max(0, Math.floor(right - pop.getBoundingClientRect().left));
    pop.style.maxWidth = `${availableWidth}px`;
    if (availableWidth < 320 || pop.scrollWidth > pop.clientWidth + 1) {
        pop.classList.add("map-settings-popover--compact");
    }
    pop.style.maxHeight = `min(320px, ${Math.max(0, Math.floor(bottom - top))}px)`;
    const box = pop.getBoundingClientRect();
    const fittedTop = Math.max(top, Math.min(box.top, bottom - box.height));
    pop.style.translate = `0px ${fittedTop - box.top}px`;
}

let popover: ReturnType<typeof createPopover>;

/** Wires the gear toggle and the popover's dismiss handlers. Call once at
 *  startup; the popover content itself is (re)rendered on each open. */
export function initMapSettingsPopover(): void {
    popover = createPopover({
        button: dom.mapSettingsToggle,
        panel: dom.mapSettingsPopover,
        afterOpen: () => {
            renderRows();
            dom.mapSettingsPopover.scrollTop = 0;
            fitPopoverToPane();
        },
    });
    initMapViewControls(dom.mapViewControl, "map");
    subscribeMapProvider((provider) => {
        for (const segment of [dom.mapLabelScaleSegment, dom.mapStreetNamesSegment]) {
            for (const button of segment.querySelectorAll("button")) {
                button.disabled = !MAP_PROVIDER_REGISTRY[provider].supportsAppearanceSettings;
                if (button.disabled) button.setAttribute("aria-describedby", "map-style-unavailable");
                else button.removeAttribute("aria-describedby");
            }
        }
        fitPopoverToPane();
    });
    const resize = new ResizeObserver(fitPopoverToPane);
    resize.observe(dom.mapWrap);
    dom.viewer.addEventListener("scroll", fitPopoverToPane, { passive: true });
    dom.mapSettingsToggle.addEventListener("click", (ev) => {
        ev.stopPropagation();
        popover.toggle();
    });
}
