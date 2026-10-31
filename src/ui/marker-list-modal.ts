// Every marker of the active trip as one list: jump to it, rename it in place,
// delete it. The pins on the timeline stay the fast path, but they are only
// reachable by contextmenu (absent on iOS touch) and a pin does not survive a
// zoom window that scrolls it out - the list is the surface where a marker can
// always be found and removed.
//
// The refresh callback arrives via init (app.ts): importing timeline-markers
// here would cycle (it imports this module to sync the bar button).

import { t } from "../i18n/index.js";
import { wallToContentSec } from "../trips.js";
import { deleteMarker, markersForTrip, updateMarkerText } from "./annotations.js";
import { formatTime } from "./format.js";
import { activateModal, deactivateModal, wireBackdropDismiss } from "./modal-helper.js";
import { seekTripTime } from "./player.js";
import { activeTrip } from "./state.js";
import { X_ICON_PATHS, buildLucideIcon } from "./icons.js";

let modal: HTMLElement | null = null;
let listEl: HTMLElement | null = null;
let emptyEl: HTMLElement | null = null;
let openButton: HTMLButtonElement | null = null;
let onChanged: (() => void) | null = null;

export function initMarkerListModal(callbacks: { onChanged: () => void }): void {
    onChanged = callbacks.onChanged;
    modal = document.getElementById("marker-list-modal");
    listEl = document.getElementById("marker-list-items");
    emptyEl = document.getElementById("marker-list-empty");
    // Only adopt the button once the modal it opens exists - otherwise
    // syncMarkerListButton could reveal a control with no click handler.
    if (!modal || !listEl || !emptyEl) return;
    openButton = document.getElementById("player-marker-list") as HTMLButtonElement | null;

    openButton?.addEventListener("click", open);
    document.getElementById("marker-list-close")?.addEventListener("click", close);
    wireBackdropDismiss(modal, close);
    // Annotations can already be in memory (sidecar merge on a chip click
    // resolving before this init) - do not wait for the next overlay sync.
    syncMarkerListButton();
}

/** Shows the bar button only once the active trip has a marker: an empty list
 *  is a dead control, and the bar is already crowded. `count` comes from the
 *  caller when it has just walked the trip's markers anyway (the pin refresh
 *  runs per pointermove during an overview drag). */
export function syncMarkerListButton(count?: number): void {
    if (!openButton) return;
    const trip = activeTrip();
    const markerCount = count ?? (trip ? markersForTrip(trip).length : 0);
    const shouldHide = !trip || markerCount === 0;
    // Only on a real change: setAttribute fires a mutation record even when the
    // value is identical, and the player-bar overflow watches [hidden] with a
    // synchronous re-measure. This runs per pointermove during an overview drag.
    if (openButton.hidden !== shouldHide) openButton.hidden = shouldHide;
}

function open(): void {
    if (!modal) return;
    render();
    modal.hidden = false;
    activateModal(modal, { onClose: close, initialFocus: firstFocusable() });
}

function firstFocusable(): HTMLElement | undefined {
    return (
        listEl?.querySelector<HTMLElement>(".marker-list-seek") ??
        document.getElementById("marker-list-close") ??
        undefined
    );
}

function render(): void {
    if (!listEl || !emptyEl) return;
    const trip = activeTrip();
    const markers = trip ? markersForTrip(trip) : [];
    emptyEl.hidden = markers.length > 0;
    listEl.replaceChildren();
    if (!trip) return;
    for (const marker of markers) {
        const contentSec = wallToContentSec(trip.timeline, marker.utc / 1000);
        listEl.appendChild(buildRow(marker.id, marker.text, contentSec));
    }
}

function buildRow(id: string, text: string, contentSec: number): HTMLElement {
    const row = document.createElement("li");
    row.className = "marker-list-row";

    const seek = document.createElement("button");
    seek.type = "button";
    seek.className = "marker-list-seek mono";
    seek.textContent = formatTime(contentSec);
    const seekLabel = t("markerList.seek", { time: formatTime(contentSec) });
    seek.setAttribute("aria-label", seekLabel);
    seek.title = seekLabel;
    seek.addEventListener("click", () => {
        seekTripTime(contentSec);
        // The backdrop covers the video, so staying open would hide the very
        // moment the user just jumped to.
        close();
    });
    row.appendChild(seek);

    const textInput = document.createElement("input");
    textInput.type = "text";
    textInput.className = "marker-list-text";
    textInput.maxLength = 200;
    textInput.autocomplete = "off";
    textInput.value = text;
    textInput.placeholder = t("markerList.textPlaceholder");
    textInput.setAttribute("aria-label", t("markerModal.textLabel"));
    // Commit on blur and on Enter; the record is only written when the text
    // actually changed, so a tab-through does not bump updatedAt and win LWW
    // against a real edit made on another machine.
    const commit = (): void => {
        if (textInput.value === text) return;
        text = textInput.value;
        updateMarkerText(id, text);
        onChanged?.();
    };
    textInput.addEventListener("blur", commit);
    textInput.addEventListener("keydown", (ev) => {
        if (ev.key !== "Enter") return;
        ev.preventDefault();
        commit();
    });
    row.appendChild(textInput);

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "marker-list-delete";
    const removeIcon = buildLucideIcon(X_ICON_PATHS, 16);
    removeIcon.setAttribute("aria-hidden", "true");
    remove.appendChild(removeIcon);
    const removeLabel = t("markerList.delete");
    remove.setAttribute("aria-label", removeLabel);
    remove.title = removeLabel;
    remove.addEventListener("click", () => {
        deleteMarker(id);
        onChanged?.();
        render();
        // The row that held focus is gone - land it somewhere predictable
        // instead of on <body>, where Escape/Tab lose the modal.
        firstFocusable()?.focus();
    });
    row.appendChild(remove);

    return row;
}

function close(): void {
    if (!modal) return;
    modal.hidden = true;
    deactivateModal(modal);
}
