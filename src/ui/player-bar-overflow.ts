// Player bar layout: the info group (sidebar, sound, time, speed, loop), the
// transport and the secondary actions share one row; on phones the transport
// takes a row of its own. The transport sits under the video's center while
// both side groups fit beside it, and slides toward the side with room when
// one does not. Controls fold into the overflow menu only when the whole bar
// cannot hold them, by one priority order across both groups. Both decisions
// come from the same measurement, so a group never sheds a control while the
// other one has room for it.

import { t } from "../i18n/index.js";
import { openCaptureMenuFromOverflow } from "./capture-menu.js";
import { dom } from "./dom.js";
import { isMobileLayout, MOBILE_LAYOUT_QUERY } from "./media-queries.js";
import { type OverflowableItem, initOverflowBar, visibleRightEdge } from "./overflow-bar.js";
import { state } from "./state.js";
import { applyVolumeLevel } from "./player-volume.js";
import { initPlayerPopoverPosition } from "./player-popover.js";

/**
 * Width a group's controls take from its left content edge, as laid out now:
 * they never shrink, so their positions hold even when the group's grid
 * column is too narrow for them. A spacer only absorbs free room and is left
 * out; controls that are not displayed take no room.
 */
function groupNeed(group: HTMLElement): number {
    const rect = group.getBoundingClientRect();
    const contentLeft = rect.left + (Number.parseFloat(getComputedStyle(group).paddingLeft) || 0);
    let right = contentLeft;
    let spacers = 0;
    for (const child of group.children) {
        const box = child.getBoundingClientRect();
        if (child.classList.contains("player-spacer")) spacers += box.width;
        else if (box.width > 0 || box.height > 0) right = Math.max(right, box.right);
    }
    return Math.max(0, right - contentLeft - spacers);
}

