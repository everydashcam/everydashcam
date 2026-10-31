import { syncMobileViewNav } from "./mobile-view-nav.js";
import { scheduleRecognitionHelp } from "./recognition-help.js";
// Top-panel: composition controls visible above the player.
//
// Visibility matrix (driven by trip channel count + export-mode flag):
//   - single-channel + casual:    hidden;
//   - multi-channel  + casual:    show layout + channels + audio source;
//   - single-channel + export:    trip-name header only;
//   - multi-channel  + export:    trip-name header + layout + channels + audio.
//
// The output-frame preset used to live here too; it moved to the export panel
// (export-panel.ts) - it is a save-spec, not a live-composition control.
//
// Content per group:
//   - layout buttons: small SVG-icon buttons for each layout valid at the
//     current channel count (e.g., 2 channels -> h2 / v2 / pip2). aria-pressed
//     reflects state.composition.layout. Click -> setLayoutAndChannels({layout}).
//   - channel chips: one chip per trip channel. An include checkbox toggles
//     whether the channel is in the composition - which is shared, so it drives
//     the player grid AND the export; toggling refits the layout to the new
//     visible count. Included chips also drag onto one another (Pointer Events,
//     touch-capable) to reorder slots - the same swap the video tiles expose
//     (player-tile-reorder.ts). Both paths go through setLayoutAndChannels.
//   - audio dropdown: <select> with options = currently visible slots. Change
//     -> setLayoutAndChannels({audioChannel}); player re-applies mute/volume
//     via the onCompositionApply callback (set at init).
//
// State changes from outside (toggleViewMode in player.ts, trip change) must
// call syncTopPanel() so the panel reflects the new composition. Re-render is
// idempotent and cheap (few dozen DOM nodes).

import type { Channel } from "../parsers/types.js";
import { getDateLocale, t } from "../i18n/index.js";
import type { Trip } from "../trips.js";
import { displayClockDate, tripChannels } from "../trips.js";
import { dom } from "./dom.js";
import { channelDisplayLabel, formatDuration } from "./format.js";
import { notifyExportStateChanged, subscribeExportState } from "./export-state.js";
import { persistCurrentLayout } from "./player-layout-pref.js";
import { MOBILE_LAYOUT_QUERY } from "./media-queries.js";
import {
    activeTrip,
    defaultLayoutForCount,
    layoutSlotCount,
    moveChannelInOrder,
    setLayoutAndChannels,
    state,
} from "./state.js";
import type { Layout } from "./state.js";

/**
 * Layouts available for each channel count. PiP-style and tile-style layouts
 * coexist - user picks one via the buttons. Order matches visual flow (tile
 * variants first, pip last) so the default for a new count is a tile layout
 * if nothing else applies.
 */
const LAYOUTS_BY_SLOTS: Record<number, Layout[]> = {
    1: ["single"],
    2: ["h2", "v2", "pip2"],
    3: ["left1right2", "left2right1", "pip3"],
    4: ["grid2x2", "pip4"],
};

/**
 * Callback into player.ts to re-apply current composition to the DOM video
 * grid (mute routing, tile positions, view-mode button visuals). Set via
 * initTopPanel({onCompositionApply}). top-panel.ts deliberately does not
 * import player.ts directly - the dependency points the other way (player
 * imports syncTopPanel) and circular imports would break.
 */
let onCompositionApply: () => void = () => {};

/**
 * Resets the active video's digital zoom. Layout/channel-order changes restage
 * which <video> is the primary tile; a lingering zoom transform would otherwise
 * stay stranded on the ex-primary (now a small overlay) while the new primary
 * is unzoomed, and the zoom mini-map would keep showing. toggleViewMode resets
 * zoom for the same reason - these top-panel paths must match it. Audio / output
 * changes do NOT restage the primary, so they intentionally leave zoom alone.
 */
let resetZoom: () => void = () => {};

/**
 * One-time wiring: subscribe to export-state changes, store the
 * composition-apply callback, and seed initial visibility from current state.
 * Call from app.ts after dom.ts has resolved the new element refs.
 */
