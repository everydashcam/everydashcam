// Keeps the same live player in native fullscreen or an expanded viewport.
// Browser-owned transitions are immediate; only the surrounding controls move.

import { readLocalStorage, writeLocalStorage } from "../local-storage.js";
import { t } from "../i18n/index.js";
import type { I18nKey } from "../i18n/keys.js";
import { createLogger } from "../log.js";
import { dom, onActivePlayerEvent } from "./dom.js";
import { setExportModePreparation, subscribeExportState } from "./export-state.js";
import { applyMapLayout } from "./map.js";
import { isCoarsePointer, prefersReducedMotion } from "./media-queries.js";
import { isolateBackground } from "./inert-background.js";
import { focusableWithin, isAnyModalOpen } from "./modal-helper.js";
import { notify } from "./notifications.js";
import { state } from "./state.js";
import { setExpandedViewPanels } from "./view-menu.js";

const log = createLogger("player");
const HIDE_DELAY_MS = 1000;
const PANELS_BELOW_STORAGE_KEY = "everydashcam:player:panelsBelow";
const CONTROL_SELECTOR = ".player-bar, .player-chart, .player-readout, .player-fullscreen-actions";
const OPEN_MENU_SELECTOR =
    ".player-speed-menu:not([hidden]), .view-menu-popover:not([hidden]), .overflow-menu:not([hidden]), .player-volume-popover:not([hidden])";
let hideTimer: ReturnType<typeof setTimeout> | null = null;
let motionTimer: ReturnType<typeof setTimeout> | null = null;
let hintTimer: ReturnType<typeof setTimeout> | null = null;
let transition: Promise<boolean> | null = null;
let isViewportExpanded = false;
let hasShownHint = false;
let isPinned = false;
let hasPanelsBelow = false;
let shouldRestoreFocus = true;
let savedFocus: HTMLElement | null = null;
let savedScroll: { element: Element; left: number; top: number }[] = [];
let releaseBackground: (() => void) | null = null;
const hoveredControls = new Set<Element>();
const activePointers = new Set<number>();

function isExpanded(): boolean {
    return dom.playerWrap.classList.contains("player-expanded");
}

function canUseNativeFullscreen(): boolean {
    return typeof dom.playerWrap.requestFullscreen === "function" && document.fullscreenEnabled === true;
}

function clearHideTimer(): void {
    if (hideTimer !== null) clearTimeout(hideTimer);
    hideTimer = null;
}

function revealControls(): void {
    if (!isExpanded()) return;
    dom.playerWrap.classList.add("controls-visible");
    clearHideTimer();
    scheduleHideControls();
}

function scheduleHideControls(): void {
    if (hideTimer !== null) return;
    if (!isExpanded() || hasPanelsBelow || isPinned || dom.player.paused || dom.player.ended) return;
    hideTimer = setTimeout(() => {
        hideTimer = null;
        if (!isExpanded()) return;
        const focused = document.activeElement;
        const hasKeyboardFocus =
            focused instanceof HTMLElement && focused.matches(":focus-visible") && dom.playerWrap.contains(focused);
        if (
            hasPanelsBelow ||
            isPinned ||
            dom.player.paused ||
            dom.player.ended ||
            hoveredControls.size ||
            activePointers.size ||
            hasKeyboardFocus ||
            isAnyModalOpen() ||
            dom.playerWrap.querySelector(OPEN_MENU_SELECTOR)
        ) {
            scheduleHideControls();
            return;
        }
        dom.playerWrap.classList.remove("controls-visible");
    }, HIDE_DELAY_MS);
}

function showHint(key: I18nKey, delay = 3000): void {
    const hint = document.getElementById("player-fullscreen-hint");
    if (!hint) return;
    if (hintTimer !== null) clearTimeout(hintTimer);
    hint.textContent = t(key);
    hint.hidden = false;
    hintTimer = setTimeout(() => {
        hint.hidden = true;
        hintTimer = null;
    }, delay);
}

