// Cameras section of the View menu: arrangement mode, overlay permission,
// which cameras show and in what order, the main camera and the sound source
// on trips with several cameras, then the reflection of each shown camera on
// every trip. Viewing and export share the arrangement and the reflection, so
// this is the one place to set them. Arrangement changes go through
// camera-arrangement.ts, reflection through player-camera-flip.ts. The View
// menu (view-menu.ts) owns the dialog and its lifecycle; the orchestrator
// renders this section when it opens.
//
// Native controls rather than menu items: the section mixes radios,
// checkboxes, a select and drag handles, which menu semantics cannot express.
// That is why the View menu is a dialog.

import { t } from "../i18n/index.js";
import type { Channel } from "../parsers/types.js";
import {
    makeMainCamera,
    moveCamera,
    setAllowOverlay,
    setArrangementMode,
    setAudioSource,
    setCameraHidden,
} from "./camera-arrangement.js";
import { cameraFlipForChannel } from "./camera-flip-pref.js";
import { dom } from "./dom.js";
import { subscribeExportState } from "./export-state.js";
import { channelDisplayLabel } from "./format.js";
import { type CameraFlipAxis, isCameraFlipLocked, toggleCameraFlip } from "./player-camera-flip.js";
import { attachPointerDrag } from "./pointer-drag.js";
import { activeTrip, mainChannel, state, visibleChannels } from "./state.js";

// Row under the pointer while a camera is dragged by its handle.
let drag: { channel: Channel; target: Channel | null; ghost: HTMLElement | null } | null = null;

/** Whether a trip is open: every camera can be reflected. */
function hasCameras(): boolean {
    return !!activeTrip() && state.composition.order.length > 0;
}

/** Whether the open trip has cameras to arrange. */
function hasSeveralCameras(): boolean {
    return hasCameras() && state.composition.order.length > 1;
}

/**
 * Shows the section while a trip is open and refreshes it while the View
 * menu is open. Called after every arrangement change and trip switch.
 */
export function syncCamerasMenu(): void {
    const section = dom.camerasSection;
    const available = hasCameras();
    section.hidden = !available;
    if (!available) {
        cancelCameraDrag();
        // A trip switch can empty the section under an open menu; the panel
        // rows below keep the keyboard inside the dialog.
        const hadFocus = section.contains(document.activeElement);
        section.replaceChildren();
        if (hadFocus) dom.viewMenuPopover.querySelector<HTMLElement>(".view-menu-row:not([hidden])")?.focus();
        return;
    }
    if (!dom.viewMenuPopover.hidden) renderCamerasMenu();
}

/* -------------------------------- rendering -------------------------------- */

function header(textKey: Parameters<typeof t>[0]): HTMLElement {
    const el = document.createElement("div");
    el.className = "view-menu-popover__header";
    el.textContent = t(textKey);
    return el;
}

function renderModes(): HTMLElement {
    const group = document.createElement("div");
    group.className = "view-menu-map__modes cameras-menu__modes";
    group.setAttribute("role", "radiogroup");
    group.setAttribute("aria-label", t("player.cameras.mode.label"));
    for (const mode of ["main", "equal"] as const) {
        const option = document.createElement("button");
        option.type = "button";
        option.setAttribute("role", "radio");
        option.dataset.cameraMode = mode;
        option.dataset.focusKey = `mode:${mode}`;
        const checked = state.composition.mode === mode;
        option.setAttribute("aria-checked", String(checked));
        option.tabIndex = checked ? 0 : -1;
        option.textContent = t(mode === "main" ? "player.cameras.mode.main" : "player.cameras.mode.equal");
        option.addEventListener("click", () => setArrangementMode(mode));
        // Arrows only move focus; Enter or Space picks the layout, like the
        // map modes below. The View menu opens with focus here, and a stray
        // arrow must not restage every camera.
        option.addEventListener("keydown", (e) => {
            if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
            e.preventDefault();
            e.stopPropagation();
            const other = mode === "main" ? "equal" : "main";
            group.querySelector<HTMLElement>(`[data-camera-mode="${other}"]`)?.focus();
        });
        group.append(option);
    }
    return group;
}

function renderOverlayToggle(): HTMLElement {
    const label = document.createElement("label");
    label.className = "cameras-menu__row cameras-menu__row--described";
    label.hidden = state.composition.mode !== "main";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.className = "cameras-menu__overlay";
    input.dataset.focusKey = "overlay";
    input.checked = state.composition.allowOverlay;
    input.addEventListener("change", () => setAllowOverlay(input.checked));
    const text = document.createElement("span");
    text.className = "view-menu-row__text";
    const title = document.createElement("span");
    title.className = "view-menu-row__label";
    title.textContent = t("player.cameras.allowOverlay");
    const description = document.createElement("span");
    description.className = "view-menu-row__description";
    description.textContent = t("player.cameras.allowOverlay.description");
    text.append(title, description);
    label.append(input, text);
    return label;
}