export function initTopPanel(opts: { onCompositionApply: () => void; resetZoom?: () => void }): void {
    onCompositionApply = opts.onCompositionApply;
    if (opts.resetZoom) resetZoom = opts.resetZoom;
    const controls = document.querySelector<HTMLDetailsElement>("#top-panel-controls");
    const mobile = window.matchMedia(MOBILE_LAYOUT_QUERY);
    const syncControls = (): void => {
        if (controls) controls.open = !mobile.matches;
    };
    mobile.addEventListener("change", syncControls);
    syncControls();
    subscribeExportState(syncTopPanel);
    syncTopPanel();
}

/**
 * Re-evaluates top-panel visibility and content. Called by every export-state
 * tick and from player.ts on trip change / view-mode toggle.
 *
 * Cheap (~20 DOM writes worst case) - safe to call from any lifecycle hook.
 */
export function syncTopPanel(): void {
    scheduleRecognitionHelp();
    syncMobileViewNav();
    if (!dom.topPanel) return;
    const trip = activeTrip();
    const isMulti = !!trip && hasMultipleChannels(trip);
    const open = state.exportModeOpen;

    // Show whenever there's something to surface: multi-channel composition
    // controls (always), or the trip-name header in export mode (the sidebar is
    // hidden then). Single-channel casual = nothing to show, panel stays hidden.
    const shouldShow = !!trip && (isMulti || open);
    dom.topPanel.hidden = !shouldShow;
    if (!shouldShow || !trip) return;

    if (dom.topPanelLayout) dom.topPanelLayout.hidden = !isMulti;
    if (dom.topPanelChannels) dom.topPanelChannels.hidden = !isMulti;
    if (dom.topPanelAudio) dom.topPanelAudio.hidden = !isMulti;
    const controls = document.getElementById("top-panel-controls");
    if (controls) controls.hidden = !isMulti;
    const summary = document.getElementById("top-panel-controls-summary");
    if (summary) summary.textContent = t("plurals.camera", { n: state.composition.channelOrder.length });

    // Trip-name header is only useful when the sidebar is hidden (export
    // mode on desktop) - duplicating the sidebar trip card is noise.
    if (dom.topPanelTripName) {
        if (open) {
            dom.topPanelTripName.textContent = formatTripHeader(trip);
            dom.topPanelTripName.hidden = false;
        } else {
            dom.topPanelTripName.textContent = "";
            dom.topPanelTripName.hidden = true;
        }
    }

    if (isMulti) {
        renderLayoutButtons(trip);
        renderChannelsList(trip);
        renderAudioDropdown(trip);
    }
}

/* ----------------------------- layout group ----------------------------- */

function renderLayoutButtons(trip: Trip): void {
    const host = dom.topPanelLayout;
    if (!host) return;
    const slots = state.composition.channelOrder.length;
    const layouts = LAYOUTS_BY_SLOTS[slots] ?? LAYOUTS_BY_SLOTS[1]!;
    host.innerHTML = "";

    const label = document.createElement("span");
    label.className = "top-panel__label";
    label.textContent = t("topPanel.layout.label");
    host.appendChild(label);

    for (const layout of layouts) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "top-panel__layout-btn";
        btn.dataset.layout = layout;
        btn.setAttribute("aria-pressed", layout === state.composition.layout ? "true" : "false");
        btn.setAttribute("aria-label", layoutLabel(layout));
        btn.title = layoutLabel(layout);
        btn.appendChild(layoutIcon(layout));
        btn.addEventListener("click", () => onLayoutClick(layout, trip));
        host.appendChild(btn);
    }
}

