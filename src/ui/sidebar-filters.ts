import { t } from "../i18n/index.js";
import type { I18nKey } from "../i18n/keys.js";
import { hasTripFilters, matchesTripFilters } from "../trip-filters.js";
import type { TripFilterFacts, TripFilterKind, TripToggleFilter } from "../trip-filters.js";
import { dom } from "./dom.js";
import { state } from "./state.js";

const kindLabels: Record<TripFilterKind, I18nKey> = {
    all: "sidebar.filter.all",
    normal: "sidebar.filter.normal",
    parking: "sidebar.filter.parking",
};
const toggleLabels: Record<TripToggleFilter, I18nKey> = {
    event: "sidebar.filter.event",
    manual: "sidebar.filter.manual",
    notes: "sidebar.filter.notes",
    favorites: "sidebar.bucket.favorites",
};

function filterButton(): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "trip-filter";
    button.setAttribute("aria-controls", "trip-list");
    const label = document.createElement("span");
    label.className = "trip-filter__label";
    const count = document.createElement("span");
    count.className = "trip-filter__count";
    count.setAttribute("aria-hidden", "true");
    button.append(label, count);
    return button;
}

/**
 * Moves focus to the first visible filter control: the "All" chip while the
 * tray is open, the search field otherwise. Used when the focused control
 * disappears (a chip whose count dropped to zero) or after a reset.
 */
export function focusTripFilterStart(): void {
    const target = dom.tripFilterTray.hidden
        ? dom.tripSearch
        : dom.tripFilterKinds.querySelector<HTMLButtonElement>("button");
    target?.focus({ preventScroll: true });
}

function addToggleButton(filter: TripToggleFilter, onChange: () => void): void {
    const button = filterButton();
    button.dataset.tripFilterToggle = filter;
    button.addEventListener("click", () => {
        state.tripFilters[filter] = !state.tripFilters[filter];
        onChange();
        if (button.hidden) focusTripFilterStart();
    });
    dom.tripFilterOptions.append(button);
}

// Typing re-renders the whole list; one render per pause keeps keystrokes
// responsive on a long library.
const SEARCH_DEBOUNCE_MS = 150;

export function initSidebarFilters(onChange: () => void): void {
    for (const kind of Object.keys(kindLabels) as TripFilterKind[]) {
        const button = filterButton();
        button.dataset.tripFilterKind = kind;
        button.addEventListener("click", () => {
            state.tripFilters.kind = kind;
            onChange();
        });
        dom.tripFilterKinds.append(button);
    }
    for (const filter of Object.keys(toggleLabels) as TripToggleFilter[]) {
        addToggleButton(filter, onChange);
    }
    dom.tripFilterReset.addEventListener("click", () => {
        resetTripFilters();
        onChange();
        focusTripFilterStart();
    });
    dom.tripFilterToggle.addEventListener("click", () => {
        const open = dom.tripFilterTray.hidden;
        dom.tripFilterTray.hidden = !open;
        dom.tripFilterToggle.setAttribute("aria-expanded", open ? "true" : "false");
    });
    let searchTimer: ReturnType<typeof setTimeout> | undefined;
    dom.tripSearch.addEventListener("input", () => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => {
            if (state.tripFilters.query === dom.tripSearch.value) return;
            state.tripFilters.query = dom.tripSearch.value;
            onChange();
        }, SEARCH_DEBOUNCE_MS);
    });
}

export function resetTripFilters(): void {
    state.tripFilters.kind = "all";
    state.tripFilters.event = false;
    state.tripFilters.manual = false;
    state.tripFilters.notes = false;
    state.tripFilters.favorites = false;
    state.tripFilters.query = "";
    dom.tripSearch.value = "";
}

function updateButton(button: HTMLButtonElement, key: I18nKey, count: number, pressed: boolean): void {
    button.hidden = count === 0 && !pressed;
    button.querySelector<HTMLElement>(".trip-filter__label")!.textContent = t(key);
    button.querySelector<HTMLElement>(".trip-filter__count")!.textContent = String(count);
    button.setAttribute("aria-pressed", String(pressed));
    button.setAttribute("aria-label", `${t(key)} · ${t("plurals.trip", { n: count })}`);
}

export function syncSidebarFilters(facts: readonly TripFilterFacts[]): void {
    dom.tripFilters.hidden = facts.length === 0;
    if (facts.length === 0) resetTripFilters();
    dom.tripFilterKinds.setAttribute("aria-label", t("sidebar.filter.kind"));
    dom.tripFilterOptions.setAttribute("aria-label", t("sidebar.filter.options"));
    for (const button of dom.tripFilterKinds.querySelectorAll<HTMLButtonElement>("button")) {
        const kind = button.dataset.tripFilterKind as TripFilterKind;
        const count = facts.filter((fact) => matchesTripFilters(fact, { ...state.tripFilters, kind })).length;
        const pressed = state.tripFilters.kind === kind;
        updateButton(button, kindLabels[kind], count, pressed);
        if (kind === "all") button.hidden = false;
    }
    for (const button of dom.tripFilterOptions.querySelectorAll<HTMLButtonElement>("button")) {
        const filter = button.dataset.tripFilterToggle as TripToggleFilter;
        const filters =
            filter === "event" || filter === "manual"
                ? { ...state.tripFilters, event: filter === "event", manual: filter === "manual" }
                : { ...state.tripFilters, [filter]: true };
        const count = facts.filter((fact) => matchesTripFilters(fact, filters)).length;
        updateButton(button, toggleLabels[filter], count, state.tripFilters[filter]);
        if (filter === "event" || filter === "manual") {
            button.title = t(filter === "event" ? "sidebar.filter.eventHint" : "sidebar.filter.manualHint");
        }
    }
    dom.tripFilterOptions.hidden = Array.from(
        dom.tripFilterOptions.querySelectorAll<HTMLButtonElement>("button"),
    ).every((button) => button.hidden);
    const shown = facts.filter((fact) => matchesTripFilters(fact, state.tripFilters)).length;
    const result = t("sidebar.filter.result", { shown, total: facts.length });
    if (dom.tripFilterResult.textContent !== result) dom.tripFilterResult.textContent = result;
    dom.tripFilterReset.textContent = t("sidebar.filter.reset");
    dom.tripFilterReset.hidden = !hasTripFilters(state.tripFilters);
    dom.tripFilterResult.parentElement!.hidden = !hasTripFilters(state.tripFilters);
    // Chip filters only: the query is visible in its own field.
    const { kind, event, manual, notes, favorites } = state.tripFilters;
    const activeChips = Number(kind !== "all") + Number(event) + Number(manual) + Number(notes) + Number(favorites);
    dom.tripFilterCount.hidden = activeChips === 0;
    dom.tripFilterCount.textContent = String(activeChips);
    const toggleLabel = t("sidebar.filter.toggle");
    dom.tripFilterToggle.setAttribute("aria-label", activeChips > 0 ? `${toggleLabel} · ${activeChips}` : toggleLabel);
}