function renderCameraRow(channel: Channel): HTMLElement {
    const trip = activeTrip();
    const name = trip ? channelDisplayLabel(channel, trip) : channel;
    const c = state.composition;
    const visible = !c.hidden.includes(channel);
    const isMain = visible && channel === mainChannel() && c.mode === "main";
    const row = document.createElement("li");
    row.className = "cameras-menu__camera";
    row.dataset.channel = channel;
    row.classList.toggle("is-hidden", !visible);

    const handle = document.createElement("button");
    handle.type = "button";
    handle.className = "cameras-menu__handle";
    handle.dataset.focusKey = `handle:${channel}`;
    handle.setAttribute("aria-label", t("player.cameras.moveAria", { ch: name }));
    handle.title = t("player.cameras.reorderAria");
    handle.innerHTML =
        '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="currentColor"><circle cx="6" cy="4" r="1.3"/><circle cx="10" cy="4" r="1.3"/><circle cx="6" cy="8" r="1.3"/><circle cx="10" cy="8" r="1.3"/><circle cx="6" cy="12" r="1.3"/><circle cx="10" cy="12" r="1.3"/></svg>';
    handle.addEventListener("keydown", (e) => {
        const order = state.composition.order;
        const index = order.indexOf(channel);
        const neighbour = e.key === "ArrowUp" ? order[index - 1] : e.key === "ArrowDown" ? order[index + 1] : null;
        if (!neighbour) return;
        e.preventDefault();
        e.stopPropagation();
        moveCamera(channel, neighbour);
    });
    attachHandleDrag(handle, channel, name);

    const label = document.createElement("label");
    label.className = "cameras-menu__show";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = "cameras-menu__visible";
    checkbox.dataset.focusKey = `visible:${channel}`;
    checkbox.checked = visible;
    checkbox.disabled = visible && visibleChannels().length <= 1;
    checkbox.setAttribute("aria-label", t("player.cameras.showAria", { ch: name }));
    checkbox.addEventListener("change", () => setCameraHidden(channel, !checkbox.checked));
    const text = document.createElement("span");
    text.className = "cameras-menu__name";
    text.textContent = name;
    label.append(checkbox, text);

    const main = document.createElement("button");
    main.type = "button";
    main.className = "cameras-menu__main";
    main.dataset.focusKey = `main:${channel}`;
    main.setAttribute("aria-pressed", String(isMain));
    main.disabled = !visible;
    main.textContent = t("player.cameras.mainBadge");
    main.title = t("player.cameras.makeMainAria", { ch: name });
    main.setAttribute("aria-label", t("player.cameras.makeMainAria", { ch: name }));
    main.addEventListener("click", () => makeMainCamera(channel));

    row.append(handle, label, main);
    return row;
}

function renderAudio(): HTMLElement {
    const label = document.createElement("label");
    label.className = "cameras-menu__row cameras-menu__audio";
    const text = document.createElement("span");
    text.className = "view-menu-row__label";
    text.textContent = t("player.cameras.audio.label");
    const select = document.createElement("select");
    select.className = "cameras-menu__audio-select";
    select.dataset.focusKey = "audio";
    const follow = document.createElement("option");
    follow.value = "follow-main";
    follow.textContent = t("player.cameras.audio.followMain");
    select.append(follow);
    const trip = activeTrip();
    for (const channel of visibleChannels()) {
        const option = document.createElement("option");
        option.value = channel;
        option.textContent = trip ? channelDisplayLabel(channel, trip) : channel;
        select.append(option);
    }
    select.value = state.composition.audio;
    select.addEventListener("change", () => setAudioSource(select.value as Channel | "follow-main"));
    label.append(text, select);
    return label;
}

const FLIP_AXES: readonly CameraFlipAxis[] = ["horizontal", "vertical"];

function flipIcon(axis: CameraFlipAxis): string {
    return `<svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><g${axis === "vertical" ? ' transform="rotate(90 10 10)"' : ""}><path d="M10 2v16" stroke-dasharray="2 2"/><path d="M3 5v10l4-2V7z"/><path d="M17 5v10l-4-2V7z" fill="currentColor" fill-opacity=".25"/></g></svg>`;
}

/** The reflection block: one row per shown camera with a toggle per axis.
 *  Each row is a group named after its camera, so the toggles can keep the
 *  short axis names. */
