// In-session notifications: toasts + bell drawer. Single store, two views.
//
// Use case:
//   notify({ severity: "warn", messageKey: "recognition.files.body", messageParams: { n: 3 } });
//
// Behavior:
//   - A toast slides in top-right with the severity icon and message.
//   - The same notification is appended to the bell drawer (top of list).
//   - Info/warn auto-dismiss after a timeout; error toasts stay until the
//     user clicks the close button. The bell drawer keeps everything until
//     the user clears it or the page reloads.
//   - The bell icon stays hidden while there is nothing to list; the red dot
//     marks unread items. Opening the drawer marks everything read.
//   - A pinned status line (setPinnedStatus) reflects a standing fact rather
//     than an event: no toast, listed above the history, untouched by "Clear
//     all" and by the history limit, removed only by its owner.
//
// Replaces the old #status text in the topbar, which mixed progress with
// final warnings and stuck them in a tiny mono font that scrolled off in
// narrow PWA windows.

import { tabbable } from "tabbable";
import { createPopover } from "./popover-lifecycle.js";
import { t } from "../i18n/index.js";
import type { I18nKey } from "../i18n/keys.js";
import { createLogger } from "../log.js";
import { X_ICON_PATHS, buildLucideIcon } from "./icons.js";

const log = createLogger("notifications");

export type Severity = "info" | "warn" | "error";

export interface NotifyInput {
    severity: Severity;
    messageKey: I18nKey;
    /** ICU MessageFormat parameters; merged into the template at render time. */
    messageParams?: Record<string, string | number | boolean>;
    /** Optional action button on the toast. */
    actionKey?: I18nKey;
    onAction?: () => void;
    /** Opt in only for actions that revalidate their state when invoked. */
    actionInDrawer?: boolean;
    /** Separates identical messages whose actions belong to different sources. */
    dedupKey?: string;
}

interface Notification extends NotifyInput {
    id: string;
    timestamp: number;
    read: boolean;
    /** severity|key|params signature, used to collapse identical bursts. */
    sig: string;
}

/** Stable signature for de-duplicating identical notifications. */
function notifSignature(input: NotifyInput): string {
    return `${input.severity}|${input.messageKey}|${JSON.stringify(input.messageParams ?? {})}|${input.actionKey ?? ""}|${input.actionInDrawer === true}|${input.dedupKey ?? ""}`;
}

// Newest first. Capped to keep the drawer from growing unboundedly in long
// sessions (one entry every ~few seconds for ingest progress would have been
// a memory problem; we don't push progress here, but bound anyway).
const MAX_ENTRIES = 50;
const notifications: Notification[] = [];

// Toast auto-dismiss timeouts per severity. Errors stay until manually
// dismissed - the user must acknowledge.
const TOAST_TIMEOUT_MS: Record<Severity, number | null> = {
    info: 5000,
    warn: 8000,
    error: null,
};

// A toast carrying an action needs reading time PLUS deciding time - the
// default info window is gone before the user reaches the button.
const ACTION_TOAST_TIMEOUT_MS = 15000;

function toastTimeoutFor(n: Notification): number | null {
    if (n.actionKey && n.onAction) return ACTION_TOAST_TIMEOUT_MS;
    return TOAST_TIMEOUT_MS[n.severity];
}

// Toast stack cap on screen. Extra toasts are not queued - they live only
// in the bell drawer history. Avoids a wall of toasts on slow recovery
// scenarios (e.g. burst of errors). 3 is a typical Material Design ceiling.
const TOAST_STACK_LIMIT = 3;

/** A standing line at the top of the drawer, owned by the module that sets it. */
export interface PinnedStatusInput {
    severity: Severity;
    messageKey: I18nKey;
    actionKey: I18nKey;
    onAction: () => void;
    /** Identifies the news the line carries. Opening the drawer marks this
     *  revision read; only a different revision lights the dot again. */
    revision: number;
}

// Insertion order is display order.
const pinnedStatuses = new Map<string, PinnedStatusInput>();
const readPinnedRevisions = new Map<string, number>();

// Each notification's toast lifecycle is tracked here so dismissAll can
// tear them down cleanly. The DOM element is the key.
const activeToasts: Map<string, { el: HTMLElement; timer: number | null }> = new Map();

