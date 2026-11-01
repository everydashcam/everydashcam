// Secondary player controls share one overflow row. The transport group stays
// visible and gets its own row when the player is narrow.

import { t } from "../i18n/index.js";
import { dom } from "./dom.js";
import { isMobileLayout, MOBILE_LAYOUT_QUERY } from "./media-queries.js";
import { type OverflowableItem, initOverflowBar } from "./overflow-bar.js";
import { state } from "./state.js";
import { applyVolumeLevel } from "./player-volume.js";
import { initPlayerPopoverPosition } from "./player-popover.js";

export function initPlayerBarOverflow() {
    const bar = document.getElementById("player-bar-secondary");
    const playerBar = document.getElementById("player-bar");
    const button = document.getElementById("player-overflow") as HTMLButtonElement | null;
    const menu = document.getElementById("player-overflow-menu") as HTMLUListElement | null;
    if (!bar || !playerBar || !button || !menu) return;

    const layout = playerBar.querySelector<HTMLElement>(".player-bar-layout");
    const transport = playerBar.querySelector<HTMLElement>(".player-transport");
    const info = playerBar.querySelector<HTMLElement>(".player-info");
    const video = dom.playerWrap.querySelector<HTMLElement>(".video-frame");
    const syncLayout = (): void => {
        dom.playerWrap.style.setProperty("--player-controls-measured-h", `${playerBar.offsetHeight}px`);
        if (!layout || !transport || !info || !video) return;
        const bounds = layout.getBoundingClientRect();
        if (!bounds.width) return;
        const videoBounds = video.getBoundingClientRect();
        const center = videoBounds.width > 0 ? videoBounds.x + videoBounds.width / 2 : bounds.x + bounds.width / 2;
        const desiredLeft = Math.max(0, center - bounds.x - transport.offsetWidth / 2);
        const gap = Number.parseFloat(getComputedStyle(layout).columnGap) || 0;
        const requiredInfoSpace = (): number => {
            // Mute and loop can overflow; they must not move the center when
            // an overflow pass temporarily restores every button.
            const fixedItems = Array.from(info.children).filter(
                (child) => child !== muteWrap && child !== loop && (child as HTMLElement).offsetWidth > 0,
            );
            return (
                fixedItems.reduce((total, child) => total + (child as HTMLElement).offsetWidth, 0) +
                gap * fixedItems.length
            );
        };
        const isStacked = isMobileLayout();
        info.dataset.compactTime = "false";
        info.dataset.compactTime = String(!isStacked && desiredLeft < requiredInfoSpace());
        const left = isStacked ? desiredLeft : Math.max(desiredLeft, requiredInfoSpace());
        layout.style.setProperty("--transport-left", `${left}px`);
        layout.style.setProperty("--transport-left-space", `${Math.max(0, left - gap)}px`);
        layout.dataset.transportStacked = String(isStacked);
    };
    const sizeObserver = new ResizeObserver(syncLayout);
    sizeObserver.observe(playerBar);
    if (video) sizeObserver.observe(video);
    if (transport) sizeObserver.observe(transport);
    if (info) {
        sizeObserver.observe(info);
        // Intrinsic labels can grow inside a fixed-width grid column.
        for (const child of info.children) sizeObserver.observe(child);
    }
    document.addEventListener("playerexpansionchange", syncLayout);

    const muteWrap = document.querySelector<HTMLElement>(".player-mute-wrap");
    const mute = document.getElementById("player-mute") as HTMLButtonElement | null;
    const capture = document.getElementById("player-capture") as HTMLButtonElement | null;
    const loop = document.getElementById("player-loop") as HTMLButtonElement | null;
    const viewMode = document.getElementById("player-view-mode") as HTMLButtonElement | null;
    const help = document.getElementById("player-help") as HTMLButtonElement | null;
    const addMarker = document.getElementById("player-add-marker") as HTMLButtonElement | null;
    const markerList = document.getElementById("player-marker-list") as HTMLButtonElement | null;
    const map = document.getElementById("player-map") as HTMLButtonElement | null;
    const gpsSync = document.getElementById("gps-sync-pill-mobile") as HTMLButtonElement | null;
    const exportBtn = document.getElementById("player-export") as HTMLButtonElement | null;
    const mobileLayout = window.matchMedia(MOBILE_LAYOUT_QUERY);
    const syncControlGroups = (): void => {
        if (!info || !muteWrap || !loop) return;
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
    // least-useful-on-mobile controls (help, capture, loop, view-mode) leave the
    // bar first; mute next; the map toggle stays longest (it is the
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
    if (capture) {
        items.push({
            el: capture,
            priority: 9,
            label: () => t("player.capture"),
            isAvailable: () => !capture.hidden,
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
    if (viewMode) {
        items.push({
            el: viewMode,
            priority: 7,
            label: () => t("player.view.toggle"),
            isAvailable: () => !viewMode.hidden,
        });
    }
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
        additionalContainers: info ? [info] : [],
        overflowButton: button,
        overflowMenu: menu,
        items,
    });
    mobileLayout.addEventListener("change", () => {
        syncControlGroups();
        syncLayout();
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
