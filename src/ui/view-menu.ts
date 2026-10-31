// "View" dropdown - toggle visibility of the optional viewer panels. Chart,
// events and readouts are checkboxes; map is a three-state control
// (off / mini / large) whose layout transition is owned by map.ts. The basic
// on/off preference remains persisted in localStorage["dc.viewer.panels"].
//
// Toggling a panel sets the `hidden` attribute on its host element; layout
// reflows via existing CSS grid/flex rules (no JS layout math here).
//

import { readLocalStorageJson, writeLocalStorageJson } from "../local-storage.js";
import { createSubscribers } from "../subscribers.js";
import { isAnyModalOpen } from "./modal-helper.js";
import { initPlayerPopoverPosition } from "./player-popover.js";
import { createPopover } from "./popover-lifecycle.js";

const STORAGE_KEY = "dc.viewer.panels";
const HOTKEY_BY_PANEL = { chart: "KeyC", strip: "KeyT", map: "KeyM", readout: "KeyG" } as const;
const PANELS = ["chart", "strip", "map", "readout"] as const;
export type Panel = (typeof PANELS)[number];
export type MapViewMode = "off" | "mini" | "large";

/** Visibility state of the view-menu panels. Default: all visible. */
export type ViewPanels = Record<Panel, boolean>;

const DEFAULT_PANELS: ViewPanels = { chart: true, strip: true, map: true, readout: true };

/** In-memory mirror of the persisted state. */
let currentPanels: ViewPanels = { ...DEFAULT_PANELS };
type DetailPanels = Pick<ViewPanels, "chart" | "strip" | "readout">;
let ordinaryDetails: DetailPanels | null = null;
let expandedDetails: DetailPanels = { chart: false, strip: false, readout: false };
let currentMapMode: MapViewMode = "mini";
let preferredMapMode: MapViewMode = "mini";
let mapModeRequestHandler: ((mode: MapViewMode) => void) | null = null;

/** Listeners for visibility changes. Map.ts uses this to suppress mini-map
 *  visibility logic when the user hid it via the menu. */
type Listener = (panels: ViewPanels) => void;
const listeners = createSubscribers<Parameters<Listener>>("view-panels");

export function subscribeViewPanels(handler: Listener): () => void {
    return listeners.subscribe(handler);
}

export function getViewPanels(): ViewPanels {
    return { ...currentPanels };
}

/** Expanded viewing keeps its detail choices for the session without changing
 *  the ordinary viewer's saved layout. The map stays where the user put it. */
export function setExpandedViewPanels(expanded: boolean): void {
    if (expanded === (ordinaryDetails !== null)) return;
    const details = { chart: currentPanels.chart, strip: currentPanels.strip, readout: currentPanels.readout };
    if (expanded) {
        ordinaryDetails = details;
        Object.assign(currentPanels, expandedDetails);
    } else {
        expandedDetails = details;
        Object.assign(currentPanels, ordinaryDetails);
        ordinaryDetails = null;
    }
    if (currentOpts) applyPanels(currentOpts);
    notifyListeners();
}

export function getPreferredMapMode(): MapViewMode {
    return preferredMapMode;
}

/** Map.ts registers the state transition here after its maps are ready. Keeping
 *  the callback in this direction avoids a view-menu -> MapLibre dependency. */
export function setMapModeRequestHandler(handler: ((mode: MapViewMode) => void) | null): void {
    mapModeRequestHandler = handler;
}

/** Reflects map.ts's canonical layout state in the segmented control. */
export function syncMapModeControl(mode: MapViewMode): void {
    currentMapMode = mode;
    applyMapModeControl();
}

interface LoadedViewPreferences {
    panels: ViewPanels;
    mapMode: MapViewMode;
}

function isMapViewMode(value: unknown): value is MapViewMode {
    return value === "off" || value === "mini" || value === "large";
}

function loadFromStorage(): LoadedViewPreferences {
    const value = readLocalStorageJson(STORAGE_KEY);
    if (typeof value !== "object" || value === null) return { panels: { ...DEFAULT_PANELS }, mapMode: "mini" };
    const parsed = value as Partial<ViewPanels> & { mapMode?: unknown };
    // A newly added panel is absent from old preferences and defaults to on.
    const restored = {} as ViewPanels;
    for (const panel of PANELS) restored[panel] = parsed[panel] !== false;
    // Old preferences stored only map:boolean. Preserve it until the next save.
    const mapMode = isMapViewMode(parsed.mapMode) ? parsed.mapMode : restored.map ? "mini" : "off";
    restored.map = mapMode !== "off";
    return { panels: restored, mapMode };
}

