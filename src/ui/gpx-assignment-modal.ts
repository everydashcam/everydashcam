// Manual GPX-to-trip assignment for an unassociated batch. The dialog pauses only
// sidecar classification; skipping it leaves the recording ingest untouched.

import { t } from "../i18n/index.js";
import { totalDistanceKm } from "../parser.js";
import { formatDistanceFromKm } from "../units-pref.js";
import { formatDuration, formatNumber } from "./format.js";
import { GpxRoutePreview } from "./gpx-route-preview.js";
import type { LooseGpxAssignment } from "./loose-gpx-assignment.js";
import type { LooseGpxChoice, LooseGpxPlan } from "./loose-gpx.js";
import { activateModal, deactivateModal, wireBackdropDismiss } from "./modal-helper.js";
import { createModalResult } from "./modal-result.js";

interface GpxAssignmentCopy {
    tripLabel: (name: string) => string;
    unassigned: string;
    alreadyHasGps: string;
    timeMatches: string;
    timeMismatch: string;
    timeUncertain: string;
}

interface GpxAssignmentElements {
    modal: HTMLElement;
    list: HTMLDivElement;
    map: HTMLDivElement;
    previewName: HTMLElement;
    previewSummary: HTMLElement;
    skip: HTMLButtonElement;
    apply: HTMLButtonElement;
}

interface AssignmentRow {
    plan: LooseGpxPlan;
    root: HTMLDivElement;
    trackButton: HTMLButtonElement;
    select: HTMLSelectElement;
    summary: string;
}

let rows: AssignmentRow[] = [];
let routePreview: GpxRoutePreview | null = null;
const modalResult = createModalResult<LooseGpxAssignment[]>();
let pendingSignal: AbortSignal | null = null;
let pendingAbort: (() => void) | null = null;
let isInitialized = false;
let elements: GpxAssignmentElements | null = null;

function requireElement<T extends HTMLElement>(id: string): T {
    const element = document.getElementById(id);
    if (!element) throw new Error(`element #${id} not found`);
    return element as T;
}

function assignmentElements(): GpxAssignmentElements {
    return {
        modal: requireElement("gpx-assignment-modal"),
        list: requireElement("gpx-assignment-list"),
        map: requireElement("gpx-assignment-map"),
        previewName: requireElement("gpx-assignment-preview-name"),
        previewSummary: requireElement("gpx-assignment-preview-summary"),
        skip: requireElement("gpx-assignment-skip"),
        apply: requireElement("gpx-assignment-apply"),
    };
}

function displayPath(plan: LooseGpxPlan): string {
    return plan.track.file.file.relativePath || plan.track.file.file.file.name;
}

function trackSummary(plan: LooseGpxPlan): string {
    const records = plan.track.records;
    const distance = formatDistanceFromKm(totalDistanceKm(records));
    const distanceText = `${formatNumber(distance.value, distance.value < 10 ? 1 : 0)} ${t(distance.unitKey)}`;
    const durationSec = plan.track.timeRanges.reduce(
        (total, range) => total + Math.max(0, range.endUnix - range.startUnix),
        0,
    );
    return t("export.gpx.summary", {
        n: records.length,
        dist: distanceText,
        dur: formatDuration(durationSec),
    });
}

function setActiveRow(rowIndex: number): void {
    if (!elements || rowIndex < 0 || rowIndex >= rows.length) return;
    for (let index = 0; index < rows.length; index++) {
        const isActive = index === rowIndex;
        rows[index]!.root.classList.toggle("is-active", isActive);
        rows[index]!.trackButton.setAttribute("aria-pressed", String(isActive));
    }
    const row = rows[rowIndex]!;
    elements.previewName.textContent = displayPath(row.plan);
    elements.previewName.title = displayPath(row.plan);
    elements.previewSummary.textContent = row.summary;
    routePreview?.show(row.plan.track.records);
}

function settle(assignments: LooseGpxAssignment[]): void {
    if (!elements) return;
    if (pendingSignal && pendingAbort) pendingSignal.removeEventListener("abort", pendingAbort);
    pendingSignal = null;
    pendingAbort = null;
    elements.modal.hidden = true;
    deactivateModal(elements.modal);
    routePreview?.dispose();
    routePreview = null;
    rows = [];
    modalResult.settle(assignments);
}

function skipAll(): void {
    settle([]);
}

/** A trip accepts at most one GPX in one dialog. This prevents an accidental
 *  merged route while still letting the user leave any track unassigned. */
