// Time-scale renderer for the horizontal range slider / chart.
// Renders labels into a host container based on viewStartPct/EndPct.
// One label per tick - "0:00 | 17:03:00" (relative from trip start + absolute
// clock separated by "|"). Ticks are visualized via a ::before pseudo-element
// on the label (a short tick mark to the left of the text); no separate tick
// elements are created so the ruler fits in a single line without consuming
// vertical space.

import { contentToWallUtc, displayClockDate, type Trip } from "../trips.js";

import { formatClock } from "./date-format.js";
import { formatTime } from "./format.js";
import { pickRulerInterval } from "./strip-zoom.js";

/** Display clock (camera clock when known) - see displayClockDate contract. */
function formatAbsoluteClock(unixSec: number, withSeconds: boolean, cameraTzSec: number | null): string {
    return formatClock(displayClockDate(unixSec, cameraTzSec), { seconds: withSeconds });
}

/**
 * Fills host with .range-ruler-label elements. Each label shows relative +
 * absolute time via " | " so the ruler fits in a single line. Ticks land on
 * multiples of intervalSec aligned to the trip's wall-clock start (predictable
 * ticks: "0:00 | 17:30:00, 0:05 | 17:30:05").
 *
 * leftFrac/rightFrac are the timeline gutters (getTimelineView) as fractions
 * of the host width. They are baked into each label's left:% here because the
 * labels are position:absolute - percentage offsets resolve against the host's
 * padding box, so host padding cannot shift them (unlike the in-flow strip
 * canvas, which does get aligned via wrap padding).
 *
 * Labels are left-edge-aligned to the tick point (no translateX) so the
 * ::before tick mark points at the exact moment. Edge clamp: the last label
 * may overflow the right edge of the slider - clipped via .is-edge-r (right: 0).
 */
// Estimated rendered width of one "0:00 | 17:00:00" label at 10px mono.
// 14 chars × ~6px = ~84-90px; use 92 to detect overlap of the edge-r-pinned
// last label with the previous one on short trips (4s/2s = 3 labels at
// 0/50/100% where middle and edge-r visually clash) - without dropping labels
// that honestly fit on wide viewports.
const ESTIMATED_LABEL_WIDTH_PX = 92;

export function renderRangeRuler(
    host: HTMLElement,
    trip: Trip,
    viewStartPct: number,
    viewEndPct: number,
    leftFrac: number,
    rightFrac: number,
): void {
    host.innerHTML = "";
    // Footage-time axis: viewStart/EndPct come from the content-based xScale, so
    // the ruler length must be the content duration too (pauses removed).
    const dur = trip.timeline.contentDurationSec;
    if (dur <= 0) return;
    const visStart = viewStartPct * dur;
    const visEnd = viewEndPct * dur;
    const visDur = Math.max(0.001, visEnd - visStart);
    // Ticks live inside the gutter-inset content span of the row.
    const contentFrac = Math.max(0.01, 1 - leftFrac - rightFrac);
    // Content width in CSS px is needed so pickRulerInterval can compute the
    // maximum possible number of labels without overlap. On a mobile chart
    // ~340 px = ~3 labels (instead of the default 7), labels do not merge.
    const hostWidth = host.clientWidth;
    const intervalSec = pickRulerInterval(visDur, hostWidth * contentFrac);
    const withSeconds = intervalSec < 60;
    // Aligned to the trip's wall-clock START: on the first content segment the
    // absolute labels land on round times (17:30:00, 17:30:05, ...). Relative
    // offsets on the same ticks are uneven from the trip start - the price of
    // round absolute, still readable.
    //
    // Known limitation: after a recording pause the labels drift off the round
    // grid by the accumulated pause durations (contentToWallUtc adds them) -
    // e.g. 17:42:18, 17:42:23. The values stay correct, only the roundness is
    // lost; per-segment re-alignment would make tick SPACING uneven inside one
    // ruler, which reads worse than off-grid labels.
    const wallOffset = Math.floor(trip.startUtc) % intervalSec;
    const firstTick = Math.ceil((visStart + wallOffset) / intervalSec) * intervalSec - wallOffset;
    type Tick = { t: number; xPct: number; edgeR: boolean };
    const ticks: Tick[] = [];
    for (let t = firstTick; t <= visEnd + 0.5; t += intervalSec) {
        if (t < visStart - 0.5) continue;
        // Window fraction -> host-width percentage, gutter-aware (the same
        // mapping timelineSecToFrac applies), so ticks line up with the
        // playhead/thumb/range tabs across every chart-visibility mode.
        const winFrac = (t - visStart) / visDur;
        const xPct = (leftFrac + winFrac * contentFrac) * 100;
        ticks.push({ t, xPct, edgeR: winFrac > 0.96 });
    }
    // The edge-r label is pinned at the content right edge, so it occupies
    // [hostWidth*(1-rightFrac)-LABEL_WIDTH, hostWidth*(1-rightFrac)]. The
    // previous label at natural left: [xPct*hostWidth/100, +LABEL_WIDTH]. On
    // short trips (3 ticks) they overlap. Drop the second-to-last label if it
    // intrudes into the edge-r zone.
    if (hostWidth > 0 && ticks.length >= 2) {
        const last = ticks[ticks.length - 1];
        if (last?.edgeR) {
            const edgeAnchorLeftPx = hostWidth * (1 - rightFrac) - ESTIMATED_LABEL_WIDTH_PX;
            for (let i = ticks.length - 2; i >= 0; i--) {
                const prev = ticks[i];
                if (prev === undefined) break;
                const prevLeftPx = (prev.xPct / 100) * hostWidth;
                const prevRightPx = prevLeftPx + ESTIMATED_LABEL_WIDTH_PX;
                if (prevRightPx > edgeAnchorLeftPx) ticks.splice(i, 1);
                else break;
            }
        }
    }
    const frag = document.createDocumentFragment();
    for (const tick of ticks) {
        const labelEl = document.createElement("div");
        labelEl.className = "range-ruler-label";
        // is-edge-r pins the last label to the content right edge (the class
        // right:0 is overridden inline with the gutter) to prevent overflow.
        // The left edge is already the base position (translateX=0), so no
        // is-edge-l is needed.
        if (tick.edgeR) {
            labelEl.classList.add("is-edge-r");
            labelEl.style.right = `${(rightFrac * 100).toFixed(3)}%`;
        } else {
            labelEl.style.left = `${tick.xPct.toFixed(3)}%`;
        }
        const rel = formatTime(tick.t);
        // tick.t is footage-sec; map to wall-clock for the absolute clock label
        // (so it skips paused time and stays the real time of that footage).
        const abs = formatAbsoluteClock(contentToWallUtc(trip.timeline, tick.t), withSeconds, trip.cameraTzSec);
        labelEl.textContent = `${rel} | ${abs}`;
        frag.appendChild(labelEl);
    }
    host.appendChild(frag);
}
