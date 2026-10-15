// Entry point for an SD card folder or drag-and-drop batch. It discovers files,
// merges external data and hands recording candidates to the progressive reader.
//
// Supports cancellation via AbortController (state.ingestController).
// On a second drop during an active ingest, the set is queued in state.ingestQueue
// and started after the current ingest's finally{}.

import { t } from "../i18n/index.js";
import { bindRecordsByRecordingStart, buildVideoAssociationIndex, recordsForVideo } from "../gps-association.js";
import { dropDuplicateFiles } from "../ingest-dedup.js";
import { ignoredRootSegments, isIgnoredPath } from "../ingest-filter.js";
import { partitionByIndexCache } from "./ingest-cache.js";
import { createLogger } from "../log.js";
import { captureSentryException } from "../sentry.js";
import { markStage } from "../perf.js";
import { cloneRecordsAcrossChannels, firstSyncedRecord, mergeIntoGpsLog, rebindOrphanLogRecords } from "../parser.js";
import {
    classifyFilesViaPool as dispatchClassifyFiles,
    dispatchParseAccelSidecarsViaPool as dispatchParseAccelSidecars,
    dispatchParseLogsViaPool as dispatchParseLogs,
    dispatchParseSidecarsViaPool as dispatchParseSidecars,
} from "./ingest-shim.js";
import type { VendorFile } from "../parsers/types.js";
import { cameraFingerprint } from "../parsers/camera-fingerprint.js";
import { classifyFilenameTime } from "../parsers/filename/index.js";
import { estimatePreciseClockOffsetByFingerprint, estimateTzByFingerprint, tripAllCandidates } from "../trips.js";
import { usableCandidateRecords } from "../stale-gps.js";
import type { Trip, TzSample, VideoCandidate } from "../trips.js";

import { registerIngestSource } from "./folder-sources.js";
import { isNotesBackupName, mergeNotesFilesFromBatch } from "./annotations-sidecar.js";
import {
    hideIngestOverlay,
    hideIngestProgress,
    setIngestStage,
    showIngestProgress,
    showIngestOverlay,
    syncIngestQueueIndicator,
} from "./ingest-overlay.js";
import { type IngestOrigin, state } from "./state.js";
import { notify } from "./notifications.js";
import { countUnplayableByExtension, showUnsupportedFormatsModal } from "./unsupported-formats-modal.js";
import { checkCanPlay, vendorFileKey } from "./ingest-candidate.js";
import { cancelProgressiveIngest, resumeProgressiveIngest, startProgressiveIngest } from "./progressive-ingest.js";
import { cancelDeferredGpsLoad } from "./deferred-gps.js";
import { countByExtension, countByField } from "./ingest-core.js";
import { reportParseErrors } from "./ingest-diagnostics.js";
import { scopeIngestFiles } from "./ingest-source-key.js";
import { resolveLooseGpxFiles } from "./loose-gpx-ingest.js";

const log = createLogger("ingest");

/**
 * Resolves after the browser has painted at least once. Double requestAnimationFrame:
 * the first callback fires before a paint, the second after it. Lets a just-shown
 * blocking overlay render before the main thread starts a long synchronous pass.
 * The setTimeout cap keeps a backgrounded tab (rAF suspended) from hanging ingest.
 */
function nextPaint(): Promise<void> {
    return new Promise((resolve) => {
        let settled = false;
        const done = () => {
            if (settled) return;
            settled = true;
            resolve();
        };
        requestAnimationFrame(() => requestAnimationFrame(done));
        setTimeout(done, 100);
    });
}

/**
 * Public entry point: shows the blocking overlay, manages the AbortController and the drop queue,
 * and (after finally) starts the next queued item.
 *
 * If an ingest is already running, the files go into state.ingestQueue and are started sequentially
 * after the current ingest finishes (success / cancel / error). No drop is ever lost.
 *
 * `origin` names the folder the batch was picked from - only the FSA path can
 * (see folder-sources.ts); it travels with the queued batch so a drop that
 * waited behind another ingest still knows where it came from.
 */
