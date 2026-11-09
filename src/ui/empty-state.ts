// Viewer placeholders for missing selection, unsupported video and playback failure.

import { t } from "../i18n/index.js";
import type { VideoCodec } from "mediabunny";

import { identifyBrowser } from "../capabilities.js";
import { dom } from "./dom.js";
import { state } from "./state.js";
import { isTripMapAvailable, syncTripMap } from "./trip-map.js";
import { getTripMapPreferences } from "./trip-map-pref.js";

// Official Microsoft Store listing of the "HEVC Video Extensions" add-on - the
// one Microsoft's own Edge troubleshooting doc links to. Linked directly so
// users don't land on look-alike codec downloads outside the Store.
const MS_STORE_HEVC_URL = "https://apps.microsoft.com/detail/9n4wgh0z6vhq";

/**
 * Advice line for an undecodable video, as HTML (may carry the Store link).
 * Shared by the player overlay and the export panel's re-encode-blocked note so
 * the guidance never diverges. HEVC on Windows branches by browser: Edge plays
 * HEVC only through the OS decoder that the Store add-on provides (works even
 * without a hardware decoder), while Chrome needs no install but silently lacks
 * HEVC on machines without hardware decode - so a user already in Chrome is
 * pointed at Edge and vice versa. Every other codec/OS keeps the generic "try
 * another browser" line.
 */
export function codecPlaybackAdviceHtml(codec: VideoCodec | null): string {
    const browser = identifyBrowser();
    if (codec !== "hevc" || browser.os !== "windows") return t("codecUnsupported.hint");
    const link = `<a href="${MS_STORE_HEVC_URL}" target="_blank" rel="noopener noreferrer">HEVC Video Extensions</a>`;
    const key =
        browser.name === "Edge"
            ? "codecUnsupported.hint.windowsEdge"
            : browser.name === "Chrome"
              ? "codecUnsupported.hint.windowsChrome"
              : "codecUnsupported.hint.windows";
    return t(key, { link });
}

/**
 * Toggles empty-state vs player-wrap visibility and fills the placeholder text.
 * Empty-state is shown while nothing is selected (state.active === null):
 *  - Before any ingest: product screenshot (UX-03).
 *  - Trips loaded but none selected: the map of all trips, or a "pick one on
 *    the left" hint with a way back to the map when the user turned it off.
 */
export function syncEmptyState(): void {
    if (!dom.viewer) return;
    const isEmpty = !state.active;
    dom.viewer.classList.toggle("empty", isEmpty);
    syncTripMap();
    if (!isEmpty) return;
    const card = document.getElementById("empty-state-card");
    if (!card) return;
    if (state.trips.length === 0) {
        // Theoretically dead code: trips=0 shows the landing page (body.no-trips).
        // Safe fallback in case landing is ever removed.
        card.innerHTML = `
            <div class="empty-state-title">${t("emptyState.first.title")}</div>
            <ol class="empty-state-steps">
                <li>${t("emptyState.first.step1")}</li>
                <li>${t("emptyState.first.step2")}</li>
                <li>${t("emptyState.first.step3")}</li>
            </ol>
            <div class="empty-state-hint">${t("emptyState.first.hint")}</div>
        `;
    } else {
        // .feedback-link opens the feedback form (delegated in feedback.ts) -
        // the escape hatch for "a trip loaded, but recognition looks wrong"
        // (front/rear swapped, mode missing), which the zero-trips path misses.
        const showMap =
            isTripMapAvailable() && !getTripMapPreferences().isShownWithoutTrip
                ? `<button type="button" class="dc-btn dc-btn--primary empty-state-map" data-action="show-trip-map">${t("tripMap.show")}</button>`
                : "";
        card.innerHTML = `
            <div class="empty-state-title">${t("emptyState.withTrips.title")}</div>
            <div class="empty-state-hint">${t("emptyState.withTrips.hint", { n: state.trips.length })}</div>
            ${showMap}
            <button type="button" class="empty-state-report feedback-link" data-feedback-preset="other">${t("emptyState.withTrips.report")}</button>
        `;
    }
}

/**
 * Shows the "browser cannot play this codec" overlay.
 * Used when the selected VideoCandidate.canPlay === false (mediabunny canDecodeVideo returned false on ingest).
 * Called in playFrame before setting <video>.src so the user sees the reason instead of a black frame.
 */
export function showCodecUnsupportedOverlay(codec: VideoCodec | null): void {
    if (!dom.viewer) return;
    dom.viewer.classList.remove("playback-failed");
    dom.viewer.classList.add("codec-unsupported");
    const retry = document.getElementById("playback-failed-retry") as HTMLButtonElement | null;
    if (retry) {
        retry.hidden = true;
        retry.onclick = null;
    }
    const titleEl = document.getElementById("codec-unsupported-title");
    if (titleEl) {
        titleEl.textContent = t("codecUnsupported.title");
    }
    // The hint is per-codec/per-browser, so it is filled here rather than left
    // to the static data-i18n default (which stays as the generic fallback).
    const hintEl = document.getElementById("codec-unsupported-hint");
    if (hintEl) {
        hintEl.innerHTML = `${codecPlaybackAdviceHtml(codec)} ${t("codecUnsupported.stillWorks")}`;
    }
}

/** Runtime faults offer another attempt without claiming the format is unsupported. */
export function showPlaybackFailureOverlay(onRetry: () => void): void {
    if (!dom.viewer) return;
    dom.viewer.classList.remove("codec-unsupported");
    dom.viewer.classList.add("playback-failed");
    const title = document.getElementById("codec-unsupported-title");
    const hint = document.getElementById("codec-unsupported-hint");
    if (title) title.textContent = t("playbackFailed.title");
    if (hint) hint.textContent = t("playbackFailed.hint");
    const retry = document.getElementById("playback-failed-retry") as HTMLButtonElement | null;
    if (retry) {
        retry.hidden = false;
        retry.textContent = t("playbackFailed.retry");
        retry.onclick = onRetry;
    }
}

export function hideCodecUnsupportedOverlay(): void {
    if (!dom.viewer) return;
    dom.viewer.classList.remove("codec-unsupported", "playback-failed");
    const retry = document.getElementById("playback-failed-retry") as HTMLButtonElement | null;
    if (retry) {
        retry.hidden = true;
        retry.onclick = null;
    }
}
