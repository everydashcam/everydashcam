// Trip sidebar: aggregate stats, sorting, date-bucket separators, trip headers with chevron, and expanded frame list.
//
// The only reverse dependency is click-to-play. To avoid a sidebar→player→sidebar cycle,
// trip and exact-clip playback arrive as callbacks in initSidebar().

import { t } from "../i18n/index.js";
import { recordsHaveGps } from "../parser.js";
import { recordingAnalysisPercent } from "../recording-analysis-progress.js";
import { hasTripFilters, matchesTripFilters, tripFilterFacts } from "../trip-filters.js";
import type { TripFilterFacts } from "../trip-filters.js";
import { subscribeUnitsChange } from "../units-pref.js";
import type { Channel } from "../parsers/types.js";
import type { Trip, VideoCandidate } from "../trips.js";
import { frameChannels, needsRecordingMetadata, tripAllCandidates } from "../trips.js";

import { buildEventList } from "./event-list.js";
import { dom } from "./dom.js";
import { syncEmptyState } from "./empty-state.js";
import { buildFileDetailsHtml } from "./file-details.js";
import { vendorFileKey } from "./ingest-candidate.js";
import { exitLanding } from "./landing.js";
import { syncBrowseState } from "./mobile-drawer.js";
import {
    channelDisplayLabel,
    channelDisplayShortLabel,
    comparatorFor,
    dateBucketLabel,
    formatDuration,
    formatFileMeta,
    formatTripMeta,
    formatTripDistance,
    formatTripStartTitle,
    formatTripTitle,
    recordingModeLabel,
} from "./format.js";
import type { TripLoadingState } from "./format.js";
import { setTripMeta, tripMetaFor } from "./annotations.js";
import { isTripSortKey, state } from "./state.js";
import { scheduleRecognitionHelp } from "./recognition-help.js";
import { initSidebarFilters, resetTripFilters, syncSidebarFilters } from "./sidebar-filters.js";

interface SidebarCallbacks {
    /** Opens the first playable frame, tolerating a damaged leading clip. */
    onPlayTrip: (tripIdx: number) => void | Promise<void>;
    /** Opens the exact clip row the user selected. */
    onPlayFrame: (tripIdx: number, frameIdx: number) => void | Promise<void>;
    /** Opens the trip name/note editor (trip-meta-modal, wired in app.ts -
     *  a direct import here would cycle: saving re-renders this sidebar). */
    // The Trip object, not its index - the modal outlives regroups that
    // reorder state.trips, and a stale index would edit the wrong trip.
    onEditTripMeta?: (trip: Trip) => void;
    /**
     * UX-08: clicked the event chip in the trip header. Implementation (frame selection, seek to event-5s, pause)
     * lives in the player so the sidebar does not depend on the player API.
     */
    onPlayTripEvent?: (tripIdx: number, eventIndex: number, saveClip?: boolean) => void | Promise<void>;
}

/** UX-08: current "next" event index per trip. In-memory, resets on reload. Keyed by tripIdx (not trip object) because groupTrips can recreate the object; the index stays stable within one state.trips snapshot. */
const tripEventCycleIdx = new Map<number, number>();
let selectTripEvent: SidebarCallbacks["onPlayTripEvent"];
const renderedFilterFacts = new Map<number, TripFilterFacts>();

/**
 * Drops the per-trip event-cycle cursor. Called from applyRegroup: the cursor is
 * keyed by positional trip index, which groupTrips renumbers on every regroup, so
 * a surviving entry would make the first event-chip click on a trip jump to a
 * stale event instead of cycling from the start (G8).
 */
export function clearTripEventCycle(): void {
    tripEventCycleIdx.clear();
}

