// User actions on the camera arrangement. Every control that changes it - a
// tile click or drag, the View menu, hotkeys, the divider, overlay windows -
// goes through these functions, so each change restages the grid, resets a
// zoom that would land on the wrong camera, remembers the arrangement for the
// camera set and wakes the export panel the same way.

import type { CameraArrangementMode, OverlayPosition } from "../camera-layout.js";
import type { Channel } from "../parsers/types.js";
import { notifyExportStateChanged } from "./export-state.js";
import { persistCurrentArrangement } from "./player-layout-pref.js";
import {
    type AudioSource,
    mainChannel,
    moveChannelInOrder,
    state,
    swapChannelsInOrder,
    updateComposition,
    visibleChannels,
} from "./state.js";

interface ArrangementDeps {
    /** Re-applies the composition to the grid; `animate` moves the tiles to
     *  their new places instead of jumping. */
    apply: (opts: { animate: boolean }) => void;
    /** Resets the digital zoom: a restaged grid would leave the zoom on a tile
     *  that changed size or camera. */
    resetZoom: () => void;
}

let deps: ArrangementDeps = { apply: () => {}, resetZoom: () => {} };

export function initCameraArrangement(opts: ArrangementDeps): void {
    deps = opts;
}

function commit(opts: { restage: boolean; persist: boolean }): void {
    if (opts.restage) deps.resetZoom();
    deps.apply({ animate: opts.restage });
    if (opts.persist) persistCurrentArrangement();
    notifyExportStateChanged();
}

/** Makes `channel` the main camera by swapping it with the current one. In
 *  "equal" mode this also switches to "main" mode. */
export function makeMainCamera(channel: Channel): void {
    const visible = visibleChannels();
    if (!visible.includes(channel)) return;
    const main = mainChannel();
    if (channel === main && state.composition.mode === "main") return;
    updateComposition({ mode: "main", order: swapChannelsInOrder(state.composition.order, channel, main) });
    commit({ restage: true, persist: true });
}

/** The camera after the current main one becomes the main camera (the hotkey
 *  for stepping through cameras). The visible cameras rotate by one place, so
 *  repeated presses visit every camera; hidden ones keep their places. */
export function cycleMainCamera(): void {
    const visible = visibleChannels();
    if (visible.length <= 1) return;
    const rotated = [...visible.slice(1), visible[0]!];
    let next = 0;
    const order = state.composition.order.map((channel) =>
        state.composition.hidden.includes(channel) ? channel : rotated[next++]!,
    );
    updateComposition({ mode: "main", order });
    commit({ restage: true, persist: true });
}

export function setArrangementMode(mode: CameraArrangementMode): void {
    if (state.composition.mode === mode) return;
    updateComposition({ mode });
    commit({ restage: true, persist: true });
}

export function toggleArrangementMode(): void {
    if (visibleChannels().length <= 1) return;
    setArrangementMode(state.composition.mode === "main" ? "equal" : "main");
}

/** Shows or hides a camera. The last visible camera cannot be hidden. */
export function setCameraHidden(channel: Channel, hidden: boolean): void {
    const c = state.composition;
    if (!c.order.includes(channel) || c.hidden.includes(channel) === hidden) return;
    if (hidden && visibleChannels().length <= 1) return;
    updateComposition({ hidden: hidden ? [...c.hidden, channel] : c.hidden.filter((ch) => ch !== channel) });
    commit({ restage: true, persist: true });
}

/** Moves `channel` to the place of `target` (insert: the cameras between them
 *  shift by one), for reordering the strip or the equal grid. */
export function moveCamera(channel: Channel, target: Channel): void {
    const order = state.composition.order;
    const targetIndex = order.indexOf(target);
    if (targetIndex < 0 || channel === target) return;
    updateComposition({ order: moveChannelInOrder(order, channel, targetIndex) });
    commit({ restage: true, persist: true });
}

/** Size of the smaller cameras; null returns to the automatic size. A live
 *  drag passes `persist: false` for every move and persists once at the end. */
export function setThumbScale(scale: number | null, opts: { persist: boolean } = { persist: true }): void {
    if (state.composition.thumbScale !== scale) {
        updateComposition({ thumbScale: scale });
        deps.apply({ animate: false });
    }
    if (opts.persist) {
        persistCurrentArrangement();
        notifyExportStateChanged();
    }
}

export function setAllowOverlay(allow: boolean): void {
    if (state.composition.allowOverlay === allow) return;
    updateComposition({ allowOverlay: allow });
    commit({ restage: true, persist: true });
}

/** Moves an overlay window; same live-drag contract as setThumbScale. */
export function setOverlayPosition(
    channel: Channel,
    position: OverlayPosition,
    opts: { persist: boolean } = { persist: true },
): void {
    updateComposition({ overlayPositions: { ...state.composition.overlayPositions, [channel]: position } });
    deps.apply({ animate: false });
    if (opts.persist) {
        persistCurrentArrangement();
        notifyExportStateChanged();
    }
}

/** Audio from the main camera or from one camera. Not remembered across
 *  trips: a camera set's audio habits are not obvious enough to restore. */
export function setAudioSource(source: AudioSource): void {
    if (state.composition.audio === source) return;
    updateComposition({ audio: source });
    deps.apply({ animate: false });
    notifyExportStateChanged();
}
