// Shared modal a11y manager. Modals keep their own show/hide DOM mechanics
// (some toggle [hidden], some toggle an .is-open class, some custom-render);
// this module owns the cross-cutting concerns that were previously duplicated
// (or missing) per dialog:
//   - body scroll-lock while any modal is open (released when the last closes);
//   - focus-trap: Tab/Shift+Tab cycle within the topmost modal;
//   - focus restore when the foreground dialog closes; background completion
//     only updates the return path and never steals focus;
//   - one Escape handler for the foreground dialog's own dismissal policy.
//
// Usage: call activateModal(el, { onClose, initialFocus }) right after the
// modal becomes visible, and deactivateModal(el) right after it is hidden.
// onClose handles Escape; a busy dialog may keep working instead of closing.

import { tabbable } from "tabbable";
import { isolateBackground } from "./inert-background.js";
import { closeActivePopover } from "./popover-lifecycle.js";

interface ModalEntry {
    el: HTMLElement;
    layer: number;
    onClose: () => void;
    savedFocus: HTMLElement | SVGElement | null;
    /** Original position before joining the shared modal host, restored on close. */
    home: { parent: Node; next: Node | null } | null;
}

// Topmost = last. Order follows the CSS layers of the fixed dialog roots, which
// share body (or the expanded player) as their stacking context. Equal layers
// follow opening order because active roots are appended to that shared host.
// Scroll-lock is released only when the last closes.
const stack: ModalEntry[] = [];
let keydownBound = false;

let releaseBackground: (() => void) | null = null;

export function focusableWithin(el: HTMLElement): (HTMLElement | SVGElement)[] {
    return tabbable(el);
}

function syncModalBackground(): void {
    releaseBackground?.();
    const top = stack.at(-1);
    releaseBackground = top ? isolateBackground(top.el) : null;
}

/** True while at least one modal is tracked (open). Feature-level global
 *  keydown listeners (player hotkeys, view-menu) consult this to stay inert
 *  under an open modal: the capture-phase trap only swallows Escape/Tab, so
 *  without this guard letter shortcuts (F/U/S/E, C/T/M) would fire on the
 *  player/panels behind the backdrop. */
export function isAnyModalOpen(): boolean {
    return stack.length > 0;
}

function onKeydown(ev: KeyboardEvent): void {
    const top = stack[stack.length - 1];
    if (!top) return;

    if (ev.key === "Escape") {
        // stopPropagation so a single Escape does not also reach feature-level
        // listeners (player hotkeys, etc.) underneath the modal.
        ev.preventDefault();
        ev.stopPropagation();
        top.onClose();
        return;
    }

    if (ev.key !== "Tab") return;
    const focusable = focusableWithin(top.el);
    if (focusable.length === 0) {
        // Nothing focusable inside - keep focus pinned on the modal root so Tab
        // cannot escape to the page behind the backdrop.
        ev.preventDefault();
        top.el.focus();
        return;
    }
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    const active = document.activeElement;
    if (ev.shiftKey) {
        if (active === first || !top.el.contains(active)) {
            ev.preventDefault();
            last.focus();
        }
    } else if (active === last || !top.el.contains(active)) {
        ev.preventDefault();
        first.focus();
    }
}

/**
 * Activates a11y management for a now-visible modal. Saves the current focus,
 * locks body scroll (first modal only), and moves focus inside - to
 * initialFocus if given, else the first focusable element, else the modal root
 * (which must be focusable, e.g. tabindex="-1", for the trap to hold).
 * CSS z-index owns the layer order: opening background work beneath a visible
 * dialog preserves that dialog's keyboard ownership and focus return path.
 */
export function activateModal(el: HTMLElement, opts: { onClose: () => void; initialFocus?: HTMLElement | null }): void {
    // Re-activating an already-tracked modal is a no-op (idempotent open).
    if (stack.some((e) => e.el === el)) return;

    if (!keydownBound) {
        // Capture phase so the trap/Escape run before feature-level handlers.
        document.addEventListener("keydown", onKeydown, true);
        document.addEventListener("fullscreenchange", syncModalParents);
        document.addEventListener("playerexpansionchange", syncModalParents);
        const children = new MutationObserver((records) => {
            const top = stack.at(-1);
            if (top && records.some((record) => record.target instanceof Element && record.target.contains(top.el))) {
                syncModalBackground();
            }
        });
        children.observe(document.body, { childList: true, subtree: true });
        keydownBound = true;
    }

    closeActivePopover();
    const focused = document.activeElement;
    const savedFocus = focused instanceof HTMLElement || focused instanceof SVGElement ? focused : null;
    if (stack.length === 0) document.body.style.overflow = "hidden";
    const home = adoptIntoModalHost(el);
    const entry: ModalEntry = {
        el,
        layer: Number.parseInt(getComputedStyle(el).zIndex, 10) || 0,
        onClose: opts.onClose,
        savedFocus,
        home,
    };
    // Release the previous foreground's isolation before inspecting a dialog
    // that may itself currently be inert in the background.
    releaseBackground?.();
    releaseBackground = null;
    const target = opts.initialFocus ?? focusableWithin(el)[0] ?? el;
    const foregroundIndex = stack.findIndex((other) => other.layer > entry.layer);
    if (foregroundIndex !== -1) {
        // Splice background work into the first higher dialog's return path;
        // later dialogs retain their existing chain back to that foreground.
        const foreground = stack[foregroundIndex]!;
        entry.savedFocus = foreground.savedFocus;
        foreground.savedFocus = target;
        stack.splice(foregroundIndex, 0, entry);
        syncModalBackground();
        return;
    }
    stack.push(entry);
    syncModalBackground();

    // preventScroll: several modals put initialFocus on a "Close" button in
    // the card's footer (settings, unsupported-formats). A plain focus()
    // scrolls the focused element into view, so a card taller than the
    // viewport opened scrolled to the bottom. Focus still lands on the
    // button for Escape/Enter; it just doesn't drag the scroll with it.
    target.focus?.({ preventScroll: true });
}