export function renderTrips(): void {
    // Preserve reading position + keyboard focus across the full-list rebuild.
    // The final regroup sweep / user actions re-render the whole list; without
    // this the viewport jumps to the top and focus is lost.
    const prevScrollTop = dom.sidebar.scrollTop;
    const focus = captureListFocus(dom.list);

    dom.list.innerHTML = "";
    // Empty-state must stay in sync with the trip list so the player shows exactly when the first trip appears in the sidebar.
    syncEmptyState();

    // If still in landing mode (body.no-trips) and trips arrived - start the FLIP transition.
    // Idempotent: exitLanding checks body.no-trips itself and is a no-op if already exited.
    if (state.trips.length > 0) {
        exitLanding();
    }

    refreshTripAnalysisStatus();

    // Build the displayed list with original indices and sort by the selected field/direction.
    // The physical order of state.trips is NOT changed - state.active.trip and state.expandedTrips indices depend on it.
    renderedFilterFacts.clear();
    const entries = state.trips.map((trip, idx) => {
        const facts = tripFilterFacts(trip, tripMetaFor(trip));
        renderedFilterFacts.set(idx, facts);
        return { trip, idx, facts };
    });
    syncSidebarFilters(entries.map((entry) => entry.facts));
    let displayed = entries.filter((entry) => matchesTripFilters(entry.facts, state.tripFilters));
    if (displayed.length > 0) {
        dom.list.appendChild(buildSummaryItem(displayed.map((entry) => entry.trip)));
    } else if (state.trips.length > 0) {
        const empty = document.createElement("li");
        empty.className = "trip-filter-empty";
        const message = document.createElement("p");
        message.textContent = t("sidebar.filter.empty");
        const reset = document.createElement("button");
        reset.type = "button";
        reset.className = "trip-filter-reset";
        reset.dataset.action = "reset-trip-filters";
        reset.textContent = t("sidebar.filter.reset");
        empty.append(message, reset);
        dom.list.append(empty);
    }
    const cmp = comparatorFor(state.tripSortKey);
    // Duration/distance are provisional while metadata is pending (a per-fingerprint
    // estimate / 0 distance), so ranking by them makes cards jump as the
    // background fill lands real values. Park provisional trips in stable
    // chronological (startUtc) order after the measured trips, in both directions;
    // a card re-ranks exactly once when its measured value arrives. Date sort
    // stays useful from the first paint without provisional-value ranking.
    const sortsByValue = state.tripSortKey === "duration" || state.tripSortKey === "distance";
    if (sortsByValue) {
        const dir = state.tripSortDir === "desc" ? -1 : 1;
        displayed.sort((a, b) => {
            const aReal = !tripHasProvisionalFacts(a.trip);
            const bReal = !tripHasProvisionalFacts(b.trip);
            if (aReal !== bReal) return aReal ? -1 : 1; // measured first, provisional parked last
            if (!aReal) return a.trip.startUtc - b.trip.startUtc; // provisional: chronological, stable
            return dir * cmp(a.trip, b.trip);
        });
    } else {
        displayed.sort((a, b) => cmp(a.trip, b.trip));
        if (state.tripSortDir === "desc") displayed.reverse();
    }

    // Favorited trips float above everything, keeping their relative sorted
    // order. Applied after the sort so the star wins over any sort key.
    const isFavoriteEntry = (entry: { facts: TripFilterFacts }) => entry.facts.favorites;
    const favoriteCount = displayed.filter(isFavoriteEntry).length;
    if (favoriteCount > 0) {
        displayed = [...displayed.filter(isFavoriteEntry), ...displayed.filter((d) => !isFavoriteEntry(d))];
    }

    // Date bucket separators ("Today · Yesterday · This week · ...") only make sense when sorting by date.
    const showDateBuckets = state.tripSortKey === "date";
    let lastBucket: string | null = null;
    // Click handling is delegated in initSidebar (see dom.list listener). data-action attributes on header/chevron/file-li are sufficient.

    displayed.forEach(({ trip, idx: tripIdx }, displayIdx) => {
        // The floated favorites always get their own labelled section - in
        // every sort mode, or they read as trips mysteriously out of order.
        // Under date sort the rest gets date buckets; under other sorts a
        // single "everything else" label closes the favorites group.
        let bucket: string | null = null;
        if (displayIdx < favoriteCount) {
            bucket = t("sidebar.bucket.favorites");
        } else if (showDateBuckets) {
            bucket = dateBucketLabel(trip.startUtc, trip.cameraTzSec);
        } else if (favoriteCount > 0) {
            bucket = t("sidebar.bucket.others");
        }
        if (bucket !== null && bucket !== lastBucket) {
            const sep = document.createElement("li");
            sep.className = "trip-date-sep";
            sep.textContent = bucket;
            dom.list.appendChild(sep);
            lastBucket = bucket;
        }
        dom.list.appendChild(buildTripCard(trip, tripIdx));
    });

    if (state.unindexed.size > 0) {
        const note = document.createElement("li");
        note.className = "trip unindexed-note";
        note.innerHTML = `<div class="trip-header"><div class="trip-title">${t("sidebar.unindexed.title")}</div><div class="trip-meta">${t("sidebar.unindexed.note", { n: state.unindexed.size })}</div></div><button type="button" class="recognition-help-link feedback-link" data-feedback-preset="load">${t("recognition.contact")}</button>`;
        dom.list.appendChild(note);
    }

    // Cards are in the DOM now - reconcile body.browsing and, on the mobile
    // browse -> watch transition, fire the list-into-icon collapse. Must be last:
    // it clones the populated list.
    syncBrowseState();

    // Restore reading position + focus captured before the rebuild.
    dom.sidebar.scrollTop = prevScrollTop;
    restoreListFocus(focus, dom.list);

    // Tell assistive tech the list is still updating while any card is provisional.
    dom.list.setAttribute("aria-busy", state.trips.some(tripHasPending) ? "true" : "false");
    scheduleRecognitionHelp();
}

/** The card's annotation controls - favorite star, name/note pencil - as one
 *  row for the header's top-left corner. Both carry data-action, so the
 *  delegated list listener drives them. */
