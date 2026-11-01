// Trip sidebar: aggregate stats, sorting, month/day sections, trip headers with chevron, and expanded frame list.
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
    formatBytes,
    formatDayHeading,
    formatMonthHeading,
    formatTime,
    formatTimeRange,
    formatTotalDuration,
    formatTripClockTitle,
    formatTripRowMeta,
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
import { focusTripFilterStart, initSidebarFilters, resetTripFilters, syncSidebarFilters } from "./sidebar-filters.js";
import { tripSearchText } from "./trip-search.js";
import { readTripDensity, writeTripDensity } from "./trip-density-pref.js";
import { initTripJump, syncTripJump } from "./trip-jump.js";
import type { TripListDayStats } from "./trip-jump.js";
import { foldParkingRuns, groupByMonthDay, nodeEntries, tripDayKey } from "./trip-list-layout.js";
import type { TripListDay, TripListMonth, TripListNode, TripListParkingNode } from "./trip-list-layout.js";

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

// Lucide glyphs repeated on every card. Each is parsed once and cloned per use:
// re-parsing the same markup for every card was a measurable share of a full
// rebuild on long libraries.
const STAR_ICON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z"/></svg>`;
const PENCIL_ICON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/></svg>`;
const FILM_ICON = `<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M7 3v18"/><path d="M3 7.5h4"/><path d="M3 12h18"/><path d="M3 16.5h4"/><path d="M17 3v18"/><path d="M17 7.5h4"/><path d="M17 16.5h4"/></svg>`;
const ALERT_ICON = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>`;
const CARET_ICON = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="trip-group-toggle__caret"><path d="m6 9 6 6 6-6"/></svg>`;
const PIN_OFF_ICON = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12.75 7.09a3 3 0 0 1 2.16 2.16"/><path d="M17.072 17.072c-1.634 2.17-3.527 3.912-4.471 4.727a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 1.432-4.568"/><path d="m2 2 20 20"/><path d="M8.475 2.818A8 8 0 0 1 20 10c0 1.183-.31 2.377-.81 3.533"/><path d="M9.13 9.13a3 3 0 0 0 3.74 3.74"/></svg>`;
const CHEVRON_RIGHT_ICON = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>`;
// Lucide arrow-down-wide-narrow / arrow-up-narrow-wide for the sort direction.
const SORT_DESC_ICON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m3 16 4 4 4-4"/><path d="M7 20V4"/><path d="M11 4h10"/><path d="M11 8h7"/><path d="M11 12h4"/></svg>`;
const SORT_ASC_ICON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m3 8 4-4 4 4"/><path d="M7 4v16"/><path d="M11 12h4"/><path d="M11 16h7"/><path d="M11 20h10"/></svg>`;
const INFO_ICON = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>`;
const parsedIcons = new Map<string, Element>();

/** Returns a fresh copy of the trusted icon markup, parsing it only on first use. */
function cloneIcon(markup: string): Node {
    let parsed = parsedIcons.get(markup);
    if (!parsed) {
        const template = document.createElement("template");
        template.innerHTML = markup;
        const element = template.content.firstElementChild;
        if (!element) throw new Error("icon markup has no element");
        parsed = element;
        parsedIcons.set(markup, parsed);
    }
    return parsed.cloneNode(true);
}

// Collapsed off-screen cards skip rendering (content-visibility: auto in
// sidebar.css) and take their height from contain-intrinsic-block-size. The
// browser remembers a card's real height only on that element, so a rebuilt card
// would fall back to the generic estimate: every off-screen card with a note or
// an event list would then shift the restored scroll position. Carry the last
// laid-out height onto the replacement instead.
const CARD_HEIGHT_PROPERTY = "contain-intrinsic-block-size";

/**
 * Measures the inner heights of the collapsed cards currently in the list, keyed
 * by recording identity. Call only while layout is already current (renderTrips
 * reads scrollTop first), or the reads force a layout of the list being replaced.
 */
function captureCollapsedCardHeights(): Map<string, number> {
    const heights = new Map<string, number>();
    // Rects report painted sizes, which the mobile drawer's FLIP animation
    // scales. One computed (layout) height yields the factor for every card;
    // getComputedStyle per card would be slow in WebKit on long lists.
    let paintScale = 0;
    let borderHeight = 0;
    for (const card of dom.list.querySelectorAll<HTMLElement>("li.trip:not(.expanded)")) {
        const key = recordingFocusKeys.get(card);
        if (!key) continue;
        const paintedHeight = card.getBoundingClientRect().height;
        if (paintScale === 0) {
            const style = getComputedStyle(card);
            const layoutHeight = Number.parseFloat(style.height);
            // No boxes (a hidden ancestor): nothing worth carrying.
            if (!(layoutHeight > 0 && paintedHeight > 0)) return heights;
            paintScale = paintedHeight / layoutHeight;
            borderHeight = Number.parseFloat(style.borderTopWidth) + Number.parseFloat(style.borderBottomWidth);
        }
        heights.set(key, paintedHeight / paintScale - borderHeight);
    }
    return heights;
}

/** Seeds a rebuilt card's off-screen height with its predecessor's measurement. */
function seedCardHeight(card: HTMLElement, heights: ReadonlyMap<string, number>): void {
    const key = recordingFocusKeys.get(card);
    const height = key === undefined ? undefined : heights.get(key);
    if (height !== undefined) card.style.setProperty(CARD_HEIGHT_PROPERTY, `auto ${height}px`);
}

// Month and day sections the user collapsed. Session-only: a reload starts
// with every section open. Keys come from trip-list-layout ("m:2026-10").
const collapsedGroups = new Set<string>();
// Parking runs the user opened; runs start folded ("p:" keys).
const expandedParkingRuns = new Set<string>();
// Section key per rendered section <li>, kept off the DOM like recordingFocusKeys:
// parking-run keys carry recording identities.
const groupKeys = new WeakMap<Element, string>();
// Day sections of the last render, summarized for the jump-to-date calendar;
// empty when the list is not sorted by date.
let renderedDays: TripListDayStats[] = [];
// Preview stack of each rendered parking run, keyed by the run's top trip, so a
// preview that arrives later paints the run too. Rebuilt on every render.
const parkingRunThumbs = new Map<Trip, HTMLElement>();
// Recording identity of the active trip the list last revealed (revealActiveTrip).
let revealedActiveKey: string | null = null;
// Section ids only need to be unique within the document for aria-controls.
let groupIdCounter = 0;

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
    const cardHeights = captureCollapsedCardHeights();

    dom.list.innerHTML = "";
    parkingRunThumbs.clear();
    dom.list.classList.toggle("is-rows", state.tripListDensity === "rows");
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
        const facts = filterFactsFor(trip);
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

    const appendCards: AppendCards = (entries, parent, dayKey) => {
        for (const { trip, idx } of entries) {
            const card = buildTripCard(trip, idx, dayKey);
            seedCardHeight(card, cardHeights);
            parent.appendChild(card);
        }
    };
    // Click handling is delegated in initSidebar (see dom.list listener). data-action attributes on header/chevron/file-li are sufficient.

    // The floated favorites always get their own section - in every sort mode,
    // or they read as trips mysteriously out of order. It looks and folds like
    // a month, so the list speaks one heading language.
    if (favoriteCount > 0) {
        dom.list.appendChild(
            buildBandSection(
                "f:favorites",
                t("sidebar.bucket.favorites"),
                displayed.slice(0, favoriteCount),
                appendCards,
            ),
        );
    }
    const rest = displayed.slice(favoriteCount);
    renderedDays = [];
    if (state.tripSortKey === "date") {
        // Month and day sections only make sense in date order.
        const chronology = entries.map(({ trip, idx }) => ({ trip, tripIdx: idx })).sort((a, b) => cmp(a.trip, b.trip));
        if (state.tripSortDir === "desc") chronology.reverse();
        const nodes = foldParkingRuns(
            chronology,
            (trip) => tripFocusKey(trip) ?? `start:${trip.startUtc}`,
            new Set(rest.map(({ idx }) => idx)),
        );
        const months = groupByMonthDay(nodes);
        renderedDays = months.flatMap((month) => month.days.map(dayJumpStats));
        for (const month of months) dom.list.appendChild(buildMonthSection(month, appendCards));
    } else {
        // Under other sorts a single "everything else" section follows the favorites.
        if (favoriteCount > 0 && rest.length > 0) {
            dom.list.appendChild(buildBandSection("o:others", t("sidebar.bucket.others"), rest, appendCards));
        } else {
            appendCards(rest, dom.list, null);
        }
    }

    if (state.unindexed.size > 0) {
        const note = document.createElement("li");
        note.className = "trip unindexed-note";
        note.innerHTML = `<div class="trip-header"><div class="trip-title">${t("sidebar.unindexed.title")}</div><div class="trip-meta">${t("sidebar.unindexed.note", { n: state.unindexed.size })}</div></div><button type="button" class="recognition-help-link feedback-link" data-feedback-preset="load">${t("recognition.contact")}</button>`;
        dom.list.appendChild(note);
    }

    revealActiveTrip();
    syncTripJump(renderedDays.length > 0);

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

/** Appends cards for `entries`; a row can omit a date only when its day heading names it. */
type AppendCards = (entries: readonly { trip: Trip; idx: number }[], parent: Element, dayKey: string | null) => void;

/** A top-level section outside the months (favorites, everything else) in the month band style. */
function buildBandSection(
    key: string,
    label: string,
    entries: readonly { trip: Trip; idx: number }[],
    appendCards: AppendCards,
): HTMLLIElement {
    const { section, list } = buildGroupSection(key, "trip-month", [
        textSpan("trip-group-toggle__label", label),
        // A count only: totals of hand-picked trips say nothing.
        textSpan("trip-group-toggle__stats", String(entries.length)),
    ]);
    appendCards(entries, list, null);
    return section;
}

function textSpan(className: string, text: string): HTMLSpanElement {
    const span = document.createElement("span");
    span.className = className;
    span.textContent = text;
    return span;
}

/**
 * A collapsible section <li>: a sticky header whose toggle button controls the
 * nested list. The collapsed state comes from collapsedGroups, so a full
 * re-render keeps what the user folded.
 */
function buildGroupSection(
    key: string,
    className: string,
    toggleContent: readonly Node[],
): { section: HTMLLIElement; list: HTMLUListElement } {
    const section = document.createElement("li");
    section.className = `trip-group ${className}`;
    groupKeys.set(section, key);
    const collapsed = isGroupCollapsed(key);
    section.classList.toggle("is-collapsed", collapsed);
    const header = document.createElement("div");
    header.className = `trip-group__header ${className}__header`;
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "trip-group-toggle";
    toggle.dataset.action = "toggle-group";
    const listId = `trip-group-${++groupIdCounter}`;
    toggle.setAttribute("aria-controls", listId);
    toggle.setAttribute("aria-expanded", collapsed ? "false" : "true");
    toggle.append(cloneIcon(CARET_ICON), ...toggleContent);
    header.appendChild(toggle);
    const list = document.createElement("ul");
    list.className = "trip-group__list";
    list.id = listId;
    section.append(header, list);
    return { section, list };
}

function nodeTrips(nodes: readonly TripListNode[]): Trip[] {
    return nodes.flatMap((node) => nodeEntries(node).map((entry) => entry.trip));
}

function isGroupCollapsed(key: string): boolean {
    return key.startsWith("p:") ? !expandedParkingRuns.has(key) : collapsedGroups.has(key);
}

function rememberGroupCollapsed(key: string, collapsed: boolean): void {
    if (key.startsWith("p:")) {
        if (collapsed) expandedParkingRuns.delete(key);
        else expandedParkingRuns.add(key);
    } else if (collapsed) {
        collapsedGroups.add(key);
    } else {
        collapsedGroups.delete(key);
    }
}

function buildMonthSection(month: TripListMonth, appendCards: AppendCards): HTMLLIElement {
    const trips = month.days.flatMap((day) => nodeTrips(day.nodes));
    const { section, list } = buildGroupSection(month.key, "trip-month", [
        textSpan("trip-group-toggle__label", formatMonthHeading(month.year, month.month)),
        textSpan("trip-group-toggle__stats", tripsSummaryText(trips)),
    ]);
    for (const day of month.days) list.appendChild(buildDaySection(day, appendCards));
    return section;
}

function buildDaySection(day: TripListDay, appendCards: AppendCards): HTMLLIElement {
    const heading = formatDayHeading(day.year, day.month, day.day);
    const content: Node[] = [textSpan("trip-group-toggle__label", heading.relative ?? heading.date)];
    if (heading.relative) content.push(textSpan("trip-group-toggle__date", heading.date));
    content.push(buildDayStats(day));
    const { section, list } = buildGroupSection(day.key, "trip-day", content);
    for (const node of day.nodes) {
        if (node.kind === "trip") appendCards([{ trip: node.entry.trip, idx: node.entry.tripIdx }], list, day.key);
        else list.appendChild(buildParkingRun(node, appendCards, day.key));
    }
    return section;
}

/** A day section summarized for the jump-to-date calendar. */
function dayJumpStats(day: TripListDay): TripListDayStats {
    const entries = day.nodes.flatMap((node) => nodeEntries(node));
    let driveSec = 0;
    for (const { trip } of entries) if (!trip.isParking) driveSec += trip.timeline.contentDurationSec;
    return {
        key: day.key,
        year: day.year,
        month: day.month,
        day: day.day,
        tripCount: entries.length,
        driveSec,
        hasEvents: entries.some(
            ({ trip, tripIdx }) => trip.events.length > 0 || renderedFilterFacts.get(tripIdx)?.event,
        ),
        hasParking: entries.some(({ trip }) => trip.isParking),
    };
}

/** The rendered section <li> with a layout key, if any. */
function findGroupSection(selector: string, key: string): HTMLElement | undefined {
    return Array.from(dom.list.querySelectorAll<HTMLElement>(selector)).find(
        (section) => groupKeys.get(section) === key,
    );
}

/**
 * Brings a day section to the top of the list, below the stuck month heading:
 * opens its month and the day if folded, scrolls, briefly highlights the
 * heading and moves focus there, where the calendar left the user.
 */
function jumpToDay(key: string): void {
    const section = findGroupSection("li.trip-day", key);
    if (!section) return;
    const month = section.parentElement?.closest<HTMLElement>("li.trip-month");
    if (month?.classList.contains("is-collapsed")) setGroupCollapsed(month, false);
    if (section.classList.contains("is-collapsed")) setGroupCollapsed(section, false);
    // Instant, then once more after a frame: off-screen cards render with an
    // estimated height (content-visibility in sidebar.css), and the cards drawn
    // around the target settle to their real height after the first jump. A
    // smooth scroll would aim at the estimate and stop short.
    section.scrollIntoView({ block: "start", behavior: "instant" });
    requestAnimationFrame(() => section.scrollIntoView({ block: "start", behavior: "instant" }));
    section.classList.remove("is-jump-target");
    // Restart the highlight animation when jumping to the same day twice.
    void section.offsetWidth;
    section.classList.add("is-jump-target");
    section.addEventListener("animationend", () => section.classList.remove("is-jump-target"), { once: true });
    section
        .querySelector<HTMLElement>(":scope > .trip-group__header > .trip-group-toggle")
        ?.focus({ preventScroll: true });
}

/** Key of the first day section still visible below the stuck month heading. */
function currentDayKey(): string | null {
    const top = dom.sidebar.getBoundingClientRect().top;
    for (const section of dom.list.querySelectorAll<HTMLElement>("li.trip-day")) {
        if (section.getBoundingClientRect().bottom > top + 40) return groupKeys.get(section) ?? null;
    }
    return null;
}

/**
 * A day heading's totals with a red dot when the day holds events (detected or
 * event recordings) and a "P" when it holds parking, so a folded day still
 * says whether it is worth opening.
 */
function buildDayStats(day: TripListDay): HTMLElement {
    const entries = day.nodes.flatMap((node) => nodeEntries(node));
    const stats = document.createElement("span");
    stats.className = "trip-group-toggle__stats";
    if (entries.some(({ trip, tripIdx }) => trip.events.length > 0 || renderedFilterFacts.get(tripIdx)?.event)) {
        const dot = textSpan("trip-day__event-dot", "");
        dot.setAttribute("aria-hidden", "true");
        stats.appendChild(dot);
    }
    stats.append(tripsSummaryText(entries.map((entry) => entry.trip)));
    if (entries.some(({ trip }) => trip.isParking)) {
        const parking = textSpan("trip-day__parking-mark", t("trip.chip.parking"));
        parking.setAttribute("aria-label", recordingModeLabel("parking"));
        stats.appendChild(parking);
    }
    return stats;
}

/**
 * A run of parking trips as one row: a night of motion clips is often a dozen
 * one-minute trips. Folded by default; unfolding lists the trips themselves,
 * which keep every card action.
 */
function buildParkingRun(node: TripListParkingNode, appendCards: AppendCards, dayKey: string): HTMLLIElement {
    const trips = node.entries.map((entry) => entry.trip);
    let first = trips[0]!;
    let endUtc = first.endUtc;
    let bytes = 0;
    let events = 0;
    for (const trip of trips) {
        if (trip.startUtc < first.startUtc) first = trip;
        endUtc = Math.max(endUtc, trip.endUtc);
        bytes += trip.totalBytes;
        events += trip.events.length;
    }
    // A stack of previews: the top one is the run's first trip in list order,
    // painted when its preview arrives (see updateTripPreview).
    const thumb = document.createElement("span");
    thumb.className = "trip-parking-run__thumb";
    thumb.setAttribute("aria-hidden", "true");
    thumb.appendChild(textSpan("trip-parking-run__count", `×${trips.length}`));
    const top = trips[0]!;
    if (top.previewDataUrl) {
        applyTripPreviewBackground(thumb, top.previewDataUrl);
    } else {
        const icon = document.createElement("span");
        icon.className = "trip-no-preview-icon";
        icon.appendChild(cloneIcon(FILM_ICON));
        thumb.appendChild(icon);
    }
    parkingRunThumbs.set(top, thumb);

    const title = document.createElement("span");
    title.className = "trip-parking-run__title";
    const badge = textSpan("trip-parking-run__badge", t("trip.chip.parking"));
    badge.setAttribute("aria-hidden", "true");
    title.append(
        badge,
        textSpan(
            "trip-parking-run__range",
            t("sidebar.parkingRun.title", { range: formatTimeRange(first.startUtc, endUtc, first.cameraTzSec) }),
        ),
    );
    const meta = document.createElement("span");
    meta.className = "trip-parking-run__meta";
    meta.append(`${t("plurals.trip", { n: trips.length })} · `);
    if (events > 0) {
        const eventCount = document.createElement("span");
        eventCount.className = "trip-parking-run__events";
        eventCount.setAttribute("aria-label", `${t("player.nav.events")}: ${events}`);
        eventCount.append(cloneIcon(ALERT_ICON), String(events));
        meta.append(eventCount, " · ");
    }
    meta.append(formatBytes(bytes));
    const text = document.createElement("span");
    text.className = "trip-parking-run__text";
    text.append(title, meta);

    const { section, list } = buildGroupSection(node.key, "trip-parking-run", [thumb, text]);
    appendCards(
        node.entries.map((entry) => ({ trip: entry.trip, idx: entry.tripIdx })),
        list,
        dayKey,
    );
    return section;
}

/**
 * Folds or unfolds one section (month, day or parking run) in place and
 * remembers the choice.
 * Folding a section whose header is stuck to the top would leave the reader
 * somewhere further down the list, so the section is scrolled back to its
 * header.
 */
function setGroupCollapsed(section: HTMLElement, collapsed: boolean): void {
    const key = groupKeys.get(section);
    if (key === undefined) return;
    rememberGroupCollapsed(key, collapsed);
    const header = section.querySelector<HTMLElement>(":scope > .trip-group__header");
    const wasStuck =
        collapsed && header !== null && section.getBoundingClientRect().top < header.getBoundingClientRect().top - 1;
    section.classList.toggle("is-collapsed", collapsed);
    header?.querySelector(".trip-group-toggle")?.setAttribute("aria-expanded", collapsed ? "false" : "true");
    if (wasStuck) section.scrollIntoView({ block: "start", behavior: "instant" });
}

/**
 * Opens every collapsed section around the active trip's card, once per
 * activation: the trip that starts playing must be visible in the list, but a
 * section the user folds afterwards stays folded.
 */
function revealActiveTrip(): void {
    const active = state.active;
    const trip = active ? state.trips[active.trip] : undefined;
    if (!active || !trip) {
        revealedActiveKey = null;
        return;
    }
    const key = tripFocusKey(trip);
    if (key === null || key === revealedActiveKey) return;
    // A trip hidden by the filters has no card; a later render reveals it.
    const card = dom.list.querySelector(`li.trip[data-trip-index="${active.trip}"]`);
    if (!card) return;
    revealedActiveKey = key;
    let section = card.parentElement?.closest<HTMLElement>("li.trip-group");
    while (section) {
        if (section.classList.contains("is-collapsed")) setGroupCollapsed(section, false);
        section = section.parentElement?.closest<HTMLElement>("li.trip-group");
    }
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
    favBtn.appendChild(cloneIcon(STAR_ICON));
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
    editBtn.appendChild(cloneIcon(PENCIL_ICON));
    actions.appendChild(editBtn);
    return actions;
}

/**
 * Builds one trip card <li> (header, hero/loading state, chips, meta, clip list).
 * Extracted from renderTrips so a single card can be rebuilt in place
 * (refreshTripCard) without tearing down the whole list while recording data
 * arrives in the background.
 */
function buildTripCard(trip: Trip, tripIdx: number, dayKey: string | null): HTMLLIElement {
    const li = document.createElement("li");
    li.className = "trip";
    // Compact rows reuse every control of the card; only the header layout and
    // the preview size differ (see the is-rows rules in sidebar.css).
    const asRow = state.tripListDensity === "rows";
    if (asRow) li.classList.add("trip--row");
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
    // A parking run can cross midnight: only omit the date when the heading
    // actually names this trip's day.
    const shownTitle = asRow && dayKey === tripDayKey(trip) ? formatTripClockTitle(trip, !provisional) : generatedTitle;
    title.textContent = tripMeta?.name || shownTitle;
    if (tripMeta?.name || shownTitle !== generatedTitle) title.title = generatedTitle;
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

    // First-frame preview: the hero card background (CSS .trip-header sets
    // aspect-ratio 3/1 with a gradient overlay for text readability), or the
    // row's small thumbnail.
    const previewHost = asRow ? document.createElement("div") : header;
    if (asRow) {
        previewHost.className = "trip-thumb";
        header.appendChild(previewHost);
        // The row's duration rides on its preview, like a video thumbnail.
        if (!provisional) {
            previewHost.appendChild(textSpan("trip-thumb__duration", formatTime(trip.timeline.contentDurationSec)));
        }
    }
    if (hasPreview && trip.previewDataUrl) {
        applyTripPreviewBackground(previewHost, trip.previewDataUrl);
    } else {
        // A muted film glyph is stable while the preview is pending and remains
        // as the final fallback when extraction fails.
        const icon = document.createElement("div");
        icon.className = "trip-no-preview-icon";
        icon.setAttribute("aria-hidden", "true");
        icon.appendChild(cloneIcon(FILM_ICON));
        previewHost.appendChild(icon);
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
    chevronIcon.appendChild(cloneIcon(CHEVRON_RIGHT_ICON));
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
    }
    // A row says "no GPS" in its meta line, where the distance would be.
    const noGps = !readFailed && !provisional && !gpsPending && !recordsHaveGps(trip.records);
    if (noGps && !asRow) {
        const noGpsChip = document.createElement("span");
        noGpsChip.className = "trip-vendor-badge warn";
        noGpsChip.textContent = t("trip.chip.noGps");
        badgeChips.push(noGpsChip);
    }
    const actions = buildTripActions(tripIdx, tripMeta?.isFavorite === true);
    // The chips and the event chip share one flag cluster in a row; on a card
    // the chips follow the actions in the top-left corner.
    const flagSlot = document.createElement("div");
    if (asRow) {
        previewHost.appendChild(actions);
        flagSlot.className = "trip-row-flags";
        // A favorite row says so with a gold star among its flags; the star
        // button itself only shows over the preview on hover or focus.
        if (tripMeta?.isFavorite) {
            const star = document.createElement("span");
            star.className = "trip-row-fav";
            star.setAttribute("aria-hidden", "true");
            star.appendChild(cloneIcon(STAR_ICON));
            flagSlot.appendChild(star);
        }
        for (const chip of badgeChips) flagSlot.appendChild(chip);
        header.appendChild(flagSlot);
    } else {
        flagSlot.className = "trip-corner-slot";
        flagSlot.appendChild(actions);
        for (const chip of badgeChips) flagSlot.appendChild(chip);
        header.appendChild(flagSlot);
    }
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
        const count = document.createElement("span");
        count.className = "num mono";
        count.textContent = String(trip.events.length);
        evchip.append(cloneIcon(ALERT_ICON), count);
        (asRow ? flagSlot : header).appendChild(evchip);
    }

    const meta = document.createElement("div");
    meta.className = "trip-meta";
    const metaText = document.createElement("span");
    metaText.className = "trip-meta-text";
    const loadingState = computeTripLoadingState(trip, tripIdx);
    metaText.textContent = asRow ? formatTripRowMeta(trip, loadingState) : formatTripMeta(trip, loadingState);
    if (asRow && noGps) {
        const noGpsNote = textSpan("trip-meta-nogps", t("trip.chip.noGps"));
        noGpsNote.prepend(cloneIcon(PIN_OFF_ICON));
        metaText.prepend(noGpsNote, " · ");
    }
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

    // Clip rows exist only while the card is expanded: a collapsed card never
    // shows them, and building them for every card dominated full rebuilds on
    // long libraries. toggleExpanded adds and removes them in place.
    if (state.expandedTrips.has(tripIdx)) li.appendChild(buildTripFileList(trip, tripIdx));

    // Keep the click "opening" spinner across a rebuild (refreshTripCard during
    // metadata read) until playback clears it via clearOpeningTrip (from playFrame).
    if (openingKeys && cands.some((candidate) => openingKeys?.has(vendorFileKey(candidate)))) {
        appendOpeningSpinner(li);
    }

    return li;
}

/**
 * Builds the clip rows of an expanded card: one row per recording at the
 * interval where it first appears, with its play target, metadata chips and
 * details toggle. The active row reflects state.active at build time; later
 * moves go through setFrameRowActive.
 */
function buildTripFileList(trip: Trip, tripIdx: number): HTMLUListElement {
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
        detailsBtn.appendChild(cloneIcon(INFO_ICON));
        fli.appendChild(detailsBtn);

        filesList.appendChild(fli);
    });
    return filesList;
}

/**
 * Filter facts for one trip. The search text costs several date formats per
 * trip, so it is built only while a search is active.
 */
function filterFactsFor(trip: Trip): TripFilterFacts {
    const meta = tripMetaFor(trip);
    return tripFilterFacts(trip, meta, state.tripFilters.query.trim() ? tripSearchText(trip, meta) : "");
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
    const after = filterFactsFor(trip);
    // Metadata can establish a recording mode after the card first appears.
    // Reconcile even hidden trips so counts and membership stay current.
    if (
        !before ||
        before.kind !== after.kind ||
        before.event !== after.event ||
        before.manual !== after.manual ||
        before.notes !== after.notes ||
        before.favorites !== after.favorites ||
        before.searchText !== after.searchText
    ) {
        renderTrips();
        return;
    }
    refreshTripAnalysisStatus();
    const oldLi = dom.list.querySelector<HTMLElement>(`li.trip[data-trip-index="${tripIdx}"]`);
    if (!oldLi) return;
    const focus = captureListFocus(oldLi);
    const daySection = oldLi.closest(".trip-day");
    const card = buildTripCard(trip, tripIdx, daySection ? (groupKeys.get(daySection) ?? null) : null);
    // Reuse the height seeded by the last full render. Measuring the old card
    // here would force a list layout on every call, and ingest refreshes many
    // cards in one task.
    const seededHeight = oldLi.style.getPropertyValue(CARD_HEIGHT_PROPERTY);
    if (seededHeight) card.style.setProperty(CARD_HEIGHT_PROPERTY, seededHeight);
    oldLi.replaceWith(card);
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
    // move the card into the favorites group, and any full render (units,
    // filters, regroup) rebuilds every card - without this a keyboard user on
    // one of these controls drops to <body>. Not a fixed union, so a control
    // added later is covered without being named here.
    | { kind: "action"; key: string; action: string }
    // A month/day section toggle; the key is the section's layout key.
    | { kind: "group"; key: string };

const recordingFocusKeys = new WeakMap<Element, string>();

/** Stable identity of a trip across regrouping and constant-size repair. */
function tripFocusKey(trip: Trip): string | null {
    const candidate = tripAllCandidates(trip)[0];
    return candidate ? vendorFileKey(candidate) : null;
}

function captureListFocus(scope: Element): ListFocus | null {
    const el = document.activeElement;
    if (!(el instanceof HTMLElement) || !scope.contains(el)) return null;
    if (el.dataset.action === "toggle-group") {
        const section = el.closest("li.trip-group");
        const key = section ? groupKeys.get(section) : undefined;
        return key === undefined ? null : { kind: "group", key };
    }
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
    if (focus.kind === "group") {
        const section = Array.from(root.querySelectorAll("li.trip-group")).find(
            (candidate) => groupKeys.get(candidate) === focus.key,
        );
        section?.querySelector<HTMLElement>(":scope > .trip-group__header > .trip-group-toggle")?.focus();
        return;
    }
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

/**
 * Expands or collapses one card in place. Nothing else in the list depends on
 * the expanded set, so a full renderTrips here only cost time; the chevron
 * element survives, which also keeps its keyboard focus.
 */
function toggleExpanded(tripIdx: number, chevron: HTMLElement): void {
    const trip = state.trips[tripIdx];
    const card = chevron.closest<HTMLLIElement>("li.trip");
    if (!trip || !card) return;
    const expanded = !state.expandedTrips.has(tripIdx);
    if (expanded) state.expandedTrips.add(tripIdx);
    else state.expandedTrips.delete(tripIdx);
    // Rows are rebuilt on every expand rather than kept hidden, so they never
    // carry state that went stale while the card was collapsed.
    card.querySelector(":scope > .trip-files")?.remove();
    // Last child, matching buildTripCard (the opening spinner lives in the header).
    if (expanded) card.appendChild(buildTripFileList(trip, tripIdx));
    card.classList.toggle("expanded", expanded);
    const label = expanded ? t("trip.chevron.collapse") : t("trip.chevron.expand");
    chevron.setAttribute("aria-label", label);
    chevron.setAttribute("aria-expanded", expanded ? "true" : "false");
    chevron.title = label;
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
    li.textContent = tripsSummaryText(trips);
    return li;
}

/** "8 trips · 3h 47min · 142 km"; only the count while any duration or distance is provisional. */
function tripsSummaryText(trips: readonly Trip[]): string {
    if (trips.some(tripHasProvisionalFacts)) return t("plurals.trip", { n: trips.length });
    let totalDuration = 0;
    let totalDistance = 0;
    for (const trip of trips) {
        // Footage duration (pauses removed) - matches the per-card duration.
        totalDuration += trip.timeline.contentDurationSec;
        totalDistance += trip.distanceKm;
    }
    // ICU plurals handle Russian/English rules automatically.
    const parts = [t("plurals.trip", { n: trips.length }), formatTotalDuration(totalDuration)];
    if (totalDistance > 0) {
        parts.push(formatTripDistance(totalDistance));
    }
    return parts.join(" · ");
}

/**
 * Applies a preview dataURL as the background-image of a trip hero card (or a
 * row's thumbnail) and adds the has-preview class (CSS enables the gradient overlay). Extracted because it is called both at initial render (renderTrips)
 * and when a preview becomes available asynchronously (updateTripPreview).
 */
function applyTripPreviewBackground(target: HTMLElement, dataUrl: string): void {
    // Defense-in-depth: dataURL must start with "data:image/" - our source (trip-preview-worker.toDataURL)
    // guarantees this, but a prefix check prevents "javascript:..." from leaking into CSS if the source ever changes.
    if (!dataUrl.startsWith("data:image/")) return;
    // dataURL from toDataURL contains a comma but not double quotes or \n. Safe in CSS url("...").
    // Still escape " in case of a future generator regression.
    target.style.backgroundImage = `url("${dataUrl.replace(/"/g, "%22")}")`;
    target.classList.add("has-preview");
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
    const runThumb = parkingRunThumbs.get(trip);
    if (runThumb) {
        applyTripPreviewBackground(runThumb, dataUrl);
        runThumb.querySelector(".trip-no-preview-icon")?.remove();
    }
    const tripIdx = state.trips.indexOf(trip);
    if (tripIdx < 0) return;
    const tripLi = dom.list.querySelector(`li.trip[data-trip-index="${tripIdx}"]`);
    if (!tripLi) return;
    const host = tripLi.querySelector<HTMLElement>(".trip-thumb") ?? tripLi.querySelector<HTMLElement>(".trip-header");
    if (!host) return;
    applyTripPreviewBackground(host, dataUrl);
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
    revealActiveTrip();
}

