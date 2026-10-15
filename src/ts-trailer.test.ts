import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BlobSource, Input, MPEG_TS } from "mediabunny";
import { describe, expect, it } from "vitest";

import { clampTsTrailingBytes, findTsGpsTrailer } from "./ts-trailer.js";

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), "parsers/__fixtures__/ligogps-trailer-ts");
const happy = readFileSync(resolve(FIXTURES, "synthetic-happy.TS"));
const wrongFormat = readFileSync(resolve(FIXTURES, "synthetic-wrong-format.TS"));
const realAnonymized = readFileSync(resolve(FIXTURES, "real-anonymized.TS"));
const realAmpersand = readFileSync(resolve(FIXTURES, "real-anonymized-ampersand.TS"));
const realEmptyCapacity = readFileSync(resolve(FIXTURES, "real-anonymized-empty-capacity.TS"));
const realPaired = readFileSync(resolve(FIXTURES, "real-anonymized-paired.TS"));

// happy = 2 null TS packets + trailer (see build-synthetic.mjs).
const HAPPY_CLEAN = 2 * 188;

function blobOf(buf: Buffer): Blob {
    return new Blob([Uint8Array.from(buf)]);
}

describe("findTsGpsTrailer", () => {
    it("detects the LCAI trailer and reports the clean 188-aligned prefix", async () => {
        const t = await findTsGpsTrailer(blobOf(happy));
        expect(t).not.toBeNull();
        expect(t!.cleanLength).toBe(HAPPY_CLEAN);
        expect(t!.trailerLength).toBe(happy.length - HAPPY_CLEAN);
    });

    it("accepts the classic LIGO magic spelling with the length-header dialect", async () => {
        const patched = Buffer.from(happy);
        patched.write("SKIPLIGOGPSINFO", HAPPY_CLEAN + 4, "latin1");
        expect(await findTsGpsTrailer(blobOf(patched))).not.toBeNull();
    });

    it("rejects the ampersand terminator paired with LCAI magic", async () => {
        const lcaiWithAmpersands = Buffer.from(happy);
        lcaiWithAmpersands.write("&&&&", lcaiWithAmpersands.length - 8, "latin1");
        expect(await findTsGpsTrailer(blobOf(lcaiWithAmpersands))).toBeNull();
    });

    it("rejects invalid dialect header values", async () => {
        const lcaiWithSlotCount = Buffer.from(happy);
        lcaiWithSlotCount.writeUInt32LE(2, HAPPY_CLEAN + 24);
        expect(await findTsGpsTrailer(blobOf(lcaiWithSlotCount))).toBeNull();

        const ligoWithUndersizedCapacity = Buffer.from(realAmpersand);
        const ligoTrailerLength = ligoWithUndersizedCapacity.readUInt32BE(ligoWithUndersizedCapacity.length - 4);
        ligoWithUndersizedCapacity.writeUInt32LE(59, ligoWithUndersizedCapacity.length - ligoTrailerLength + 24);
        expect(await findTsGpsTrailer(blobOf(ligoWithUndersizedCapacity))).toBeNull();
    });

    it.each(["count", "empty"])("detects and demuxes the real %s dialect", async (dialect) => {
        const bytes = readFileSync(resolve(FIXTURES, `real-anonymized-${dialect}.TS`));
        const file = new File([Uint8Array.from(bytes)], "20260904_202849F.ts");
        const trailer = await findTsGpsTrailer(file);
        expect(trailer?.trailerLength).toBe(dialect === "count" ? 7956 : 36);
        const input = new Input({ source: new BlobSource(await clampTsTrailingBytes(file)), formats: [MPEG_TS] });
        try {
            expect(await input.computeDuration()).toBeGreaterThanOrEqual(2);
        } finally {
            input.dispose();
        }
    });

    it("clamps an empty LCAI table with a retained slot capacity", async () => {
        const file = new File([Uint8Array.from(realEmptyCapacity)], "20260904_205125F.ts");
        const trailer = await findTsGpsTrailer(file);
        expect(trailer?.trailerLength).toBe(36);
        expect((await clampTsTrailingBytes(file)).size).toBe(file.size - 36);
        const input = new Input({ source: new BlobSource(await clampTsTrailingBytes(file)), formats: [MPEG_TS] });
        try {
            expect(await input.computeDuration()).toBeGreaterThan(2);
        } finally {
            input.dispose();
        }
    });

    it("rejects populated or nonzero SKIP-only headers", async () => {
        const empty = readFileSync(resolve(FIXTURES, "real-anonymized-empty.TS"));
        empty[empty.length - 36 + 8] = 1;
        expect(await findTsGpsTrailer(blobOf(empty))).toBeNull();
        const populated = Buffer.from(happy);
        populated.fill(0, HAPPY_CLEAN + 8, HAPPY_CLEAN + 28);
        expect(await findTsGpsTrailer(blobOf(populated))).toBeNull();
    });

    it("rejects an LCAI capacity when slots are present or it exceeds the sanity bound", async () => {
        const populated = Buffer.from(happy);
        populated.writeUInt32LE(35, HAPPY_CLEAN + 24);
        expect(await findTsGpsTrailer(blobOf(populated))).toBeNull();

        const excessive = Buffer.from(realEmptyCapacity);
        const trailerStart = excessive.length - 36;
        excessive.writeUInt32LE(200_000, trailerStart + 24);
        expect(await findTsGpsTrailer(blobOf(excessive))).toBeNull();
    });

    it("rejects a foreign magic even with valid structure", async () => {
        expect(await findTsGpsTrailer(blobOf(wrongFormat))).toBeNull();
    });

    it("rejects a foreign terminator even with valid lengths and magic", async () => {
        const patched = Buffer.from(happy);
        patched.write("!!!!", patched.length - 8, "latin1");
        expect(await findTsGpsTrailer(blobOf(patched))).toBeNull();
    });

    it("rejects a file with no known terminator", async () => {
        expect(await findTsGpsTrailer(blobOf(happy.subarray(0, HAPPY_CLEAN)))).toBeNull();
    });

    it("rejects a trailer whose slot region is not 132-byte aligned", async () => {
        const patched = Buffer.concat([happy.subarray(0, -8), Buffer.alloc(1), happy.subarray(-8)]);
        const trailerLength = patched.length - HAPPY_CLEAN;
        patched.writeUInt32BE(trailerLength, HAPPY_CLEAN);
        patched.writeUInt32BE(trailerLength, patched.length - 4);
        expect(await findTsGpsTrailer(blobOf(patched))).toBeNull();
    });

    it("rejects when the clean prefix falls off the 188 grid", async () => {
        // One junk byte before the trailer shifts the grid; the trailer
        // length no longer lands the prefix on a packet boundary.
        const shifted = Buffer.concat([
            happy.subarray(0, HAPPY_CLEAN),
            Buffer.from([0xaa]),
            happy.subarray(HAPPY_CLEAN),
        ]);
        expect(await findTsGpsTrailer(blobOf(shifted))).toBeNull();
    });

    it("rejects when the leading length copy disagrees with the terminator", async () => {
        const patched = Buffer.from(happy);
        patched.writeUInt32BE(0xdeadbeef >>> 0, HAPPY_CLEAN);
        expect(await findTsGpsTrailer(blobOf(patched))).toBeNull();
    });

    it("rejects blobs smaller than a packet plus an empty trailer", async () => {
        expect(await findTsGpsTrailer(blobOf(happy.subarray(0, 64)))).toBeNull();
    });

    it("detects the trailer on the real-anonymized fixture", async () => {
        const t = await findTsGpsTrailer(blobOf(realAnonymized));
        expect(t).not.toBeNull();
        expect(t!.cleanLength % 188).toBe(0);
        expect(t!.trailerLength).toBe(7956);
    });

    it("detects the ampersand dialect on its real-anonymized fixture", async () => {
        const t = await findTsGpsTrailer(blobOf(realAmpersand));
        expect(t).not.toBeNull();
        expect(t!.cleanLength % 188).toBe(0);
        expect(t!.trailerLength).toBe(7956);
    });

    it("accepts an ampersand trailer whose capacity exceeds its written slots", async () => {
        const patched = Buffer.from(realAmpersand);
        const trailerLength = patched.readUInt32BE(patched.length - 4);
        patched.writeUInt32LE(61, patched.length - trailerLength + 24);
        expect(await findTsGpsTrailer(blobOf(patched))).not.toBeNull();
    });
});

