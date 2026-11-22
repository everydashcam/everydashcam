// A/B of the export read abstraction: mediabunny's BlobSource vs our
// RetryingBlobSource (CustomSource + per-chunk retry). The retrying source
// replaced BlobSource on every export read path, and the two differ in
// mechanics (BlobSource keeps long-lived per-worker stream readers and runs up
// to 4 read workers; CustomSource opens a stream per orchestrator request and
// is capped at 2 workers) - this bench is the regression tripwire for that
// swap. The walk is a full sequential EncodedPacketSink pass: the same
// dominant access pattern an export's demux performs, minus decode.
//
// Files come from private/samples (real recordings, local-only) - the largest
// one under the size cap, so the walk is long enough to dominate setup.
// Without samples the corpus fixture keeps the bench runnable, just less
// representative. The File is built in-memory so disk IO is out of the
// measurement.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";

import { BlobSource, EncodedPacketSink, Input, type Source } from "./mediabunny.js";

import { createRetryingBlobSource } from "./retrying-blob-source.js";
import { VIDEO_INPUT_FORMATS } from "./video-formats.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const SAMPLES_ROOT = join(REPO_ROOT, "private", "samples");
const FALLBACK = join(REPO_ROOT, "tests", "testdata", "dashcam-viewer-corpus", "MOV_0581.mp4");

// Big enough that the packet walk dominates, small enough that one iteration
// stays in the hundreds of milliseconds.
const MAX_SIZE_BYTES = 512 * 1024 * 1024;

function pickSample(): string | null {
    if (!existsSync(SAMPLES_ROOT)) return existsSync(FALLBACK) ? FALLBACK : null;
    let best: { path: string; size: number } | null = null;
    const walk = (dir: string): void => {
        let entries: string[];
        try {
            entries = readdirSync(dir);
        } catch {
            return;
        }
        for (const entry of entries) {
            const p = join(dir, entry);
            let st: ReturnType<typeof statSync>;
            try {
                st = statSync(p);
            } catch {
                continue;
            }
            if (st.isDirectory()) walk(p);
            else if (/\.(mp4|mov)$/i.test(entry) && st.size <= MAX_SIZE_BYTES && (!best || st.size > best.size)) {
                best = { path: p, size: st.size };
            }
        }
    };
    walk(SAMPLES_ROOT);
    return best ? (best as { path: string }).path : existsSync(FALLBACK) ? FALLBACK : null;
}

async function walkAllPackets(source: Source): Promise<void> {
    const input = new Input({ source, formats: VIDEO_INPUT_FORMATS });
    try {
        const track = await input.getPrimaryVideoTrack();
        if (!track) throw new Error("bench sample has no video track");
        const sink = new EncodedPacketSink(track);
        for (let packet = await sink.getFirstPacket(); packet; packet = await sink.getNextPacket(packet)) {
            // The walk itself is the workload.
        }
    } finally {
        input.dispose();
    }
}

const samplePath = pickSample();

if (samplePath) {
    const bytes = readFileSync(samplePath);
    const file = new File([bytes], samplePath.split("/").pop() ?? "sample.mp4");
    const label = `${file.name} (${Math.round(file.size / 1048576)} MB)`;

    it(`walks packets sequentially over ${label}`, async ({ bench }) => {
        await bench.compare(
            bench("BlobSource", () => walkAllPackets(new BlobSource(file))),
            bench("RetryingBlobSource", () => walkAllPackets(createRetryingBlobSource(file))),
        );
    });
} else {
    describe.skip("sequential packet walk (no sample available)", () => {});
}