function syncChoices(): void {
    const selected = new Set(
        rows
            .map((row) =>
                row.select.value === "" ? null : row.plan.choices[Number(row.select.value)]?.target.videoKey,
            )
            .filter((value): value is string => value !== null && value !== undefined),
    );
    for (const row of rows) {
        const rowSelectedKey =
            row.select.value === "" ? null : (row.plan.choices[Number(row.select.value)]?.target.videoKey ?? null);
        for (const option of Array.from(row.select.options)) {
            if (option.value === "") continue;
            const choice = row.plan.choices[Number(option.value)];
            option.disabled =
                choice?.target.hasGps === true ||
                (choice !== undefined &&
                    selected.has(choice.target.videoKey) &&
                    rowSelectedKey !== choice.target.videoKey);
        }
    }
    if (elements) elements.apply.disabled = selected.size === 0;
}

function applyAssignments(): void {
    const assignments: LooseGpxAssignment[] = [];
    for (const row of rows) {
        if (row.select.value === "") continue;
        const choice = row.plan.choices[Number(row.select.value)];
        if (choice && !choice.target.hasGps) assignments.push({ track: row.plan.track, target: choice.target });
    }
    settle(assignments);
}

function choiceStatus(choice: LooseGpxChoice, copy: GpxAssignmentCopy): string {
    if (choice.target.hasGps) return copy.alreadyHasGps;
    if (choice.timeMatch === "overlap") return copy.timeMatches;
    if (choice.timeMatch === "uncertain") return copy.timeUncertain;
    return copy.timeMismatch;
}

function renderRows(plans: readonly LooseGpxPlan[], copy: GpxAssignmentCopy): void {
    if (!elements) return;
    const list = elements.list;
    list.replaceChildren();
    rows = plans.map((plan, rowIndex) => {
        const root = document.createElement("div");
        root.className = "gpx-assignment-row";
        root.setAttribute("role", "listitem");

        const trackButton = document.createElement("button");
        trackButton.type = "button";
        trackButton.className = "gpx-assignment-track";
        trackButton.setAttribute("aria-pressed", "false");

        const path = document.createElement("code");
        path.className = "gpx-assignment-path";
        path.textContent = displayPath(plan);

        const summary = trackSummary(plan);
        const meta = document.createElement("span");
        meta.className = "gpx-assignment-track-meta";
        meta.textContent = summary;
        trackButton.append(path, meta);
        trackButton.addEventListener("click", () => setActiveRow(rowIndex));

        const select = document.createElement("select");
        select.className = "gpx-assignment-select";
        select.id = `gpx-assignment-select-${rowIndex}`;
        select.setAttribute("aria-label", copy.tripLabel(plan.track.file.file.file.name));

        const unassigned = document.createElement("option");
        unassigned.value = "";
        unassigned.textContent = copy.unassigned;
        select.appendChild(unassigned);

        for (let choiceIndex = 0; choiceIndex < plan.choices.length; choiceIndex++) {
            const choice = plan.choices[choiceIndex]!;
            const target = choice.target;
            const option = document.createElement("option");
            option.value = String(choiceIndex);
            option.textContent = `${target.label} · ${choiceStatus(choice, copy)}`;
            option.disabled = target.hasGps;
            select.appendChild(option);
        }
        if (plan.recommendedVideoKey !== null) {
            const recommendedIndex = plan.choices.findIndex(
                (choice) => choice.target.videoKey === plan.recommendedVideoKey,
            );
            if (recommendedIndex >= 0) select.value = String(recommendedIndex);
        }
        select.addEventListener("change", () => {
            setActiveRow(rowIndex);
            syncChoices();
        });
        select.addEventListener("focus", () => setActiveRow(rowIndex));

        root.append(trackButton, select);
        list.appendChild(root);
        return { plan, root, trackButton, select, summary };
    });
    syncChoices();
}

/** Shows every unassigned GPX and resolves with only the rows the user chose.
 *  A second open settles the earlier promise as skipped before replacing it. */
export function showGpxAssignmentModal(
    plans: readonly LooseGpxPlan[],
    copy: GpxAssignmentCopy,
    signal?: AbortSignal,
): Promise<LooseGpxAssignment[]> {
    initGpxAssignmentModal();
    if (modalResult.pending) settle([]);
    renderRows(plans, copy);
    elements!.modal.hidden = false;
    routePreview = new GpxRoutePreview(elements!.map);
    setActiveRow(0);

    const result = modalResult.wait([]);
    if (signal) {
        pendingSignal = signal;
        pendingAbort = skipAll;
        signal.addEventListener("abort", pendingAbort, { once: true });
    }
    activateModal(elements!.modal, {
        onClose: skipAll,
        initialFocus: rows[0]?.select ?? elements!.skip,
    });
    if (signal?.aborted) skipAll();
    return result;
}

function initGpxAssignmentModal(): void {
    if (isInitialized) return;
    isInitialized = true;
    elements = assignmentElements();
    elements.skip.addEventListener("click", skipAll);
    elements.apply.addEventListener("click", applyAssignments);
    wireBackdropDismiss(elements.modal, skipAll, { cardSelector: ".gpx-assignment-card" });
}
