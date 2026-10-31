// Pure projection from one embedded-dispatch result to persistent raw GPS
// artifacts. Kept separate from IndexedDB/session glue so the revision
// generator can hash exactly the serialization semantics without pulling UI,
// storage, Sentry, or worker lifecycle code into every parser prefix.

import { embeddedGpsDispatchRevision, noEmbeddedGpsDispatchRevision } from "../parsers/primitives/cache-revisions.js";
import type { ClassifiedFile, DispatchedEmbeddedGpsResult } from "../parsers/registry.js";
import type { GpsRecord } from "../parsers/types.js";
import { packAccelColumns, packGpsRecordColumns } from "../persist/gps-columns.js";
import { fileIdentityKey, fileIdentityOf } from "../persist/identity.js";
import type { CachedEmbeddedGps } from "../persist/types.js";
import { vendorFileKey } from "../vendor-file-key.js";

function cacheKeyOf(file: ClassifiedFile): string {
    return fileIdentityKey(fileIdentityOf(file.file.file, file.file.relativePath));
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
    // Groups references only: packing below copies the persisted facts, so no
    // intermediate per-record object is built.
    const recordsByVideoKey = new Map<string, GpsRecord[]>();
    for (const record of result.records) {
        if (!record.videoKey) continue;
        let records = recordsByVideoKey.get(record.videoKey);
        if (!records) {
            records = [];
            recordsByVideoKey.set(record.videoKey, records);
        }
        records.push(record);
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
            recordColumns: packGpsRecordColumns(recordsByVideoKey.get(sessionKey) ?? []),
        };
        const startHint = result.videoStartUtcHintByFileKey.get(sessionKey);
        if (startHint !== undefined) artifact.videoStartUtcHint = startHint;
        const clockHint = result.localClockOffsetHintByFileKey.get(sessionKey);
        if (clockHint !== undefined) artifact.localClockOffsetHintSec = clockHint;
        const accel = result.accelByFileKey.get(sessionKey);
        if (accel && accel.length > 0) artifact.accelColumns = packAccelColumns(accel);
        updates.set(identityKey, artifact);
    }
    return updates;
}