function buildTripActions(tripIdx: number, isFavorite: boolean): HTMLElement {
    const actions = document.createElement("span");
    actions.className = "trip-card-actions";
    const favBtn = document.createElement("button");
    favBtn.type = "button";
    favBtn.className = "trip-card-action trip-fav";
    if (isFavorite) favBtn.classList.add("is-on");
    const favLabel = isFavorite ? t("trip.fav.remove") : t("trip.fav.add");
    favBtn.title = favLabel;
    favBtn.setAttribute("aria-label", favLabel);
    favBtn.setAttribute("aria-pressed", isFavorite ? "true" : "false");
    favBtn.dataset.action = "trip-fav";
    favBtn.dataset.tripIndex = String(tripIdx);
    // Lucide star; fill switches on via CSS when .is-on.
    favBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z"/></svg>`;
    actions.appendChild(favBtn);
    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "trip-card-action trip-edit";
    const editLabel = t("trip.editMeta");
    editBtn.title = editLabel;
    editBtn.setAttribute("aria-label", editLabel);
    editBtn.dataset.action = "trip-edit";
    editBtn.dataset.tripIndex = String(tripIdx);
    // Lucide pencil.
    editBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/></svg>`;
    actions.appendChild(editBtn);
    return actions;
}

/**
 * Builds one trip card <li> (header, hero/loading state, chips, meta, clip list).
 * Extracted from renderTrips so a single card can be rebuilt in place
 * (refreshTripCard) without tearing down the whole list while recording data
 * arrives in the background.
 */
function buildTripCard(trip: Trip, tripIdx: number): HTMLLIElement {
    const li = document.createElement("li");
    li.className = "trip";
    // data-trip-index is used by updateActiveFrameHighlight to find the frame in the correct trip.
    // data-frame-index alone is not unique across trips (0..N in each); without trip scope querySelector would highlight the wrong trip.
    li.dataset.tripIndex = String(tripIdx);
    if (state.expandedTrips.has(tripIdx)) li.classList.add("expanded");
    if (state.active && state.active.trip === tripIdx) {
        li.classList.add("active");
        // aria-current tells AT which trip is selected - a CSS class alone is
        // invisible to a screen reader.
        li.setAttribute("aria-current", "true");
    }

    // Card visual state, split into two orthogonal signals:
    //  - DATA: provisional = a clip's moov is not read yet, so duration/distance
    //    stay out of the card; readFailed = a clip could not be read at all.
    //  - THUMBNAIL: until a preview is available, a static film glyph keeps the
    //    placeholder intentional. Background progress belongs to the one status
    //    above the list; animation on individual cards made ordinary work look
    //    like a problem with those specific trips.
    const cands = tripAllCandidates(trip);
    const focusKey = tripFocusKey(trip);
    if (focusKey) recordingFocusKeys.set(li, focusKey);
    const provisional = cands.some((candidate) => candidate.metadataReady === false);
    const gpsPending = cands.some((candidate) => {
        const key = vendorFileKey(candidate);
        return state.pendingHeavyEmbeddedGps.has(key) || state.inflightEmbeddedGps.has(key);
    });
    const readFailed = cands.some((c) => c.metadataFailed === true);
    const hasPreview = !!trip.previewDataUrl;
    if (provisional) li.setAttribute("aria-busy", "true");

    // Trip header. Click on any part except the chevron selects the trip (plays from first file); chevron click only expands/collapses.
    const header = document.createElement("div");
    header.className = "trip-header";

    const tripMeta = tripMetaFor(trip);
    const title = document.createElement("div");
    title.className = "trip-title";
    // Custom name replaces the generated title; the generated one (date/time)
    // moves to the tooltip so it stays discoverable.
    const generatedTitle = provisional ? formatTripStartTitle(trip) : formatTripTitle(trip);
    title.textContent = tripMeta?.name || generatedTitle;
    if (tripMeta?.name) title.title = generatedTitle;
    // Keyboard / screen-reader affordance: the title IS the trip's open/play
    // control. role=button + tabindex makes it focusable and Enter/Space
    // activatable (the header div carries the same data-action for broad
    // mouse clicks, but a bare div is not focusable). The chevron and chips
    // stay separate real buttons, after it in DOM/tab order.
    title.dataset.action = "play-trip";
    title.dataset.tripIndex = String(tripIdx);
    title.setAttribute("role", "button");
    title.tabIndex = 0;
    header.appendChild(title);

    // First-frame preview as the hero card background. CSS .trip-header sets aspect-ratio 3/1 with a gradient overlay for text readability.
    if (hasPreview && trip.previewDataUrl) {
        applyTripPreviewBackground(header, trip.previewDataUrl);
    } else {
        // A muted film glyph is stable while the preview is pending and remains
        // as the final fallback when extraction fails.
        const icon = document.createElement("div");
        icon.className = "trip-no-preview-icon";
        icon.setAttribute("aria-hidden", "true");
        icon.innerHTML = `<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M7 3v18"/><path d="M3 7.5h4"/><path d="M3 12h18"/><path d="M3 16.5h4"/><path d="M17 3v18"/><path d="M17 7.5h4"/><path d="M17 16.5h4"/></svg>`;
        header.appendChild(icon);
    }

    const chevron = document.createElement("button");
    chevron.className = "trip-chevron";
    chevron.type = "button";
    const expanded = state.expandedTrips.has(tripIdx);
    const chevLabel = expanded ? t("trip.chevron.collapse") : t("trip.chevron.expand");
    chevron.setAttribute("aria-label", chevLabel);
    chevron.setAttribute("aria-expanded", expanded ? "true" : "false");
    chevron.title = chevLabel;
    // Rotate only the glyph: rotating the button would move its asymmetric
    // touch target into the event chip and away from the lower card corner.
    const chevronIcon = document.createElement("span");
    chevronIcon.className = "trip-chevron__icon";
    chevronIcon.setAttribute("aria-hidden", "true");
    chevronIcon.textContent = "›";
    chevron.appendChild(chevronIcon);
    // Click is handled by the delegated listener in initSidebar via data-action and data-trip-index.
    chevron.dataset.action = "chevron";
    chevron.dataset.tripIndex = String(tripIdx);
    header.appendChild(chevron);

    // Top-left corner cluster: the annotation controls first (in the corner
    // proper, where they are always in the same place), then the trip-level
    // chips. One flex row, so a parking badge and a warning coexist without
    // overlapping and neither hides a button. Read-failed takes priority over
    // "no GPS": an unreadable clip is the more important signal, and it has no
    // records anyway.
    const badgeChips: HTMLElement[] = [];
    if (trip.isParking) {
        const parkingChip = document.createElement("span");
        parkingChip.className = "trip-vendor-badge parking";
        // The road-sign "P", not a word: it reads the same in every locale and
        // the slot competes with the title for width. AT gets the full label.
        parkingChip.textContent = t("trip.chip.parking");
        parkingChip.setAttribute("aria-label", recordingModeLabel("parking"));
        badgeChips.push(parkingChip);
    }
    if (readFailed) {
        const failChip = document.createElement("span");
        failChip.className = "trip-vendor-badge warn";
        failChip.textContent = t("trip.chip.readFailed");
        badgeChips.push(failChip);
    } else if (!provisional && !gpsPending && !recordsHaveGps(trip.records)) {
        const noGpsChip = document.createElement("span");
        noGpsChip.className = "trip-vendor-badge warn";
        noGpsChip.textContent = t("trip.chip.noGps");
        badgeChips.push(noGpsChip);
    }
    const cornerSlot = document.createElement("div");
    cornerSlot.className = "trip-corner-slot";
    cornerSlot.appendChild(buildTripActions(tripIdx, tripMeta?.isFavorite === true));
    for (const chip of badgeChips) cornerSlot.appendChild(chip);
    header.appendChild(cornerSlot);
    // UX-08: red outline chip showing event count. Clickable, cycles to the next trip event (seek -5s).
    // Top-right corner left of the chevron - both group into the actions zone.
    if (trip.events.length > 0) {
        const evchip = document.createElement("button");
        evchip.type = "button";
        evchip.className = "trip-event-chip";
        evchip.dataset.action = "trip-events";
        evchip.dataset.tripIndex = String(tripIdx);
        const evTitle = t("trip.events.chip.title", { n: trip.events.length });
        evchip.title = evTitle;
        evchip.setAttribute("aria-label", evTitle);
        // Inline Lucide alert-triangle. Color inherited from CSS.
        evchip.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg><span class="num mono">${trip.events.length}</span>`;
        header.appendChild(evchip);
    }

    const meta = document.createElement("div");
    meta.className = "trip-meta";
    const metaText = document.createElement("span");
    metaText.className = "trip-meta-text";
    const loadingState = computeTripLoadingState(trip, tripIdx);
    metaText.textContent = formatTripMeta(trip, loadingState);
    if (loadingState === "gps-pending" || loadingState === "gps-inflight") {
        metaText.classList.add(`load-${loadingState}`);
    }
    meta.appendChild(metaText);
    header.appendChild(meta);

    // Click on header (but not chevron) is handled by the delegated listener in initSidebar.
    header.dataset.action = "play-trip";
    header.dataset.tripIndex = String(tripIdx);

    li.appendChild(header);

    // Free-text note under the header. Display-only here; edited via the
    // pencil. Clamped by CSS - a long note must not dwarf the card.
    if (tripMeta?.note) {
        const noteEl = document.createElement("div");
        noteEl.className = "trip-note";
        noteEl.textContent = tripMeta.note;
        noteEl.title = tripMeta.note;
        li.appendChild(noteEl);
    }

    if (trip.events.length > 0) {
        const events = document.createElement("details");
        events.className = "trip-events-list";
        const summary = document.createElement("summary");
        summary.textContent = `${t("player.nav.events")} · ${trip.events.length}`;
        events.appendChild(summary);
        events.appendChild(
            buildEventList(trip, (index, saveClip) => {
                markOpening(tripIdx);
                void selectTripEvent?.(tripIdx, index, saveClip);
            }),
        );
        li.appendChild(events);
    }

    // A camera can keep the same file across several intervals. List it only
    // when it first appears, preferring a newly started camera for each row.
    const listedCandidates = new Set<VideoCandidate>();
    const fileRows = trip.frames.flatMap((frame, frameIdx) => {
        const channels = frameChannels(frame).filter((channel) => !listedCandidates.has(frame.channels[channel]!));
        for (const channel of channels) listedCandidates.add(frame.channels[channel]!);
        const channel = channels[0];
        return channel ? [{ frame, frameIdx, picked: { channel, candidate: frame.channels[channel]! } }] : [];
    });
    const filesList = document.createElement("ul");
    filesList.className = "trip-files";
    fileRows.forEach(({ frame, frameIdx, picked }, rowIndex) => {
        const primary = picked.candidate;
        const endFrameIdx = (fileRows[rowIndex + 1]?.frameIdx ?? trip.frames.length) - 1;

        const fli = document.createElement("li");
        recordingFocusKeys.set(fli, vendorFileKey(primary));
        // data-frame-index is used by updateActiveFrameHighlight to find the <li> without a full re-render.
        fli.dataset.frameIndex = String(frameIdx);
        fli.dataset.frameEndIndex = String(endFrameIdx);
        const frameCandidates = Object.values(frame.channels);
        const metadataUnresolvedForFrame = frameCandidates.some((candidate) => candidate.metadataReady === false);
        const gpsPendingForFrame = frameCandidates.some((candidate) => {
            const key = vendorFileKey(candidate);
            return state.pendingHeavyEmbeddedGps.has(key) || state.inflightEmbeddedGps.has(key);
        });
        const hasNoRecords =
            !metadataUnresolvedForFrame && !gpsPendingForFrame && frameCandidates.every((c) => c.records.length === 0);
        if (hasNoRecords) fli.classList.add("no-gps");
        if (
            state.active &&
            state.active.trip === tripIdx &&
            state.active.frame >= frameIdx &&
            state.active.frame <= endFrameIdx
        ) {
            fli.classList.add("active");
            fli.setAttribute("aria-current", "true");
        }

        const name = document.createElement("div");
        name.className = "file-name";
        name.textContent = primary.file.name;
        // Keyboard / AT control for "open this clip", like the trip title. The li
        // carries the same data-action for broad mouse clicks but stays a plain
        // li (no role=button), so the details toggle below can be an interactive
        // sibling without nesting a button inside a button (nested-interactive).
        name.dataset.action = "play-file";
        name.dataset.tripIndex = String(tripIdx);
        name.dataset.frameIndex = String(frameIdx);
        name.setAttribute("role", "button");
        name.tabIndex = 0;
        // Extra channel badges next to the name so the user can see rear/interior without expanding.
        const extras = (Object.keys(frame.channels) as Channel[]).filter((ch) => ch !== picked.channel);
        for (const ch of extras) {
            const tag = document.createElement("span");
            tag.className = "channel-tag";
            tag.textContent = `+${channelDisplayShortLabel(ch, trip)}`;
            tag.title = channelDisplayLabel(ch, trip);
            name.appendChild(tag);
        }
        fli.appendChild(name);

        const fmeta = document.createElement("div");
        fmeta.className = "file-meta";
        const fmetaText = document.createElement("span");
        fmetaText.className = "file-meta-text";
        const primaryKey = vendorFileKey(primary);
        const primaryGpsPending =
            state.pendingHeavyEmbeddedGps.has(primaryKey) || state.inflightEmbeddedGps.has(primaryKey);
        fmetaText.textContent = formatFileMeta(primary, trip.startUtc, primaryGpsPending);
        fmeta.appendChild(fmetaText);
        // Right-side chips, grouped in one wrapper so a frame carrying both keeps
        // them together instead of .file-meta's space-between spreading them apart.
        const fchips: HTMLElement[] = [];
        // Recording-mode chip - "normal" is the default loop recording and gets no
        // chip, only event/parking/manual clips are called out.
        if (primary.recordingMode && primary.recordingMode !== "normal") {
            const fmode = document.createElement("span");
            fmode.className = "vendor-chip";
            fmode.textContent = recordingModeLabel(primary.recordingMode);
            // Bonus hint: the source folder (e.g. "Event/Front"), when the camera
            // filed the clip under one - empty for a flat drop (no folder structure).
            const srcDir = primary.relativePath.split("/").slice(0, -1).join("/");
            if (srcDir) fmode.title = srcDir;
            fchips.push(fmode);
        }
        // Time-lapse chip - orthogonal to the mode chip (an A510 LA clip is both
        // parking AND time-lapse). Flags that the clip is sped up so its clock
        // and duration are not real time; the tooltip spells that out.
        if (primary.isTimelapse) {
            const ftl = document.createElement("span");
            ftl.className = "vendor-chip";
            ftl.textContent = t("trip.fileChip.timelapse");
            ftl.title = t("trip.fileChip.timelapseHint");
            fchips.push(ftl);
        }
        // No-gps chip - vendor chip removed (F4A in refactor-parser-pipeline.md).
        if (hasNoRecords) {
            const fnogps = document.createElement("span");
            fnogps.className = "vendor-chip warn";
            fnogps.textContent = t("trip.fileChip.noGps");
            fchips.push(fnogps);
        }
        if (fchips.length > 0) {
            const fchipWrap = document.createElement("span");
            fchipWrap.className = "file-meta-chips";
            for (const chip of fchips) fchipWrap.appendChild(chip);
            fmeta.appendChild(fchipWrap);
        }
        fli.appendChild(fmeta);

        // Broad mouse-click target (matches trip-header: the container carries
        // data-action, the inner .file-name is the focusable control). The
        // delegated listener resolves the click; the details toggle and any open
        // details panel are handled/guarded there.
        fli.dataset.action = "play-file";
        fli.dataset.tripIndex = String(tripIdx);
        // data-frame-index is already set above for updateActiveFrameHighlight.

        // Technical-details toggle: an opt-in, per-clip info button. Sibling of
        // the play targets (never nested in one), so it is a valid interactive
        // control. The panel itself is built lazily on first open (toggleFileDetails).
        const detailsBtn = document.createElement("button");
        detailsBtn.type = "button";
        detailsBtn.className = "file-details-toggle";
        detailsBtn.dataset.action = "file-details";
        detailsBtn.dataset.tripIndex = String(tripIdx);
        detailsBtn.dataset.frameIndex = String(frameIdx);
        detailsBtn.setAttribute("aria-expanded", "false");
        const detailsLabel = t("fileDetails.trigger");
        detailsBtn.setAttribute("aria-label", detailsLabel);
        detailsBtn.title = detailsLabel;
        // Lucide "info" glyph. Color/opacity from CSS.
        detailsBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>`;
        fli.appendChild(detailsBtn);

        filesList.appendChild(fli);
    });
    li.appendChild(filesList);

    // Keep the click "opening" spinner across a rebuild (refreshTripCard during
    // metadata read) until playback clears it via clearOpeningTrip (from playFrame).
    if (openingKeys && cands.some((candidate) => openingKeys?.has(vendorFileKey(candidate)))) {
        appendOpeningSpinner(li);
    }

    return li;
}

