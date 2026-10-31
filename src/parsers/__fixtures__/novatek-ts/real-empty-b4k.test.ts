import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { classifyFiles, dispatchParseVideoEmbeddedGps } from "../../registry.js";
import { buildMp4Index } from "../../internal/mp4-index.js";
import { findNovatekTsGpsPid } from "../../internal/novatek-ts-extract.js";
import { collectPesBody, pesBodyOffset, TS_SIZE } from "../../internal/ts-walk.js";

describe("real B4K empty GPS carrier", () => {
    it("preserves the private PES packet split without manufacturing a zero-coordinate fix", async () => {
        const bytes = readFileSync(new URL("./real-empty-b4k.TS", import.meta.url));
        let groups = 0;
        for (let offset = 0; offset + TS_SIZE <= bytes.length; offset += TS_SIZE) {
            if ((bytes[offset + 1]! & 0x40) === 0) continue;
            const pid = ((bytes[offset + 1]! & 0x1f) << 8) | bytes[offset + 2]!;
            if (pid !== 0x300) continue;
            const bodyOffset = pesBodyOffset(bytes, offset)!;
            const collected = collectPesBody(bytes, offset, bodyOffset, pid, 220);
            expect(typeof collected).toBe("object");
            if (typeof collected !== "object") throw new Error("missing fixture pes");
            expect(collected.body.subarray(164, 208).every((byte) => byte === 0)).toBe(true);
            groups++;
        }
        expect(groups).toBe(2);
        expect(findNovatekTsGpsPid(bytes)).toBeNull();
        for (const name of ["4K_1006095311_v009_jeely.TS", "renamed.ts"]) {
            const file = new File([bytes], name);
            const index = await buildMp4Index(file);
            expect(findNovatekTsGpsPid(index.headerBytes!)).toBeNull();
            const result = await dispatchParseVideoEmbeddedGps(await classifyFiles([{ file, relativePath: name }]));
            expect(result.records).toEqual([]);
            expect(result.errors).toEqual([]);
        }
    });
});
