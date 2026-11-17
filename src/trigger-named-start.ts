// Starts of clips named after an event trigger, measured from the card's file
// modification times.
//
// A trigger-named clip (classifyFilenameNamesTrigger) starts before its name by
// a pre-event buffer whose length the file does not record. When the filename
// family declares that mtime marks the clip's close (classifyFilenameMtimeClosesClip),
// mtime minus the clip duration is its first frame. mtime survives only on a
// card opened directly or copied with its dates, so a card's mtimes count only
// when its clips that are named at their start close exactly one duration
// after their names.

import { knownFileMtime } from "./file-mtime.js";
import { classifyFilenameMtimeClosesClip, classifyFilenameNamesTrigger } from "./parsers/filename/index.js";
import type { VendorFile } from "./parsers/types.js";

/** A clip and its length, as the trip builder holds it. */
export interface DurationClip extends VendorFile {
    durationSec: number;
    /** False while durationSec is a provisional estimate rather than the indexed length. */
    metadataReady?: boolean;
}

// Card file systems store mtime without a zone, and operating systems read it
// as local time or as UTC. Whole quarter-hour steps between mtime and the name
// are therefore zone readings, not evidence about the clip.
const ZONE_STEP_SEC = 900;
// Real zones span UTC-12 to UTC+14. A larger distance is a copy or a reset clock.
const MAX_ZONE_DISTANCE_SEC = 14 * 3600 + ZONE_STEP_SEC / 2;
// FAT32 keeps mtime in 2 s steps.
const CLOSE_TOLERANCE_SEC = 2;
// Longest pre-event buffer accepted. Thinkware documents 10 s; the margin
// covers mtime resolution and a few seconds of closing time.
const MAX_PRE_EVENT_SEC = 15;
// A copy time matches a name by chance on a few clips, not on most of a card.
const MIN_REFERENCE_CLIPS = 2;
const MIN_AGREEING_SHARE = 0.9;

/** Seconds from the name time to mtime minus the duration, without whole
 *  zone steps, or null when the clip lacks the inputs or mtime is too far
 *  from the name to be a zone reading of the same clock. */
function closeResidualSec(clip: DurationClip, nameTime: Date): number | null {
    const mtimeMs = knownFileMtime(clip.file);
    if (mtimeMs === null || clip.metadataReady === false || !(clip.durationSec > 0)) return null;
    const distanceSec = mtimeMs / 1000 - clip.durationSec - nameTime.getTime() / 1000;
    if (Math.abs(distanceSec) > MAX_ZONE_DISTANCE_SEC) return null;
    return distanceSec - Math.round(distanceSec / ZONE_STEP_SEC) * ZONE_STEP_SEC;
}

/**
 * Returns, per File, the seconds to add to a trigger-named clip's filename time
 * to reach its first frame (negative for a pre-event buffer). A clip is
 * included only when:
 *   - its filename family declares both trigger naming and close-stamped mtime;
 *   - at least two close-stamped clips named at their start, from the same
 *     ingest source, have mtimes, and at least 90% of them close within 2 s of
 *     name plus duration, so the source still carries the camera's mtimes;
 *   - its own start falls between 15 s before and 2 s after its name.
 * Clips without indexed durations are skipped. Anything else keeps its
 * filename time, which then marks the trigger rather than the first frame.
 */
export function estimateTriggerNamedStartOffsets(
    clips: readonly DurationClip[],
    filenameTime: (file: VendorFile) => Date | null,
): Map<File, number> {
    interface SourceEvidence {
        referenceResiduals: number[];
        triggered: { file: File; residualSec: number }[];
    }
    const bySource = new Map<string, SourceEvidence>();
    for (const clip of clips) {
        if (!classifyFilenameMtimeClosesClip(clip)) continue;
        const nameTime = filenameTime(clip);
        if (nameTime === null) continue;
        const residualSec = closeResidualSec(clip, nameTime);
        if (residualSec === null) continue;
        const sourceKey = clip.sourceKey ?? "";
        let evidence = bySource.get(sourceKey);
        if (!evidence) {
            evidence = { referenceResiduals: [], triggered: [] };
            bySource.set(sourceKey, evidence);
        }
        if (classifyFilenameNamesTrigger(clip)) evidence.triggered.push({ file: clip.file, residualSec });
        else evidence.referenceResiduals.push(residualSec);
    }

    const offsets = new Map<File, number>();
    for (const { referenceResiduals, triggered } of bySource.values()) {
        const agreeing = referenceResiduals.filter((residual) => Math.abs(residual) <= CLOSE_TOLERANCE_SEC).length;
        if (referenceResiduals.length < MIN_REFERENCE_CLIPS) continue;
        if (agreeing < referenceResiduals.length * MIN_AGREEING_SHARE) continue;
        for (const { file, residualSec } of triggered) {
            if (residualSec < -MAX_PRE_EVENT_SEC || residualSec > CLOSE_TOLERANCE_SEC) continue;
            offsets.set(file, residualSec);
        }
    }
    return offsets;
}