/**
 * Rebuilds ONE trip card in place (no full-list teardown), used when a single
 * trip's metadata completes so the rest of the list does not flicker. Preserves
 * keyboard focus if it was inside this card.
 */
export function refreshTripCard(tripIdx: number): void {
    const trip = state.trips[tripIdx];
    if (!trip) return;
    const before = renderedFilterFacts.get(tripIdx);
    const after = tripFilterFacts(trip, tripMetaFor(trip));
    // Metadata can establish a recording mode after the card first appears.
    // Reconcile even hidden trips so counts and membership stay current.
    if (
        !before ||
        before.kind !== after.kind ||
        before.event !== after.event ||
        before.manual !== after.manual ||
        before.notes !== after.notes ||
        before.favorites !== after.favorites
    ) {
        renderTrips();
        return;
    }
    refreshTripAnalysisStatus();
    const oldLi = dom.list.querySelector<HTMLElement>(`li.trip[data-trip-index="${tripIdx}"]`);
    if (!oldLi) return;
    const focus = captureListFocus(oldLi);
    oldLi.replaceWith(buildTripCard(trip, tripIdx));
    restoreListFocus(focus, dom.list);
    dom.list.setAttribute("aria-busy", state.trips.some(tripHasPending) ? "true" : "false");
}

/** Paints the one shared background-work status above the trip list. */
export function refreshTripAnalysisStatus(): void {
    const progress = state.recordingAnalysisProgress;
    if (!progress || progress.total <= 0) {
        dom.tripAnalysisStatus.hidden = true;
        return;
    }
    const completed = progress.completed;
    const percent = recordingAnalysisPercent(progress);
    dom.tripAnalysisPercent.textContent = `≈${percent}%`;
    dom.tripAnalysisProgress.textContent = t("sidebar.analysis.progress", {
        done: completed,
        total: progress.total,
    });
    dom.tripAnalysisProgressbar.setAttribute("aria-valuenow", String(percent));
    dom.tripAnalysisProgressFill.style.transform = `scaleX(${percent / 100})`;
    dom.tripAnalysisStatus.hidden = false;
}