function saveToStorage(): void {
    writeLocalStorageJson(STORAGE_KEY, { ...currentPanels, ...ordinaryDetails, mapMode: preferredMapMode });
}

export interface ViewMenuOptions {
    button: HTMLElement;
    popover: HTMLElement;
    panels: Record<Panel, HTMLElement | null>;
}

/** Per-panel availability. A disabled panel cannot be toggled by the user
 *  (row dimmed, click no-op, hotkey ignored) - used to prevent "show
 *  mini-map" when there's no GPS track. The stored visibility preference
 *  is preserved so toggling availability back on restores the user's last
 *  choice. */
const availability: Record<Panel, boolean> = { chart: true, strip: true, map: true, readout: true };

/** Module-level options ref set by initViewMenu. setPanelAvailable needs it
 *  to re-apply visibility on availability change (no need to wait for the
 *  next user action). null before init - setPanelAvailable still updates
 *  the availability map; applyPanels will read the up-to-date value on
 *  next call. */
let currentOpts: ViewMenuOptions | null = null;

/** Sets a panel's visibility from outside the menu (e.g. mini-map close-X
 *  click) and syncs the checkbox + persisted state. No-op if unavailable. */
export function setPanelVisible(panel: Panel, visible: boolean): void {
    if (!availability[panel]) return;
    if (panel === "map") {
        setMapViewModePreference(visible ? (preferredMapMode === "large" ? "large" : "mini") : "off");
        return;
    }
    if (currentPanels[panel] === visible) return;
    currentPanels[panel] = visible;
    saveToStorage();
    if (currentOpts) applyPanels(currentOpts);
    notifyListeners();
}

/** Persists only explicit map choices. Availability changes for a no-GPS trip
 *  never call this, so opening such a trip cannot overwrite another trip's
 *  preferred mini/large layout. */
export function setMapViewModePreference(mode: MapViewMode): void {
    if (!availability.map) return;
    if (preferredMapMode === mode && currentPanels.map === (mode !== "off")) return;
    preferredMapMode = mode;
    currentMapMode = mode;
    currentPanels.map = mode !== "off";
    saveToStorage();
    if (currentOpts) applyPanels(currentOpts);
    notifyListeners();
}

function notifyListeners(): void {
    listeners.emitWith(() => [{ ...currentPanels }]);
}

/** Marks a panel as available/unavailable. The row gets aria-disabled +
 *  data-disabled, click handlers skip it, hotkey is ignored. Visibility is
 *  also forced off when made unavailable so the underlying DOM element is
 *  hidden (e.g. no-GPS trip -> mini-map node truly hidden, not just
 *  user-toggled-off). */
export function setPanelAvailable(panel: Panel, available: boolean): void {
    if (availability[panel] === available) return;
    availability[panel] = available;
    const row = document.querySelector<HTMLElement>(`[data-panel="${panel}"]`);
    if (row) {
        if (available) {
            row.removeAttribute("aria-disabled");
            row.removeAttribute("data-disabled");
        } else {
            row.setAttribute("aria-disabled", "true");
            row.setAttribute("data-disabled", "true");
        }
        if (panel === "map") {
            row.querySelectorAll<HTMLButtonElement>("[data-map-mode]").forEach((button) => {
                button.disabled = !available;
            });
        }
    }
    if (currentOpts) applyPanels(currentOpts);
}

/**
 * Wires the dropdown button + popover to localStorage + DOM visibility.
 * Idempotent only at module-scope: caller should call once at startup.
 * Returns a dispose() function for tests.
 */
