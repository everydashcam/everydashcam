// "Cameras" menu in the player bar: arrangement mode, overlay permission,
// which cameras show and in what order, the main camera and the sound source.
// Shown on trips with several cameras, in viewing and export alike - the
// arrangement is shared, so this is the one place to set it. Every change goes
// through camera-arrangement.ts.
//
// A dialog with native controls rather than a role="menu": it mixes radios,
// checkboxes, a select and drag handles, which menu semantics cannot express.

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
import { dom } from "./dom.js";
import { channelDisplayLabel } from "./format.js";
import { initPlayerPopoverPosition } from "./player-popover.js";
import { attachPointerDrag } from "./pointer-drag.js";
import { createPopover } from "./popover-lifecycle.js";
import { activeTrip, mainChannel, state, visibleChannels } from "./state.js";

let popover: ReturnType<typeof createPopover> | null = null;
// Whether the Cameras button was folded into the overflow menu when the menu
// opened, which decides the button the menu sits by.
let openedFolded = false;
// Row under the pointer while a camera is dragged by its handle.
let drag: { channel: Channel; target: Channel | null; ghost: HTMLElement | null } | null = null;

/** Whether the open trip has cameras to arrange. */
function hasSeveralCameras(): boolean {
    return !!activeTrip() && state.composition.order.length > 1;
}

/** Whether the Cameras button is folded into the overflow menu right now. */
function isFolded(): boolean {
    return dom.camerasWrap.dataset.overflowHidden === "true";
}

function overflowButton(): HTMLElement | null {
    return document.getElementById("player-overflow");
}

export function initCamerasMenu(): void {
    const button = dom.camerasBtn;
    const panel = dom.camerasPopover;
    initPlayerPopoverPosition(() => (isFolded() ? (overflowButton() ?? button) : button), panel);
    popover = createPopover({
        button,
        panel,
        show: () => {
            openedFolded = isFolded();
            renderCamerasMenu();
            panel.hidden = false;
            button.classList.add("is-open");
        },
        hide: () => {
            panel.hidden = true;
            button.classList.remove("is-open");
            endDrag();
            // Back home after an opening from the overflow menu.
            if (panel.parentElement !== dom.camerasWrap) dom.camerasWrap.append(panel);
        },
        afterOpen: () => panel.querySelector<HTMLElement>("input:checked, input, button")?.focus(),
    });
    button.addEventListener("click", (e) => {
        e.stopPropagation();
        popover?.toggle();
    });
    // The menu sits by whichever button opened it; once the Cameras button
    // folds into the overflow menu or comes back, that place is wrong. An
    // overflow pass rewrites the attribute on every bar resize (opening the
    // menu is one), so only a changed outcome counts.
    new MutationObserver(() => {
        if (!panel.hidden && isFolded() !== openedFolded) popover?.close();
    }).observe(dom.camerasWrap, { attributes: true, attributeFilter: ["data-overflow-hidden"] });
    syncCamerasMenu();
}

/**
 * Opens the menu from its overflow-menu entry. The Cameras button is hidden
 * then, so the dialog moves next to the overflow button and opens there.
 */
export function openCamerasMenuFromOverflow(): void {
    const anchorWrap = overflowButton()?.parentElement;
    if (isFolded() && anchorWrap) anchorWrap.append(dom.camerasPopover);
    popover?.open();
}

/**
 * Shows the button on multi-camera trips and refreshes an open menu. Called
 * after every arrangement change and trip switch.
 */
export function syncCamerasMenu(): void {
    const available = hasSeveralCameras();
    dom.camerasWrap.hidden = !available;
    if (!available) {
        popover?.close();
        return;
    }
    if (!dom.camerasPopover.hidden) renderCamerasMenu();
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
        option.addEventListener("keydown", (e) => {
            if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
            e.preventDefault();
            e.stopPropagation();
            setArrangementMode(mode === "main" ? "equal" : "main");
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

/** Rebuilds the menu from state, keeping keyboard focus on the same control. */
export function renderCamerasMenu(): void {
    const panel = dom.camerasPopover;
    if (drag) return;
    const focused = (document.activeElement as HTMLElement | null)?.dataset?.focusKey;
    panel.replaceChildren();
    panel.append(header("player.cameras.mode.label"), renderModes(), renderOverlayToggle());
    panel.append(header("player.cameras.title"));
    const list = document.createElement("ul");
    list.className = "cameras-menu__cameras";
    for (const channel of state.composition.order) list.append(renderCameraRow(channel));
    panel.append(list, renderAudio());
    const help = document.createElement("button");
    help.type = "button";
    help.className = "view-menu-row feedback-link";
    help.dataset.feedbackPreset = "cameras";
    help.textContent = t("recognition.cameras.help");
    help.addEventListener("click", () => popover?.close(true));
    panel.append(help);
    if (focused) panel.querySelector<HTMLElement>(`[data-focus-key="${focused}"]`)?.focus();
}

/* -------------------------------- reordering ------------------------------- */

function rowUnderPoint(x: number, y: number): HTMLElement | null {
    for (const row of dom.camerasPopover.querySelectorAll<HTMLElement>(".cameras-menu__camera")) {
        const r = row.getBoundingClientRect();
        if (y >= r.top && y <= r.bottom && x >= r.left && x <= r.right) return row;
    }
    return null;
}

function endDrag(): void {
    if (!drag) return;
    drag.ghost?.remove();
    for (const row of dom.camerasPopover.querySelectorAll(".cameras-menu__camera")) {
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
            for (const r of dom.camerasPopover.querySelectorAll(".cameras-menu__camera")) {
                r.classList.toggle("drop-target", r === row && target !== channel);
            }
            drag.target = target !== channel ? target : null;
        },
        onEnd: (_e, reason) => {
            const target = drag?.target ?? null;
            endDrag();
            if (reason === "up" && target) moveCamera(channel, target);
            else renderCamerasMenu();
        },
    });
}