function onLayoutClick(layout: Layout, trip: Trip): void {
    if (layout === state.composition.layout) return;
    const newSlots = layoutSlotCount(layout);
    const oldOrder = state.composition.channelOrder;
    const tripChs = tripChannels(trip);

    // Slot count may grow (e.g., pip2 -> pip3 when user switches from a 2-up
    // to a 3-up layout). Extend channelOrder from the trip's available
    // channels, picking those not yet in the order to avoid duplicates.
    const nextOrder: Channel[] = oldOrder.slice(0, newSlots);
    for (const ch of tripChs) {
        if (nextOrder.length >= newSlots) break;
        if (!nextOrder.includes(ch)) nextOrder.push(ch);
    }
    setLayoutAndChannels({ layout, channelOrder: nextOrder });
    resetZoom();
    onCompositionApply();
    persistCurrentLayout();
    // Composition is shared with the export (channel set + layout drive the
    // export estimate and the stream-copy-vs-re-encode decision), so a change
    // here must wake the export panel too. notifyExportStateChanged also re-runs
    // syncTopPanel via its subscription, so the top panel still refreshes.
    notifyExportStateChanged();
}

/** Localized layout label. pip2/pip3/pip4 collapse to the generic "pip"
 *  i18n key - there's only one PiP button visible at any channel count, so
 *  context is unambiguous from the icon. */
function layoutLabel(layout: Layout): string {
    switch (layout) {
        case "single":
            return t("export.split.layout.single");
        case "h2":
            return t("export.split.layout.h2");
        case "v2":
            return t("export.split.layout.v2");
        case "left1right2":
            return t("export.split.layout.left1right2");
        case "left2right1":
            return t("export.split.layout.left2right1");
        case "grid2x2":
            return t("export.split.layout.grid2x2");
        case "pip2":
        case "pip3":
        case "pip4":
            return t("export.split.layout.pip");
    }
}

/**
 * SVG icon depicting the layout (24x16 viewport). currentColor inherits from
 * the button color; aria-hidden because the button's aria-label conveys the
 * meaning. PiP variants show the main frame at low opacity and the overlays
 * at higher opacity so the visual hierarchy is obvious at small sizes.
 */
function layoutIcon(layout: Layout): SVGElement {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 24 16");
    svg.setAttribute("width", "24");
    svg.setAttribute("height", "16");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("fill", "currentColor");

    const rects: Array<[number, number, number, number, number]> = (() => {
        switch (layout) {
            case "single":
                return [[1, 1, 22, 14, 0.45]];
            case "h2":
                return [
                    [1, 1, 10.5, 14, 0.45],
                    [12.5, 1, 10.5, 14, 0.45],
                ];
            case "v2":
                return [
                    [1, 1, 22, 6.5, 0.45],
                    [1, 8.5, 22, 6.5, 0.45],
                ];
            case "grid2x2":
                return [
                    [1, 1, 10.5, 6.5, 0.45],
                    [12.5, 1, 10.5, 6.5, 0.45],
                    [1, 8.5, 10.5, 6.5, 0.45],
                    [12.5, 8.5, 10.5, 6.5, 0.45],
                ];
            case "left1right2":
                return [
                    [1, 1, 13, 14, 0.45],
                    [15, 1, 8, 6.5, 0.45],
                    [15, 8.5, 8, 6.5, 0.45],
                ];
            case "left2right1":
                return [
                    [1, 1, 8, 6.5, 0.45],
                    [1, 8.5, 8, 6.5, 0.45],
                    [10, 1, 13, 14, 0.45],
                ];
            case "pip2":
                return [
                    [1, 1, 22, 14, 0.22],
                    [15, 9, 7, 5, 0.7],
                ];
            case "pip3":
                return [
                    [1, 1, 22, 14, 0.22],
                    [15, 3.5, 7, 5, 0.7],
                    [15, 9.5, 7, 5, 0.7],
                ];
            case "pip4":
                return [
                    [1, 1, 22, 14, 0.22],
                    [15, 1.5, 7, 4, 0.7],
                    [15, 6, 7, 4, 0.7],
                    [15, 10.5, 7, 4, 0.7],
                ];
        }
    })();

    for (const [x, y, w, h, opacity] of rects) {
        const r = document.createElementNS(ns, "rect");
        r.setAttribute("x", String(x));
        r.setAttribute("y", String(y));
        r.setAttribute("width", String(w));
        r.setAttribute("height", String(h));
        r.setAttribute("rx", "1.2");
        r.setAttribute("opacity", String(opacity));
        svg.appendChild(r);
    }
    return svg;
}

