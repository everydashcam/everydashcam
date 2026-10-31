// Jump-to-date calendar for the date-sorted trip list: a month grid of the
// days that hold trips in the current list (after filters and search), shaded
// by drive time, with event and parking marks. Picking a day scrolls the list
// to that day's section; the list itself stays unfiltered.

import { getDateLocale, t } from "../i18n/index.js";
import { firstDayOfWeek, monthGridCells, weekdayOrder } from "./calendar-grid.js";
import { dom } from "./dom.js";
import { cachedDateTimeFormat, formatDayHeading, formatMonthHeading } from "./format.js";
import { createPopover } from "./popover-lifecycle.js";

/** One day section of the rendered list, summarized for the calendar. */
export interface TripListDayStats {
    /** The layout key of the day section ("d:2026-10-31"). */
    readonly key: string;
    readonly year: number;
    /** 0-based, like Date. */
    readonly month: number;
    readonly day: number;
    readonly tripCount: number;
    /** Footage of the day's drives, parking excluded. */
    readonly driveSec: number;
    readonly hasEvents: boolean;
    readonly hasParking: boolean;
}

interface TripJumpOptions {
    /** Day sections of the current list, in any order; empty when it is not grouped by date. */
    days: () => readonly TripListDayStats[];
    /** Key of the day at the top of the list's viewport; the calendar opens on its month. */
    currentDayKey: () => string | null;
    /** Scrolls the list to a day section, opening it if folded, and focuses its heading. */
    jumpToDay: (key: string) => void;
}

// Drive time that paints a day at full strength; longer days stay at the cap.
const FULL_HEAT_DRIVE_SEC = 2 * 3600;

let options: TripJumpOptions | null = null;
let popover: ReturnType<typeof createPopover> | null = null;
/** Month shown in the grid, as year * 12 + month. */
let shownMonth = 0;

const monthIndex = (year: number, month: number): number => year * 12 + month;

function element<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className: string,
    text?: string,
): HTMLElementTagNameMap[K] {
    const el = document.createElement(tag);
    el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
}

function stepButton(step: -1 | 1, disabled: boolean): HTMLButtonElement {
    const button = element("button", "trip-jump__step", step < 0 ? "‹" : "›");
    button.type = "button";
    button.dataset.step = String(step);
    button.disabled = disabled;
    const label = t(step < 0 ? "sidebar.jump.prev" : "sidebar.jump.next");
    button.setAttribute("aria-label", label);
    button.title = label;
    return button;
}

/** Rebuilds the grid for shownMonth from the current list. */
function render(): void {
    if (!options) return;
    const days = options.days();
    const panel = dom.tripJumpPanel;
    panel.replaceChildren();
    if (days.length === 0) return;
    const byKey = new Map(days.map((day) => [day.key, day]));
    const months = days.map((day) => monthIndex(day.year, day.month));
    const first = Math.min(...months);
    const last = Math.max(...months);
    shownMonth = Math.min(last, Math.max(first, shownMonth));
    const year = Math.floor(shownMonth / 12);
    const month = shownMonth % 12;
    const locale = getDateLocale();

    const header = element("div", "trip-jump__header");
    const title = element("span", "trip-jump__title", formatMonthHeading(year, month));
    title.id = "trip-jump-title";
    header.append(stepButton(-1, shownMonth <= first), title, stepButton(1, shownMonth >= last));

    const grid = element("div", "trip-jump__grid");
    grid.setAttribute("role", "group");
    grid.setAttribute("aria-labelledby", title.id);
    const weekStart = firstDayOfWeek(locale);
    const weekdayFormat = cachedDateTimeFormat(locale, { weekday: "narrow", timeZone: "UTC" });
    for (const weekday of weekdayOrder(weekStart)) {
        // January 4, 2026 is a Sunday, so day 4 + n is weekday n.
        const label = element(
            "span",
            "trip-jump__weekday",
            weekdayFormat.format(new Date(Date.UTC(2026, 0, 4 + weekday))),
        );
        label.setAttribute("aria-hidden", "true");
        grid.appendChild(label);
    }
    const pad = (value: number): string => String(value).padStart(2, "0");
    for (const cell of monthGridCells(year, month, weekStart)) {
        if (cell === null) {
            grid.appendChild(element("span", "trip-jump__blank"));
            continue;
        }
        const key = `d:${year}-${pad(month + 1)}-${pad(cell)}`;
        const stats = byKey.get(key);
        const button = element("button", "trip-jump__day");
        button.type = "button";
        button.appendChild(element("span", "trip-jump__number", String(cell)));
        const date = formatDayHeading(year, month, cell).date;
        if (!stats) {
            button.disabled = true;
            button.setAttribute("aria-label", date);
        } else {
            button.dataset.dayKey = key;
            button.style.setProperty("--heat", String(Math.min(1, stats.driveSec / FULL_HEAT_DRIVE_SEC)));
            button.setAttribute("aria-label", `${date} · ${t("plurals.trip", { n: stats.tripCount })}`);
            if (stats.hasEvents) button.appendChild(element("span", "trip-jump__event"));
            if (stats.hasParking) button.appendChild(element("span", "trip-jump__parking"));
        }
        grid.appendChild(button);
    }

    const legend = element("div", "trip-jump__legend");
    legend.setAttribute("aria-hidden", "true");
    legend.append(
        element("span", "trip-jump__legend-heat", t("sidebar.jump.driveTime")),
        element("span", "trip-jump__legend-event", t("player.nav.events")),
        element("span", "trip-jump__legend-parking", t("sidebar.filter.parking")),
    );
    panel.append(header, grid, legend);
}