function saveViewerContext(focusReturn?: HTMLElement): void {
    savedFocus = focusReturn ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    savedScroll = [];
    for (let element: Element | null = dom.playerWrap.parentElement; element; element = element.parentElement) {
        savedScroll.push({ element, left: element.scrollLeft, top: element.scrollTop });
    }
    shouldRestoreFocus = true;
}

function fullscreenEntryFocusTarget(): HTMLElement {
    return dom.playerBar.fullscreen.offsetParent !== null
        ? dom.playerBar.fullscreen
        : (document.getElementById("player-overflow") ?? dom.playerBar.play);
}

function isolateViewportPlayer(): void {
    releaseBackground?.();
    // Dialog roots are adopted into the visible player by the modal manager.
    releaseBackground = isolateBackground(dom.playerWrap, (element) => element.matches(".modal-overlay"));
}

function syncExpandedState(expanded: boolean): void {
    if (expanded === isExpanded()) return;
    if (motionTimer !== null) clearTimeout(motionTimer);
    clearHideTimer();
    hoveredControls.clear();
    activePointers.clear();
    dom.playerWrap.classList.remove("fullscreen-entering", "fullscreen-leaving");
    dom.playerWrap.classList.toggle("player-expanded", expanded);
    dom.playerWrap.classList.toggle("player-panels-below", expanded && hasPanelsBelow);
    dom.playerWrap.classList.toggle("player-viewport", expanded && isViewportExpanded);
    document.body.classList.toggle("has-expanded-player", expanded);
    dom.playerWrap.classList.toggle("controls-visible", expanded);
    syncFullscreenButton();
    setExpandedViewPanels(expanded);
    if (expanded) {
        if (isViewportExpanded) isolateViewportPlayer();
        if (!hasShownHint && !isCoarsePointer()) {
            showHint("player.fullscreen.hint");
            hasShownHint = true;
        }
        if (
            document.activeElement === dom.playerBar.fullscreen ||
            document.activeElement?.closest("#player-overflow-menu") ||
            !dom.playerWrap.contains(document.activeElement)
        ) {
            dom.playerBar.fullscreenExit.focus({ preventScroll: true });
        }
        scheduleHideControls();
    } else {
        if (hintTimer !== null) clearTimeout(hintTimer);
        hintTimer = null;
        const hint = document.getElementById("player-fullscreen-hint");
        if (hint) hint.hidden = true;
        releaseBackground?.();
        releaseBackground = null;
        for (const { element, left, top } of savedScroll) {
            element.scrollLeft = left;
            element.scrollTop = top;
        }
        savedScroll = [];
    }
    if (!prefersReducedMotion()) {
        const motionClass = expanded ? "fullscreen-entering" : "fullscreen-leaving";
        dom.playerWrap.classList.add(motionClass);
        motionTimer = setTimeout(
            () => {
                dom.playerWrap.classList.remove(motionClass);
                motionTimer = null;
            },
            expanded ? 220 : 160,
        );
    }
    applyMapLayout();
    document.dispatchEvent(new Event("playerexpansionchange"));
    if (!expanded) {
        if (shouldRestoreFocus && !isAnyModalOpen()) {
            const target =
                savedFocus?.isConnected && savedFocus.offsetParent !== null ? savedFocus : fullscreenEntryFocusTarget();
            target.focus({ preventScroll: true });
        }
        savedFocus = null;
    }
}

function runTransition(action: () => Promise<boolean>): Promise<boolean> {
    const pending = action().finally(() => {
        transition = null;
        syncFullscreenButton();
    });
    transition = pending;
    syncFullscreenButton();
    return pending;
}