describe("paired TS trailers", () => {
    const cleanLength = realPaired.length - 1024 - 17360;

    it("recognizes the table structure independently of the firmware label and filename", async () => {
        const bytes = Buffer.from(realPaired);
        bytes.write("OTHERFW V2 ", cleanLength + 8680 + 8, "latin1");
        const file = new File([Uint8Array.from(bytes)], "another-camera.ts");
        expect((await findTsGpsTrailer(file))?.cleanLength).toBe(cleanLength);
    });

    it("uses each table's own length and slot count", async () => {
        const first = Buffer.from(realPaired.subarray(cleanLength, cleanLength + 8680 - 132));
        const total = 17360 - 132;
        first.writeUInt32BE(total, 0);
        first.writeUInt32LE(64, 24);
        first.write("&&&&", first.length - 8, "latin1");
        first.writeUInt32BE(total, first.length - 4);
        const bytes = Buffer.concat([
            realPaired.subarray(0, cleanLength),
            first,
            realPaired.subarray(cleanLength + 8680),
        ]);
        expect(await findTsGpsTrailer(blobOf(bytes))).toEqual({
            cleanLength,
            trailerLength: total,
            unindexedRecordsOffset: 8772 - 132,
        });
    });

    it("preserves zero bytes belonging to the trailing length field", async () => {
        const blocks = [0, 8680].map((offset) => {
            const block = Buffer.from(realPaired.subarray(cleanLength + offset, cleanLength + offset + 1024));
            block.writeUInt32BE(offset === 0 ? 2048 : 1024, 0);
            if (offset === 0) block.writeUInt32LE(7, 24);
            else block.writeUInt32BE(7, 24);
            block.write("&&&&", 1016, "latin1");
            block.writeUInt32BE(offset === 0 ? 2048 : 1024, 1020);
            return block;
        });
        const file = blobOf(Buffer.concat([realPaired.subarray(0, cleanLength), ...blocks, Buffer.alloc(1024)]));
        expect(await findTsGpsTrailer(file)).toEqual({
            cleanLength,
            trailerLength: 2048,
            unindexedRecordsOffset: 1116,
        });
    });

    it.each([0, 1024, 40 * 1024 * 1024])("detects both tables before %i zero padding bytes", async (padding) => {
        const file = new File([Uint8Array.from(realPaired.subarray(0, -1024)), new Uint8Array(padding)], "paired.ts");
        expect(await findTsGpsTrailer(file)).toEqual({
            cleanLength,
            trailerLength: 17360,
            unindexedRecordsOffset: 8772,
        });
        expect((await clampTsTrailingBytes(file)).size).toBe(cleanLength);
    });

    it.each([0, 4, 24, 28, 8680 - 8, 8680 - 4, 8680, 8680 + 4, 8680 + 24, 8680 + 28, 17360 - 8, 17360 - 4])(
        "rejects a damaged paired header or footer at offset %i",
        async (offset) => {
            const bytes = Buffer.from(realPaired);
            bytes[cleanLength + offset]! ^= 1;
            expect(await findTsGpsTrailer(blobOf(bytes))).toBeNull();
        },
    );

    it("rejects nonzero data following the tables", async () => {
        const bytes = Buffer.from(realPaired);
        bytes[bytes.length - 500] = 1;
        expect(await findTsGpsTrailer(blobOf(bytes))).toBeNull();
    });

    it("rejects a valid-looking pair without the TS packet grid", async () => {
        for (const offset of [0, cleanLength - 188]) {
            const bytes = Buffer.from(realPaired);
            bytes[offset] = 0;
            expect(await findTsGpsTrailer(blobOf(bytes))).toBeNull();
        }
    });

    it("rejects a pair shifted off the packet grid", async () => {
        expect(await findTsGpsTrailer(new Blob([new Uint8Array(1), Uint8Array.from(realPaired)]))).toBeNull();
    });

    it("finds the tables behind padding larger than the scan bound", async () => {
        const file = new Blob([Uint8Array.from(realPaired), new Uint8Array(65 * 1024 * 1024)]);
        expect((await findTsGpsTrailer(file))?.cleanLength).toBe(cleanLength);
    });

    it("rejects stray bytes behind the tables even past the padding window", async () => {
        // The exhaustive scan treats any non-zero byte behind the tables as an
        // unknown structure; the bisection path keeps that rule for the window
        // it reads and leaves the rest of the padding unread.
        const bytes = Buffer.concat([realPaired, Buffer.alloc(32 * 1024)]);
        bytes[bytes.length - 1] = 1;
        expect(await findTsGpsTrailer(blobOf(bytes))).toBeNull();
    });
});

