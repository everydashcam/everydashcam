// Reusable "priority+" toolbar: when the container shrinks, the
// lowest-priority items are hidden and appear in the overflow popover (kebab).
// Used by the topbar (see app.ts) - reusable by any horizontal toolbar with
// variable width.
//
// The measuring logic only works if the container is a flex with nowrap. On
// flex-wrap items wrap to a new line and scrollWidth === clientWidth, so
// overflow is not detected.

import { createLogger } from "../log.js";

const log = createLogger("ui:overflow-bar");

/** Describes one "collapsible" toolbar item. */
import { createPopover } from "./popover-lifecycle.js";

export interface OverflowableItem {
    /** Original element in the bar. On overflow it gets
     *  data-overflow-hidden="true" + CSS hides it. */
    el: HTMLElement;

    /** Visibility priority. Lower = more important. Items with higher priority
     *  are hidden first. */
    priority: number;

    /** Text for the row in the overflow menu. */
    label: () => string;

    /** Icon clone for the menu row. Defaults to the element's first <svg>. */
    iconSource?: () => SVGElement | null;

    /** What to do on activation from the menu. Default - el.click(). */
    onActivate?: () => void;

    /** Whether active (show ✓ in the menu). Optional. */
    isActive?: () => boolean;

    /** Whether the item should be ignored right now (e.g. hidden=true on the
     *  original means the feature is unavailable entirely). */
    isAvailable?: () => boolean;

    /** Custom render of the row in the overflow menu. If set, used instead of
     *  the standard "[icon] label". Must return a ready <li> element. Useful
     *  for composite controls like the theme-toggle (3 auto/light/dark buttons
     *  in a single row). */
    customMenuRow?: () => HTMLElement;
}

export interface OverflowBarOptions {
    /** Container with flex layout, flex-wrap: nowrap. */
    container: HTMLElement;

    /** Other flex groups that share this container's overflow button and menu. */
    additionalContainers?: HTMLElement[];

    /** Kebab button (always last in the DOM after items). Hides itself if all
     *  items fit. */
    overflowButton: HTMLButtonElement;

    /** UL menu, popover downward. Contents re-rendered on every overflow-state
     *  change. */
    overflowMenu: HTMLUListElement;

    /** Items in their visual order in the bar. */
    items: OverflowableItem[];
}

export interface OverflowBarHandle {
    /** Force-recompute overflow. Useful if external JS changed item visibility
     *  (e.g. install-btn appeared). Defaults to a next-rAF measure (coalesces
     *  bursts). Pass { immediate: true } to measure synchronously in the current
     *  frame - required when a mid-session reveal would otherwise paint one
     *  over-wide frame and blow out the mobile layout viewport (see the burger
     *  watch in topbar-overflow.ts). */
    remeasure(opts?: { immediate?: boolean }): void;
    /** Close the overflow menu. Used from customMenuRow handlers. */
    close(): void;
    destroy(): void;
}

/** Initializes the overflow-bar. Idempotent across repeated DOM mutations -
 *  the ResizeObserver recomputes on container width changes by itself. */