/* ----------------------------- channels list ----------------------------- */

function renderChannelsList(trip: Trip): void {
    const host = dom.topPanelChannels;
    if (!host) return;
    // A re-render mid-drag (export-state tick, language switch) detaches the
    // captured chip - its pointerup/cancel listeners never fire, stranding
    // the floating ghost and the drag state until the next drag. Close the
    // drag before wiping the list.
    endChipDrag();
    host.innerHTML = "";

    const label = document.createElement("span");
    label.className = "top-panel__label";
    label.textContent = t("topPanel.channels.label");
    host.appendChild(label);

    const list = document.createElement("ul");
    list.className = "top-panel__channels-list";
    list.setAttribute("aria-label", t("topPanel.channels.reorderAria"));

    const order = state.composition.channelOrder;
    // Included channels first (slot order, reorderable), then the excluded ones
    // (static, muted) so the user can re-add them. A channel toggled off leaves
    // the shared composition entirely - the player grid AND the export - so the
    // chip checkbox is the single "which cameras" control.
    const excluded = tripChannels(trip).filter((ch) => !order.includes(ch));
    const canExclude = order.length > 1; // keep at least one visible channel

    for (let i = 0; i < order.length; i++) {
        list.appendChild(buildChannelChip(order[i]!, trip, list, { included: true, slot: i, canExclude }));
    }
    for (const ch of excluded) {
        list.appendChild(buildChannelChip(ch, trip, list, { included: false, slot: -1, canExclude }));
    }
    host.appendChild(list);
    const help = document.createElement("button");
    help.type = "button";
    help.className = "recognition-help-link feedback-link";
    help.dataset.feedbackPreset = "cameras";
    help.textContent = t("recognition.cameras.help");
    host.appendChild(help);
}

/** One channel chip: an include checkbox plus, for included channels, a drag
 *  handle and reorder behaviour. Excluded channels render muted and static so
 *  they can be re-added. The sole remaining included channel cannot be
 *  unchecked (an empty export is not valid). */
function buildChannelChip(
    ch: Channel,
    trip: Trip,
    list: HTMLUListElement,
    opts: { included: boolean; slot: number; canExclude: boolean },
): HTMLLIElement {
    const li = document.createElement("li");
    li.className = "top-panel__channel-chip";
    if (!opts.included) li.classList.add("is-excluded");
    li.dataset.channel = ch;
    if (opts.included) li.dataset.slot = String(opts.slot);

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.className = "top-panel__channel-include";
    cb.checked = opts.included;
    cb.disabled = opts.included && !opts.canExclude;
    cb.setAttribute("aria-label", t("topPanel.channels.includeAria", { ch: channelDisplayLabel(ch, trip) }));
    cb.addEventListener("change", () => toggleChannelInclude(ch, cb.checked, trip));
    li.appendChild(cb);

    if (opts.included) {
        const handle = document.createElement("span");
        handle.className = "top-panel__channel-handle";
        handle.setAttribute("aria-hidden", "true");
        handle.textContent = "⋮⋮";
        li.appendChild(handle);
    }

    const txt = document.createElement("span");
    txt.className = "top-panel__channel-text";
    txt.textContent = channelDisplayLabel(ch, trip);
    li.appendChild(txt);

    if (opts.included) attachChannelChipDrag(li, list);
    return li;
}

/** Includes/excludes a channel from the shared composition and refits the
 *  layout to the new visible count. No-op at the bounds (min 1, max the trip's
 *  channel count capped at 4). Mirrors onLayoutClick's restage sequence. */