let bellBtn: HTMLButtonElement | null = null;
let bellDot: HTMLSpanElement | null = null;
let drawerEl: HTMLElement | null = null;
let drawerList: HTMLElement | null = null;
let toastContainer: HTMLElement | null = null;
let notificationModal: HTMLElement | null = null;

/** Toast controls belong to the active dialog's focus and accessibility tree. */
export function setNotificationModal(modal: HTMLElement | null): void {
    notificationModal = modal;
    syncToastHost();
}

function syncToastHost(): void {
    if (!toastContainer) return;
    const fullscreen = document.fullscreenElement ?? document.querySelector(".player-expanded");
    const host =
        notificationModal ??
        (fullscreen instanceof HTMLElement && !(fullscreen instanceof HTMLMediaElement) ? fullscreen : document.body);
    if (toastContainer.parentElement === host) return;
    const focused = document.activeElement;
    const restoreFocus = focused instanceof HTMLElement && toastContainer.contains(focused);
    host.appendChild(toastContainer);
    if (restoreFocus) focused.focus({ preventScroll: true });
}

let drawerPopover: ReturnType<typeof createPopover> | null = null;
let drawerOpen = false;
// Tiny incrementing counter is sufficient for id generation - we only need
// uniqueness within one page load.
let idCounter = 0;
function makeId(): string {
    idCounter++;
    return `n${idCounter}`;
}

// --- Public API ---

/**
 * Adds a notification. Surfaces a toast and appends to the bell drawer.
 * Safe to call before initNotifications - the entry is queued in the
 * store; UI catches up when init runs.
 */
export function notify(input: NotifyInput): void {
    const sig = notifSignature(input);
    // Collapse a burst of identical notifications: if one is still on screen,
    // refresh its toast timer instead of stacking a visual duplicate and a
    // second drawer entry. Distinct events separated in time still each show
    // (their earlier toast has already auto-dismissed).
    if (bellBtn && toastContainer && drawerList) {
        for (const id of activeToasts.keys()) {
            const existing = notifications.find((x) => x.id === id);
            if (existing && existing.sig === sig) {
                existing.timestamp = Date.now();
                // Move it back to the front: the drawer renders newest-first, so
                // a refreshed timestamp without reordering would leave a repeated
                // notification stuck at its old (now out-of-order) position.
                const idx = notifications.indexOf(existing);
                if (idx > 0) {
                    notifications.splice(idx, 1);
                    notifications.unshift(existing);
                    renderDrawerList();
                }
                resetToastTimer(id);
                return;
            }
        }
    }
    const n: Notification = {
        ...input,
        id: makeId(),
        sig,
        timestamp: Date.now(),
        read: false,
    };
    notifications.unshift(n);
    if (notifications.length > MAX_ENTRIES) {
        // Do not evict entries whose toast is still on screen (error toasts
        // persist until dismissed): an orphaned toast loses live
        // re-localization, dedup and timer reset, while activeToasts still
        // tracks it. Evict from the tail skipping those.
        for (let i = notifications.length - 1; i >= 0 && notifications.length > MAX_ENTRIES; i--) {
            const candidate = notifications[i]!;
            if (activeToasts.has(candidate.id)) continue;
            notifications.splice(i, 1);
        }
    }
    log.debug("notify", { severity: n.severity, key: n.messageKey });
    // Defer UI work until DOM is available.
    if (bellBtn && toastContainer && drawerList) {
        showToast(n);
        syncBellVisibility();
        renderDrawerList();
        renderBellBadge();
    }
}

/**
 * Shows or replaces the pinned status line `id`, or removes it when `input` is
 * null. The line raises no toast; the dot lights when its revision has not
 * been seen in an open drawer. Safe to call before initNotifications.
 */
export function setPinnedStatus(id: string, input: PinnedStatusInput | null): void {
    if (input) pinnedStatuses.set(id, input);
    else if (!pinnedStatuses.delete(id)) return;
    if (bellBtn && drawerList) {
        syncBellVisibility();
        renderDrawerList();
        renderBellBadge();
    }
}

/**
 * Initializes UI bindings. Idempotent; must be called exactly once from
 * app.ts after the DOM is parsed. Renders any notifications that arrived
 * before init (unlikely, but harmless).
 */