export function initOverflowBar(opts: OverflowBarOptions): OverflowBarHandle {
    const { container, overflowButton, overflowMenu, items } = opts;
    const containers = [...new Set([container, ...(opts.additionalContainers ?? [])])];

    // Sort once: the priority list is fixed. Hide by descending priority
    // (higher priority → less important → hidden first).
    const dropOrder = [...items].sort((a, b) => b.priority - a.priority);

    let menuOpen = false;
    const popover = createPopover({
        button: overflowButton,
        panel: overflowMenu,
        show: () => {
            menuOpen = true;
            overflowMenu.hidden = false;
        },
        hide: () => {
            menuOpen = false;
            overflowMenu.hidden = true;
        },
    });
    function setMenuOpen(open: boolean): void {
        if (open) popover.open();
        else popover.close();
    }
    function toggleMenu(): void {
        popover.toggle();
    }

    function renderMenu(hiddenItems: OverflowableItem[]) {
        // Full re-render of the list - cheap (≤ 6 buttons), no need to diff.
        // Keep it simple.
        overflowMenu.replaceChildren();
        for (const item of hiddenItems) {
            // Custom render - all responsibility is on the caller (it wires up
            // its own click handlers and decides whether to close the menu).
            if (item.customMenuRow) {
                overflowMenu.appendChild(item.customMenuRow());
                continue;
            }

            const li = document.createElement("li");
            li.className = "overflow-menu-item";
            li.setAttribute("role", "menuitem");

            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "overflow-menu-btn";

            // Icon.
            const iconSrc = item.iconSource?.() ?? item.el.querySelector("svg");
            if (iconSrc) {
                const clone = iconSrc.cloneNode(true) as SVGElement;
                clone.classList.add("overflow-menu-icon");
                btn.appendChild(clone);
            }

            const labelSpan = document.createElement("span");
            labelSpan.className = "overflow-menu-label";
            labelSpan.textContent = item.label();
            btn.appendChild(labelSpan);

            if (item.isActive?.()) {
                btn.setAttribute("aria-pressed", "true");
                const check = document.createElement("span");
                check.className = "overflow-menu-check";
                check.textContent = "✓";
                check.setAttribute("aria-hidden", "true");
                btn.appendChild(check);
            }

            btn.addEventListener("click", (e) => {
                e.stopPropagation();
                if (item.onActivate) {
                    item.onActivate();
                } else {
                    item.el.click();
                }
                // Recompute isActive on the next tick.
                queueMicrotask(() => renderMenu(getHiddenItems()));
                // Close the menu for one-shot actions.
                if (!item.isActive) {
                    setMenuOpen(false);
                }
            });

            li.appendChild(btn);
            overflowMenu.appendChild(li);
        }
    }

    /** Close the menu. Useful from customMenuRow click handlers. */
    function close() {
        setMenuOpen(false);
    }

    function getHiddenItems(): OverflowableItem[] {
        return items.filter((it) => it.el.dataset.overflowHidden === "true");
    }

    /** Signature of the current hidden-set: "0010..." in items order.
     *  Needed to skip renderMenu on resize if the hidden set did not change
     *  (a closed menu is invisible to the user - a wasted DOM mutation). On
     *  sidebar drag-resize this saves ~60 reflow/sec. */
    function hiddenSignature(): string {
        let s = "";
        for (const it of items) s += it.el.dataset.overflowHidden === "true" ? "1" : "0";
        return s;
    }
    let lastHiddenSig = "";

    /** Detect overflow via getBoundingClientRect, not scrollWidth.
     *  scrollWidth requires overflow:hidden/clip on the container for a stable
     *  value, but that clips children popovers (.lang-menu,
     *  .player-speed-menu, .player-volume-popover) that live in
     *  position:absolute. Rect-based works under any overflow and is more
     *  precise: we look at where the last visible child physically ends and
     *  compare it with the right edge of the parent's content area. */
    function isOverflowing(group: HTMLElement): boolean {
        const containerRect = group.getBoundingClientRect();
        const cs = getComputedStyle(group);
        const padR = Number.parseFloat(cs.paddingRight) || 0;
        // Anchor the right edge to the VISUAL VIEWPORT, not the container's own
        // rect. On mobile a flex container with nowrap + flex-shrink:0 children
        // is allowed to grow WIDER than the screen to fit them, which expands the
        // layout viewport - and body{overflow:hidden} does NOT prevent that on
        // mobile (it only clips, the layout still widens and the page becomes
        // pinch-zoomable with a dead strip on the right). If we measured against
        // the grown container's own right edge, every child would look like it
        // "fits" and we would never collapse - the bar stays inflated forever.
        // Normalize visual width by page scale: zoom changes the visible area,
        // not the toolbar's CSS layout. Comparing against zoomed width would
        // hide every optional item while the flex spacer still fills the bar.
        // min() makes this a no-op when the container fits the viewport.
        const vp = window.visualViewport;
        const viewportRight = vp ? vp.offsetLeft + vp.width * vp.scale : document.documentElement.clientWidth;
        const limit = Math.min(containerRect.right, viewportRight) - padR;

        let maxRight = Number.NEGATIVE_INFINITY;
        for (const child of group.children) {
            const ce = child as HTMLElement;
            if (ce.hidden) continue;
            if (ce.dataset.overflowHidden === "true") continue;
            const r = ce.getBoundingClientRect();
            if (r.right > maxRight) maxRight = r.right;
        }
        // 0.5px tolerance - sub-pixel rounding must not jitter the state
        // (the kebab would appear and disappear endlessly at fractional widths).
        return maxRight > limit + 0.5;
    }

    // MutationObserver below observes the same container subtree we mutate
    // here (overflowButton.hidden, items' data-overflow-hidden). Without
    // unsubscribing we'd ping-pong: each measure() schedules a MO callback
    // that schedules another rAF(measure). Disconnect before mutating,
    // reconnect after - MO drops mutations emitted while disconnected, which
    // is exactly what we want (we know they came from us).
    function measure(opts?: { forceRender?: boolean }): void {
        const wasOverflowFocused = document.activeElement === overflowButton;
        mo.disconnect();
        try {
            measureInner(opts?.forceRender ?? false);
        } finally {
            for (const group of containers) mo.observe(group, MO_OPTS);
        }
        // Measuring temporarily hides the trigger, which clears browser focus.
        if (wasOverflowFocused && !overflowButton.hidden) overflowButton.focus({ preventScroll: true });
    }
    function measureInner(forceRender: boolean): void {
        // Clear stale menu entries too when a control becomes unavailable.
        for (const it of items) {
            it.el.dataset.overflowHidden = "false";
        }

        // Hide kebab during measurement so its width does not affect the
        // calc - we'll show it again below only if anything was hidden.
        overflowButton.hidden = true;

        collapseOverflow();

        const hidden = getHiddenItems();
        overflowButton.hidden = hidden.length === 0;
        // Final check: after showing the kebab the bar can become overflowing
        // too. If so - hide more items until it fits together with the kebab.
        if (!overflowButton.hidden) collapseOverflow();

        // Recompute the hidden set AFTER the final-check loop: that loop can
        // drop more items than the `hidden` snapshot above captured (e.g. the
        // lowest-priority item, dropped only once the kebab's own width pushed
        // the bar back into overflow). Rendering the stale snapshot would leave
        // such an item hidden in the bar yet absent from the menu - unreachable.
        const menuItems = getHiddenItems();

        // Preserve focused menu controls through resize measurements. Opening
        // refreshes labels and state even when the hidden set has not changed.
        const sig = hiddenSignature();
        if (forceRender || sig !== lastHiddenSig) {
            renderMenu(menuItems);
            lastHiddenSig = sig;
        }

        // If the overflow button disappeared as a result while the menu was
        // open - close it.
        if (overflowButton.hidden && menuOpen) {
            setMenuOpen(false);
        }
    }

    function collapseOverflow(): void {
        while (true) {
            const overflowing = containers.filter(isOverflowing);
            if (overflowing.length === 0) return;
            // Hiding a control in another group cannot resolve this collision.
            // Items can move between groups at layout breakpoints.
            const next = dropOrder.find(
                (item) =>
                    item.el.dataset.overflowHidden !== "true" &&
                    (item.isAvailable?.() ?? !item.el.hidden) &&
                    overflowing.some((group) => group.contains(item.el)),
            );
            if (!next) return;
            next.el.dataset.overflowHidden = "true";
        }
    }

    const ro = new ResizeObserver(() => {
        // requestAnimationFrame - smooth out the resize spam on sidebar
        // drag-resize: measure once per frame, not per pixel.
        requestAnimationFrame(() => measure());
    });
    for (const group of containers) ro.observe(group);

    // Mutation observer on children - detects external visibility changes
    // (hidden/disabled attribute) after initial measure. E.g. player-view-mode
    // becomes visible only after trip activation (multi-channel detect);
    // without this it would not enter overflow despite bar overflowing.
    // attributeFilter narrows traffic; subtree:true catches mutations inside
    // wrappers (.player-mute-wrap).
    // measure() does mo.disconnect()/mo.observe() to avoid self-trigger loop.
    const MO_OPTS: MutationObserverInit = {
        attributes: true,
        attributeFilter: ["hidden", "disabled"],
        subtree: true,
    };
    const mo = new MutationObserver(() => {
        // Synchronous (no rAF): a button revealed mid-session (notif-bell on the
        // first notification, settings, install) must collapse in the SAME frame.
        // If it waits a frame, the over-wide bar paints once and on mobile that one
        // frame is enough to expand the layout viewport (the persistent dead-strip
        // bug). measure() guards against the self-trigger loop via mo.disconnect()/
        // mo.observe() around the mutation, so a synchronous call cannot re-enter.
        // The ResizeObserver path keeps its rAF - it coalesces sidebar drag-resize
        // reflow (~60/sec), which a single attribute mutation does not produce.
        measure();
    });
    for (const group of containers) mo.observe(group, MO_OPTS);

    overflowButton.addEventListener("click", (e) => {
        e.stopPropagation();
        // Sync measure + force-render before opening: visibility of items
        // can change between last measure and now (view-mode shows up after
        // trip activation, mute toggles aria-pressed, etc). forceRender
        // covers cases where the signature stayed the same but inner state
        // (isActive) changed.
        if (!menuOpen) measure({ forceRender: true });
        toggleMenu();
    });

    // Esc closes the menu. We do not keep the listener attached permanently -
    // only while open.

    // Initial measure right away - a frame can pass before the first
    // ResizeObserver delivery, and the user would see "all buttons + then
    // collapse".
    measure();

    // The Chakra Petch font for the brand mark loads asynchronously (woff2 in
    // public/fonts). Before it loads, .dc-mark renders with the Inter fallback
    // of a different width - the first measure catches the wrong content size,
    // and the buttons can "drift" until the frame after fonts.ready recomputes.
    // Subscribing to document.fonts.ready handles this explicitly.
    if (document.fonts && typeof document.fonts.ready?.then === "function") {
        document.fonts.ready.then(() => requestAnimationFrame(() => measure())).catch(() => {});
    }

    log.debug("overflow-bar initialized", { items: items.length });

    return {
        remeasure: (opts) => {
            if (opts?.immediate) measure();
            else requestAnimationFrame(() => measure());
        },
        close,
        destroy: () => {
            ro.disconnect();
            mo.disconnect();
            popover.close();
        },
    };
}