describe("clampTsTrailingBytes", () => {
    it.each([1, 7, 40 * 1024 * 1024])(
        "recognizes standard GPS tables before %i zero padding bytes",
        async (padding) => {
            const file = new File([Uint8Array.from(realAmpersand), new Uint8Array(padding)], "standard.ts");
            const trailer = await findTsGpsTrailer(file);
            expect(trailer?.trailerLength).toBe(7956);
            expect((await clampTsTrailingBytes(file)).size).toBe(realAmpersand.length - 7956);
        },
    );

    it.each([0, 1000])("clamps large zero preallocation after %i unknown suffix bytes without GPS", async (suffix) => {
        const clean = Buffer.from(realEmptyCapacity.subarray(0, -36));
        clean.fill(0, clean.length - 100);
        const file = new File(
            [Uint8Array.from(clean), new Uint8Array(suffix).fill(0xa5), new Uint8Array(40 * 1024 * 1024)],
            "preallocated.ts",
        );
        expect(await findTsGpsTrailer(file)).toBeNull();
        expect((await clampTsTrailingBytes(file)).size).toBe(clean.length);
    });

    it("clamps a .ts File to the clean stream", async () => {
        const file = new File([Uint8Array.from(happy)], "20260813211138_0000002F.ts");
        const clamped = await clampTsTrailingBytes(file);
        expect(clamped.size).toBe(HAPPY_CLEAN);
    });

    it("passes a trailer-less .ts File through unchanged", async () => {
        const file = new File([Uint8Array.from(happy.subarray(0, HAPPY_CLEAN))], "clean.ts");
        expect(await clampTsTrailingBytes(file)).toBe(file);
    });

    it("never probes a non-TS name even with trailer bytes present", async () => {
        const file = new File([Uint8Array.from(happy)], "movie.mp4");
        expect(await clampTsTrailingBytes(file)).toBe(file);
    });

    it("passes a nameless Blob through unchanged", async () => {
        const blob = blobOf(happy);
        expect(await clampTsTrailingBytes(blob)).toBe(blob);
    });

    it.each([53, 3 * 188, 100_000])("clips %i unknown trailing bytes after the last TS packet", async (count) => {
        const clean = realEmptyCapacity.subarray(0, -36);
        const suffix = Buffer.alloc(count, 0xa5);
        // A single sync-shaped byte in a suffix is not a packet run.
        if (count > 188) suffix[0] = 0x47;
        const file = new File([Uint8Array.from(clean), Uint8Array.from(suffix)], "unknown.ts");
        expect(await findTsGpsTrailer(file)).toBeNull();
        const clamped = await clampTsTrailingBytes(file);
        expect(clamped.size).toBe(clean.length);
        const input = new Input({ source: new BlobSource(clamped), formats: [MPEG_TS] });
        try {
            expect(await input.computeDuration()).toBeGreaterThan(2);
        } finally {
            input.dispose();
        }
    });

    it("keeps a stream with an internal sync defect and a valid packet tail", async () => {
        const bytes = Buffer.from(realEmptyCapacity.subarray(0, -36));
        bytes[bytes.length - 20 * 188] = 0;
        const file = new File([Uint8Array.from(bytes)], "corrupt.ts");
        expect(await clampTsTrailingBytes(file)).toBe(file);
    });

    it.each([0, 1000])("keeps complete packets with transport errors before %i trailing bytes", async (count) => {
        const clean = Buffer.from(realEmptyCapacity.subarray(0, -36));
        clean[clean.length - 3 * 188 + 1]! |= 0x80;
        const file = new File([Uint8Array.from(clean), new Uint8Array(count).fill(0xa5)], "transport-error.ts");
        const clamped = await clampTsTrailingBytes(file);
        expect(clamped.size).toBe(clean.length);
    });

    it("clips trailing bytes after the minimum complete sync run", async () => {
        const clean = realEmptyCapacity.subarray(0, 4 * 188);
        const file = new File([Uint8Array.from(clean), new Uint8Array(1000).fill(0xa5)], "short.ts");
        expect((await clampTsTrailingBytes(file)).size).toBe(clean.length);
    });

    it("clips a suffix reaching the scan boundary", async () => {
        const clean = realEmptyCapacity.subarray(0, -36);
        const suffixLength = Math.floor((16 * 1024 * 1024) / 188) * 188;
        const file = new File([Uint8Array.from(clean), new Uint8Array(suffixLength).fill(0xa5)], "long-suffix.ts");
        expect((await clampTsTrailingBytes(file)).size).toBe(clean.length);
    });

    it("leaves a suffix beyond the scan bound unchanged", async () => {
        const clean = realEmptyCapacity.subarray(0, -36);
        const file = new File([Uint8Array.from(clean), new Uint8Array(17 * 1024 * 1024).fill(0xa5)], "huge-suffix.ts");
        expect(await clampTsTrailingBytes(file)).toBe(file);
    });

    it("keeps a mislabeled container without a TS packet grid at its head", async () => {
        const bytes = Buffer.alloc(8 * 188, 0xa5);
        bytes[bytes.length - 4 * 188] = 0x47;
        const file = new File([Uint8Array.from(bytes)], "movie.ts");
        expect(await clampTsTrailingBytes(file)).toBe(file);
    });

    it("keeps a non-TS file whose tail contains a complete packet run", async () => {
        const tail = realEmptyCapacity.subarray(-36 - 4 * 188, -36);
        const file = new File(
            [new Uint8Array(4 * 188).fill(0xa5), Uint8Array.from(tail), new Uint8Array(53).fill(0xa5)],
            "movie.ts",
        );
        expect(await clampTsTrailingBytes(file)).toBe(file);
    });

    it("mediabunny chokes on the raw trailer and computes duration on the clamped stream", async () => {
        // The original bug: computeDuration scans the whole container, loses
        // packet sync on the off-grid trailer and throws - every file of the
        // card read as unindexable ("empty folder").
        const file = new File([Uint8Array.from(realAnonymized)], "20260813211138_0000002F.ts");
        const raw = new Input({ source: new BlobSource(file), formats: [MPEG_TS] });
        try {
            await expect(raw.computeDuration()).rejects.toThrow(/sync byte/i);
        } finally {
            raw.dispose();
        }
        const clamped = new Input({ source: new BlobSource(await clampTsTrailingBytes(file)), formats: [MPEG_TS] });
        try {
            expect(await clamped.computeDuration()).toBeGreaterThan(1);
        } finally {
            clamped.dispose();
        }
    });
});

