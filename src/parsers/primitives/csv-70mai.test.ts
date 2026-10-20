import { describe, expect, it } from "vitest";

import { WrongFormatError, type VendorFile } from "../types.js";
import { _internal, csv70maiPrimitive } from "./csv-70mai.js";

function makeVf(name: string, content: string): VendorFile {
    return {
        file: new File([content], name, { type: "text/plain" }),
        relativePath: name,
    };
}

describe("csv70maiPrimitive.marker", () => {
    it("positive on GPSData*.txt with $V signature in first line", async () => {
        const vf = makeVf("GPSData0.txt", "$V02\n");
        expect(await csv70maiPrimitive.marker(vf)).toBe(true);
    });

    it("positive when $V is not on the first line (after BOM/CRLF/empty line)", async () => {
        const vf = makeVf("GPSData.txt", "\r\n\n$V02,...\n");
        expect(await csv70maiPrimitive.marker(vf)).toBe(true);
    });

    it("accepts a renamed text log when the content signature survives", async () => {
        const vf = makeVf("random.txt", "$V02\n");
        expect(await csv70maiPrimitive.marker(vf)).toBe(true);
    });

    it("does not probe a non-text file even when its bytes start with $V", async () => {
        const vf = makeVf("random.bin", "$V02\n");
        expect(await csv70maiPrimitive.marker(vf)).toBe(false);
    });

    it("rejects a text file whose signature is missing", async () => {
        const vf = makeVf("GPSData0.txt", "header,fields,here\n");
        expect(await csv70maiPrimitive.marker(vf)).toBe(false);
    });
});