// The recordings the user just clicked, shown with an "opening" spinner on their trip
// until playback takes over - instant acknowledgement that the click registered,
// independent of how long metadata read takes (in-player progress only escalates past a
// threshold, and on a fast backend that never fires). Source-qualified keys
// survive both regrouping and the File replacement used by container repair.
let openingKeys: Set<string> | null = null;

/** Adds the click-feedback spinner overlay to a card (idempotent per card). */
function appendOpeningSpinner(li: Element): void {
    li.classList.add("trip--opening");
    li.setAttribute("aria-busy", "true");
    const header = li.querySelector(".trip-header");
    if (header && !header.querySelector(".trip-opening-spinner")) {
        const spinner = document.createElement("div");
        spinner.className = "trip-opening-spinner";
        spinner.setAttribute("role", "status");
        const label = document.createElement("span");
        label.className = "trip-opening-label";
        label.textContent = t("recordingLoad.title");
        spinner.appendChild(label);
        header.appendChild(spinner);
    }
}

/** Marks a trip as "opening" and paints the spinner immediately (synchronous on
 *  click, before any async metadata read), so the click is never silent. */
function markOpening(tripIdx: number, frameIdx?: number): void {
    const trip = state.trips[tripIdx];
    const frame = frameIdx === undefined ? null : trip?.frames[frameIdx];
    const candidates = trip ? (frame ? Object.values(frame.channels) : tripAllCandidates(trip)) : [];
    clearOpeningTrip();
    if (candidates.length === 0) return;
    openingKeys = new Set(candidates.map((candidate) => vendorFileKey(candidate)));
    const li = dom.list.querySelector(`li.trip[data-trip-index="${tripIdx}"]`);
    if (li) appendOpeningSpinner(li);
}

