import type { RecordingCopy } from "./ingest-dedup.js";
import { classifyFilenameMode } from "./parsers/filename/index.js";
import type { VendorFile, VideoWithRecordingCopies } from "./parsers/types.js";
import type { VideoCandidate } from "./trips.js";
import { vendorFileKey } from "./vendor-file-key.js";

/** Keeps duplicate-matched names and source scopes beside their surviving file.
 * A copy matching several independent loaded owners cannot choose one of them. */
export function mergeRecordingCopies(
    videos: readonly VideoWithRecordingCopies[],
    copies: readonly RecordingCopy[],
): VideoWithRecordingCopies[] {
    const canonicalKeys = new Set(videos.map(vendorFileKey));
    const matches = new Map<string, { file: VendorFile; owners: Set<string>; ambiguous: boolean }>();
    function addMatch(file: VendorFile, owner: string | null): void {
        const key = vendorFileKey(file);
        // A loaded file owns its identity even if stale copy evidence also claims it.
        if (canonicalKeys.has(key)) return;
        let match = matches.get(key);
        if (!match) {
            match = { file, owners: new Set(), ambiguous: false };
            matches.set(key, match);
        }
        if (owner === null) match.ambiguous = true;
        else match.owners.add(owner);
    }
    for (const video of videos) {
        const owner = vendorFileKey(video);
        for (const file of video.recordingCopies ?? []) addMatch(file, owner);
    }
    const owners = new Map<string, string | null>([...canonicalKeys].map((key) => [key, key]));
    for (const [key, match] of matches) {
        owners.set(key, match.owners.size === 1 ? match.owners.values().next().value! : null);
    }
    for (const copy of copies) {
        addMatch(copy.duplicate, owners.get(vendorFileKey(copy.kept)) ?? null);
    }
    const aliases = new Map<string, VendorFile[]>([...canonicalKeys].map((key) => [key, []]));
    for (const match of matches.values()) {
        if (match.ambiguous || match.owners.size !== 1) continue;
        const owner = match.owners.values().next().value!;
        aliases.get(owner)!.push(match.file);
    }

    return videos.map((video) => {
        const recordingCopies = aliases.get(vendorFileKey(video))!;
        return recordingCopies.length > 0 || video.recordingCopies !== undefined
            ? { ...video, recordingCopies }
            : video;
    });
}

/** Applies session evidence without replacing the file used by playback,
 * annotations or the byte-derived cache. Call at the ingest commit boundary. */
export function applyRecordingCopies(
    candidates: readonly VideoCandidate[],
    videos: readonly VideoWithRecordingCopies[],
): void {
    const byKey = new Map(videos.map((video) => [vendorFileKey(video), video]));
    for (const candidate of candidates) {
        const video = byKey.get(vendorFileKey(candidate));
        if (!video) continue;
        const copies = video.recordingCopies ?? [];
        if (copies.length === 0 && !candidate.recordingCopies?.length) continue;
        const previousModes = new Set(candidate.recordingCopies?.map(classifyFilenameMode));
        const modes = new Set(copies.map(classifyFilenameMode));
        candidate.recordingCopies = [...copies];
        const mode = candidate.recordingMode;
        // Retract only protection contributed by removed copies. The survivor's
        // own filename and inferred time-lapse parking remain independent evidence.
        if ((mode === "event" || mode === "manual") && previousModes.has(mode) && !modes.has(mode)) {
            const filenameMode = classifyFilenameMode(candidate);
            if (filenameMode !== mode) {
                candidate.recordingMode =
                    candidate.isTimelapse && (filenameMode === null || filenameMode === "normal")
                        ? "parking"
                        : filenameMode;
            }
        }
        if (modes.has("event")) {
            candidate.recordingMode = "event";
        } else if (modes.has("manual") && (candidate.recordingMode === null || candidate.recordingMode === "normal")) {
            candidate.recordingMode = "manual";
        }
    }
}
