// General feedback asks for an optional recordings link, then offers a local
// report and email hand-off. Recognition help opens directly at the report and
// allows email immediately, so preparing sample recordings cannot block contact.

import { collectDiagnostics, serializeDiagnosticsText, utcTimestampSlug } from "../diagnostics.js";
import { downloadBlob } from "../download.js";
import { getDateLocale, t } from "../i18n/index.js";
import { createLogger } from "../log.js";
import { buildStructureReport, buildStructureReportFromSnapshot } from "../report-structure.js";
import { captureSentryException } from "../sentry.js";
import { displayClockDate, frameMediaOffset, tripAllCandidates, wallToContentSec } from "../trips.js";
import { formatDistanceFromKm } from "../units-pref.js";
import { APP_VERSION } from "../version.js";
import { dom, effectiveMasterChannel } from "./dom.js";
import { formatNumber, formatTime } from "./format.js";
import { activateModal, deactivateModal, wireBackdropDismiss } from "./modal-helper.js";
import { notify } from "./notifications.js";
import { activeCandidate, activeFrame, isFocusLayout, mainChannel, state } from "./state.js";

const log = createLogger("feedback");

const FEEDBACK_EMAIL = "feedback@everydashcam.app";

/** First lines of the report .txt: what it is and where to send it. English by
 *  design - the whole report body is technical/English (voice.md exception). */
const REPORT_HEADER = [
    "everydashcam — technical details for diagnosis",
    `Please email this file to ${FEEDBACK_EMAIL} — attach it to your message. It has no video and no location, just technical details that help us reproduce the problem or add your camera.`,
].join("\n");

let preset: ValidPreset | null = null;

interface FeedbackSnapshot {
    context: string;
    environment: string;
    structure: string | null;
    diagnostics: string;
    recognitionIssue: string | null;
}

// Playback and background ingest can keep moving while the dialog is open.
let openedSnapshot: FeedbackSnapshot | null = null;

/** Name of the report .txt downloaded this session, if any - drives the mail
 *  body's "attach this file" reminder. Reset on every modal open. */
let downloadedReportName: string | null = null;

/** Whether the user said they have a recordings link (step 1) - adds a paste
 *  placeholder to the email body. Reset on every modal open. */
let hasRecordingsLink = false;

function modalEl(): HTMLElement | null {
    return document.getElementById("feedback-modal");
}

function getEl<T extends HTMLElement>(sel: string): T | null {
    const m = modalEl();
    if (!m) return null;
    return m.querySelector<T>(sel);
}

/** Valid preset keys - whitelist matches i18n/keys.ts (feedback.step1.preset.*). Unknown presets are ignored so t() does not throw MissingValueError on a corrupt data-attribute. */
const VALID_PRESETS = ["load", "video", "map", "chart", "export", "other", "gps", "cameras"] as const;
type ValidPreset = (typeof VALID_PRESETS)[number];
function isValidPreset(p: string): p is ValidPreset {
    return (VALID_PRESETS as readonly string[]).includes(p);
}

/** The three wizard steps, keyed by the DOM section they toggle. */
const STEP_SECTIONS = {
    recordings: "#feedback-step-recordings",
    report: "#feedback-step-report",
    handoff: "#feedback-post-download",
} as const;
type Step = keyof typeof STEP_SECTIONS;

function showStep(step: Step): void {
    for (const [key, sel] of Object.entries(STEP_SECTIONS)) {
        getEl(sel)?.toggleAttribute("hidden", key !== step);
    }
}

/** True once any memory card has been loaded this session (even a zero-trips
 *  drop) - i.e. the report can carry a folder layout. */
function hasLoadedCard(): boolean {
    return (state.lastIngestStructure?.length ?? 0) > 0 || (state.lastIngestFiles?.length ?? 0) > 0;
}

/**
 * The byte-free folder-structure report for the current drop, or null when no
 * recordings have been loaded. Sourced from the raw ingest snapshot so it also
 * covers files that failed to become trips (the unrecognised-camera case).
 */
function cameraStructure(): string | null {
    if (!hasLoadedCard()) return null;
    const files = state.lastIngestFiles ?? [];
    return state.lastIngestStructure
        ? buildStructureReportFromSnapshot(files, state.lastIngestStructure)
        : buildStructureReport(files);
}