export function syncSortControls(): void {
    dom.sortKey.value = state.tripSortKey;
    const desc = state.tripSortDir === "desc";
    dom.sortDir.replaceChildren(cloneIcon(desc ? SORT_DESC_ICON : SORT_ASC_ICON));
    const label = desc ? t("sidebar.sort.dir.desc") : t("sidebar.sort.dir.asc");
    dom.sortDir.setAttribute("aria-label", label);
    dom.sortDir.setAttribute("title", label);
}

function syncDensityControl(): void {
    for (const option of dom.tripDensity.querySelectorAll<HTMLButtonElement>("[data-density]")) {
        option.setAttribute("aria-pressed", option.dataset.density === state.tripListDensity ? "true" : "false");
    }
}

export function initSidebar(cb: SidebarCallbacks): void {
    selectTripEvent = cb.onPlayTripEvent;
    initSidebarFilters(renderTrips);
    state.tripListDensity = readTripDensity();
    syncDensityControl();
    initTripJump({ days: () => renderedDays, currentDayKey, jumpToDay });
    dom.tripDensity.addEventListener("click", (event) => {
        const option = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-density]") : null;
        const density = option?.dataset.density;
        if ((density !== "cards" && density !== "rows") || density === state.tripListDensity) return;
        state.tripListDensity = density;
        writeTripDensity(state.tripListDensity);
        syncDensityControl();
        renderTrips();
    });
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
            focusTripFilterStart();
            return;
        }
        if (action === "toggle-group") {
            const section = actionEl.closest<HTMLElement>("li.trip-group");
            if (section) setGroupCollapsed(section, !section.classList.contains("is-collapsed"));
            return;
        }
        const tripIdxStr = actionEl.dataset.tripIndex;
        if (!tripIdxStr) return;
        const tripIdx = Number(tripIdxStr);
        if (!Number.isFinite(tripIdx)) return;

        if (action === "chevron") {
            toggleExpanded(tripIdx, actionEl);
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
