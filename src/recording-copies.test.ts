import { describe, expect, it } from "vitest";
import { buildVideoAssociationIndex } from "./gps-association.js";
import { dropDuplicateFiles } from "./ingest-dedup.js";
import { cameraFingerprint } from "./parsers/camera-fingerprint.js";
import type { VendorFile } from "./parsers/types.js";
import { applyRecordingCopies, mergeRecordingCopies } from "./recording-copies.js";
import { frameRecordingMode, groupTrips } from "./trips.js";
import { buildProvisionalCandidate } from "./ui/ingest-candidate.js";
import { vendorFileKey } from "./vendor-file-key.js";

function file(mode: "NO" | "EV", channel = "F", sourceKey = "card"): VendorFile {
    const name = `${mode}20260101-120000-000042${channel}.MP4`;
    const folder = mode === "NO" ? "Normal" : "Event";
    return {
        file: new File([new Uint8Array([1, 2, 3])], name, { lastModified: 1 }),
        relativePath: `card/${folder}/${name}`,
        sourceKey,
    };
}

function candidate(file: VendorFile) {
    return buildProvisionalCandidate({
        file,
        fingerprint: cameraFingerprint(file),
        startUtc: 1000,
        startSource: "name",
        cameraTzSec: null,
        durationSec: 70,
        records: [],
        appliedExtractors: [],
    });
}

function protectedCopy(mode: "event" | "manual", sourceKey = "copy-drop"): VendorFile {
    const copy = file(mode === "event" ? "EV" : "NO", "F", sourceKey);
    return mode === "manual" ? { ...copy, relativePath: copy.relativePath.replace("Normal/", "Manual/") } : copy;
}

