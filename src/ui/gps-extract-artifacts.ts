// Pure artifact-affecting pieces of the GPS worker facade. Pool sizing,
// progress callbacks, and worker lifecycle stay in gps-extract-shim.ts; these
// functions define which bytes are grouped together, how the worker request is
// wired, and how success/failure results become cacheable facts.

import { extendArray } from "../array-extend.js";
import { VIDEO_CLONE_GROUPERS, videoCloneAffinityKey } from "../parsers/primitives/clone-groups.js";
import type { ClassifiedFile, DispatchedEmbeddedGpsResult } from "../parsers/registry.js";
import type { AccelSample, GpsRecord, SkippedLine, VendorFile } from "../parsers/types.js";
import { vendorFileKey } from "../vendor-file-key.js";
import type { EmbeddedGpsExtractionMode, ExtractRequestData } from "../workers/gps-extract-protocol.js";

/** Scoped clone-affinity key of one video, or null when no primitive clones
 * GPS across a group containing it. Progressive ingest holds group members
 * until all are indexed so they reach the worker in one request, and the shard
 * planner below keeps them in one chunk; both must derive the same key. */
export function videoCloneAffinityKeyOf(file: VendorFile): string | null {
    for (const grouper of VIDEO_CLONE_GROUPERS) {
        const group = grouper.cloneAcrossGroup(file);
        if (group !== null) return videoCloneAffinityKey(grouper.id, file, group);
    }
    return null;
}

/** Splits videos while keeping cloneAcrossGroup peers in one worker shard. */
export function shardByCloneAffinity(classified: ClassifiedFile[], n: number): ClassifiedFile[][] {
    const videos = classified.filter((candidate) => candidate.role === "video");
    if (videos.length === 0 || n <= 1) return videos.length > 0 ? [videos] : [];

    const groups = new Map<string, ClassifiedFile[]>();
    const singletons: ClassifiedFile[] = [];
    for (const video of videos) {
        const key = videoCloneAffinityKeyOf(video.file);
        if (key === null) {
            singletons.push(video);
        } else {
            let peers = groups.get(key);
            if (!peers) {
                peers = [];
                groups.set(key, peers);
            }
            peers.push(video);
        }
    }

    const chunks: ClassifiedFile[][] = Array.from({ length: n }, () => []);
    let cursor = 0;
    for (const peers of groups.values()) {
        chunks[cursor % n]!.push(...peers);
        cursor++;
    }
    for (const singleton of singletons) {
        chunks[cursor % n]!.push(singleton);
        cursor++;
    }
    return chunks.filter((chunk) => chunk.length > 0);
}

/** The result-affecting request fields sent through the worker protocol. */
export function buildGpsExtractRequest(
    token: string,
    classified: ClassifiedFile[],
    mode: EmbeddedGpsExtractionMode,
    prebuiltMoovByPath?: Map<string, Uint8Array>,
): ExtractRequestData {
    return {
        token,
        classified,
        // File-level parallelism comes from the pool. A worker stays serial so
        // it cannot turn one removable device into concurrent random reads.
        concurrency: 1,
        mode,
        prebuiltMoovByPath,
    };
}

/** Selects only this shard's identity-keyed moov buffers and transfer list. */
export function buildGpsExtractShardRequest(
    token: string,
    classified: ClassifiedFile[],
    mode: EmbeddedGpsExtractionMode,
    prebuiltMoovByPath?: ReadonlyMap<string, Uint8Array>,
): { request: ExtractRequestData; transfer: Transferable[] } {
    let shardMoov: Map<string, Uint8Array> | undefined;
    const transfer: Transferable[] = [];
    if (prebuiltMoovByPath && prebuiltMoovByPath.size > 0) {
        shardMoov = new Map();
        for (const candidate of classified) {
            const key = vendorFileKey(candidate.file);
            const bytes = prebuiltMoovByPath.get(key);
            if (!bytes) continue;
            shardMoov.set(key, bytes);
            transfer.push(bytes.buffer);
        }
        if (shardMoov.size === 0) shardMoov = undefined;
    }
    return {
        request: buildGpsExtractRequest(token, classified, mode, shardMoov),
        transfer,
    };
}

/** Concatenates successful dispatch results without mutating the inputs. */
export function mergeEmbeddedResults(results: readonly DispatchedEmbeddedGpsResult[]): DispatchedEmbeddedGpsResult {
    const appliedSet = new Set<string>();
    const records: GpsRecord[] = [];
    const skipped: SkippedLine[] = [];
    const errors: DispatchedEmbeddedGpsResult["errors"] = [];
    const failedFileKeys = new Set<string>();
    const winningExtractorByFileKey = new Map<string, string>();
    const sourceFileKeyByFileKey = new Map<string, string>();
    const videoStartUtcHintByFileKey = new Map<string, number>();
    const localClockOffsetHintByFileKey = new Map<string, number>();
    const accelByFileKey = new Map<string, AccelSample[]>();
    const heavyFiles: ClassifiedFile[] = [];
    for (const result of results) {
        for (const extractor of result.appliedExtractors) appliedSet.add(extractor);
        // A long single-file stream can exceed the call-argument limit.
        extendArray(records, result.records);
        extendArray(skipped, result.skipped);
        extendArray(errors, result.errors);
        for (const key of result.failedFileKeys) failedFileKeys.add(key);
        for (const [key, value] of result.winningExtractorByFileKey) winningExtractorByFileKey.set(key, value);
        for (const [key, value] of result.sourceFileKeyByFileKey) sourceFileKeyByFileKey.set(key, value);
        for (const [key, value] of result.videoStartUtcHintByFileKey) videoStartUtcHintByFileKey.set(key, value);
        for (const [key, value] of result.localClockOffsetHintByFileKey) {
            localClockOffsetHintByFileKey.set(key, value);
        }
        for (const [key, value] of result.accelByFileKey) accelByFileKey.set(key, value);
        extendArray(heavyFiles, result.heavyFiles);
    }
    for (const key of winningExtractorByFileKey.keys()) failedFileKeys.delete(key);
    for (const file of heavyFiles) failedFileKeys.delete(vendorFileKey(file.file));
    return {
        appliedExtractors: [...appliedSet],
        records,
        skipped,
        errors,
        failedFileKeys,
        winningExtractorByFileKey,
        sourceFileKeyByFileKey,
        videoStartUtcHintByFileKey,
        localClockOffsetHintByFileKey,
        accelByFileKey,
        heavyFiles,
    };
}

/** Merges healthy shards and marks every file in a crashed shard retryable. */
export function mergeSettledGpsExtractShards(
    settled: readonly PromiseSettledResult<DispatchedEmbeddedGpsResult>[],
    chunks: readonly ClassifiedFile[][],
): DispatchedEmbeddedGpsResult {
    const fulfilled: DispatchedEmbeddedGpsResult[] = [];
    const shardErrors: DispatchedEmbeddedGpsResult["errors"] = [];
    for (let index = 0; index < settled.length; index++) {
        const result = settled[index]!;
        if (result.status === "fulfilled") {
            fulfilled.push(result.value);
            continue;
        }
        if (result.reason instanceof DOMException && result.reason.name === "AbortError") throw result.reason;
        const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
        for (const candidate of chunks[index] ?? []) {
            shardErrors.push({
                file: candidate.file.file.name,
                extractor: "gps-extract-worker",
                message,
            });
        }
    }
    const merged = mergeEmbeddedResults(fulfilled);
    extendArray(merged.errors, shardErrors);
    return merged;
}
