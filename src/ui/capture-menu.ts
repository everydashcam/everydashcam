// Still-image menu of the capture button: save what the player shows, copy it
// to the clipboard, or save one camera's whole picture. S and Shift+S save
// and copy without the menu. With a single choice (one camera, no clipboard)
// the button saves at once instead of opening a one-row menu. When the bar is
// narrow the button folds into the overflow menu, and its entry opens this
// menu next to the overflow button (like the Cameras menu).

import { t } from "../i18n/index.js";
import type { I18nKey } from "../i18n/keys.js";
import type { Channel } from "../parsers/types.js";
import { dom } from "./dom.js";
import { channelDisplayLabel } from "./format.js";
import { initMenuKeyboard } from "./menu-keyboard.js";
import { canCopyStill, type StillContent, type StillDelivery } from "./player-capture.js";
import { initPlayerPopoverPosition } from "./player-popover.js";
import { isCameraOnGrid } from "./player-zoom.js";
import { createPopover } from "./popover-lifecycle.js";
import { activeTrip, visibleChannels } from "./state.js";

/** Takes a still; supplied by the playback core, which owns the trip clock. */
export type TakeStill = (content: StillContent, delivery: StillDelivery) => void;

/** One menu entry: a section header or an action. */
type CaptureMenuEntry =
    | { kind: "header"; key: I18nKey }
    | { kind: "action"; label: string; hint: string | null; content: StillContent; delivery: StillDelivery };

let popover: ReturnType<typeof createPopover> | null = null;
let takeStill: TakeStill | null = null;
// Whether the button was folded into the overflow menu when the menu opened,
// which decides the button the menu sits by.
let openedFolded = false;

const VIEW: StillContent = { kind: "view" };

function isFolded(): boolean {
    return dom.playerBar.captureWrap.dataset.overflowHidden === "true";
}

function overflowButton(): HTMLElement | null {
    return document.getElementById("player-overflow");
}

/** What the menu offers now: the cameras on screen and their names change
 *  with the trip and the arrangement, so it is rebuilt on every opening. */
function captureMenuEntries(): CaptureMenuEntry[] {
    const entries: CaptureMenuEntry[] = [
        { kind: "action", label: t("player.captureMenu.save"), hint: "S", content: VIEW, delivery: "download" },
    ];
    if (canCopyStill()) {
        entries.push({
            kind: "action",
            label: t("player.captureMenu.copy"),
            hint: "Shift+S",
            content: VIEW,
            delivery: "clipboard",
        });
    }
    const trip = activeTrip();
    const cameras: Channel[] = visibleChannels().filter(isCameraOnGrid);
    if (trip && cameras.length > 1) {
        entries.push({ kind: "header", key: "player.captureMenu.oneCamera" });
        for (const channel of cameras) {
            entries.push({
                kind: "action",
                label: channelDisplayLabel(channel, trip),
                hint: null,
                content: { kind: "camera", channel },
                delivery: "download",
            });
        }
    }
    return entries;
}

/**
 * Opens the menu, or takes the still right away when saving is the only
 * choice. Runs inside the click, so a later clipboard write keeps its user
 * activation either way.
 */
function openOrSave(): void {
    if (dom.playerBar.capture.disabled) return;
    const actions = captureMenuEntries().filter((entry) => entry.kind === "action");
    if (actions.length === 1 && actions[0]) {
        takeStill?.(actions[0].content, actions[0].delivery);
        return;
    }
    popover?.open();
}

export function initCaptureMenu(take: TakeStill): void {
    takeStill = take;
    const button = dom.playerBar.capture;
    const panel = dom.playerBar.captureMenu;
    initPlayerPopoverPosition(() => (isFolded() ? (overflowButton() ?? button) : button), panel);
    popover = createPopover({
        button,
        panel,
        show: () => {
            openedFolded = isFolded();
            renderCaptureMenu();
            panel.hidden = false;
            button.classList.add("is-open");
        },
        hide: () => {
            panel.hidden = true;
            button.classList.remove("is-open");
            // Back home after an opening from the overflow menu.
            if (panel.parentElement !== dom.playerBar.captureWrap) dom.playerBar.captureWrap.append(panel);
        },
        afterOpen: () => panel.querySelector<HTMLElement>("[role=menuitem]")?.focus(),
    });
    const close = (): void => popover?.close(true);
    button.addEventListener("click", (e) => {
        e.stopPropagation();
        if (popover?.isOpen) popover.close();
        else openOrSave();
    });
    initMenuKeyboard({ button, menu: panel, itemSelector: "[role=menuitem]", onOpen: openOrSave, onClose: close });
    // The menu sits by whichever button opened it; once the button folds into
    // the overflow menu or comes back, that place is wrong.
    new MutationObserver(() => {
        if (!panel.hidden && isFolded() !== openedFolded) popover?.close();
    }).observe(dom.playerBar.captureWrap, { attributes: true, attributeFilter: ["data-overflow-hidden"] });
    // syncCaptureButton disables the button when there is nothing to capture
    // (trip closed, unplayable video); an open menu goes with it.
    new MutationObserver(() => {
        if (dom.playerBar.capture.disabled) popover?.close();
    }).observe(dom.playerBar.capture, { attributes: true, attributeFilter: ["disabled"] });
}

/** Opens the menu from its overflow-menu entry, next to the overflow button. */
export function openCaptureMenuFromOverflow(): void {
    const anchorWrap = overflowButton()?.parentElement;
    if (isFolded() && anchorWrap) anchorWrap.append(dom.playerBar.captureMenu);
    openOrSave();
}

function menuRow(entry: Extract<CaptureMenuEntry, { kind: "action" }>, take: TakeStill): HTMLButtonElement {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "view-menu-row";
    row.setAttribute("role", "menuitem");
    row.tabIndex = -1;
    const text = document.createElement("span");
    text.className = "view-menu-row__label";
    text.textContent = entry.label;
    row.append(text);
    if (entry.hint) {
        const kbd = document.createElement("span");
        kbd.className = "view-menu-row__hint mono";
        kbd.textContent = entry.hint;
        row.append(kbd);
    }
    // The clipboard write must start inside this click to keep its user
    // activation, so the action runs before the menu closes.
    row.addEventListener("click", (e) => {
        e.stopPropagation();
        take(entry.content, entry.delivery);
        popover?.close(true);
    });
    return row;
}

function header(key: I18nKey): HTMLElement {
    const el = document.createElement("div");
    el.className = "view-menu-popover__header";
    el.textContent = t(key);
    return el;
}

function renderCaptureMenu(): void {
    const take = takeStill;
    if (!take) return;
    dom.playerBar.captureMenu.replaceChildren(
        ...captureMenuEntries().map((entry) => (entry.kind === "header" ? header(entry.key) : menuRow(entry, take))),
    );
}
