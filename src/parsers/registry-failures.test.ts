import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { vendorFileKey } from "../vendor-file-key.js";
import { findFreeGpsOffsets } from "./internal/freegps.js";
import { iterTokens } from "./internal/gpmf.js";
import { buildMp4Index } from "./internal/mp4-index.js";
import { findBox, readSampleTable } from "./internal/mp4-walker.js";
import { type ClassifiedFile, dispatchParseVideoEmbeddedGps } from "./registry.js";

const HERE = dirname(fileURLToPath(import.meta.url));

function fixture(path: string): Uint8Array<ArrayBuffer> {
    return Uint8Array.from(readFileSync(resolve(HERE, path)));
}

function video(file: File, sourceKey = "card"): ClassifiedFile {
    return {
        file: { file, relativePath: `Record/${file.name}`, sourceKey },
        role: "video",
        sidecarId: null,
        sidecarMp4: null,
        logExtractorId: null,
    };
}

/** Keeps real fixture bytes while reproducing an unreadable range at the File boundary. */
class UnreadableRangeFile extends File {
    constructor(
        bytes: Uint8Array<ArrayBuffer>,
        name: string,
        private readonly rejects: (start: number, end: number) => boolean,
        private readonly failure: Error = new Error("file range is unreadable"),
    ) {
        super([bytes], name, { lastModified: 0 });
    }

    override slice(start = 0, end = this.size, contentType?: string): Blob {
        if (this.rejects(start, end)) throw this.failure;
        return super.slice(start, end, contentType);
    }
}

async function navitelFixture() {
    const bytes = fixture("__fixtures__/navitel/real-anonymized.TS");
    const index = await buildMp4Index(new File([bytes], "clip.mp4"));
    expect(index.navitelGps0Atom).not.toBeNull();
    expect(index.navitelIditAtom).not.toBeNull();
    return { bytes, gps: index.navitelGps0Atom!, idit: index.navitelIditAtom! };
}

function withoutGpsFix(view: DataView): number {
    let changed = 0;
    for (const token of iterTokens(view)) {
        if (token.type === 0) changed += withoutGpsFix(token.payload);
        else if (token.fourCC === "GPSF") {
            token.payload.setUint32(0, 0);
            changed++;
        }
    }
    return changed;
}

async function goproWithFailingNavitel(noFix: boolean): Promise<ClassifiedFile> {
    const bytes = fixture("../../tests/testdata/gopro-gpmf/hero5-trimmed.mp4");
    if (noFix) {
        const index = await buildMp4Index(new File([bytes], "clip.mp4"));
        const track = index.tracks.find((item) => item.sampleFormat === "gpmd");
        expect(track).toBeDefined();
        const samples = readSampleTable(index.moovView!, track!.trakBox)!;
        let changed = 0;
        for (const sample of samples) {
            changed += withoutGpsFix(new DataView(bytes.buffer, sample.offset, sample.size));
        }
        expect(changed).toBeGreaterThan(0);
    }
    const navitel = await navitelFixture();
    const tail = [navitel.idit, navitel.gps].map((atom) => navitel.bytes.slice(atom.offset, atom.offset + atom.size));
    const combined = new Uint8Array(bytes.length + tail[0]!.length + tail[1]!.length);
    combined.set(bytes);
    combined.set(tail[0]!, bytes.length);
    const gpsOffset = bytes.length + tail[0]!.length;
    combined.set(tail[1]!, gpsOffset);
    return video(
        new UnreadableRangeFile(
            combined,
            "clip.mp4",
            (start, end) => start === gpsOffset && end === gpsOffset + navitel.gps.size,
        ),
    );
}