describe("csv70maiPrimitive.parse", () => {
    // Full V02 row: 13 fields: ts,A,lat,lon,bearing*100,speed*100,ax*100,ay*100,az*100,mp4,?,?,?.
    // ts = 1700000000 (camera claims 2023-11-14 22:13:20 UTC, but the
    // firmware clock bias shifts the record by 8h - real UTC is
    // 1700000000 + 28800).
    const exampleRow = "1700000000,A,55.123,37.456,12000,1500,10,105,-3,NO20231114-221320F.mp4,,,";

    it("applies the correct 8-hour firmware bias", async () => {
        const text = `$V02\n${exampleRow}\n`;
        const vf = makeVf("GPSData.txt", text);
        const result = await csv70maiPrimitive.parse(vf);
        expect(result.records).toHaveLength(1);
        const rec = result.records[0]!;
        expect(rec.unixSeconds).toBe(1700000000 + _internal.GPS_TIMESTAMP_FIRMWARE_OFFSET_SEC);
    });

    it("single-row log: DC removal is skipped (cannot separate bias from motion), accel stays raw/100", async () => {
        // With one sample there is no way to tell the static gravity/tilt bias
        // from motion, so the per-axis mean subtraction is skipped and the raw
        // /100 values (gravity included) are returned - see parseSingleLog.
        const text = `$V02\n${exampleRow}\n`;
        const result = await csv70maiPrimitive.parse(makeVf("GPSData.txt", text));
        const rec = result.records[0]!;
        expect(rec.accelXg).toBeCloseTo(0.1, 5); // 10/100
        expect(rec.accelYg).toBeCloseTo(1.05, 5); // 105/100, no gravity axis removed
        expect(rec.accelZg).toBeCloseTo(-0.03, 5);
    });

    it("gravity removal is model-agnostic: subtracts the per-axis mean, whichever axis carries 1g", async () => {
        // A810 puts ~1g on field 6 (ax); x800 on field 7 (ay). A hard-coded axis
        // would be wrong on the other model. These A810-shaped rows sit at rest
        // with ~1g on field 6 - after DC removal every axis must land near 0,
        // proving gravity left field 6 without a hard-coded assumption.
        const restRows = [
            "1700000000,A,50.0,9.0,0,0,100,-5,-12,NO20231114-221320F.mp4,,,",
            "1700000001,A,50.0,9.0,0,0,101,-4,-13,NO20231114-221320F.mp4,,,",
            "1700000002,A,50.0,9.0,0,0,99,-5,-11,NO20231114-221320F.mp4,,,",
        ];
        const result = await csv70maiPrimitive.parse(makeVf("GPSData.txt", `$V02\n${restRows.join("\n")}\n`));
        expect(result.records).toHaveLength(3);
        for (const r of result.records) {
            expect(Math.abs(r.accelXg)).toBeLessThan(0.05); // field-6 gravity removed
            expect(Math.abs(r.accelYg)).toBeLessThan(0.05);
            expect(Math.abs(r.accelZg)).toBeLessThan(0.05);
        }
    });

    it("motion is preserved through DC removal: a lateral kick survives as a deviation from the mean", async () => {
        // DC removal must strip only the constant bias, not real maneuvers. One
        // row has a strong field-7 kick against an otherwise-at-rest window; the
        // kick must remain well above zero after the mean is subtracted.
        const rows = [
            "1700000000,A,50.0,9.0,0,0,100,0,-12,NO20231114-221320F.mp4,,,",
            "1700000001,A,50.0,9.0,0,0,100,0,-12,NO20231114-221320F.mp4,,,",
            "1700000002,A,50.0,9.0,0,0,100,60,-12,NO20231114-221320F.mp4,,,", // lateral kick on field 7
            "1700000003,A,50.0,9.0,0,0,100,0,-12,NO20231114-221320F.mp4,,,",
        ];
        const result = await csv70maiPrimitive.parse(makeVf("GPSData.txt", `$V02\n${rows.join("\n")}\n`));
        const kick = result.records[2]!;
        expect(kick.accelYg).toBeGreaterThan(0.4); // 0.60 raw minus the 0.15 mean
    });

    it("V (void) row is dropped, not in records nor in skipped", async () => {
        const voidRow = "1700000000,V,0,0,0,0,0,0,0,NO20231114-221320F.mp4,,,";
        const text = `$V02\n${voidRow}\n${exampleRow}\n`;
        const result = await csv70maiPrimitive.parse(makeVf("GPSData.txt", text));
        expect(result.records).toHaveLength(1);
        expect(result.skipped).toHaveLength(0);
    });

    it("RTC-not-synced row (status A, valid coords, near-epoch timestamp) is kept but flagged timeUnsynced", async () => {
        // Cold-start pattern from a real 70mai capture (coords rounded to whole
        // degrees per the sample policy): after a $V02 reboot the chip has a
        // position fix but the clock is still ~epoch 0. Raw -28801 -> -1 after
        // the +8h offset. The fix is valid, only the time is a placeholder -
        // keep the record (so the track renders) but flag the time so the time
        // layer re-anchors it instead of throwing the file onto 1970.
        const coldStartRow = "-28801,A,43.000000,77.000000,20800,27,-1,100,6,NO20260101-120000-000001F.MP4,0,0,0";
        const result = await csv70maiPrimitive.parse(makeVf("GPSData.txt", `$V02\n${coldStartRow}\n${exampleRow}\n`));
        expect(result.records).toHaveLength(2);
        const cold = result.records.find((r) => r.mp4Filename === "NO20260101-120000-000001F.MP4")!;
        expect(cold.timeUnsynced).toBe(true);
        expect(cold.lat).toBeCloseTo(43.0, 6); // position preserved
        expect(cold.unixSeconds).toBe(-1); // placeholder, rewritten downstream
        const synced = result.records.find((r) => r.mp4Filename === "NO20231114-221320F.mp4")!;
        expect(synced.timeUnsynced).toBeUndefined(); // real GPS time untouched
        expect(result.skipped).toHaveLength(0);
    });

    it("repeated $V?? is treated as a session separator, not in skipped", async () => {
        const text = `$V02\n${exampleRow}\n$V02\n${exampleRow}\n`;
        const result = await csv70maiPrimitive.parse(makeVf("GPSData.txt", text));
        expect(result.records).toHaveLength(2);
        expect(result.skipped).toHaveLength(0);
    });

    it("malformed row (wrong field count) goes to skipped, does not abort parsing", async () => {
        const badRow = "1700000000,A,55.0,37.0,broken";
        const text = `$V02\n${badRow}\n${exampleRow}\n`;
        const result = await csv70maiPrimitive.parse(makeVf("GPSData.txt", text));
        expect(result.records).toHaveLength(1);
        expect(result.skipped).toHaveLength(1);
        expect(result.skipped[0]!.reason).toContain("expected 13 fields");
    });

    it("skips out-of-range coordinates, bearing and speed", async () => {
        const badLat = "1700000000,A,91,37,0,0,0,0,0,clip.mp4,,,";
        const badLon = "1700000001,A,55,181,0,0,0,0,0,clip.mp4,,,";
        const badBearing = "1700000002,A,55,37,36001,0,0,0,0,clip.mp4,,,";
        const badSpeed = "1700000003,A,55,37,0,-1,0,0,0,clip.mp4,,,";
        const result = await csv70maiPrimitive.parse(
            makeVf("GPSData.txt", `$V02\n${badLat}\n${badLon}\n${badBearing}\n${badSpeed}\n${exampleRow}\n`),
        );

        expect(result.records).toHaveLength(1);
        expect(result.skipped.map((entry) => entry.reason)).toEqual([
            "bad coordinates",
            "bad coordinates",
            "bad bearing",
            "bad speed",
        ]);
    });

    it("normalizes a 360-degree bearing to zero", async () => {
        const row = "1700000000,A,55,37,36000,0,0,0,0,clip.mp4,,,";
        const result = await csv70maiPrimitive.parse(makeVf("renamed.txt", `$V02\n${row}\n`));
        expect(result.records[0]!.bearingDeg).toBe(0);
    });

    it("no $V?? signature - WrongFormatError", async () => {
        const text = "header,with,no,signature\n";
        await expect(csv70maiPrimitive.parse(makeVf("GPSData.txt", text))).rejects.toBeInstanceOf(WrongFormatError);
    });

    it.each(["0", ""])(
        "keeps an entirely unnamed session with %j filenames for scoped time association",
        async (name) => {
            const noMp4 = `1700000000,A,55.0,37.0,12000,1500,0,100,0,${name},0,0,0`;
            const file = makeVf("GPSData.txt", `$V02\n${noMp4}\n`);
            file.relativePath = "card/GPSData.txt";
            file.sourceKey = "card-source";
            const result = await csv70maiPrimitive.parse(file);
            expect(result.skipped).toEqual([]);
            expect(result.records).toHaveLength(1);
            expect(result.records[0]).toMatchObject({
                mp4Filename: "GPSData.txt",
                unixSeconds: 1700000000 + _internal.GPS_TIMESTAMP_FIRMWARE_OFFSET_SEC,
                speedMs: 15,
                bearingDeg: 120,
                trackSegment: 0,
                timeAssociation: {
                    sourcePath: "card/GPSData.txt",
                    sourceKey: "card-source",
                    extractorId: "csv-70mai",
                },
            });
            expect(result.records[0]!.timeUnsynced).toBeUndefined();
            expect(result.records[0]!.videoKey).toBeUndefined();
        },
    );

    it("falls back to the source basename when no relative path is available", async () => {
        const row = "1700000000,A,55.0,37.0,0,0,0,100,0,0,0,0,0";
        const file = makeVf("GPSData.txt", `$V02\n${row}\n`);
        file.relativePath = "";
        const result = await csv70maiPrimitive.parse(file);
        expect(result.records[0]!.timeAssociation).toEqual({
            sourcePath: "GPSData.txt",
            extractorId: "csv-70mai",
        });
        expect(_internal.parseSingleLog(`$V02\n${row}\n`, "GPSData.txt").records[0]!.timeAssociation).toEqual(
            result.records[0]!.timeAssociation,
        );
    });

    it("keeps separate segments for two unnamed sessions and removes gravity from their records", async () => {
        const first = "1700000000,A,55.0,37.0,0,0,100,0,0,0,0,0,0";
        const second = "1700000100,A,55.0,37.0,0,0,100,0,0,0,0,0,0";
        const result = await csv70maiPrimitive.parse(makeVf("GPSData.txt", `$V02\n${first}\n$V02\n${second}\n`));
        expect(result.skipped).toEqual([]);
        expect(result.records.map((record) => record.trackSegment)).toEqual([0, 1]);
        for (const record of result.records) {
            expect(record.mp4Filename).toBe("GPSData.txt");
            expect(record.timeAssociation?.extractorId).toBe("csv-70mai");
            expect(record.accelXg).toBeCloseTo(0, 6);
        }
    });

    it.each([1700000001, -28801])(
        "still skips early orphans in a session with a valid named fix at raw timestamp %s",
        async (namedTimestamp) => {
            const orphan = "1700000000,A,55.0,37.0,0,0,0,100,0,0,0,0,0";
            const named = `${namedTimestamp},A,55.0,37.0,0,0,0,100,0,clip.mp4,0,0,0`;
            const result = await csv70maiPrimitive.parse(makeVf("GPSData.txt", `$V02\n${orphan}\n${named}\n`));
            expect(result.records).toHaveLength(1);
            expect(result.records[0]!.mp4Filename).toBe("clip.mp4");
            expect(result.records[0]!.timeAssociation).toBeUndefined();
            expect(result.skipped).toEqual([{ line: 2, raw: orphan, reason: "missing or sentinel mp4 filename" }]);
        },
    );

    it("drops clockless orphans but retains synced rows when named rows are void or malformed", async () => {
        const cold = "-28801,A,55.0,37.0,0,0,0,100,0,0,0,0,0";
        const malformedNamed = "1700000000,A,91,37.0,0,0,0,100,0,clip.mp4,0,0,0";
        const voidNamed = "1700000001,V,55.0,37.0,0,0,0,100,0,clip.mp4,0,0,0";
        const synced = "1700000002,A,55.0,37.0,0,0,0,100,0,0,0,0,0";
        const text = `$V02\n${cold}\n${malformedNamed}\n${voidNamed}\n${synced}\n`;
        const result = await csv70maiPrimitive.parse(makeVf("GPSData.txt", text));
        expect(result.records).toHaveLength(1);
        expect(result.records[0]!.timeAssociation).toBeDefined();
        expect(result.records[0]!.unixSeconds).toBe(1700000002 + _internal.GPS_TIMESTAMP_FIRMWARE_OFFSET_SEC);
        expect(result.skipped).toEqual([
            { line: 2, raw: cold, reason: "missing or sentinel mp4 filename" },
            { line: 3, raw: malformedNamed, reason: "bad coordinates" },
        ]);
    });

    it("keeps a cold-start-only unnamed session out of pending time association", async () => {
        const cold = "-28801,A,55.0,37.0,0,0,0,100,0,0,0,0,0";
        const result = await csv70maiPrimitive.parse(makeVf("GPSData.txt", `$V02\n${cold}\n`));
        expect(result.records).toEqual([]);
        expect(result.skipped).toHaveLength(1);
    });

    it("orphan burst (empty/'0' mp4 name) inherits the session's last valid filename, fields intact", async () => {
        // Real 70mai quirk: at file rollover the firmware writes a burst of rows
        // with "0"/"" in the front-MP4 field but valid position+time. Rows of one
        // file are written contiguously, so such a row belongs to the last named
        // file. We carry that name forward instead of dropping the position.
        const named = "1700000000,A,55.0,37.0,12000,1500,10,105,-3,NO20231114-221320F.mp4,,,";
        const orphanZero = "1700000001,A,55.1,37.1,13000,1600,10,105,-3,0,,,";
        const orphanEmpty = "1700000002,A,55.2,37.2,14000,1700,10,105,-3,,,,";
        const orphanThird = "1700000003,A,55.3,37.3,15000,1800,10,105,-3,0,,,";
        const text = `$V02\n${named}\n${orphanZero}\n${orphanEmpty}\n${orphanThird}\n`;
        const result = await csv70maiPrimitive.parse(makeVf("GPSData.txt", text));
        expect(result.records).toHaveLength(4);
        expect(result.skipped).toHaveLength(0);
        // The whole burst binds to the same (last named) file.
        expect(result.records.every((r) => r.mp4Filename === "NO20231114-221320F.mp4")).toBe(true);
        // A recovered row keeps its full payload, not just the binding.
        const recovered = result.records[1]!;
        expect(recovered.lat).toBeCloseTo(55.1, 6);
        expect(recovered.lon).toBeCloseTo(37.1, 6);
        expect(recovered.speedMs).toBeCloseTo(16.0, 5); // 1600 / 100
        expect(recovered.unixSeconds).toBe(1700000001 + _internal.GPS_TIMESTAMP_FIRMWARE_OFFSET_SEC);
    });

    it("orphan between file A and file B binds to A (last preceding), not B", async () => {
        // Carry-forward must use the file recording at the orphan's moment = the
        // PREVIOUS named file, never the one that starts after it.
        const fileA = "1700000000,A,55.0,37.0,0,1500,10,105,-3,NO20231114-221320F.mp4,,,";
        const orphan = "1700000001,A,55.1,37.1,0,1600,10,105,-3,0,,,";
        const fileB = "1700000002,A,55.2,37.2,0,1700,10,105,-3,NO20231114-221520F.mp4,,,";
        const text = `$V02\n${fileA}\n${orphan}\n${fileB}\n`;
        const result = await csv70maiPrimitive.parse(makeVf("GPSData.txt", text));
        expect(result.records).toHaveLength(3);
        expect(result.skipped).toHaveLength(0);
        expect(result.records[0]!.mp4Filename).toBe("NO20231114-221320F.mp4");
        expect(result.records[1]!.mp4Filename).toBe("NO20231114-221320F.mp4"); // orphan -> A, not B
        expect(result.records[2]!.mp4Filename).toBe("NO20231114-221520F.mp4");
    });

    it("a void (V) row does not become the carry-forward anchor", async () => {
        // V rows carry no usable file context - an orphan after one must still
        // inherit the last NAMED file, not be stranded by the void in between.
        const named = "1700000000,A,55.0,37.0,0,1500,10,105,-3,NO20231114-221320F.mp4,,,";
        const voidRow = "1700000001,V,0,0,0,0,0,0,0,0,,,";
        const orphan = "1700000002,A,55.1,37.1,0,1600,10,105,-3,0,,,";
        const text = `$V02\n${named}\n${voidRow}\n${orphan}\n`;
        const result = await csv70maiPrimitive.parse(makeVf("GPSData.txt", text));
        expect(result.records).toHaveLength(2); // named + recovered orphan; void dropped
        expect(result.skipped).toHaveLength(0);
        expect(result.records[1]!.mp4Filename).toBe("NO20231114-221320F.mp4");
    });

    it("orphan beyond MAX_ORPHAN_GAP_SEC from the anchor (synced clock) is NOT carried forward", async () => {
        // A large synced-clock gap means recording stopped between the anchor and
        // the orphan (dropped rollover marker) - binding would extend a finished
        // file's track, so the orphan is skipped instead.
        const named = "1700000000,A,55.0,37.0,0,1500,10,105,-3,NO20231114-221320F.mp4,,,";
        const farOrphan = "1700000400,A,55.1,37.1,0,1600,10,105,-3,0,,,"; // +400s > 300s guard
        const text = `$V02\n${named}\n${farOrphan}\n`;
        const result = await csv70maiPrimitive.parse(makeVf("GPSData.txt", text));
        expect(result.records).toHaveLength(1); // only the named row
        expect(result.skipped).toHaveLength(1);
        expect(result.skipped[0]!.reason).toMatch(/mp4 filename/);
    });

    it("orphan does NOT inherit a filename across a $V02 session separator", async () => {
        // A new session starts with its own (yet unknown) file - carrying the
        // previous session's name forward would mis-bind the row.
        const named = "1700000000,A,55.0,37.0,0,1500,10,105,-3,NO20231114-221320F.mp4,,,";
        const orphanZero = "1700000100,A,55.1,37.1,0,1600,10,105,-3,0,,,";
        const text = `$V02\n${named}\n$V02\n${orphanZero}\n`;
        const result = await csv70maiPrimitive.parse(makeVf("GPSData.txt", text));
        expect(result.records).toHaveLength(2);
        expect(result.skipped).toEqual([]);
        expect(result.records[0]!.mp4Filename).toBe("NO20231114-221320F.mp4");
        expect(result.records[0]!.timeAssociation).toBeUndefined();
        expect(result.records[1]!.mp4Filename).toBe("GPSData.txt");
        expect(result.records[1]!.trackSegment).toBe(1);
        expect(result.records[1]!.timeAssociation).toBeDefined();
    });

    it("a log with a recovered orphan and a malformed row fills both records and skipped", async () => {
        // The recovery branch and the error branch must coexist: recovery does
        // not swallow real errors, and an error does not poison the anchor.
        const named = "1700000000,A,55.0,37.0,0,1500,10,105,-3,NO20231114-221320F.mp4,,,";
        const orphan = "1700000001,A,55.1,37.1,0,1600,10,105,-3,0,,,";
        const malformed = "1700000002,A,55.0,37.0,broken"; // wrong field count
        const text = `$V02\n${named}\n${orphan}\n${malformed}\n`;
        const result = await csv70maiPrimitive.parse(makeVf("GPSData.txt", text));
        expect(result.records).toHaveLength(2); // named + recovered orphan
        expect(result.skipped).toHaveLength(1);
        expect(result.skipped[0]!.reason).toContain("expected 13 fields");
    });
});