/** Clears the "opening" spinner once playback takes over (or supersedes). Called
 *  by playFrame before it moves the card highlight, so no card keeps a spinner. */
export function clearOpeningTrip(): void {
    openingKeys = null;
    for (const el of dom.list.querySelectorAll(".trip--opening")) {
        el.classList.remove("trip--opening");
        el.querySelector(".trip-opening-spinner")?.remove();
        const tripIdx = Number((el as HTMLElement).dataset.tripIndex);
        const trip = Number.isInteger(tripIdx) ? state.trips[tripIdx] : undefined;
        if (trip && (tripHasProvisionalFacts(trip) || state.readingTrips.has(tripIdx))) {
            el.setAttribute("aria-busy", "true");
        } else {
            el.removeAttribute("aria-busy");
        }
    }
}

// Keyboard focus is captured before a (full or single-card) rebuild and restored
// after, so a re-render mid-interaction does not drop the user's place. Only the
// title (play-trip) and clip rows (play-file) are focusable; the header div that
// shares data-action="play-trip" is NOT, so restore must target the .trip-title.
//
// Keyed by source-qualified recording identity, not a volatile array index or
// File object: regrouping renumbers trips, and container repair can replace the
// File while keeping the same recording. Keys live in a WeakMap instead of DOM
// attributes because the canonical separator is a NUL character.
type ListFocus =
    | { kind: "title"; key: string }
    | { kind: "frame-action"; key: string; action: string }
    // Any trip-level control: toggling the star re-renders the list AND can
    // move the card into the favorites group, the chevron and the event chip
    // rebuild it outright - without this every keyboard press on one of them
    // drops focus to <body>. Not a fixed union: naming the controls one by one
    // is what left the chevron broken while the star next to it was fixed.
    | { kind: "action"; key: string; action: string };

const recordingFocusKeys = new WeakMap<Element, string>();

/** Stable identity of a trip across regrouping and constant-size repair. */
function tripFocusKey(trip: Trip): string | null {
    const candidate = tripAllCandidates(trip)[0];
    return candidate ? vendorFileKey(candidate) : null;
}

function captureListFocus(scope: Element): ListFocus | null {
    const el = document.activeElement;
    if (!(el instanceof HTMLElement) || !scope.contains(el)) return null;
    const card = el.closest("li.trip");
    if (!card || !scope.contains(card)) return null;
    const key = recordingFocusKeys.get(card);
    if (!key) return null;
    if (el.classList.contains("trip-title")) return { kind: "title", key };
    const action = el.dataset.action;
    if (action && el.dataset.frameIndex != null) {
        const row = el.closest(".trip-files > li");
        const frameKey = row ? recordingFocusKeys.get(row) : null;
        if (frameKey) return { kind: "frame-action", key: frameKey, action };
    }
    // Every remaining trip-level control, by construction rather than by list.
    // Frame-scoped ones are excluded: they repeat per clip, so `action` alone
    // would restore focus onto the first row instead of the one it left - the
    // branch above carries the recording key that gets it right.
    if (action && el.dataset.frameIndex == null) return { kind: "action", key, action };
    return null;
}

function restoreListFocus(focus: ListFocus | null, root: Element): void {
    if (!focus) return;
    const candidates =
        focus.kind === "frame-action"
            ? root.querySelectorAll<HTMLElement>(".trip-files > li")
            : root.querySelectorAll<HTMLElement>("li.trip");
    const owner = Array.from(candidates).find((candidate) => recordingFocusKeys.get(candidate) === focus.key);
    if (!owner) {
        // Removing a note or favorite can remove the focused card from the
        // filtered list. Keep keyboard navigation at the visible controls.
        if (hasTripFilters(state.tripFilters)) dom.tripFilterReset.focus({ preventScroll: true });
        return;
    }
    if (focus.kind === "title") {
        owner.querySelector<HTMLElement>(".trip-title")?.focus();
        return;
    }
    Array.from(owner.querySelectorAll<HTMLElement>("[data-action]"))
        .find((candidate) => candidate.dataset.action === focus.action)
        ?.focus();
}

/**
 * Returns the most important unresolved state for the trip card. Mandatory
 * recording metadata takes precedence over optional embedded GPS; active work
 * takes precedence over queued work within each stage.
 */
function computeTripLoadingState(trip: Trip, tripIdx: number): TripLoadingState {
    // Mandatory recording metadata takes precedence over deferred GPS:
    // until the moov is read the duration/distance shown are estimates, so the
    // meta must read as not-final regardless of the GPS state.
    if (state.readingTrips.has(tripIdx)) return "recordings-inflight";
    if (tripHasProvisionalFacts(trip)) return "recordings-pending";
    // Heavy embedded GPS may remain pending until the trip is opened.
    if (state.inflightEmbeddedGps.size === 0 && state.pendingHeavyEmbeddedGps.size === 0) {
        return "loaded";
    }
    let hasPending = false;
    for (const cand of tripAllCandidates(trip)) {
        // vendorFileKey is source/path/metadata-qualified, matching both ingest and deferred GPS
        // these sets: a bare-basename lookup would paint a stale spinner on a
        // different card that happens to share a filename (FILE0001.MP4 reuse).
        const key = vendorFileKey(cand);
        if (state.inflightEmbeddedGps.has(key)) return "gps-inflight";
        if (state.pendingHeavyEmbeddedGps.has(key)) hasPending = true;
    }
    return hasPending ? "gps-pending" : "loaded";
}

/** Whether any clip still has provisional byte-derived metadata. */
function tripHasPending(trip: Trip): boolean {
    return tripAllCandidates(trip).some(needsRecordingMetadata);
}

/** Whether any displayed duration/end/GPS fact is still provisional. */
function tripHasProvisionalFacts(trip: Trip): boolean {
    return tripAllCandidates(trip).some((candidate) => candidate.metadataReady === false);
}