/** Focuses the day the list is on, or the first day with trips in the shown month. */
function focusInitialDay(preferredKey: string | null): void {
    const panel = dom.tripJumpPanel;
    const preferred = preferredKey
        ? Array.from(panel.querySelectorAll<HTMLButtonElement>(".trip-jump__day:enabled")).find(
              (button) => button.dataset.dayKey === preferredKey,
          )
        : undefined;
    (preferred ?? panel.querySelector<HTMLButtonElement>(".trip-jump__day:enabled"))?.focus();
}

/**
 * Arrow keys walk the grid by day (left/right) and week (up/down), skipping
 * days without trips; there is no wrap into the neighbouring month.
 */
function moveFocus(event: KeyboardEvent): void {
    const steps: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    const step = steps[event.key];
    const from = event.target;
    if (step === undefined || !(from instanceof HTMLButtonElement) || !from.classList.contains("trip-jump__day"))
        return;
    event.preventDefault();
    // Weekday labels and blanks keep the cell positions aligned to the 7-column grid.
    const cells = Array.from(dom.tripJumpPanel.querySelectorAll(".trip-jump__grid > *"));
    for (let index = cells.indexOf(from) + step; index >= 0 && index < cells.length; index += step) {
        const cell = cells[index];
        if (cell instanceof HTMLButtonElement && cell.classList.contains("trip-jump__day") && !cell.disabled) {
            cell.focus();
            return;
        }
    }
}

export function initTripJump(jumpOptions: TripJumpOptions): void {
    options = jumpOptions;
    const panel = dom.tripJumpPanel;
    let preferredKey: string | null = null;
    popover = createPopover({
        button: dom.tripJump,
        panel,
        afterOpen: () => focusInitialDay(preferredKey),
    });
    dom.tripJump.addEventListener("click", () => {
        if (!popover || !options) return;
        if (popover.isOpen) {
            popover.close();
            return;
        }
        preferredKey = options.currentDayKey();
        const match = preferredKey?.match(/^d:(\d{4})-(\d{2})/);
        if (match) shownMonth = monthIndex(Number(match[1]), Number(match[2]) - 1);
        else shownMonth = Math.max(...options.days().map((day) => monthIndex(day.year, day.month)));
        render();
        popover.open();
    });
    panel.addEventListener("click", (event) => {
        const target = event.target instanceof Element ? event.target : null;
        const step = target?.closest<HTMLButtonElement>("[data-step]");
        if (step && !step.disabled) {
            shownMonth += Number(step.dataset.step);
            render();
            // The clicked step may be disabled now; keep focus inside the panel.
            (
                panel.querySelector<HTMLButtonElement>(`[data-step="${step.dataset.step}"]:enabled`) ??
                panel.querySelector<HTMLButtonElement>(".trip-jump__day:enabled")
            )?.focus();
            return;
        }
        const day = target?.closest<HTMLButtonElement>("[data-day-key]");
        if (day?.dataset.dayKey && options) {
            popover?.close();
            options.jumpToDay(day.dataset.dayKey);
        }
    });
    panel.addEventListener("keydown", moveFocus);
}

/**
 * Shows the calendar button while the list has day sections and refreshes an
 * open calendar after the list changed; with no sections it closes it.
 */
export function syncTripJump(hasDaySections: boolean): void {
    dom.tripJump.hidden = !hasDaySections;
    if (!popover?.isOpen) return;
    if (hasDaySections) render();
    else popover.close();
}