export async function ingestFiles(vfiles: VendorFile[], origin: IngestOrigin | null = null): Promise<void> {
    // Empty drop (a DnD that yielded nothing) - not a real ingest; warn and bail
    // without opening the overlay. The hidden/junk-path filter, which may also
    // empty the list, runs later (ingestFilesInternal, after the overlay paints)
    // so this entry point stays O(1) and the modal appears immediately on a large
    // mobile card instead of after a multi-pass main-thread stall.
    if (vfiles.length === 0) {
        notify({ severity: "warn", messageKey: "status.filesNotSelected" });
        return;
    }

    // Scope before queueing: a queued ad-hoc drop must keep the identity it
    // received when the user supplied it, not become part of the later batch.
    vfiles = scopeIngestFiles(vfiles, origin);

    if (state.ingestController !== null) {
        // Queue the raw (unfiltered) list - it is filtered when this wrapper
        // re-runs on it at dequeue, so no junk slips through.
        state.ingestQueue.push({ files: vfiles, origin });
        syncIngestQueueIndicator();
        return;
    }

    const controller = new AbortController();
    state.ingestController = controller;
    showIngestOverlay();
    setIngestStage(t("ingestOverlay.stage.classifying"));
    showIngestProgress();
    syncIngestQueueIndicator();

    let cancelled = false;
    let failed = false;
    try {
        await ingestFilesInternal(vfiles, controller.signal, origin);
    } catch (err) {
        // AbortError means the user clicked Cancel; partial state stays in the sidebar.
        if (err instanceof Error && err.name === "AbortError") {
            // Log so we can distinguish "it hung" vs "user cancelled" in bug reports.
            log.info("ingest cancelled");
            cancelled = true;
        } else {
            failed = true;
            log.error("ingest failed", err);
            // Raw cause is logged above; the user gets clear, actionable guidance
            // instead of a leaked browser exception string.
            notify({ severity: "error", messageKey: "ingest.error.loadFailed" });
            const reason = err instanceof Error ? err.name || "Error" : "unknown";
            // Most severe user-facing ingest outcome: the app loaded nothing.
            // Capture the real exception (stack), fingerprint by error name (the
            // message can embed a filename/path from a deeper throw).
            captureSentryException(err, { fingerprint: ["ingest_failed", reason], tags: { reason } });
        }
    } finally {
        state.ingestController = null;
        hideIngestOverlay();
        hideIngestProgress();
        // An interrupted ingest may have carried pending trips from an earlier
        // batch. Resume them here; successful runs already own their scheduler.
        if (cancelled || failed) resumeProgressiveIngest();
    }

    // Start the next queued item after the current ingest fully finishes (the controller is null above,
    // otherwise the wrapper would push it back into the queue). Tail call - stack does not grow.
    const next = state.ingestQueue.shift();
    if (next) {
        // No await - to not keep the first ingest session's promise chain alive.
        // void + .catch prevents the unhandled rejection from the next ingest from polluting the global uncaught handler.
        // ingestFiles already logs errors internally, so this catch is just a suppressor.
        void ingestFiles(next.files, next.origin).catch(() => {
            /* already logged inside ingestFiles */
        });
    }
}