function renderFlips(): HTMLElement {
    const trip = activeTrip();
    const block = document.createElement("div");
    block.className = "cameras-menu__flips";
    block.setAttribute("role", "group");
    const title = header("player.camera.flip.title");
    title.id = "cameras-menu-flip-title";
    const hint = document.createElement("div");
    hint.id = "cameras-menu-flip-hint";
    hint.className = "view-menu-row__description cameras-menu__flip-hint";
    hint.textContent = t("player.camera.flip.hint");
    block.setAttribute("aria-labelledby", title.id);
    block.setAttribute("aria-describedby", hint.id);
    block.append(title, hint);
    for (const channel of visibleChannels()) {
        const row = document.createElement("div");
        row.className = "cameras-menu__flip";
        row.dataset.channel = channel;
        row.setAttribute("role", "group");
        const name = document.createElement("span");
        name.id = `cameras-menu-flip-${channel}`;
        name.className = "cameras-menu__name";
        name.textContent = trip ? channelDisplayLabel(channel, trip) : channel;
        row.setAttribute("aria-labelledby", name.id);
        row.append(name);
        for (const axis of FLIP_AXES) {
            const toggle = document.createElement("button");
            toggle.type = "button";
            toggle.className = "cameras-menu__flip-axis";
            toggle.dataset.flip = axis;
            toggle.dataset.focusKey = `flip:${channel}:${axis}`;
            toggle.title = t(`player.camera.flip.${axis}`);
            toggle.setAttribute("aria-label", toggle.title);
            toggle.innerHTML = flipIcon(axis);
            toggle.addEventListener("click", () => toggleCameraFlip(channel, axis));
            row.append(toggle);
        }
        block.append(row);
    }
    syncFlipToggles(block);
    return block;
}

/** Brings the reflection toggles in `root` to the remembered reflection and
 *  the export lock, in place, so focus stays on the toggle just pressed. */
function syncFlipToggles(root: ParentNode = dom.camerasSection): void {
    const isLocked = isCameraFlipLocked();
    for (const toggle of root.querySelectorAll<HTMLButtonElement>(".cameras-menu__flip-axis")) {
        const channel = toggle.closest<HTMLElement>(".cameras-menu__flip")?.dataset.channel as Channel | undefined;
        const axis = toggle.dataset.flip as CameraFlipAxis | undefined;
        if (!channel || !axis) continue;
        toggle.setAttribute("aria-pressed", String(cameraFlipForChannel(channel)[axis]));
        toggle.disabled = isLocked;
    }
}

/**
 * Rebuilds the section from state, keeping keyboard focus on the same
 * control. The View menu calls it before it opens; no-op without an open
 * trip and while a camera is being dragged.
 */
export function renderCamerasMenu(): void {
    const section = dom.camerasSection;
    if (drag || !hasCameras()) return;
    const focused = (document.activeElement as HTMLElement | null)?.dataset?.focusKey;
    section.replaceChildren();
    if (hasSeveralCameras()) {
        // The segmented control explains itself; its group carries the
        // "Layout" name for screen readers, and the menu stays one header
        // shorter.
        section.append(header("player.cameras.title"), renderModes(), renderOverlayToggle());
        const list = document.createElement("ul");
        list.className = "cameras-menu__cameras";
        for (const channel of state.composition.order) list.append(renderCameraRow(channel));
        section.append(list, renderAudio());
    }
    section.append(renderFlips());
    if (focused) section.querySelector<HTMLElement>(`[data-focus-key="${focused}"]`)?.focus();
}

/** Keeps the reflection toggles of an open menu current: a toggle press and
 *  the export lock both arrive as export-state changes. */
export function initCamerasMenu(): void {
    subscribeExportState(() => {
        if (!dom.viewMenuPopover.hidden) syncFlipToggles();
    });
}

/* -------------------------------- reordering ------------------------------- */

function rowUnderPoint(x: number, y: number): HTMLElement | null {
    for (const row of dom.camerasSection.querySelectorAll<HTMLElement>(".cameras-menu__camera")) {
        const r = row.getBoundingClientRect();
        if (y >= r.top && y <= r.bottom && x >= r.left && x <= r.right) return row;
    }
    return null;
}

/** Drops an unfinished reorder: the View menu calls it when it closes. */
export function cancelCameraDrag(): void {
    if (!drag) return;
    drag.ghost?.remove();
    for (const row of dom.camerasSection.querySelectorAll(".cameras-menu__camera")) {
        row.classList.remove("is-dragging", "drop-target");
    }
    drag = null;
}

function attachHandleDrag(handle: HTMLElement, channel: Channel, name: string): void {
    attachPointerDrag(handle, {
        onStart: (e) => {
            e.preventDefault();
            drag = { channel, target: null, ghost: null };
            handle.closest(".cameras-menu__camera")?.classList.add("is-dragging");
            return true;
        },
        onMove: (e) => {
            if (!drag) return;
            if (!drag.ghost) {
                drag.ghost = document.createElement("div");
                drag.ghost.className = "tile-drag-ghost";
                drag.ghost.textContent = name;
                document.body.append(drag.ghost);
            }
            drag.ghost.style.left = `${e.clientX + 12}px`;
            drag.ghost.style.top = `${e.clientY + 12}px`;
            const row = rowUnderPoint(e.clientX, e.clientY);
            const target = (row?.dataset.channel as Channel | undefined) ?? null;
            for (const r of dom.camerasSection.querySelectorAll(".cameras-menu__camera")) {
                r.classList.toggle("drop-target", r === row && target !== channel);
            }
            drag.target = target !== channel ? target : null;
        },
        onEnd: (_e, reason) => {
            const target = drag?.target ?? null;
            cancelCameraDrag();
            if (reason === "up" && target) moveCamera(channel, target);
            else renderCamerasMenu();
        },
    });
}