function toggleChannelInclude(ch: Channel, include: boolean, trip: Trip): void {
    const order = state.composition.channelOrder;
    const maxCount = Math.min(4, tripChannels(trip).length);
    let next: Channel[];
    if (include) {
        if (order.includes(ch) || order.length >= maxCount) return;
        next = [...order, ch];
    } else {
        if (!order.includes(ch) || order.length <= 1) return;
        next = order.filter((c) => c !== ch);
    }
    setLayoutAndChannels({ layout: defaultLayoutForCount(next.length), channelOrder: next });
    resetZoom();
    onCompositionApply();
    // Composition is shared with the export (channel set + layout drive the
    // export estimate and the stream-copy-vs-re-encode decision), so a change
    // here must wake the export panel too. notifyExportStateChanged also re-runs
    // syncTopPanel via its subscription, so the top panel still refreshes.
    notifyExportStateChanged();
}

/** In-flight chip drag. Pointer Events (not HTML5 DnD) so reorder works on
 *  touch - the old draggable=true path fired no events on phones. Insert
 *  semantics (drop a chip onto another to move it into that slot) match the
 *  video-tile drag. */
interface ChipDragState {
    pointerId: number;
    sourceCh: Channel;
    chip: HTMLLIElement;
    list: HTMLUListElement;
    target: HTMLLIElement | null;
    moved: boolean;
}

let chipDrag: ChipDragState | null = null;
// Floating label following the pointer during a chip drag, mirroring the
// video-tile ghost. Created lazily, kept detached between drags.
let chipGhost: HTMLElement | null = null;

function attachChannelChipDrag(chip: HTMLLIElement, list: HTMLUListElement): void {
    chip.addEventListener("pointerdown", (ev) => {
        if (ev.pointerType === "mouse" && ev.button !== 0) return;
        // The include checkbox handles its own clicks - never start a drag from it.
        if ((ev.target as HTMLElement | null)?.closest("input")) return;
        const sourceCh = chip.dataset.channel as Channel | undefined;
        if (!sourceCh) return;
        ev.preventDefault();
        try {
            chip.setPointerCapture(ev.pointerId);
        } catch {
            /* capture may fail if the pointer is already inactive - continue */
        }
        chipDrag = { pointerId: ev.pointerId, sourceCh, chip, list, target: null, moved: false };
        chip.classList.add("is-dragging");
    });
    chip.addEventListener("pointermove", (ev) => {
        if (!chipDrag || ev.pointerId !== chipDrag.pointerId) return;
        if (!chipDrag.moved) {
            chipDrag.moved = true;
            showChipGhost(chipDrag.sourceCh);
        }
        moveChipGhost(ev.clientX, ev.clientY);
        const targetChip = chipUnderPoint(chipDrag.list, ev.clientX, ev.clientY);
        if (targetChip === chipDrag.target) return;
        chipDrag.target?.classList.remove("drop-before");
        // Insert indicator on the target chip (the slot the source moves into).
        if (targetChip && targetChip !== chipDrag.chip) {
            chipDrag.target = targetChip;
            targetChip.classList.add("drop-before");
        } else {
            chipDrag.target = null;
        }
    });
    chip.addEventListener("pointerup", (ev) => {
        if (!chipDrag || ev.pointerId !== chipDrag.pointerId) return;
        const { sourceCh, target } = chipDrag;
        try {
            chip.releasePointerCapture(ev.pointerId);
        } catch {
            /* see pointerdown */
        }
        endChipDrag();
        if (!target) return;
        const targetCh = target.dataset.channel as Channel | undefined;
        if (!targetCh || targetCh === sourceCh) return;
        insertChannel(sourceCh, targetCh);
    });
    chip.addEventListener("pointercancel", (ev) => {
        if (!chipDrag || ev.pointerId !== chipDrag.pointerId) return;
        endChipDrag();
    });
}

function showChipGhost(ch: Channel): void {
    const trip = activeTrip();
    if (!chipGhost) {
        chipGhost = document.createElement("div");
        chipGhost.className = "chip-drag-ghost";
    }
    chipGhost.textContent = trip ? channelDisplayLabel(ch, trip) : ch;
    document.body.appendChild(chipGhost);
}

function moveChipGhost(clientX: number, clientY: number): void {
    if (!chipGhost) return;
    // Offset from the pointer so it does not sit under the finger/cursor.
    chipGhost.style.left = `${clientX + 12}px`;
    chipGhost.style.top = `${clientY + 12}px`;
}