export function initPlayerBarOverflow() {
    const bar = document.getElementById("player-bar-secondary");
    const playerBar = document.getElementById("player-bar");
    const button = document.getElementById("player-overflow") as HTMLButtonElement | null;
    const menu = document.getElementById("player-overflow-menu") as HTMLUListElement | null;
    const layout = playerBar?.querySelector<HTMLElement>(".player-bar-layout");
    const transport = playerBar?.querySelector<HTMLElement>(".player-transport");
    const info = playerBar?.querySelector<HTMLElement>(".player-info");
    if (!bar || !playerBar || !button || !menu || !layout || !transport || !info) return;
    const video = dom.playerWrap.querySelector<HTMLElement>(".video-frame");

    /** The row the side groups share, with the room each one needs. On phones
     *  the transport has its own row and does not compete for it. */
    const measureRow = () => {
        const isStacked = layout.dataset.transportStacked === "true";
        const bounds = layout.getBoundingClientRect();
        const gap = Number.parseFloat(getComputedStyle(layout).columnGap) || 0;
        return {
            isStacked,
            left: bounds.left,
            width: Math.min(visibleRightEdge(layout), visibleRightEdge(bar)) - bounds.left,
            gap,
            transportWidth: transport.offsetWidth,
            infoNeed: groupNeed(info),
            secondaryNeed: groupNeed(bar),
        };
    };
    const fitsRow = (): boolean => {
        const row = measureRow();
        // A hidden player has nothing to fold.
        if (row.width <= 0) return true;
        const transportNeed = row.isStacked ? 0 : row.transportWidth + row.gap;
        return row.infoNeed + row.gap + transportNeed + row.secondaryNeed <= row.width + 0.5;
    };
    /** Places the transport for the final folded state of a pass. */
    const placeTransport = (): void => {
        dom.playerWrap.style.setProperty("--player-controls-measured-h", `${playerBar.offsetHeight}px`);
        const row = measureRow();
        if (row.width <= 0) return;
        const videoBounds = video?.getBoundingClientRect();
        const center = videoBounds?.width ? videoBounds.x + videoBounds.width / 2 : row.left + row.width / 2;
        let left = Math.max(0, center - row.left - row.transportWidth / 2);
        if (!row.isStacked) {
            // The info group's need wins when even the folded bar is too tight:
            // the secondary group then runs past its edge, as it would anyway.
            const maxLeft = row.width - row.transportWidth - row.gap - row.secondaryNeed;
            left = Math.max(row.infoNeed + row.gap, Math.min(left, maxLeft));
        }
        layout.style.setProperty("--transport-left", `${left}px`);
        layout.style.setProperty("--transport-left-space", `${Math.max(0, left - row.gap)}px`);
    };
    const syncStacked = (): void => {
        layout.dataset.transportStacked = String(isMobileLayout());
    };
    syncStacked();

    const muteWrap = document.querySelector<HTMLElement>(".player-mute-wrap");
    const mute = document.getElementById("player-mute") as HTMLButtonElement | null;
    const capture = document.getElementById("player-capture") as HTMLButtonElement | null;
    const loop = document.getElementById("player-loop") as HTMLButtonElement | null;
    const help = document.getElementById("player-help") as HTMLButtonElement | null;
    const addMarker = document.getElementById("player-add-marker") as HTMLButtonElement | null;
    const markerList = document.getElementById("player-marker-list") as HTMLButtonElement | null;
    const map = document.getElementById("player-map") as HTMLButtonElement | null;
    const gpsSync = document.getElementById("gps-sync-pill-mobile") as HTMLButtonElement | null;
    const exportBtn = document.getElementById("player-export") as HTMLButtonElement | null;
    const mobileLayout = window.matchMedia(MOBILE_LAYOUT_QUERY);
    const syncControlGroups = (): void => {
        if (!muteWrap || !loop) return;
        const parent = mobileLayout.matches ? bar : info;
        if (muteWrap.parentElement === parent && loop.parentElement === parent) return;
        muteWrap.dataset.overflowHidden = "false";
        loop.dataset.overflowHidden = "false";
        if (mobileLayout.matches) {
            bar.querySelector(".player-spacer")?.after(muteWrap, loop);
        } else {
            dom.sidebarToggle.after(muteWrap);
            info.append(loop);
        }
    };
    syncControlGroups();
    if (muteWrap) {
        const muteVisibility = new MutationObserver(() => {
            if (muteWrap.dataset.overflowHidden === "true" && !dom.playerBar.volumePopover.hidden) {
                dom.playerBar.volumePopover.hidden = true;
            }
        });
        muteVisibility.observe(muteWrap, { attributes: true, attributeFilter: ["data-overflow-hidden"] });
    }
    const items: OverflowableItem[] = [];

    // Priorities: HIGH priority = drop FIRST (see overflow-bar.ts header). The
    // least-useful-on-mobile controls (help, capture, loop) leave the bar
    // first; mute next; the map toggle stays longest (it is the
    // ONLY entry to the map on mobile, the mini-map circle being hidden there).
    // Export (priority 1) is always the last to go - so on every real phone width
    // it stays inline instead of disappearing into the kebab.
    if (help) {
        items.push({
            el: help,
            priority: 10,
            label: () => t("player.help.title"),
            isAvailable: () => !help.hidden,
        });
    }
    // Still image: the button and its menu fold together; the entry opens the
    // menu next to the overflow button (or saves when that is the only choice).
    if (capture) {
        items.push({
            el: dom.playerBar.captureWrap,
            priority: 9,
            label: () => t("player.captureMenu.title"),
            isAvailable: () => !dom.playerBar.captureWrap.hidden && !capture.hidden,
            onActivate: openCaptureMenuFromOverflow,
        });
    }
    // Marker drop: secondary on narrow bars - every un-collapsible control
    // widens the mandatory floor and pushes Export toward the kebab (the
    // regression the floor comment in player-bar.css guards against).
    if (addMarker) {
        items.push({
            el: addMarker,
            priority: 9,
            label: () => t("player.addMarker"),
            isAvailable: () => !addMarker.hidden,
        });
    }
    // Same reasoning as the marker drop, one step less important: the list is
    // reachable from the pins too, the drop button is the only way to create.
    if (markerList) {
        items.push({
            el: markerList,
            priority: 10,
            label: () => t("markerList.title"),
            // Hidden until the trip has a marker - it must then enter neither
            // the bar nor the kebab.
            isAvailable: () => !markerList.hidden,
        });
    }
    if (loop) {
        items.push({
            el: loop,
            priority: 8,
            label: () => (loop.getAttribute("aria-pressed") === "true" ? t("player.loop.on") : t("player.loop.off")),
            isAvailable: () => !loop.hidden,
            isActive: () => loop.getAttribute("aria-pressed") === "true",
        });
    }
    // The total duration next to the current time goes after the extras on
    // the right and before loop: it is context, not a control. Phones never
    // show it (player-bar.css), so it is not a step there.
    items.push({
        el: dom.playerBar.total,
        priority: 8.5,
        isAvailable: () => !isMobileLayout() && !dom.playerBar.total.hidden,
    });
    // Mute (together with the volume popover wrap): collapse the whole wrap so the
    // volume range does not stay DOM-positioned against a hidden mute button. The
    // wrap holds the real slider, which goes display:none on collapse, so the
    // kebab renders its own slider (custom row) - drag to 0 mutes.
    if (mute && muteWrap) {
        items.push({
            el: muteWrap,
            priority: 6,
            // Unused for rendering (customMenuRow owns the row); kept because the
            // contract requires a label and it is the accessible name fallback.
            label: () => (dom.player.muted ? t("player.unmute") : t("player.mute")),
            isAvailable: () => !muteWrap.hidden,
            customMenuRow: renderVolumeMenuRow,
        });
    }
    items.push({
        el: dom.playerBar.fullscreen,
        priority: 5,
        label: () => dom.playerBar.fullscreen.getAttribute("aria-label") ?? t("player.fullscreen.enter"),
        isAvailable: () => !dom.playerBar.fullscreen.hidden,
    });
    // Availability must ignore overflow's own display:none so a wider bar can
    // restore the map button without requiring the user to reload.
    if (map) {
        items.push({
            el: map,
            priority: 4,
            label: () => t("miniMap.expandAria"),
            isAvailable: () => isMobileLayout() && !map.hidden,
        });
    }
    if (gpsSync) {
        items.push({
            el: gpsSync,
            priority: 3,
            label: () => t("gpsSync.open"),
            isAvailable: () => isMobileLayout() && !gpsSync.hidden,
        });
    }
    // Export is the LAST control to leave the bar (lowest priority): the secondary
    // actions above overflow first and Export stays reachable inline. Default
    // onActivate = exportBtn.click() -> openOrCloseExportMode (wired in
    // export-panel.ts), so the kebab clone opens export-mode just like the in-bar
    // button on the rare width where nothing else can be dropped.
    if (exportBtn) {
        items.push({
            el: exportBtn,
            priority: 1,
            label: () => t("player.export.label"),
            isAvailable: () => !exportBtn.hidden,
        });
    }

    initPlayerPopoverPosition(playerBar, menu);
    const handle = initOverflowBar({
        container: bar,
        additionalContainers: [info],
        overflowButton: button,
        overflowMenu: menu,
        items,
        fits: fitsRow,
        onMeasured: placeTransport,
    });
    // The video's center moves with the map and the sidebar, and labels can
    // change width (time, language) inside fixed grid columns.
    const sizeObserver = new ResizeObserver(() => handle.remeasure());
    for (const target of [playerBar, transport, ...info.children, ...bar.children]) {
        if (!target.classList.contains("player-spacer")) sizeObserver.observe(target);
    }
    if (video) sizeObserver.observe(video);
    mobileLayout.addEventListener("change", () => {
        syncControlGroups();
        syncStacked();
        handle.remeasure({ immediate: true });
    });
    // Restore toolbar visibility before fullscreen returns keyboard focus.
    document.addEventListener("playerexpansionchange", () => handle.remeasure({ immediate: true }));

    return handle;
}

/**
 * Renders the volume row shown when the mute cluster collapses into the kebab.
 * A single horizontal range (the bar's own popover slider is vertical and lives
 * inside the display:none'd wrap), initialised from the live state each time the
 * menu opens; dragging to 0 mutes (applyVolumeLevel owns that rule). The menu
 * stays open while dragging - the level is continuous, unlike the one-shot rows.
 */
function renderVolumeMenuRow(): HTMLElement {
    const li = document.createElement("li");
    li.className = "overflow-menu-item overflow-menu-item--volume";
    li.setAttribute("role", "none");

    const label = document.createElement("span");
    label.className = "overflow-menu-section-label";
    label.textContent = t("player.volume");

    const slider = document.createElement("input");
    slider.type = "range";
    slider.className = "overflow-menu-volume-slider";
    slider.min = "0";
    slider.max = "1";
    slider.step = "0.05";
    slider.value = String(state.preferredMuted ? 0 : state.preferredVolume);
    slider.setAttribute("aria-label", t("player.volume"));
    slider.addEventListener("input", (e) => {
        e.stopPropagation();
        applyVolumeLevel(Number(slider.value));
    });

    li.appendChild(label);
    li.appendChild(slider);
    return li;
}