describe("trailer detection behind zero padding", () => {
    const cleanLength = realPaired.length - 1024 - 17360;
    const TS_PACKET = 188;

    /** Counts bytes materialized through Blob.arrayBuffer until restored. */
    function countBlobReads(): { bytes: () => number; restore: () => void } {
        const original = Blob.prototype.arrayBuffer;
        let bytes = 0;
        Blob.prototype.arrayBuffer = function (this: Blob) {
            bytes += this.size;
            return original.call(this);
        };
        return {
            bytes: () => bytes,
            restore: () => {
                Blob.prototype.arrayBuffer = original;
            },
        };
    }

    it("bisects the packet grid instead of scanning the padding", async () => {
        const padding = 40 * 1024 * 1024;
        const file = new File([Uint8Array.from(realPaired.subarray(0, -1024)), new Uint8Array(padding)], "paired.ts");
        const reads = countBlobReads();
        try {
            expect(await findTsGpsTrailer(file)).toEqual({
                cleanLength,
                trailerLength: 17360,
                unindexedRecordsOffset: 8772,
            });
            expect(reads.bytes(), "bytes read while locating the tables").toBeLessThan(256 * 1024);
        } finally {
            reads.restore();
        }
    });

    it("falls back to the padding scan when a sync defect stops the bisection early", async () => {
        // A zeroed block in the middle of the stream: the first bisection
        // probe lands inside it, converges onto its start, verifies no table
        // there and must hand over to the exhaustive scan.
        const bytes = Buffer.from(realPaired);
        const packets = Math.floor(cleanLength / TS_PACKET);
        const from = Math.floor(packets * 0.4) * TS_PACKET;
        const to = Math.floor(packets * 0.6) * TS_PACKET;
        bytes.fill(0, from, to);
        expect(await findTsGpsTrailer(blobOf(bytes))).toEqual({
            cleanLength,
            trailerLength: 17360,
            unindexedRecordsOffset: 8772,
        });
    });

    it("answers a repeated lookup on the same blob without reading it again", async () => {
        const file = blobOf(realPaired);
        const first = await findTsGpsTrailer(file);
        expect(first).not.toBeNull();
        const reads = countBlobReads();
        try {
            expect(await findTsGpsTrailer(file)).toBe(first);
            expect(reads.bytes(), "bytes read on the repeated lookup").toBe(0);
        } finally {
            reads.restore();
        }
    });
});