/** "Open my card": leaves the modal and triggers the normal ingest picker (the
 *  landing CTA carries the pre-ingest overlay + upload-warning flow). Shown only
 *  when no card was loaded, so a zero-content report is offered a way to fill in
 *  the file layout first. After ingest a zero-trips drop re-surfaces this flow
 *  via the no-recordings modal, now with structure. */
function loadCard(): void {
    closeFeedbackModal();
    (dom.landingDrop ?? dom.sidebarCta)?.click();
}

/** The single report .txt: header + diagnostics (as text) + folder structure. */
function buildReportText(): string {
    const snapshot = openedSnapshot;
    if (!snapshot) throw new Error("feedback context missing");
    const parts = [REPORT_HEADER];
    if (snapshot.recognitionIssue) parts.push(`== recognition issue ==\n${snapshot.recognitionIssue}`);
    if (snapshot.context) parts.push(snapshot.context);
    parts.push(snapshot.diagnostics);
    if (snapshot.structure) parts.push(snapshot.structure);
    return parts.join("\n\n");
}

function reportFilename(ts: Date): string {
    return `everydashcam-report-${utcTimestampSlug(ts)}.txt`;
}

function captureFeedbackSnapshot(recognitionIssue?: string): FeedbackSnapshot {
    const snapshot: FeedbackSnapshot = {
        context: "",
        environment: "",
        structure: null,
        diagnostics: "",
        recognitionIssue: recognitionIssue || null,
    };
    try {
        snapshot.environment = envSummary();
        snapshot.context = currentContextSummary();
        snapshot.structure = cameraStructure();
        snapshot.diagnostics = serializeDiagnosticsText(collectDiagnostics());
    } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        log.error("feedback context snapshot failed", { error });
        // Reporting a problem must stay possible even when diagnostics fail.
        snapshot.diagnostics = `${snapshot.environment}\n\nDiagnostic snapshot failed: ${error}`;
    }
    return snapshot;
}

function openFeedbackModal(opts: { preset?: string; recognitionIssue?: string } = {}): void {
    const m = modalEl();
    if (!m) return;
    preset = opts.preset && isValidPreset(opts.preset) ? opts.preset : null;
    downloadedReportName = null;
    hasRecordingsLink = false;
    openedSnapshot = captureFeedbackSnapshot(opts.recognitionIssue);

    const isRecognitionHelp = preset === "gps" || preset === "cameras";
    for (const selector of [
        "#feedback-context-help",
        "#feedback-context-recordings",
        "#feedback-report-mail",
        "#feedback-context-contact",
    ]) {
        getEl(selector)?.toggleAttribute("hidden", !isRecognitionHelp);
    }
    if (isRecognitionHelp) {
        const hint = getEl("#feedback-context-hint");
        if (hint) {
            const reason = preset === "gps" ? "gps" : "cameras";
            const key = opts.recognitionIssue
                ? (`recognition.${reason}.body` as const)
                : (`recognition.${reason}.hint` as const);
            hint.dataset.i18n = key;
            hint.textContent = t(key);
        }
        const samples = getEl("#feedback-context-samples");
        if (samples) {
            const key = preset === "gps" ? "feedback.recognition.samples.gps" : "feedback.recognition.samples.cameras";
            samples.dataset.i18n = key;
            samples.textContent = t(key);
        }
        const email = getEl<HTMLAnchorElement>("#feedback-context-email");
        if (email) email.href = mailtoUrl();
    }

    fillPreview();
    showStep(isRecognitionHelp ? "report" : "recordings");
    // No card loaded yet -> offer to open one first (empty report otherwise).
    getEl("#feedback-noingest")?.toggleAttribute("hidden", hasLoadedCard());

    m.hidden = false;
    activateModal(m, {
        onClose: closeFeedbackModal,
        initialFocus: getEl<HTMLElement>(isRecognitionHelp ? "#feedback-primary" : "#feedback-recordings-yes"),
    });
}

function closeFeedbackModal(): void {
    const m = modalEl();
    if (!m) return;
    m.hidden = true;
    deactivateModal(m);
}

/** Step 1 choice: whether the user has a recordings link, then advance to the report. */
function chooseRecordings(hasLink: boolean): void {
    hasRecordingsLink = hasLink;
    showStep("report");
    getEl<HTMLElement>("#feedback-primary")?.focus();
}