export function initNotifications(): void {
    bellBtn = document.getElementById("notif-bell") as HTMLButtonElement | null;
    bellDot = document.getElementById("notif-bell-dot") as HTMLSpanElement | null;
    drawerEl = document.getElementById("notif-drawer");
    drawerList = document.getElementById("notif-drawer-list");
    toastContainer = document.getElementById("toast-container");

    if (!bellBtn || !drawerEl || !drawerList || !toastContainer) {
        log.warn("notifications DOM nodes missing - check index.html");
        return;
    }

    document.addEventListener("fullscreenchange", syncToastHost);
    document.addEventListener("playerexpansionchange", syncToastHost);
    syncToastHost();

    bellBtn.addEventListener("click", toggleDrawer);

    drawerPopover = createPopover({
        button: bellBtn,
        panel: drawerEl,
        contains: (target) => document.getElementById("notif-drawer-card")?.contains(target) ?? false,
        show: () => {
            drawerEl!.hidden = false;
            drawerOpen = true;
        },
        hide: () => {
            drawerEl!.hidden = true;
            drawerOpen = false;
        },
    });

    document.getElementById("notif-drawer-clear")?.addEventListener("click", clearAll);

    // Catch up if anything fired before init.
    if (notifications.length > 0 || pinnedStatuses.size > 0) {
        syncBellVisibility();
        renderBellBadge();
        renderDrawerList();
    }
}

// --- Toast rendering ---

function showToast(n: Notification): void {
    if (!toastContainer) return;

    // Enforce stack cap by removing the oldest toast first. Older entries
    // remain in the drawer; only the on-screen view is bounded.
    while (activeToasts.size >= TOAST_STACK_LIMIT) {
        const [oldestId] = activeToasts.keys();
        if (oldestId !== undefined) removeToast(oldestId);
        else break;
    }

    const el = document.createElement("div");
    el.className = `dc-toast dc-toast--${n.severity}`;
    el.setAttribute("role", n.severity === "error" ? "alert" : "status");
    el.setAttribute("aria-live", n.severity === "error" ? "assertive" : "polite");

    const icon = document.createElement("span");
    icon.className = "dc-toast__icon";
    icon.setAttribute("aria-hidden", "true");
    icon.append(buildSeverityIcon(n.severity));
    el.appendChild(icon);

    const body = document.createElement("span");
    body.className = "dc-toast__body";
    body.textContent = t(n.messageKey, n.messageParams);
    el.appendChild(body);

    if (n.actionKey && n.onAction) {
        const { actionKey, onAction } = n;
        const action = document.createElement("button");
        action.type = "button";
        action.className = "dc-toast__action";
        action.textContent = t(actionKey);
        action.addEventListener("click", () => {
            // Toast down first: the action may open a picker, and a toast
            // hanging over (or auto-dismissing under) a system dialog reads
            // as a glitch.
            removeToast(n.id);
            onAction();
        });
        body.appendChild(action);
    }

    const close = document.createElement("button");
    close.type = "button";
    close.className = "dc-toast__close";
    close.setAttribute("aria-label", t("notif.toast.dismiss"));
    const closeIcon = buildLucideIcon(X_ICON_PATHS, 16);
    closeIcon.setAttribute("aria-hidden", "true");
    close.appendChild(closeIcon);
    close.addEventListener("click", () => removeToast(n.id));
    el.appendChild(close);

    toastContainer.appendChild(el);

    const timeoutMs = toastTimeoutFor(n);
    const timer = timeoutMs === null ? null : window.setTimeout(() => removeToast(n.id), timeoutMs);
    activeToasts.set(n.id, { el, timer });
}

function removeToast(id: string): void {
    const entry = activeToasts.get(id);
    if (!entry) return;
    if (entry.timer !== null) clearTimeout(entry.timer);
    const hadFocus = entry.el.contains(document.activeElement);
    entry.el.remove();
    activeToasts.delete(id);
    if (hadFocus && notificationModal) {
        (tabbable(notificationModal)[0] ?? notificationModal).focus({ preventScroll: true });
    }
}

/** Restarts a visible toast's auto-dismiss timer. Used when a duplicate
 *  notification arrives so the collapsed toast stays up for its full window. */