/** Keeps fixed dialog roots in one stacking context and paints equal layers in
 *  opening order. Media fullscreen takes no children; other fullscreen modes
 *  host dialogs inside the player's visible and interactive subtree. */
function adoptIntoModalHost(el: HTMLElement): ModalEntry["home"] {
    const fullscreen = document.fullscreenElement ?? document.querySelector(".player-expanded");
    const host =
        fullscreen instanceof HTMLElement && !(fullscreen instanceof HTMLMediaElement) ? fullscreen : document.body;
    if (!el.parentNode || (el.parentNode === host && el.nextSibling === null)) return null;
    const home = { parent: el.parentNode, next: el.nextSibling };
    host.appendChild(el);
    return home;
}

function restoreModalHome(entry: ModalEntry): void {
    if (!entry.home) return;
    const { parent, next } = entry.home;
    if (next && next.parentNode === parent) parent.insertBefore(entry.el, next);
    else parent.appendChild(entry.el);
    entry.home = null;
}

function syncModalParents(): void {
    const fullscreen = document.fullscreenElement ?? document.querySelector(".player-expanded");
    const host =
        fullscreen instanceof HTMLElement && !(fullscreen instanceof HTMLMediaElement) ? fullscreen : document.body;
    const focused = document.activeElement;
    for (const entry of stack) {
        if (entry.el.parentNode === host) continue;
        restoreModalHome(entry);
        // Appending in stack order preserves same-layer paint order when
        // leaving fullscreen, even if the original markup orders roots otherwise.
        entry.home = adoptIntoModalHost(entry.el);
    }
    syncModalBackground();
    if (focused instanceof HTMLElement && stack.at(-1)?.el.contains(focused)) {
        focused.focus({ preventScroll: true });
    }
}

/**
 * Wires backdrop-click-to-dismiss on the modal root `el`: a click that lands on
 * the backdrop (not inside the card) calls `onClose`. Centralizes the listener
 * every modal used to hand-wire in one of two flavors:
 *   - no cardSelector: close only when the click target IS the root (backdrop is
 *     the root itself, the card is a direct child that catches its own clicks);
 *   - cardSelector given: close when the click is outside the matched card -
 *     needed when wrapper elements sit between the root and the card, so a plain
 *     target===root check would miss backdrop clicks.
 * The listener lives for the element's lifetime (modals are long-lived
 * singletons wired once at init). Escape/focus-trap/scroll-lock stay in
 * activateModal; this is only the pointer-dismiss half.
 */
export function wireBackdropDismiss(el: HTMLElement, onClose: () => void, opts: { cardSelector?: string } = {}): void {
    const { cardSelector } = opts;
    el.addEventListener("click", (ev) => {
        if (cardSelector) {
            if (ev.target instanceof Element && !ev.target.closest(cardSelector)) onClose();
        } else if (ev.target === el) {
            onClose();
        }
    });
}

/**
 * Releases a11y management for a now-hidden modal. Restores body scroll when no
 * modals remain. Closing the topmost dialog restores its saved focus; closing
 * a lower dialog preserves the foreground dialog. No-op if not tracked.
 */
export function deactivateModal(el: HTMLElement): void {
    const idx = stack.findIndex((e) => e.el === el);
    if (idx === -1) return;
    const wasTopmost = idx === stack.length - 1;
    const [entry] = stack.splice(idx, 1);
    // Background work can finish underneath a warning dialog. Keep its focus
    // inside the warning and let that dialog restore the original opener later.
    for (const remaining of stack) {
        if (remaining.savedFocus && el.contains(remaining.savedFocus)) {
            remaining.savedFocus = entry?.savedFocus ?? null;
        }
    }
    if (stack.length === 0) document.body.style.overflow = "";
    // Back to its own place in the document before anything else looks for it
    // there (a later open outside fullscreen, a querySelector on the layout).
    if (entry) restoreModalHome(entry);
    syncModalBackground();
    if (wasTopmost) entry?.savedFocus?.focus?.();
}
