// Pure projection from one embedded-dispatch result to persistent raw GPS
// artifacts. Kept separate from IndexedDB/session glue so the revision
// generator can hash exactly the serialization semantics without pulling UI,
// storage, Sentry, or worker lifecycle code into every parser prefix.

import { embeddedGpsDispatchRevision, noEmbeddedGpsDispatchRevision } from "../parsers/primitives/cache-revisions.js";
import type { ClassifiedFile, DispatchedEmbeddedGpsResult } from "../parsers/registry.js";
import type { GpsRecord } from "../parsers/types.js";
import { fileIdentityKey, fileIdentityOf } from "../persist/identity.js";
import type { CachedEmbeddedGps, CachedEmbeddedGpsRecord } from "../persist/types.js";
import { vendorFileKey } from "../vendor-file-key.js";

function cacheKeyOf(file: ClassifiedFile): string {
    return fileIdentityKey(fileIdentityOf(file.file.file, file.file.relativePath));
}

function toCachedRecord(record: GpsRecord): CachedEmbeddedGpsRecord {
    const {
        videoKey: _videoKey,
        recordingAssociation: _recordingAssociation,
        timeAssociation: _timeAssociation,
        externalTrack: _externalTrack,
        externalTrackKey: _externalTrackKey,
        localClockOffsetAppliedSec: _localClockOffsetAppliedSec,
        ...cached
    } = record;
    // Persist the parser's raw axis even if a future call site captures this
    // record after applyLocalClockCorrections has already shifted it. The marker
    // is the amount subtracted from unixSeconds, so adding it reverses the
    // session mutation before the marker itself is discarded.
    if (record.localClockOffsetAppliedSec) {
        return { ...cached, unixSeconds: cached.unixSeconds + record.localClockOffsetAppliedSec };
    }
    return cached;
}

/** Pure per-file artifact projection, exported for revision hashing/tests. */
export function buildEmbeddedGpsCacheArtifactUpdates(
    targets: readonly ClassifiedFile[],
    result: DispatchedEmbeddedGpsResult,
    excludedKeys: ReadonlySet<string> = new Set(),
): Map<string, CachedEmbeddedGps | null> {
    const updates = new Map<string, CachedEmbeddedGps | null>();
    const identityBySessionKey = new Map<string, string>();
    for (const target of targets) {
        identityBySessionKey.set(vendorFileKey(target.file), cacheKeyOf(target));
    }
    const errorNames = new Set(result.errors.map((error) => error.file));
    const heavyKeys = new Set(result.heavyFiles.map((file) => vendorFileKey(file.file)));
    const recordsByVideoKey = new Map<string, CachedEmbeddedGpsRecord[]>();
    for (const record of result.records) {
        if (!record.videoKey) continue;
        let records = recordsByVideoKey.get(record.videoKey);
        if (!records) {
            records = [];
            recordsByVideoKey.set(record.videoKey, records);
        }
        records.push(toCachedRecord(record));
    }

    for (const target of targets) {
        const sessionKey = vendorFileKey(target.file);
        const identityKey = identityBySessionKey.get(sessionKey)!;
        const extractorId = result.winningExtractorByFileKey.get(sessionKey);
        if (excludedKeys.has(sessionKey) || heavyKeys.has(sessionKey)) {
            updates.set(identityKey, null);
            continue;
        }
        if (!extractorId) {
            if (errorNames.has(target.file.file.name)) {
                updates.set(identityKey, null);
                continue;
            }
            updates.set(identityKey, {
                status: "none",
                dispatchRevision: noEmbeddedGpsDispatchRevision(),
            });
            continue;
        }

        const dispatchRevision = embeddedGpsDispatchRevision(extractorId);
        const sourceSessionKey = result.sourceFileKeyByFileKey.get(sessionKey);
        if (!sourceSessionKey) {
            updates.set(identityKey, null);
            continue;
        }
        const sourceIdentityKey = identityBySessionKey.get(sourceSessionKey);
        if (!dispatchRevision || !sourceIdentityKey) {
            // A stale generated registry or an incomplete clone result is not a
            // cacheable success. Runtime parsing still succeeded for this run.
            updates.set(identityKey, null);
            continue;
        }
        const artifact: CachedEmbeddedGps = {
            status: "parsed",
            dispatchRevision,
            extractorId,
            sourceIdentityKey,
            records: recordsByVideoKey.get(sessionKey) ?? [],
        };
        const startHint = result.videoStartUtcHintByFileKey.get(sessionKey);
        if (startHint !== undefined) artifact.videoStartUtcHint = startHint;
        const clockHint = result.localClockOffsetHintByFileKey.get(sessionKey);
        if (clockHint !== undefined) artifact.localClockOffsetHintSec = clockHint;
        const accel = result.accelByFileKey.get(sessionKey);
        if (accel && accel.length > 0) artifact.accelSamples = accel.map((sample) => ({ ...sample }));
        updates.set(identityKey, artifact);
    }
    return updates;
}