/** Fills the "what's inside" preview with the env summary and the folder
 *  structure (or a placeholder inviting the user to load recordings first). */
function fillPreview(): void {
    const body = getEl("#feedback-preview-body");
    if (!body) return;
    const structure = openedSnapshot?.structure;
    const environment = openedSnapshot?.environment ?? "";
    const text = structure ? `${environment}\n\n${structure}` : `${environment}\n\n${t("feedback.report.noFilesYet")}`;
    body.textContent = text;
}

function currentSubject(): string {
    return t("feedback.subject", {
        topic: preset ? t(`feedback.step1.preset.${preset}`) : t("feedback.modal.title"),
    });
}

/**
 * "Download the report": builds the single .txt and saves it, then advances to
 * the hand-off (email it). The main action of step 2.
 */
function downloadReport(): void {
    const name = reportFilename(new Date());
    try {
        downloadBlob(new Blob([buildReportText()], { type: "text/plain" }), name);
        downloadedReportName = name;
        log.info("feedback report prepared", { preset, hasRecordingsLink });
    } catch (err) {
        log.error("feedback report build failed", err);
        notify({ severity: "error", messageKey: "feedback.error.reportFailed" });
        // Meta-signal: our OWN report channel failed (often an OOM). Without this
        // it never reaches us - the user cannot send the report that failed.
        captureSentryException(err, {
            tags: { feature: "feedback-report", preset: preset ?? "unknown" },
        });
        return;
    }
    const step1 = getEl("#feedback-post-download-step1");
    if (step1) step1.textContent = t("feedback.success.step1", { filename: name });
    showStep("handoff");
    getEl<HTMLButtonElement>("#feedback-post-download-mail")?.focus();
}

/** "Open email": a pre-filled mailto. mailto cannot attach, so the body reminds
 *  the user to attach the downloaded report (and paste a recordings link). */
function sendEmail(): void {
    const url = mailtoUrl();
    const win = window.open(url, "_blank");
    if (!win) {
        log.warn("mailto popup blocked, falling back to location.href");
        window.location.href = url;
    }
}

function mailtoUrl(): string {
    const body = buildMailBody(downloadedReportName);
    // The recipient is a literal addr-spec (RFC 6068 - a bare "@", no encoding).
    // encodeURIComponent per query param, not URLSearchParams (the latter turns
    // spaces into "+", which Apple Mail shows literally).
    return `mailto:${FEEDBACK_EMAIL}?subject=${encodeURIComponent(currentSubject())}&body=${encodeURIComponent(body)}`;
}

function buildMailBody(reportName: string | null): string {
    const parts: string[] = [];
    if (reportName) {
        parts.push(t("feedback.body.attachReminder", { filename: reportName }));
    }
    if (preset === "gps" || preset === "cameras") {
        parts.push(t("feedback.recognition.mailPrompt"));
    }
    if (hasRecordingsLink) parts.push(t("feedback.recordings.mailPrompt"));
    return parts.join("\n\n");
}

/**
 * Captures the current file and playback position for the downloaded report.
 * Returns an empty string if no trip is selected (landing / empty state).
 */