describe("recording copies", () => {
    it.each([false, true])("keeps one event interval for every channel, event first %s", async (eventFirst) => {
        const normal = ["F", "R", "C"].map((channel) => file("NO", channel));
        const event = ["F", "R", "C"].map((channel) => file("EV", channel));
        const incoming = eventFirst ? [...event, ...normal] : [...normal, ...event];
        const dedup = await dropDuplicateFiles(incoming, []);
        const videos = mergeRecordingCopies(dedup.kept, dedup.copies);
        const candidates = videos.map(candidate);
        applyRecordingCopies(candidates, videos);
        const trips = groupTrips(candidates);

        expect(candidates).toHaveLength(3);
        expect(trips).toHaveLength(1);
        expect(trips[0]!.frames).toHaveLength(1);
        expect(Object.keys(trips[0]!.frames[0]!.channels).sort()).toEqual(["front", "interior", "rear"]);
        expect(trips[0]!.timeline.contentDurationSec).toBe(70);
        expect(frameRecordingMode(trips[0]!.frames[0]!)).toBe("event");
    });

    it("upgrades a loaded normal recording without changing its playback or annotation identity", async () => {
        const normal = file("NO", "F", "first-drop");
        const event = file("EV", "F", "second-drop");
        const loaded = candidate(normal);
        const identity = vendorFileKey(loaded);
        const records = loaded.records;
        const dedup = await dropDuplicateFiles([event], [loaded]);
        const videos = mergeRecordingCopies([loaded, ...dedup.kept], dedup.copies);

        expect(loaded.recordingMode, "staged evidence does not mutate a live candidate").toBe("normal");
        applyRecordingCopies([loaded], videos);
        expect(loaded.recordingMode).toBe("event");
        expect(loaded.file).toBe(normal.file);
        expect(vendorFileKey(loaded)).toBe(identity);
        expect(loaded.records).toBe(records);
        expect(loaded.recordingCopies).toEqual([event]);
        expect(groupTrips([loaded])[0]!.timeline.contentDurationSec).toBe(70);

        const repeated = mergeRecordingCopies([loaded], dedup.copies);
        applyRecordingCopies([loaded], repeated);
        expect(loaded.recordingCopies).toEqual([event]);
    });

    it("retains event evidence when a later normal copy arrives", async () => {
        const event = file("EV", "F", "first-drop");
        const normal = file("NO", "F", "second-drop");
        const loaded = candidate(event);
        const dedup = await dropDuplicateFiles([normal], [loaded]);
        const videos = mergeRecordingCopies([loaded], dedup.copies);
        applyRecordingCopies([loaded], videos);
        expect(loaded.recordingMode).toBe("event");
        expect(loaded.file).toBe(event.file);
        expect(loaded.recordingCopies).toEqual([normal]);
    });

    it("preserves a later manual protection flag without downgrading an event", async () => {
        const normal = file("NO");
        const manual = { ...normal, relativePath: normal.relativePath.replace("Normal/", "Manual/") };
        const loaded = candidate(normal);
        const dedup = await dropDuplicateFiles([manual], [loaded]);
        const videos = mergeRecordingCopies([loaded], dedup.copies);
        applyRecordingCopies([loaded], videos);
        expect(loaded.recordingMode).toBe("manual");
        loaded.recordingMode = "event";
        applyRecordingCopies([loaded], videos);
        expect(loaded.recordingMode).toBe("event");
    });

    it("leaves a copy with several independent owners unassigned", async () => {
        const first = candidate(file("NO", "F", "card-a"));
        const second = candidate(file("NO", "F", "card-b"));
        const event = file("EV", "F", "third-drop");
        const dedup = await dropDuplicateFiles([event], [first, second]);
        expect(dedup.copies).toHaveLength(2);
        const videos = mergeRecordingCopies([first, second], dedup.copies);
        applyRecordingCopies([first, second], videos);
        expect(first.recordingCopies).toBeUndefined();
        expect(second.recordingCopies).toBeUndefined();
        expect(first.recordingMode).toBe("normal");
        expect(second.recordingMode).toBe("normal");
    });

    it.each(["event", "manual"] as const)("removes conflicting retained %s copies without new evidence", (mode) => {
        const first = candidate(file("NO", "F", "card-a"));
        const second = candidate(file("NO", "F", "card-b"));
        const copy = protectedCopy(mode);
        for (const loaded of [first, second]) {
            applyRecordingCopies([loaded], [{ ...loaded, recordingCopies: [copy] }]);
            expect(loaded.recordingMode).toBe(mode);
        }

        const videos = mergeRecordingCopies([first, second], []);
        expect(videos.map((video) => video.recordingCopies)).toEqual([[], []]);
        expect(() => buildVideoAssociationIndex(videos)).not.toThrow();
        expect(first.recordingCopies, "sanitation is staged until commit").toEqual([copy]);
        expect(first.recordingMode).toBe(mode);

        applyRecordingCopies([first, second], videos);
        for (const loaded of [first, second]) {
            expect(loaded.recordingCopies).toEqual([]);
            expect(loaded.recordingMode).toBe("normal");
        }
        expect(mergeRecordingCopies([first, second], []).map((video) => video.recordingCopies)).toEqual([[], []]);
    });

    it.each([false, true])("gives a loaded file priority over a retained alias, new evidence %s", (addCopy) => {
        const first = candidate(file("NO", "F", "card-a"));
        const second = candidate(file("EV", "F", "card-b"));
        const normalCopy = file("NO", "F", "copy-drop");
        applyRecordingCopies([first], [{ ...first, recordingCopies: [second] }]);

        const videos = mergeRecordingCopies([first, second], addCopy ? [{ kept: second, duplicate: normalCopy }] : []);
        expect(videos[0]!.recordingCopies).toEqual([]);
        expect(videos[1]!.recordingCopies).toEqual(addCopy ? [normalCopy] : undefined);
        expect(() => buildVideoAssociationIndex(videos)).not.toThrow();
        applyRecordingCopies([first, second], videos);
        expect(first.recordingCopies).toEqual([]);
        expect(first.recordingMode).toBe("normal");
        expect(second.recordingMode).toBe("event");
    });

    it("removes an existing alias when new evidence gives it a second owner", () => {
        const first = candidate(file("NO", "F", "card-a"));
        const second = candidate(file("NO", "F", "card-b"));
        const event = protectedCopy("event");
        applyRecordingCopies([first], [{ ...first, recordingCopies: [event] }]);

        const videos = mergeRecordingCopies([first, second], [{ kept: second, duplicate: event }]);
        applyRecordingCopies([first, second], videos);
        expect(first.recordingCopies).toEqual([]);
        expect(second.recordingCopies).toBeUndefined();
        expect(first.recordingMode).toBe("normal");
        expect(second.recordingMode).toBe("normal");
    });

    it("keeps remaining manual evidence after removing a conflicting event alias", () => {
        const first = candidate(file("NO", "F", "card-a"));
        const second = candidate(file("NO", "F", "card-b"));
        const event = protectedCopy("event");
        const manual = protectedCopy("manual");
        applyRecordingCopies([first], [{ ...first, recordingCopies: [event, manual] }]);

        const videos = mergeRecordingCopies([first, second], [{ kept: second, duplicate: event }]);
        applyRecordingCopies([first, second], videos);
        expect(first.recordingCopies).toEqual([manual]);
        expect(first.recordingMode).toBe("manual");
        expect(second.recordingMode).toBe("normal");
    });

    it.each(["event", "manual"] as const)(
        "preserves the survivor's own %s classification after alias removal",
        (mode) => {
            const first = candidate(protectedCopy(mode, "card-a"));
            const second = candidate(file("NO", "F", "card-b"));
            const copy = protectedCopy(mode);
            applyRecordingCopies([first], [{ ...first, recordingCopies: [copy] }]);

            const videos = mergeRecordingCopies([first, second], [{ kept: second, duplicate: copy }]);
            applyRecordingCopies([first, second], videos);
            expect(first.recordingCopies).toEqual([]);
            expect(first.recordingMode).toBe(mode);
        },
    );

    it("restores inferred parking after removing the event copy that overrode it", () => {
        const first = candidate(file("NO", "F", "card-a"));
        const second = candidate(file("NO", "F", "card-b"));
        first.isTimelapse = true;
        first.recordingMode = "parking";
        const event = protectedCopy("event");
        applyRecordingCopies([first], [{ ...first, recordingCopies: [event] }]);
        expect(first.recordingMode).toBe("event");

        const videos = mergeRecordingCopies([first, second], [{ kept: second, duplicate: event }]);
        applyRecordingCopies([first, second], videos);
        expect(first.recordingCopies).toEqual([]);
        expect(first.recordingMode).toBe("parking");
        expect(first.isTimelapse).toBe(true);
    });

    it.each(["event", "parking"] as const)(
        "preserves independent %s evidence when a manual alias is removed",
        (mode) => {
            const first = candidate(file("NO", "F", "card-a"));
            const second = candidate(file("NO", "F", "card-b"));
            const manual = protectedCopy("manual");
            applyRecordingCopies([first], [{ ...first, recordingCopies: [manual] }]);
            first.recordingMode = mode;

            const videos = mergeRecordingCopies([first, second], [{ kept: second, duplicate: manual }]);
            applyRecordingCopies([first, second], videos);
            expect(first.recordingCopies).toEqual([]);
            expect(first.recordingMode).toBe(mode);
        },
    );
});