function resetToastTimer(id: string): void {
    const entry = activeToasts.get(id);
    if (!entry) return;
    if (entry.timer !== null) clearTimeout(entry.timer);
    const n = notifications.find((x) => x.id === id);
    const timeoutMs = n ? toastTimeoutFor(n) : null;
    entry.timer = timeoutMs === null ? null : window.setTimeout(() => removeToast(id), timeoutMs);
}

// --- Bell + drawer ---

function syncBellVisibility(): void {
    if (!bellBtn) return;
    const isEmpty = notifications.length === 0 && pinnedStatuses.size === 0;
    bellBtn.hidden = isEmpty;
    if (isEmpty) closeDrawer();
}

function renderBellBadge(): void {
    if (!bellDot) return;
    const hasUnread =
        notifications.some((n) => !n.read) ||
        [...pinnedStatuses].some(([id, status]) => readPinnedRevisions.get(id) !== status.revision);
    bellDot.hidden = !hasUnread;
}

function toggleDrawer(): void {
    if (drawerOpen) closeDrawer();
    else openDrawer();
}

function openDrawer(): void {
    if (!drawerEl) return;
    drawerPopover?.open();
    // Mark everything read at open; dot disappears immediately.
    for (const n of notifications) n.read = true;
    for (const [id, status] of pinnedStatuses) readPinnedRevisions.set(id, status.revision);
    renderBellBadge();
}

function closeDrawer(): void {
    if (!drawerEl) return;
    drawerPopover?.close();
}

function clearAll(): void {
    notifications.length = 0;
    // Also tear down any toasts currently on screen - otherwise the drawer
    // empties out while toasts still hang in the corner, an inconsistent
    // visual state. Iterating a snapshot of keys avoids mutating-while-iterating.
    for (const id of [...activeToasts.keys()]) removeToast(id);
    renderDrawerList();
    renderBellBadge();
    syncBellVisibility();
    closeDrawer();
}

function renderDrawerList(): void {
    if (!drawerList) return;
    drawerList.replaceChildren();

    if (notifications.length === 0 && pinnedStatuses.size === 0) {
        const empty = document.createElement("p");
        empty.className = "notif-drawer-empty";
        empty.textContent = t("notif.drawer.empty");
        drawerList.appendChild(empty);
        return;
    }

    for (const status of pinnedStatuses.values()) {
        const item = buildDrawerItem(status.severity, t(status.messageKey), {
            label: t(status.actionKey),
            run: status.onAction,
        });
        item.classList.add("notif-drawer-item--pinned");
        drawerList.appendChild(item);
    }
    for (const n of notifications) {
        const action =
            n.actionInDrawer && n.actionKey && n.onAction ? { label: t(n.actionKey), run: n.onAction } : null;
        drawerList.appendChild(buildDrawerItem(n.severity, t(n.messageKey, n.messageParams), action));
    }
}

function buildDrawerItem(
    severity: Severity,
    message: string,
    action: { label: string; run: () => void } | null,
): HTMLElement {
    const item = document.createElement("div");
    item.className = `notif-drawer-item notif-drawer-item--${severity}`;

    const icon = document.createElement("span");
    icon.className = "notif-drawer-item__icon";
    icon.setAttribute("aria-hidden", "true");
    icon.append(buildSeverityIcon(severity));
    item.appendChild(icon);

    const text = document.createElement("span");
    text.className = "notif-drawer-item__text";
    text.textContent = message;
    if (action) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "dc-toast__action";
        button.textContent = action.label;
        button.addEventListener("click", () => {
            closeDrawer();
            action.run();
        });
        text.append(button);
    }
    item.appendChild(text);
    return item;
}

// --- Severity icons (Lucide) ---

function buildSeverityIcon(severity: Severity): SVGElement {
    return buildLucideIcon(ICON_PATHS[severity]);
}

// Lucide-style path data for each severity. Kept inline so we don't need
// a runtime icon library or bundle increase.
//   info  - Lucide "info" (circle with dot + vertical line)
//   warn  - Lucide "triangle-alert"
//   error - Lucide "circle-x"
const ICON_PATHS: Record<Severity, string[]> = {
    info: ["M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z", "M12 16v-4", "M12 8h.01"],
    warn: ["m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z", "M12 9v4", "M12 17h.01"],
    error: ["M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z", "m15 9-6 6", "m9 9 6 6"],
};