function currentContextSummary(): string {
    const af = activeFrame();
    const cand = activeCandidate();
    if (!af || !cand) return "";

    const lines: string[] = [t("feedback.body.context.title")];
    lines.push(t("feedback.body.context.file", { name: cand.file.name }));

    // Trip: start → end on the display clock (camera clock when known) + counters.
    const tripFmt = new Intl.DateTimeFormat(getDateLocale(), {
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        timeZone: "UTC",
    });
    const start = tripFmt.format(displayClockDate(af.trip.startUtc, af.trip.cameraTzSec));
    const end = tripFmt.format(displayClockDate(af.trip.endUtc, af.trip.cameraTzSec));
    const filesCount = tripAllCandidates(af.trip).length;
    let dist = "—";
    if (af.trip.distanceKm > 0) {
        const d = formatDistanceFromKm(af.trip.distanceKm);
        dist = `${formatNumber(d.value, 1)} ${t(d.unitKey)}`;
    }
    lines.push(
        t("feedback.body.context.trip", {
            start,
            end,
            files: t("plurals.file", { n: filesCount }),
            distance: dist,
        }),
    );

    // Avoid a player -> feedback -> player import cycle.
    const ct = dom.player?.currentTime || 0;
    const tripPosSec =
        wallToContentSec(af.trip.timeline, af.frame.startUtc) +
        ct -
        frameMediaOffset(af.frame, effectiveMasterChannel());
    lines.push(
        t("feedback.body.context.position", {
            pos: formatTime(tripPosSec),
            dur: formatTime(af.trip.timeline.contentDurationSec),
        }),
    );

    if (cand.codec) {
        const codecStr = cand.codecParam ? `${cand.codec} (${cand.codecParam})` : cand.codec;
        lines.push(t("feedback.body.context.codec", { codec: codecStr }));
    }
    if (cand.fingerprint) {
        lines.push(t("feedback.body.context.fingerprint", { fingerprint: cand.fingerprint }));
    }
    lines.push(
        t("feedback.body.context.layout", {
            view: isFocusLayout(state.composition.layout) ? "focus" : "split",
            channel: mainChannel(),
        }),
    );

    // If a chart selection is active, include the range - bugs often reproduce only on a specific segment.
    if (state.chartZoomed && state.chart) {
        const xScale = state.chart.scales.x;
        if (xScale && Number.isFinite(xScale.min) && Number.isFinite(xScale.max)) {
            lines.push(
                t("feedback.body.context.zoom", {
                    from: formatTime(xScale.min as number),
                    to: formatTime(xScale.max as number),
                }),
            );
        }
    }

    return lines.join("\n");
}

/** Version and browser for the report preview and diagnostic fallback. */
function envSummary(): string {
    return [
        t("feedback.body.env.title"),
        t("feedback.body.env.app", { version: APP_VERSION }),
        t("feedback.body.env.browser", { ua: navigator.userAgent }),
    ].join("\n");
}

export function initFeedbackModal(): void {
    const m = modalEl();
    if (!m) return;
    const entry = document.getElementById("feedback-btn");
    entry?.addEventListener("click", () => openFeedbackModal());

    // Additional entry points from error scenarios. Any button with .feedback-link
    // opens the modal; data-feedback-preset (optional) tags the subject. Delegated
    // to document to handle dynamically inserted buttons (empty-state, modals).
    document.addEventListener("click", (e) => {
        const target = e.target;
        if (!(target instanceof Element)) return;
        const link = target.closest<HTMLElement>(".feedback-link");
        if (!link) return;
        // Skip if this is the main feedback button - it has its own handler above.
        if (link.id === "feedback-btn") return;
        e.preventDefault();
        // Close the parent modal (no-recordings, unsupported, ...) - its z-index
        // would cover the feedback modal.
        const parentDialog = link.closest<HTMLElement>('[role="dialog"]');
        if (parentDialog && parentDialog.id !== "feedback-modal") {
            parentDialog.hidden = true;
            deactivateModal(parentDialog);
        }
        openFeedbackModal({ preset: link.dataset.feedbackPreset, recognitionIssue: link.dataset.recognitionIssue });
    });

    // Click on the backdrop (outside the card) closes the modal.
    wireBackdropDismiss(m, closeFeedbackModal, { cardSelector: ".feedback-modal-card" });
    // Escape is handled centrally by the modal manager (onClose: closeFeedbackModal).

    getEl<HTMLButtonElement>("#feedback-cancel")?.addEventListener("click", closeFeedbackModal);
    getEl<HTMLButtonElement>("#feedback-load-card")?.addEventListener("click", loadCard);
    getEl<HTMLButtonElement>("#feedback-recordings-yes")?.addEventListener("click", () => chooseRecordings(true));
    getEl<HTMLButtonElement>("#feedback-recordings-skip")?.addEventListener("click", () => chooseRecordings(false));
    getEl<HTMLButtonElement>("#feedback-primary")?.addEventListener("click", downloadReport);
    getEl<HTMLButtonElement>("#feedback-post-download-mail")?.addEventListener("click", sendEmail);
    getEl<HTMLButtonElement>("#feedback-report-mail")?.addEventListener("click", sendEmail);
    getEl<HTMLAnchorElement>("#feedback-context-email")?.addEventListener("click", (event) => {
        event.preventDefault();
        sendEmail();
    });
}