function toggleExpanded(tripIdx: number): void {
    if (state.expandedTrips.has(tripIdx)) state.expandedTrips.delete(tripIdx);
    else state.expandedTrips.add(tripIdx);
    renderTrips();
}

/**
 * Lazily builds (on first open) and toggles the per-clip technical-details panel.
 * No re-render: the panel is a child of the clip <li>, shown/hidden by the
 * .file-details-open class, so the list's scroll position is undisturbed. The
 * panel is a snapshot at open time; a card rebuild after metadata arrives
 * discards it, so a subsequent open reflects the now-real metadata.
 */
function toggleFileDetails(tripIdx: number, frameIdx: number, btn: HTMLElement): void {
    const trip = state.trips[tripIdx];
    const frame = trip?.frames[frameIdx];
    if (!trip || !frame) return;
    const fli = btn.closest<HTMLElement>("li[data-frame-index]");
    if (!fli) return;
    if (!fli.querySelector(".file-details")) {
        const panel = document.createElement("div");
        panel.className = "file-details";
        panel.innerHTML = buildFileDetailsHtml(frame, trip);
        fli.appendChild(panel);
    }
    const open = fli.classList.toggle("file-details-open");
    btn.setAttribute("aria-expanded", open ? "true" : "false");
}

/** Returns a <li> with aggregate stats across all trips: "8 trips · 3h 47m · 142 km". */
function buildSummaryItem(trips: Trip[]): HTMLLIElement {
    const li = document.createElement("li");
    li.className = "trip-summary";
    if (trips.some(tripHasProvisionalFacts)) {
        li.textContent = t("plurals.trip", { n: trips.length });
        return li;
    }
    let totalDuration = 0;
    let totalDistance = 0;
    for (const trip of trips) {
        // Footage duration (pauses removed) - matches the per-card duration.
        totalDuration += trip.timeline.contentDurationSec;
        totalDistance += trip.distanceKm;
    }
    // ICU plurals handle Russian/English rules automatically.
    const parts = [t("plurals.trip", { n: trips.length }), formatDuration(totalDuration)];
    if (totalDistance > 0) {
        parts.push(formatTripDistance(totalDistance));
    }
    li.textContent = parts.join(" · ");
    return li;
}

/**
 * Applies a preview dataURL as the background-image of a trip hero card and adds the has-preview class
 * (CSS enables the gradient overlay). Extracted because it is called both at initial render (renderTrips)
 * and when a preview becomes available asynchronously (updateTripPreview).
 */
function applyTripPreviewBackground(header: HTMLElement, dataUrl: string): void {
    // Defense-in-depth: dataURL must start with "data:image/" - our source (trip-preview-worker.toDataURL)
    // guarantees this, but a prefix check prevents "javascript:..." from leaking into CSS if the source ever changes.
    if (!dataUrl.startsWith("data:image/")) return;
    // dataURL from toDataURL contains a comma but not double quotes or \n. Safe in CSS url("...").
    // Still escape " in case of a future generator regression.
    header.style.backgroundImage = `url("${dataUrl.replace(/"/g, "%22")}")`;
    header.classList.add("has-preview");
}

/**
 * Updates the preview background on one trip card without re-rendering the sidebar.
 * Called by the background generator in trip-preview.ts as each preview becomes ready.
 * A full renderTrips() here would rebuild the DOM N times on a long list and steal clicks.
 */
export function updateTripPreview(trip: Trip, dataUrl: string): void {
    // Resolve the trip's CURRENT index - the background preview run outlives
    // regroups, and an index captured at schedule time pointed at whatever
    // card now occupies that slot. A trip no longer in state.trips (orphaned
    // by a regroup) simply skips the paint; carryOverTripPreviews or the next
    // scheduled run covers its successor.
    const tripIdx = state.trips.indexOf(trip);
    if (tripIdx < 0) return;
    const tripLi = dom.list.querySelector(`li.trip[data-trip-index="${tripIdx}"]`);
    if (!tripLi) return;
    const header = tripLi.querySelector<HTMLElement>(".trip-header");
    if (!header) return;
    applyTripPreviewBackground(header, dataUrl);
    // The thumbnail arrived: drop the static placeholder glyph so the hero
    // photo shows cleanly.
    tripLi.querySelector(".trip-no-preview-icon")?.remove();
}

/**
 * Updates the active-frame highlight without re-rendering the list.
 * Looks up the <li> by data-trip-index and data-frame-index.
 * Does not recreate DOM so scroll position and transitions are undisturbed.
 */
export function updateActiveFrameHighlight(tripIdx: number, prevFrameIdx: number, nextFrameIdx: number): void {
    const trip = state.trips[tripIdx];
    if (!trip) return;
    const tripLi = dom.list.querySelector<HTMLLIElement>(`li.trip[data-trip-index="${tripIdx}"]`);
    if (!tripLi) return;
    setFrameRowActive(tripLi, trip, prevFrameIdx, false);
    setFrameRowActive(tripLi, trip, nextFrameIdx, true);
}

/** Toggles the active class + aria-current on the clip row that covers frame
 *  `frameIdx` of `trip` inside its card. Out-of-range indices are ignored. */
function setFrameRowActive(tripLi: HTMLLIElement, trip: Trip, frameIdx: number, on: boolean): void {
    if (frameIdx < 0 || frameIdx >= trip.frames.length) return;
    const row = Array.from(tripLi.querySelectorAll<HTMLLIElement>(".trip-files > li")).find(
        (candidate) =>
            frameIdx >= Number(candidate.dataset.frameIndex) && frameIdx <= Number(candidate.dataset.frameEndIndex),
    );
    if (!row) return;
    row.classList.toggle("active", on);
    if (on) row.setAttribute("aria-current", "true");
    else row.removeAttribute("aria-current");
}

/**
 * Moves the active highlight from one trip card to another without rebuilding
 * the list: the card's and the clip row's active class + aria-current are the
 * only things in a card that depend on the active trip (see buildTripCard), and
 * a full renderTrips on every trip switch cost tens of milliseconds of DOM work
 * on long libraries - on every auto-advance between trips, mid-playback.
 * `prev` is null when no trip was active before.
 */