function exitExpandedPlayer(restoreFocus = true): Promise<boolean> {
    if (transition) return transition.then(() => exitExpandedPlayer(restoreFocus));
    if (!isExpanded()) return Promise.resolve(true);
    shouldRestoreFocus = restoreFocus;
    return runTransition(async () => {
        try {
            if (document.fullscreenElement === dom.playerWrap) await document.exitFullscreen();
            isViewportExpanded = false;
            syncExpandedState(false);
            return true;
        } catch (error) {
            log.warn("fullscreen exit failed", { error: error instanceof Error ? error.message : String(error) });
            revealControls();
            showHint("player.fullscreen.exitError", 6000);
            return false;
        }
    });
}

export async function toggleFullscreen(focusReturn?: HTMLElement): Promise<void> {
    if (transition) return;
    if (isExpanded()) {
        await exitExpandedPlayer();
        return;
    }
    if (!state.active || isAnyModalOpen()) return;
    saveViewerContext(focusReturn);
    await runTransition(async () => {
        try {
            if (canUseNativeFullscreen()) {
                // The request must retain the triggering user activation.
                await dom.playerWrap.requestFullscreen();
                syncExpandedState(document.fullscreenElement === dom.playerWrap);
            } else {
                // iPhone may lack container fullscreen. Keep every camera and
                // custom control in the available viewport without hiding Safari.
                isViewportExpanded = true;
                syncExpandedState(true);
            }
            return isExpanded();
        } catch (error) {
            savedFocus = null;
            savedScroll = [];
            log.warn("fullscreen entry failed", { error: error instanceof Error ? error.message : String(error) });
            notify({ severity: "warn", messageKey: "player.fullscreen.error" });
            return false;
        }
    });
}

export function syncFullscreenButton(): void {
    const expanded = isExpanded();
    const native = canUseNativeFullscreen();
    const label = t(native ? "player.fullscreen.enter" : "player.fullscreen.expand");
    const button = dom.playerBar.fullscreen;
    button.setAttribute("aria-label", label);
    button.title = label;
    button.hidden = expanded;
    button.disabled = !state.active;
    button.setAttribute("aria-busy", String(transition !== null));
    const exit = dom.playerBar.fullscreenExit;
    const exitLabel = t(isViewportExpanded ? "player.fullscreen.restore" : "player.fullscreen.exit");
    exit.setAttribute("aria-label", exitLabel);
    exit.title = exitLabel;
    exit.setAttribute("aria-busy", String(transition !== null));
    const text = exit.querySelector(".fullscreen-label");
    if (text) text.textContent = t("player.fullscreen.exitShort");
    const key = exit.querySelector<HTMLElement>(".fullscreen-key");
    if (key) key.hidden = isCoarsePointer();
    const pin = document.getElementById("player-controls-pin");
    if (pin) {
        pin.hidden = !expanded || hasPanelsBelow;
        pin.setAttribute("aria-label", t("player.controls.pin"));
        pin.setAttribute("aria-pressed", String(isPinned));
        pin.title = t("player.controls.pin");
    }
    const panelsBelow = document.querySelector<HTMLElement>("[data-fullscreen-panels-below]");
    if (panelsBelow) {
        panelsBelow.hidden = !expanded;
        panelsBelow.setAttribute("aria-checked", String(hasPanelsBelow));
    }
}

