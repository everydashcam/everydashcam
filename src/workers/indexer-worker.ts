// Worker for MP4/TS indexing (the indexAllMp4Files logic). Two effects:
//   1. Main thread stays responsive during the indexing phase of ingest -
//      a 240-file drop's moov walks would otherwise freeze the UI for 1-3 s.
//   2. Returns moov bytes alongside each result when requested - lets
//      gps-extract reuse them instead of doing a second moov read on
//      cold SD.
//
// MP4/MOV: mediabunny-free single moov walk yields everything we need
// (mvhd duration/creation_time, stsd FourCC for codec, tkhd rotation,
// hvcC for HEVC remux probe).
//
// MPEG-TS: mediabunny.computeDuration + getCodec - TS has no moov, so
// the worker pays the mediabunny bundle cost only on the TS branch.

import type { IndexerWorkerContract } from "./indexer-protocol.js";

import { createLogger } from "../log.js";
import { indexOneFile, type IndexedWithMoov } from "../parsers/internal/mp4-indexing.js";
import {
    INDEXER_NOTIFY_PROGRESS,
    INDEXER_REQUEST_INDEX_ALL,
    type IndexProgressNotificationData,
} from "./indexer-protocol.js";
import { createTypedWorkerServer, type WorkerScopeEndpoint } from "./_protocol/worker-server.js";

declare const self: WorkerScopeEndpoint;

const log = createLogger("indexer-worker");

const server = createTypedWorkerServer<IndexerWorkerContract>(self, {
    onRequest: {
        [INDEXER_REQUEST_INDEX_ALL]: async (req, ctx) => {
            const files = req.files;
            const total = files.length;
            let done = 0;
            let cursor = 0;

            // Concurrency pool inside the worker. Same shape as the previous
            // main-side pool in indexer.ts:218 - N async workers race on cursor++.
            const cap = Math.max(1, Math.min(req.concurrency, files.length));
            const workers = Array.from({ length: cap }, async () => {
                while (cursor < files.length) {
                    if (ctx.signal.aborted) return;
                    const idx = cursor++;
                    const file = files[idx];
                    if (!file) continue;
                    const result: IndexedWithMoov = await indexOneFile(file, req.withMoovBytes, ctx.signal).catch(
                        (err) => {
                            // Degrading a file to state.unindexed is user-visible ("N files
                            // could not be indexed"), so the reason must reach the ring
                            // buffer - a bare swallow left it empty for a whole class of
                            // index failures (A7). One warn per bad file is the right noise
                            // level. Abort is not a file defect - skip its noise.
                            if (!ctx.signal.aborted) {
                                log.warn("index file failed", {
                                    file: file.name,
                                    err: err instanceof Error ? err.message : String(err),
                                });
                            }
                            return { indexed: null };
                        },
                    );
                    if (ctx.signal.aborted) return;
                    done++;
                    const ntf: IndexProgressNotificationData = {
                        batchId: req.batchId,
                        done,
                        total,
                        fileIndex: idx,
                        result: result.indexed,
                    };
                    // Transfer both moov buffers zero-copy: the raw moov for
                    // gps-extract reuse, and (only on a broken file) the patched moov
                    // for the main-thread repair splice. Both are distinct buffers.
                    const transfer: Transferable[] = [];
                    if (result.moovBytes) {
                        ntf.moovBytes = result.moovBytes;
                        transfer.push(result.moovBytes.buffer);
                    }
                    if (result.repair) {
                        ntf.repair = result.repair;
                        transfer.push(result.repair.patchedMoov.buffer);
                    }
                    server.notify(INDEXER_NOTIFY_PROGRESS, ntf, transfer);
                }
            });
            await Promise.all(workers);
            if (ctx.signal.aborted) throw new DOMException("ingest aborted", "AbortError");
            return {};
        },
    },
});
