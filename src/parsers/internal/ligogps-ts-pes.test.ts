import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { extractLigoGpsTsPes, findLigoGpsTsPesPid } from "./ligogps-ts-pes.js";
import { pesBodyExtent, TS_SIZE } from "./ts-walk.js";

const FIXTURE = readFileSync(new URL("../__fixtures__/ligogps-ts-pes/real-anonymized.TS", import.meta.url));
const NAME = "2026_10_18_130426_00.TS";
const FIRST_UNIX = Date.UTC(2026, 9, 18, 13, 4, 30) / 1000;

function shortenPes(bytes: Buffer, recordIndex: number, bodyLength: number): void {
    let bodyOff = -1;
    for (let i = 0; i <= recordIndex; i++) bodyOff = bytes.indexOf("LIGOGPSINFO", bodyOff + 1);
    expect(bodyOff, "fixture contains the GPS record").toBeGreaterThan(0);
    const packetOff = Math.floor(bodyOff / TS_SIZE) * TS_SIZE;
    expect(pesBodyExtent(bytes, packetOff)?.bodyOff, "fixture PES body offset").toBe(bodyOff);
    let payloadOff = packetOff + 4;
    if ((bytes[packetOff + 3]! & 0x30) === 0x30) payloadOff += 1 + bytes[payloadOff]!;
    const countedHeaderBytes = bodyOff - payloadOff - 6;
    bytes.writeUInt16BE(countedHeaderBytes + bodyLength, payloadOff + 4);
}

describe("LigoGPS PES boundaries", () => {
    it("does not claim a header that extends beyond the declared PES body", () => {
        const bytes = Buffer.from(FIXTURE);
        // The dialect header needs 24 bytes; the remaining TS payload is
        // outside the declared PES and cannot establish the dialect.
        shortenPes(bytes, 0, 23);
        expect(findLigoGpsTsPesPid(bytes)).toBeNull();
    });

    it("skips a truncated cipher instead of decoding bytes beyond its PES", async () => {
        const bytes = Buffer.from(FIXTURE);
        // Keep the dialect and cipher length headers, but place the cipher
        // bytes beyond the end advertised by PES_packet_length.
        shortenPes(bytes, 2, 28);
        const file = new File([bytes], NAME);
        const result = await extractLigoGpsTsPes({ file, relativePath: NAME }, bytes);
        expect(result.records.map((record) => record.unixSeconds - FIRST_UNIX)).toEqual([0, 1, 3, 4, 5]);
        expect(result.skipped).toEqual([{ line: 3, raw: "", reason: "ligogps pes chunk did not decrypt" }]);
    });
});