export function syncActiveTripHighlight(
    prev: { trip: number; frame: number } | null,
    next: { trip: number; frame: number },
): void {
    const setTripActive = (location: { trip: number; frame: number }, on: boolean): void => {
        const trip = state.trips[location.trip];
        const tripLi = dom.list.querySelector<HTMLLIElement>(`li.trip[data-trip-index="${location.trip}"]`);
        if (!trip || !tripLi) return;
        tripLi.classList.toggle("active", on);
        if (on) tripLi.setAttribute("aria-current", "true");
        else tripLi.removeAttribute("aria-current");
        setFrameRowActive(tripLi, trip, location.frame, on);
    };
    if (prev && prev.trip !== next.trip) setTripActive(prev, false);
    setTripActive(next, true);
}

export function syncSortControls(): void {
    dom.sortKey.value = state.tripSortKey;
    const desc = state.tripSortDir === "desc";
    dom.sortDir.textContent = desc ? "↓" : "↑";
    const label = desc ? t("sidebar.sort.dir.desc") : t("sidebar.sort.dir.asc");
    dom.sortDir.setAttribute("aria-label", label);
    dom.sortDir.setAttribute("title", label);
}

export function initSidebar(cb: SidebarCallbacks): void {
    selectTripEvent = cb.onPlayTripEvent;
    initSidebarFilters(renderTrips);
    dom.sortKey.addEventListener("change", () => {
        // Type guard: value comes from a <select> we control. Unknown values are ignored rather than cast as any.
        const v = dom.sortKey.value;
        if (isTripSortKey(v)) state.tripSortKey = v;
        renderTrips();
    });

    dom.sortDir.addEventListener("click", () => {
        state.tripSortDir = state.tripSortDir === "desc" ? "asc" : "desc";
        syncSortControls();
        renderTrips();
    });

    // Delegated click listener instead of per-element. On long trips with 100+ frames, per-element
    // listeners add 1000+ registrations; delegation uses one listener on dom.list.
    // Action is read from data-action; context from data-trip-index / data-frame-index.
    // closest() walks up in DOM-bubble order: chevron inside header means a click on chevron finds the chevron element first, not the header.
    dom.list.addEventListener("click", (ev) => {
        const target = ev.target;
        if (!(target instanceof Element)) return;
        // Clicks inside an expanded technical-details panel do nothing: allow text
        // selection and never start playback of the clip row hosting it.
        if (target.closest(".file-details")) return;
        const actionEl = target.closest<HTMLElement>("[data-action]");
        if (!actionEl) return;
        const action = actionEl.dataset.action;
        if (action === "reset-trip-filters") {
            resetTripFilters();
            renderTrips();
            dom.tripFilterKinds.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
            return;
        }
        const tripIdxStr = actionEl.dataset.tripIndex;
        if (!tripIdxStr) return;
        const tripIdx = Number(tripIdxStr);
        if (!Number.isFinite(tripIdx)) return;

        if (action === "chevron") {
            toggleExpanded(tripIdx);
        } else if (action === "play-trip") {
            markOpening(tripIdx);
            void cb.onPlayTrip(tripIdx);
        } else if (action === "play-file") {
            const frameIdxStr = actionEl.dataset.frameIndex;
            if (!frameIdxStr) return;
            const frameIdx = Number(frameIdxStr);
            if (Number.isFinite(frameIdx)) {
                markOpening(tripIdx, frameIdx);
                void cb.onPlayFrame(tripIdx, frameIdx);
            }
        } else if (action === "trip-events") {
            // UX-08: cycle through trip event markers. Stop propagation - the chip is inside trip-meta
            // (which has no data-action play-trip), but the header above could intercept via closest.
            ev.stopPropagation();
            const trip = state.trips[tripIdx];
            if (!trip || trip.events.length === 0 || !cb.onPlayTripEvent) return;
            const next = ((tripEventCycleIdx.get(tripIdx) ?? -1) + 1) % trip.events.length;
            tripEventCycleIdx.set(tripIdx, next);
            markOpening(tripIdx);
            void cb.onPlayTripEvent(tripIdx, next);
        } else if (action === "trip-fav") {
            // Stop propagation - the button sits inside the header, which
            // carries data-action="play-trip".
            ev.stopPropagation();
            const trip = state.trips[tripIdx];
            if (!trip) return;
            setTripMeta(trip, { isFavorite: tripMetaFor(trip)?.isFavorite !== true });
            renderTrips();
        } else if (action === "trip-edit") {
            ev.stopPropagation();
            const trip = state.trips[tripIdx];
            if (trip) cb.onEditTripMeta?.(trip);
        } else if (action === "file-details") {
            // Stop propagation - the button sits inside the clip li, which carries
            // data-action="play-file"; without this the closest() walk on bubble
            // would also trigger playback.
            ev.stopPropagation();
            const frameIdxStr = actionEl.dataset.frameIndex;
            if (!frameIdxStr) return;
            const frameIdx = Number(frameIdxStr);
            if (Number.isFinite(frameIdx)) toggleFileDetails(tripIdx, frameIdx, actionEl);
        }
    });

    // Keyboard activation for the focusable trip title / clip rows (role=button).
    // Enter/Space on the focused element replays the click path above (busy state
    // + playback callbacks), so there is one source of truth for opening footage.
    dom.list.addEventListener("keydown", (ev) => {
        if (ev.key !== "Enter" && ev.key !== " " && ev.key !== "Spacebar") return;
        const target = ev.target;
        if (!(target instanceof HTMLElement)) return;
        // Only the element that OWNS the play action acts (not a bubbled key from
        // a nested control); the chevron/event-chip are real <button>s with their
        // own default activation.
        if (target.dataset.action !== "play-trip" && target.dataset.action !== "play-file") return;
        ev.preventDefault(); // Space would otherwise scroll the list
        target.click();
    });

    // Same trick for units: trip-meta strings carry "x km" / "y mi", and the
    // summary row aggregates them. Without this the inline speed toggle flips
    // the player overlay but leaves the sidebar showing the old unit.
    subscribeUnitsChange(() => {
        renderTrips();
    });
}