describe("terminal embedded GPS failure evidence", () => {
    it("identifies only the unreadable GPS file among equal paths from different cards", async () => {
        const { bytes, gps } = await navitelFixture();
        const failed = video(
            new UnreadableRangeFile(
                bytes,
                "clip.mp4",
                (start, end) => start === gps.offset && end - start === gps.size,
            ),
            "failed-card",
        );
        const healthy = video(new File([bytes], "clip.mp4", { lastModified: 0 }), "healthy-card");

        const result = await dispatchParseVideoEmbeddedGps([failed, healthy]);

        expect(result.failedFileKeys).toEqual(new Set([vendorFileKey(failed.file)]));
        expect(result.errors.some((error) => error.extractor === "navitel-tail")).toBe(true);
        expect(result.winningExtractorByFileKey.get(vendorFileKey(healthy.file))).toBe("navitel-tail");
        expect(result.records.length).toBeGreaterThan(0);
    });

    it("suppresses a matched parser failure when a later parser recovers GPS", async () => {
        const candidate = await goproWithFailingNavitel(false);

        const result = await dispatchParseVideoEmbeddedGps([candidate]);

        expect(result.errors.some((error) => error.extractor === "navitel-tail")).toBe(true);
        expect(result.winningExtractorByFileKey.get(vendorFileKey(candidate.file))).toBe("gpmf");
        expect(result.records.length).toBeGreaterThan(0);
        expect(result.failedFileKeys.size).toBe(0);
    });

    it("suppresses a matched parser failure when another parser successfully reads a no-fix track", async () => {
        const candidate = await goproWithFailingNavitel(true);

        const result = await dispatchParseVideoEmbeddedGps([candidate]);

        expect(result.errors.some((error) => error.extractor === "navitel-tail")).toBe(true);
        expect(result.records).toHaveLength(0);
        expect(result.winningExtractorByFileKey.size).toBe(0);
        expect(result.failedFileKeys.size).toBe(0);
    });

    it("does not turn GPS marker read errors into confirmed parser failures", async () => {
        const bytes = fixture("__fixtures__/thinkware/real-anonymized.mp4");
        const index = await buildMp4Index(new File([bytes], "clip.mp4"));
        const track = index.tracks.find((item) => item.handlerType === "sbtl");
        expect(track).toBeDefined();
        const first = readSampleTable(index.moovView!, track!.trakBox)![0]!;
        const candidate = video(new UnreadableRangeFile(bytes, "clip.mp4", (start) => start === first.offset));

        const result = await dispatchParseVideoEmbeddedGps([candidate]);

        expect(result.errors.some((error) => error.extractor === "nmea-subtitle")).toBe(true);
        expect(result.records).toHaveLength(0);
        expect(result.failedFileKeys.size).toBe(0);
    });

    it("does not report format rejection or absent telemetry", async () => {
        const { bytes, gps } = await navitelFixture();
        bytes.fill(0, gps.offset + 8, gps.offset + gps.size);
        const rejected = video(new File([bytes], "rejected.mp4"));
        const absent = video(new File([fixture("__fixtures__/thinkware/real-anonymized-rear.mp4")], "rear.mp4"));

        const result = await dispatchParseVideoEmbeddedGps([rejected, absent]);

        expect(result.records).toHaveLength(0);
        expect(result.errors).toHaveLength(0);
        expect(result.failedFileKeys.size).toBe(0);
    });

    it("does not report a malformed container index as a GPS parser failure", async () => {
        const { bytes } = await navitelFixture();
        const view = new DataView(bytes.buffer);
        const moov = findBox(view, 0, bytes.length, "moov")!;
        const mvhd = findBox(view, moov.payloadStart, moov.end, "mvhd")!;
        const truncated = bytes.slice(0, mvhd.payloadStart);
        const truncatedView = new DataView(truncated.buffer);
        truncatedView.setUint32(moov.start, truncated.length - moov.start);
        truncatedView.setUint32(mvhd.start, 8);

        const result = await dispatchParseVideoEmbeddedGps([video(new File([truncated], "clip.mp4"))]);

        expect(result.errors.some((error) => error.extractor === "mp4-index")).toBe(true);
        expect(result.records).toHaveLength(0);
        expect(result.failedFileKeys.size).toBe(0);
    });

    it("does not report deferred telemetry before its full scan", async () => {
        const bytes = fixture("../../tests/testdata/novatek-real-anonymized/2e-drive-730.mp4");
        const markers = findFreeGpsOffsets(bytes, 0, bytes.length, 100);
        expect(markers.length).toBeGreaterThan(1);
        for (const offset of markers.slice(1)) bytes[offset] = 0;
        const candidate = video(new File([bytes], "clip.mp4"));

        const result = await dispatchParseVideoEmbeddedGps([candidate], undefined, 1, undefined, "light-only");

        expect(result.heavyFiles).toEqual([candidate]);
        expect(result.records).toHaveLength(0);
        expect(result.failedFileKeys.size).toBe(0);
    });

    it("propagates a cancelled matched parser instead of recording a failure", async () => {
        const { bytes, gps } = await navitelFixture();
        const abort = new DOMException("cancelled", "AbortError");
        const candidate = video(
            new UnreadableRangeFile(
                bytes,
                "clip.mp4",
                (start, end) => start === gps.offset && end - start === gps.size,
                abort,
            ),
        );

        await expect(dispatchParseVideoEmbeddedGps([candidate])).rejects.toBe(abort);
    });

    it("suppresses a failed clone-group member when its peer supplies GPS", async () => {
        const bytes = fixture("__fixtures__/juscar/real-anonymized.TS");
        // The marker probe already holds the whole fixture and the extractor
        // scans it from there, so the front file is padded past the probe
        // window with null packets and its first read beyond it fails.
        const TS_PACKET = 188;
        const padding = new Uint8Array(Math.ceil((4 * 1024 * 1024) / TS_PACKET) * TS_PACKET).fill(0xff);
        for (let at = 0; at < padding.length; at += TS_PACKET) padding.set([0x47, 0x1f, 0xff, 0x10], at);
        const padded = new Uint8Array(bytes.length + padding.length);
        padded.set(bytes, 0);
        padded.set(padding, bytes.length);
        const front = video(new UnreadableRangeFile(padded, "20260429_182640F.ts", (start) => start >= bytes.length));
        const rear = video(new File([bytes], "20260429_182640R.ts"));

        const result = await dispatchParseVideoEmbeddedGps([front, rear]);

        expect(result.errors.some((error) => error.extractor === "juscar-ts")).toBe(true);
        expect(result.sourceFileKeyByFileKey.get(vendorFileKey(front.file))).toBe(vendorFileKey(rear.file));
        expect(result.records.length).toBeGreaterThan(0);
        expect(result.failedFileKeys.size).toBe(0);
    });
});