/** Chip under the viewport point within the given list, or null. */
function chipUnderPoint(list: HTMLUListElement, clientX: number, clientY: number): HTMLLIElement | null {
    const el = document.elementFromPoint(clientX, clientY);
    if (!(el instanceof HTMLElement)) return null;
    const chip = el.closest(".top-panel__channel-chip") as HTMLLIElement | null;
    if (!chip || !list.contains(chip)) return null;
    return chip;
}

function endChipDrag(): void {
    if (!chipDrag) return;
    chipDrag.chip.classList.remove("is-dragging");
    chipDrag.target?.classList.remove("drop-before");
    chipGhost?.remove();
    chipDrag = null;
}

/** Moves sourceCh into targetCh's slot (insert, not swap) and restages the
 *  player + panel. Insert matches the grid tile reorder
 *  (player-tile-reorder.ts) - one mental model - via the shared
 *  moveChannelInOrder helper. */
function insertChannel(sourceCh: Channel, targetCh: Channel): void {
    const order = state.composition.channelOrder;
    const targetIndex = order.indexOf(targetCh);
    if (targetIndex < 0) return;
    const next = moveChannelInOrder(order, sourceCh, targetIndex);
    setLayoutAndChannels({ channelOrder: next });
    resetZoom();
    onCompositionApply();
    persistCurrentLayout();
    // Composition is shared with the export (channel set + layout drive the
    // export estimate and the stream-copy-vs-re-encode decision), so a change
    // here must wake the export panel too. notifyExportStateChanged also re-runs
    // syncTopPanel via its subscription, so the top panel still refreshes.
    notifyExportStateChanged();
}

/* ----------------------------- audio dropdown ---------------------------- */

function renderAudioDropdown(trip: Trip): void {
    const host = dom.topPanelAudio;
    if (!host) return;
    host.innerHTML = "";

    const label = document.createElement("label");
    label.className = "top-panel__label";
    label.textContent = t("topPanel.audio.label");
    host.appendChild(label);

    const select = document.createElement("select");
    select.className = "top-panel__audio-select";
    select.setAttribute("aria-label", t("topPanel.audio.label"));
    for (const ch of state.composition.channelOrder) {
        const opt = document.createElement("option");
        opt.value = ch;
        opt.textContent = channelDisplayLabel(ch, trip);
        if (ch === state.composition.audioChannel) opt.selected = true;
        select.appendChild(opt);
    }
    select.addEventListener("change", () => {
        const next = select.value as Channel;
        setLayoutAndChannels({ audioChannel: next });
        onCompositionApply();
    });
    host.appendChild(select);
}

/* ------------------------------- helpers ------------------------------- */

/** True if the trip has at least two channels with playable candidates -
 *  that is the only condition under which layout / channels / audio choice
 *  is meaningful. A single-channel trip implies layout="single" implicitly. */
function hasMultipleChannels(trip: Trip): boolean {
    const channels = new Set<string>();
    for (const frame of trip.frames) {
        for (const [ch, cand] of Object.entries(frame.channels)) {
            if (cand?.canPlay) channels.add(ch);
        }
        if (channels.size > 1) return true;
    }
    return false;
}

/** Compact trip identifier: start time + duration. Sidebar header shows the
 *  same data in a richer card; we use a single line here for the slim panel. */
function formatTripHeader(trip: Trip): string {
    // Display clock (camera clock when known) - must match the sidebar card.
    const start = displayClockDate(trip.startUtc, trip.cameraTzSec);
    // Explicit UI locale (never undefined/OS default - i18n invariant) and
    // hour12:false to match formatTripTitle in the sidebar card.
    const locale = getDateLocale();
    const dateStr = start.toLocaleDateString(locale, {
        year: "numeric",
        month: "short",
        day: "numeric",
        timeZone: "UTC",
    });
    const timeStr = start.toLocaleTimeString(locale, {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        timeZone: "UTC",
    });
    return `${dateStr} · ${timeStr} · ${formatDuration(trip.timeline.contentDurationSec)}`;
}