export function initViewMenu(opts: ViewMenuOptions): () => void {
    const disposePosition = initPlayerPopoverPosition(opts.button, opts.popover);
    currentOpts = opts;
    const loaded = loadFromStorage();
    currentPanels = loaded.panels;
    currentMapMode = loaded.mapMode;
    preferredMapMode = loaded.mapMode;
    applyPanels(opts);

    const popover = createPopover({
        button: opts.button,
        panel: opts.popover,
        show: () => {
            opts.popover.hidden = false;
            opts.button.classList.add("is-open");
        },
        hide: () => {
            opts.popover.hidden = true;
            opts.button.classList.remove("is-open");
        },
    });
    function togglePopover(force?: boolean): void {
        if (force === undefined) popover.toggle();
        else if (force) popover.open();
        else popover.close();
    }

    // Toggle delegates to setPanelVisible (module-level) - single source of
    // truth for write+persist+notify. The availability check happens inside
    // setPanelVisible too; the explicit guard here is for early exit before
    // computing the new value (no DOM lookup, no microtask churn).
    function toggle(panel: Panel): void {
        if (!availability[panel]) return;
        if (panel === "map" && mapModeRequestHandler) {
            mapModeRequestHandler(currentMapMode === "off" ? "mini" : "off");
            return;
        }
        setPanelVisible(panel, !currentPanels[panel]);
    }

    opts.button.addEventListener("click", (e) => {
        e.stopPropagation();
        togglePopover();
    });

    // Row clicks toggle the corresponding panel without closing the popover -
    // the user often switches several panels in one trip.
    opts.popover.querySelectorAll<HTMLButtonElement>(".view-menu-row").forEach((row) => {
        row.addEventListener("click", () => {
            if (row.classList.contains("feedback-link")) {
                togglePopover(false);
                opts.button.focus();
                return;
            }
            const panel = row.dataset.panel as Panel | undefined;
            if (!panel) return;
            toggle(panel);
        });
    });

    const mapModes = [...opts.popover.querySelectorAll<HTMLButtonElement>("[data-map-mode]")];
    mapModes.forEach((button) => {
        button.addEventListener("click", () => {
            if (!availability.map) return;
            const mode = button.dataset.mapMode as MapViewMode | undefined;
            if (!mode) return;
            if (mapModeRequestHandler) mapModeRequestHandler(mode);
            else setPanelVisible("map", mode !== "off");
        });
        button.addEventListener("keydown", (event) => {
            const visibleModes = mapModes.filter((modeButton) => modeButton.getClientRects().length > 0);
            const visibleIndex = visibleModes.indexOf(button);
            if (visibleIndex < 0) return;
            let nextIndex: number | null = null;
            if (event.key === "ArrowLeft" || event.key === "ArrowUp") nextIndex = visibleIndex - 1;
            if (event.key === "ArrowRight" || event.key === "ArrowDown") nextIndex = visibleIndex + 1;
            if (event.key === "Home") nextIndex = 0;
            if (event.key === "End") nextIndex = visibleModes.length - 1;
            if (nextIndex === null) return;
            event.preventDefault();
            event.stopPropagation();
            visibleModes[(nextIndex + visibleModes.length) % visibleModes.length]?.focus();
        });
    });

    function onKeyDown(e: KeyboardEvent): void {
        // A modal owns the keyboard while open - C/T/M must not toggle panels
        // behind the backdrop (modal-helper's trap only swallows Escape/Tab).
        if (isAnyModalOpen()) return;
        // Skip when typing in an input.
        if (e.target instanceof HTMLElement) {
            const tag = e.target.tagName;
            if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA" || e.target.isContentEditable) return;
        }
        // Modifier keys are reserved for browser/system shortcuts - skip rebinds.
        if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
        // No-trips state = landing page. C/E/M would silently mutate the
        // localStorage preference for invisible panels; the user later opens
        // the first trip and sees panels arbitrarily disabled.
        if (document.body.classList.contains("no-trips")) return;
        for (const panel of PANELS) {
            if (e.code === HOTKEY_BY_PANEL[panel]) {
                e.preventDefault();
                toggle(panel);
                return;
            }
        }
    }
    document.addEventListener("keydown", onKeyDown);

    return () => {
        disposePosition();
        popover.close();
        document.removeEventListener("keydown", onKeyDown);
    };
}

function applyPanels(opts: ViewMenuOptions): void {
    // Final visibility = user preference AND availability. Unavailable panels
    // are forced hidden regardless of the user's stored preference (no-GPS
    // trip -> mini-map node hidden even if user previously toggled it on).
    for (const panel of PANELS) {
        const el = opts.panels[panel];
        if (el) el.hidden = !(currentPanels[panel] && availability[panel]);
    }
    // Sync checkboxes in the popover (aria-checked + visual tick via CSS).
    opts.popover.querySelectorAll<HTMLButtonElement>(".view-menu-row").forEach((row) => {
        const panel = row.dataset.panel as Panel | undefined;
        if (!panel) return;
        row.setAttribute("aria-checked", currentPanels[panel] ? "true" : "false");
    });
    applyMapModeControl();
}

function applyMapModeControl(): void {
    document.querySelectorAll<HTMLButtonElement>("[data-map-mode]").forEach((button) => {
        const selected = button.dataset.mapMode === currentMapMode;
        button.setAttribute("aria-checked", selected ? "true" : "false");
        button.tabIndex = selected ? 0 : -1;
    });
}