async function ingestFilesInternal(
    vfiles: VendorFile[],
    signal: AbortSignal,
    origin: IngestOrigin | null,
): Promise<void> {
    // Wall-clock origin for both list-ready and full-completion diagnostics.
    // Start before the paint yield so the UX metric includes every delay the
    // user experiences after committing the folder.
    const ingestStart = performance.now();
    // Stop progressive work before this drop can replace positional trip state;
    // stale sessions must never write through indices owned by the next run.
    cancelProgressiveIngest();
    // Stop deferred full-file GPS reads so a new drop gets storage priority.
    // Unfinished files return to the identity-keyed pending map.
    cancelDeferredGpsLoad();
    // Let the just-shown overlay paint before any O(n) main-thread pass. On a
    // clean all-video drop nothing below hits a real async barrier until MP4
    // indexing, so the path filter + dedup fingerprinting + classify + the
    // "ingest started" log (each walks every file, the last two with per-file
    // regex) would otherwise all run before the modal ever appears - hundreds of
    // ms on a large mobile card. One forced frame here moves the whole stall
    // behind the visible "Classifying..." overlay.
    await nextPaint();

    // Snapshot the raw drop (path/size/mtime via File refs, no content read) for
    // the "help add my camera" report. Kept even when this ingest yields zero
    // trips - the case that otherwise discards the tree. Taken before the
    // hidden/junk filter on purpose: proxy dirs (.s_Front, DCIM quirks) are
    // useful onboarding signal where the source still carries them - the classic
    // <input webkitdirectory> listing does; the FSA and DnD walkers prune
    // hidden/junk names during enumeration. Overwritten each drop, not
    // accumulated.
    state.lastIngestFiles = [...vfiles];

    // Drop hidden/junk files and known preview recordings
    // before anything touches them. Single chokepoint for both the picker and DnD
    // paths, so junk never costs an SD seek and never collides on basename with a
    // real recording. One summary log so a "my files did not load" report can be
    // traced to a path we skipped.
    const totalDropped = vfiles.length;
    const kept = vfiles.filter((vf) => !isIgnoredPath(vf.relativePath));
    if (kept.length < totalDropped) {
        log.debug("ignored non-recording paths", { ignored: totalDropped - kept.length, total: totalDropped });
    }
    if (kept.length === 0) {
        // The filter emptied a non-empty selection. Give a dedicated hint
        // instead of claiming no files were selected.
        log.info("selection contained no primary recordings", {
            total: totalDropped,
            junkRoots: ignoredRootSegments(vfiles.map((vf) => vf.relativePath)),
        });
        notify({ severity: "warn", messageKey: "status.noRecordingsFound" });
        // This early return still has to resume any carried pending recordings.
        resumeProgressiveIngest();
        return;
    }

    // A notes file in the opened folder takes priority over the last-used
    // fallback. Discovery is read-only; a later user edit owns any file prompt.
    const notesMerge = mergeNotesFilesFromBatch(kept, origin);
    vfiles = kept;

    // Read failures belong to this batch; a later clean drop must not inherit
    // an earlier batch's recovery note.
    state.unindexed = new Set();

    // Per-ingest stage timings for the final "ingest done" log. Each heavy stage is wrapped via mark().
    // Rounded to 1 ms - sub-millisecond precision is noise here. Same mark() also calls markStage()
    // so each stage produces a performance.measure entry visible in DevTools and read by the perf-test harness.
    // Baseline for the end-of-ingest "gps records skipped" summary: gpsLog
    // persists across ingests and mergeIntoGpsLog concatenates skipped[], so
    // without the snapshot the 2nd+ drop re-reports prior ingests' rows.
    const skippedLinesBaseline = state.gpsLog?.skipped.length ?? 0;
    const stageMs: Record<string, number> = {};
    const mark = <T>(stage: string, fn: () => Promise<T>): Promise<T> => {
        const t0 = performance.now();
        return markStage(`ingest:${stage}`, fn).finally(() => {
            stageMs[stage] = Math.round(performance.now() - t0);
        });
    };

    // Files already loaded into trips - the comparison base both for duplicate
    // exclusion below and for sidecar classification (existingVideoNames).
    const alreadyLoaded: VendorFile[] = [];
    for (const trip of state.trips) {
        for (const c of tripAllCandidates(trip)) {
            alreadyLoaded.push({ file: c.file, relativePath: c.relativePath, sourceKey: c.sourceKey });
        }
    }

    // Drop byte-identical copies (same basename+size, confirmed by a head/tail
    // content probe) before classify/indexing, so a duplicated subfolder in the
    // drop - or a re-dropped Backup copy of an already-loaded card - does not
    // double trip footage and never costs an SD seek. See src/ingest-dedup.ts.
    const dedup = await mark("dedup", () => dropDuplicateFiles(vfiles, alreadyLoaded, signal));
    if (dedup.dropped.length > 0) {
        // Toast so the user knows why the loaded count is below the drop count;
        // sample pairs in the log so a "my files did not load" report can be
        // traced to the surviving path.
        log.info("skipped duplicate files", {
            skipped: dedup.dropped.length,
            total: vfiles.length,
            sample: dedup.dropped.slice(0, 5),
        });
        notify({
            severity: "info",
            messageKey: "status.duplicatesSkipped",
            messageParams: { n: dedup.dropped.length },
        });
        vfiles = dedup.kept;
    }

    // Name the folders this batch came from, before any heavy stage: the rows
    // above the trip list explain the trips that are about to appear, and a
    // cancelled or partially failed ingest still leaves those trips behind.
    // After the dedup on purpose - a re-drop of an already loaded card adds no
    // trips, so it must not add a row claiming otherwise.
    // A notes backup describes a source but is not itself a recording. Leaving
    // it in this list makes a duplicate-only classic re-open manufacture a new
    // folder row after every recording was correctly deduplicated away.
    registerIngestSource(
        vfiles.filter((vendorFile) => !isNotesBackupName(vendorFile.file.name)),
        origin,
        dedup.sourceMatches,
    );
    await notesMerge;

    // Sidecar classification looks at already-known videos (state.trips + newly classified) so the user can drop a GPX later for a previously loaded MP4.
    const existingVideoNames = new Set<string>(alreadyLoaded.map((vf) => vf.file.name));
    const { classified, errors: classificationErrors } = await mark("classify", () =>
        dispatchClassifyFiles(vfiles, existingVideoNames, signal),
    );
    reportParseErrors("classify", classificationErrors);

    const classifiedVideos = classified.filter((item) => item.role === "video");

    // Extract video candidates with their role/relativePath - used from here on instead of the raw File[].
    const videos = classifiedVideos;
    const knownVideoFiles = [...alreadyLoaded, ...videos.map((candidate) => candidate.file)];
    const videoAssociation = buildVideoAssociationIndex(knownVideoFiles);
    const totalGpsLogs = classified.filter((c) => c.role === "gps-log").length;

    // If the drop contains unplayable containers (.avi/.mts/.wmv/.flv/.3gp/.jdr/.mdt/.insv/.360/...),
    // show the user a modal over the ingest overlay. Non-blocking: void = fire-and-forget,
    // classification and indexing continue while the user reads. Extension list lives in UNPLAYABLE_VIDEO_EXTENSIONS.
    const unplayableByExt = countUnplayableByExtension(vfiles.map((vf) => vf.file.name));
    if (unplayableByExt.size > 0) {
        log.info("unsupported formats in drop", { byExt: Object.fromEntries(unplayableByExt) });
        void showUnsupportedFormatsModal(unplayableByExt);
    }

    // Startup log. Placed after classify so the role/vendor breakdown is already known. Before this point we only have the raw vfiles[] which is less useful for bug reports.
    log.info("ingest started", {
        totalFiles: vfiles.length,
        totalBytes: vfiles.reduce((s, vf) => s + vf.file.size, 0),
        byExtension: countByExtension(vfiles),
        byClassify: {
            video: videos.length,
            gpsLog: totalGpsLogs,
            sidecar: classified.filter((c) => c.role === "sidecar").length,
            unknown: classified.filter((c) => c.role === "unknown").length,
        },
        byFingerprint: countByField(videos, (c) => cameraFingerprint(c.file)),
        // First 5 relative paths to reveal the SD card layout (Normal/Front/..., DCIM/, flat root, etc.).
        // 5 is a compromise: more bloats the entry; fewer may not show the pattern.
        relativePathsSample: vfiles.slice(0, 5).map((vf) => vf.relativePath),
    });

    if (signal.aborted) throw new DOMException("ingest aborted", "AbortError");
    setIngestStage(t("ingestOverlay.stage.parsingLogs"));

    // Parse logs before indexing so filename-owned records are ready now and
    // recording-start hints can bind as soon as MP4 metadata arrives. Logs,
    // GPS sidecars and accel sidecars are disjoint inputs parsed by the same
    // worker pool, so they run together; their results are applied below in
    // the fixed log -> sidecar -> accel order the merge semantics expect.
    const [logsResult, sidecarResult, accelSidecarResult] = await Promise.all([
        mark("parseLogs", () => dispatchParseLogs(classified, videoAssociation, signal)),
        mark("parseSidecars", () => dispatchParseSidecars(classified, videoAssociation, signal)),
        mark("parseAccelSidecars", () => dispatchParseAccelSidecars(classified, videoAssociation, signal)),
    ]);
    if (logsResult.records.length > 0) {
        // Merge if a log already exists (new file may be a rotated version of the old one, or the same file dropped twice).
        // Dedup by (unixSeconds, lat, lon, mp4Filename) is required: re-dropping the same log doubles brake events, distance, and point density.
        state.gpsLog = mergeIntoGpsLog(state.gpsLog, logsResult);
        // Firmware writes ghost names into the log for locked clips (renamed
        // across mode prefixes, or with garbage after ".MP4") - re-key those
        // records onto the loaded video sharing the same name core, then
        // rebuild the byFilename buckets. Runs here, before any candidate
        // pulls its records, so every downstream exact-name lookup just works.
        const videoNames = new Set<string>(existingVideoNames);
        for (const c of videos) videoNames.add(c.file.file.name);
        const rebound = rebindOrphanLogRecords(state.gpsLog, videoNames);
        if (rebound > 0) {
            state.gpsLog = mergeIntoGpsLog(null, {
                records: state.gpsLog.records,
                appliedExtractors: state.gpsLog.appliedExtractors,
                skipped: state.gpsLog.skipped,
            });
            log.info("rebound orphan gps-log records", { count: rebound });
        }
    }
    if (state.gpsLog) {
        const bound = bindRecordsByRecordingStart(state.gpsLog, state.trips.flatMap(tripAllCandidates));
        state.gpsLog = bound.log;
        if (bound.boundRecords > 0) {
            log.info("bound recording-scoped gps log", {
                records: bound.boundRecords,
                videos: bound.boundVideos,
            });
        }
    }
    if (logsResult.errors.length > 0) {
        log.warn("gps log parse errors", { count: logsResult.errors.length, errors: logsResult.errors });
    }
    reportParseErrors("log", logsResult.errors);

    if (signal.aborted) throw new DOMException("ingest aborted", "AbortError");
    setIngestStage(t("ingestOverlay.stage.parsingSidecars"));

    // Apply classifier-owned sidecars first. Loose GPX files are still unknown
    // here: their manual destinations are resolved only after we know which
    // clips already received usable GPS from logs or exact-name sidecars.
    if (sidecarResult.records.length > 0) {
        // Sidecars (GPX, .map, .gps) carry only records - no extractor labels or
        // skipped-line diagnostics - so the other two batch fields are empty.
        state.gpsLog = mergeIntoGpsLog(state.gpsLog, {
            records: sidecarResult.records,
            appliedExtractors: [],
            skipped: [],
        });
    }

    // A shared sidecar (BlackVue `.gps`) classifies against one channel only;
    // clone its records onto the recording's other channels so every channel
    // measures the same clock offset and derives the same startUtc, keeping
    // front+rear in one frame (see cloneRecordsAcrossChannels). Runs on the
    // merged log with the cumulative video set, so a channel dropped in a later
    // ingest still picks up its sibling's track.
    const cloneSharedGps = (): void => {
        if (!state.gpsLog) return;
        const clonedAcrossChannels = cloneRecordsAcrossChannels(state.gpsLog, knownVideoFiles);
        if (clonedAcrossChannels > 0) {
            state.gpsLog = mergeIntoGpsLog(null, {
                records: state.gpsLog.records,
                appliedExtractors: state.gpsLog.appliedExtractors,
                skipped: state.gpsLog.skipped,
            });
            log.info("cloned sidecar gps across channels", { count: clonedAcrossChannels });
        }
    };
    cloneSharedGps();

    if (sidecarResult.errors.length > 0) {
        log.warn("sidecar parse errors", { count: sidecarResult.errors.length, errors: sidecarResult.errors });
    }
    reportParseErrors("sidecar", sidecarResult.errors);

    // Only role=unknown XML GPX reaches this deferred resolver. Model-specific
    // `.gpx` formats (notably DDPai NMEA), logs, and exact-basename GPX were
    // claimed above and remain entirely on their parser-owned association path.
    // Defer the dialog until progressive ingest has enough candidate timing to
    // offer one destination per derived trip rather than one per video file.
    const hasLooseGpx = classified.some((item) => item.role === "unknown" && /\.gpx$/i.test(item.file.file.name));
    const protectedGpsVideoKeys = new Set([
        ...state.pendingHeavyEmbeddedGps.keys(),
        ...state.inflightEmbeddedGps.keys(),
    ]);
    const resolveLooseGpx = hasLooseGpx
        ? async (trips: readonly Trip[]): Promise<void> => {
              const resolution = await mark("parseManualGpx", () =>
                  resolveLooseGpxFiles(
                      classified,
                      trips,
                      protectedGpsVideoKeys,
                      {
                          tripLabel: (name) => t("gpxAssign.tripLabel", { name }),
                          unassigned: t("gpxAssign.unassigned"),
                          alreadyHasGps: t("gpxAssign.alreadyHasGps"),
                          timeMatches: t("gpxAssign.timeMatches"),
                          timeMismatch: t("gpxAssign.timeMismatch"),
                          timeUncertain: t("gpxAssign.timeUncertain"),
                      },
                      signal,
                  ),
              );
              if (resolution.errors.length > 0) {
                  sidecarResult.errors.push(...resolution.errors);
                  log.warn("loose GPX parse errors", { count: resolution.errors.length, errors: resolution.errors });
                  reportParseErrors("sidecar", resolution.errors);
              }
              if (resolution.needsTrip) notify({ severity: "info", messageKey: "status.gpxChooseTrip" });
              if (resolution.records.length > 0) {
                  state.gpsLog = mergeIntoGpsLog(state.gpsLog, {
                      records: resolution.records,
                      appliedExtractors: [],
                      skipped: [],
                  });
              }
              if (resolution.assignedFiles > 0) {
                  notify({
                      severity: "info",
                      messageKey: "status.gpxAttached",
                      messageParams: { n: resolution.assignedFiles },
                  });
              }
          }
        : undefined;

    // Accel-only sidecars (BlackVue .3gf): accelerometer only, no GPS. They are
    // merged once recording clocks are ready.
    if (accelSidecarResult.errors.length > 0) {
        log.warn("accel-sidecar parse errors", {
            count: accelSidecarResult.errors.length,
            errors: accelSidecarResult.errors,
        });
    }
    reportParseErrors("accel", accelSidecarResult.errors);

    // Skip already-added video versions (repeated drop). vendorFileKey includes
    // source, relative path, size, and mtime, so overwrites and equal trees from
    // separate inputs remain distinct.
    const newVideos = videos.filter((c) => !state.addedKeys.has(vendorFileKey(c.file)));

    // Cross-session cache hits restore only expensive byte-derived artifacts.
    // Filename fields, external inputs, clocks, and grouping remain live
    // computations, so their fixes never require a cache-wide version bump.
    const {
        cachedCandidates,
        cachedMetadataByFileKey,
        restoredEmbeddedRecords,
        restoredEmbeddedAccelByFileKey,
        writeBlockLeaseByFileKey,
        misses: videosToIndex,
    } = await mark("cacheLookup", () =>
        partitionByIndexCache(newVideos, classified, videoAssociation, {
            gpsLog: state.gpsLog,
            extractorByFileKey: [logsResult.extractorByFileKey, sidecarResult.extractorByFileKey],
            areValid:
                classificationErrors.length === 0 &&
                logsResult.errors.length === 0 &&
                sidecarResult.errors.length === 0 &&
                accelSidecarResult.errors.length === 0,
        }),
    );
    if (cachedCandidates.length > 0) {
        await mark("checkCachedCodecs", async () => {
            try {
                await checkCanPlay(cachedCandidates);
            } catch (err) {
                log.warn("cached codec support check failed", {
                    err: err instanceof Error ? err.message : String(err),
                });
            }
        });
    }
    if (state.gpsLog && cachedCandidates.length > 0) {
        const bound = bindRecordsByRecordingStart(state.gpsLog, [
            ...state.trips.flatMap(tripAllCandidates),
            ...cachedCandidates,
        ]);
        state.gpsLog = bound.log;
        if (bound.boundRecords > 0) {
            log.info("bound recording-scoped gps log", {
                records: bound.boundRecords,
                videos: bound.boundVideos,
            });
        }
    }
    if (restoredEmbeddedRecords.length > 0) {
        // Only embedded raw records are restored. Logs and sidecars above were
        // parsed under current code and never compete with stale cached copies.
        state.gpsLog = mergeIntoGpsLog(state.gpsLog, {
            records: restoredEmbeddedRecords,
            appliedExtractors: [],
            skipped: [],
        });
    }

    // Assemble the raw files into the candidate list.
    const allCandidates: VideoCandidate[] = [];

    // Start with existing candidates (from state.trips) - carry them over as-is.
    for (const trip of state.trips) {
        for (const f of tripAllCandidates(trip)) {
            allCandidates.push(f);
        }
    }
    // Cache hits join the pool up front so clock estimation and the provisional
    // list commit treat them exactly like carried-over ready candidates.
    allCandidates.push(...cachedCandidates);

    // Estimate camera TZ before indexing - needed for files without GPS where the filename is the only time source.
    // Collect (name, first GPS record) pairs from ALL files (old + new) with a log.
    // Computed before MP4 indexing because it only depends on the already-parsed GPS log and filenames.
    const tzSamples: TzSample[] = [];
    if (state.gpsLog) {
        // Dedup by File identity, not basename: two distinct files that share a
        // basename in different folders (a read-only backup copy + its Movie/
        // sibling) must each contribute a TZ sample - a basename key would drop
        // one. The association lookup below retains that concrete identity.
        const seen = new Set<File>();
        // Misses only: cache hits already sit in allCandidates (loop below)
        // with their mvhd, so sampling them here too would double-count.
        for (const cf of videosToIndex) {
            const recs = recordsForVideo(state.gpsLog, cf.file, videoAssociation);
            // firstSyncedRecord, not recs[0]: a cold-start (timeUnsynced) first
            // record carries a ~1970 placeholder that would poison the TZ delta.
            const firstSynced = firstSyncedRecord(recs);
            if (firstSynced && !seen.has(cf.file.file)) {
                // mvhd is not available yet. The closing accuracy sweep repeats
                // clock estimation after mandatory metadata is ready.
                // durationSec unknown for the same reason - run chaining uses the
                // fallback gap until the post-index sweep re-estimates.
                tzSamples.push({
                    file: cf.file,
                    fingerprint: cameraFingerprint(cf.file),
                    firstGpsUnix: firstSynced.unixSeconds,
                    mvhdNaiveUnix: null,
                    durationSec: null,
                });
                seen.add(cf.file.file);
            }
        }
        for (const c of allCandidates) {
            const firstSynced = firstSyncedRecord(usableCandidateRecords(c));
            if (firstSynced && !seen.has(c.file)) {
                tzSamples.push({
                    file: { file: c.file, relativePath: c.relativePath },
                    fingerprint: c.fingerprint,
                    firstGpsUnix: firstSynced.unixSeconds,
                    mvhdNaiveUnix: c.createdUtc !== null ? c.createdUtc.getTime() / 1000 : null,
                    durationSec: c.durationSec,
                });
                seen.add(c.file);
            }
        }
    }
    const tzByFingerprint = estimateTzByFingerprint(tzSamples, classifyFilenameTime);
    const preciseOffsetRuns = estimatePreciseClockOffsetByFingerprint(tzSamples, classifyFilenameTime);

    await startProgressiveIngest({
        newVideos: videosToIndex,
        allCandidates,
        logExtractorByFileKey: logsResult.extractorByFileKey,
        sidecarExtractorByFileKey: sidecarResult.extractorByFileKey,
        accelByFileKey: accelSidecarResult.accelByFileKey,
        cachedEmbeddedAccelByFileKey: restoredEmbeddedAccelByFileKey,
        cachedRecordingMetadataByFileKey: cachedMetadataByFileKey,
        cacheWriteBlockLeaseByFileKey: writeBlockLeaseByFileKey,
        videoAssociation,
        errorCounts: {
            classify: classificationErrors.length,
            logs: logsResult.errors.length,
            sidecars: sidecarResult.errors.length,
            accelSidecars: accelSidecarResult.errors.length,
        },
        stageMs,
        skippedLinesBaseline,
        tzByFingerprint,
        preciseOffsetRuns,
        ingestStart,
        sourceFiles: vfiles,
        videosNewCount: newVideos.length,
        hasUnsupportedFormats: unplayableByExt.size > 0,
        signal,
        // Metadata-only hits still read video bytes in the embedded-GPS worker.
        // Include them in the storage probe so a broad parser revision does not
        // accidentally run high-concurrency reads against removable media.
        schedulingFiles: videosToIndex.map((cf) => cf.file),
        ...(resolveLooseGpx ? { resolveLooseGpx } : {}),
    });
    if (signal.aborted) resumeProgressiveIngest();
}