export function initPlayerFullscreen(): void {
    hasPanelsBelow = readLocalStorage(PANELS_BELOW_STORAGE_KEY) === "1";
    dom.playerBar.fullscreen.addEventListener("click", () => {
        // Overflow forwards clicks without focusing the hidden toolbar button.
        void toggleFullscreen(fullscreenEntryFocusTarget());
    });
    dom.playerBar.fullscreenExit.addEventListener("click", () => void toggleFullscreen());
    document.getElementById("player-controls-pin")?.addEventListener("click", () => {
        isPinned = !isPinned;
        syncFullscreenButton();
        revealControls();
    });
    const panelsBelow = document.querySelector<HTMLElement>("[data-fullscreen-panels-below]");
    panelsBelow?.addEventListener("click", () => {
        if (!isExpanded()) return;
        panelsBelow.focus({ preventScroll: true });
        hasPanelsBelow = !hasPanelsBelow;
        writeLocalStorage(PANELS_BELOW_STORAGE_KEY, hasPanelsBelow ? "1" : "0");
        dom.playerWrap.classList.toggle("player-panels-below", hasPanelsBelow);
        syncFullscreenButton();
        revealControls();
        applyMapLayout();
    });
    setExportModePreparation(() => (isExpanded() || transition ? exitExpandedPlayer(false) : null));
    subscribeExportState(syncFullscreenButton);
    document.addEventListener("fullscreenchange", () => {
        if (!isViewportExpanded) syncExpandedState(document.fullscreenElement === dom.playerWrap);
    });
    document.addEventListener("keydown", (event) => {
        if (!isExpanded() || isAnyModalOpen() || event.defaultPrevented) return;
        if (!event.ctrlKey && !event.metaKey && !event.altKey) revealControls();
        if (event.key === "Escape" && isViewportExpanded) {
            // Overflow installs its dismiss listener when opened, after this
            // one. Let that first Escape close the menu before leaving view.
            if (dom.playerWrap.querySelector(".overflow-menu:not([hidden])")) return;
            event.preventDefault();
            void exitExpandedPlayer();
        }
        if (event.key !== "Tab") return;
        revealControls();
        if (!isViewportExpanded) return;
        const controls = focusableWithin(dom.playerWrap);
        const first = controls[0];
        const last = controls[controls.length - 1];
        if (event.shiftKey && (document.activeElement === first || !dom.playerWrap.contains(document.activeElement))) {
            event.preventDefault();
            last?.focus();
        } else if (
            !event.shiftKey &&
            (document.activeElement === last || !dom.playerWrap.contains(document.activeElement))
        ) {
            event.preventDefault();
            first?.focus();
        }
    });
    dom.playerWrap.addEventListener("pointermove", (event) => {
        if (event.pointerType === "mouse") revealControls();
    });
    dom.playerWrap.addEventListener("focusin", (event) => {
        if (event.target instanceof Element && event.target.closest(CONTROL_SELECTOR)) revealControls();
    });
    dom.playerWrap.addEventListener("focusout", scheduleHideControls);
    let shouldRevealTouch = false;
    dom.playerWrap.addEventListener(
        "pointerdown",
        (event) => {
            shouldRevealTouch =
                event.pointerType !== "mouse" && isExpanded() && !dom.playerWrap.classList.contains("controls-visible");
        },
        true,
    );
    dom.playerWrap.addEventListener(
        "click",
        (event) => {
            if (!shouldRevealTouch || event.detail === 0 || !isExpanded() || isAnyModalOpen()) return;
            shouldRevealTouch = false;
            event.stopPropagation();
            event.preventDefault();
            revealControls();
        },
        true,
    );
    for (const control of dom.playerWrap.querySelectorAll<HTMLElement>(CONTROL_SELECTOR)) {
        control.addEventListener("pointerenter", (event) => {
            if (event.pointerType !== "mouse") return;
            hoveredControls.add(control);
            revealControls();
        });
        control.addEventListener("pointerleave", () => {
            hoveredControls.delete(control);
            scheduleHideControls();
        });
        control.addEventListener("pointerdown", (event) => {
            if (!isExpanded()) return;
            activePointers.add(event.pointerId);
            revealControls();
        });
    }
    const releasePointer = (event: PointerEvent): void => {
        if (activePointers.delete(event.pointerId)) scheduleHideControls();
    };
    document.addEventListener("pointerup", releasePointer);
    document.addEventListener("pointercancel", releasePointer);
    // Automatic clip and preload-slot changes are not user activity. Keep the
    // idle deadline across them, and reveal only once playback really stops.
    onActivePlayerEvent("play", scheduleHideControls);
    for (const event of ["pause", "ended"] as const) {
        onActivePlayerEvent(event, () => {
            requestAnimationFrame(() => {
                if (dom.player.paused || dom.player.ended) revealControls();
            });
        });
    }
    syncFullscreenButton();
}
