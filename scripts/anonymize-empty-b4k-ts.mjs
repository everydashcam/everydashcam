#!/usr/bin/env node
// Retain two real private-PES packet groups from a GPS-empty B4K recording.
// Only transport/PES headers and the verified zero GPS fields survive; opaque
// prefix/suffix data is cleared. Video/audio are a fresh two-second test signal.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [, , source, destination] = process.argv;
if (!source || !destination) throw new Error("usage: anonymize-empty-b4k-ts.mjs input.ts output.ts");
const input = readFileSync(source);
const groups = [];
for (let offset = 0; offset + 188 <= input.length; offset += 188) {
    const packet = input.subarray(offset, offset + 188);
    if (packet[0] !== 0x47) throw new Error("invalid transport packet");
    if ((((packet[1] & 31) << 8) | packet[2]) !== 0x300) continue;
    if (packet[1] & 64) groups.push([]);
    if (groups.length) groups.at(-1).push(packet);
}
if (groups.length < 2) throw new Error("missing private pes groups");
const safeGroups = [];
for (const packets of groups) {
    const segments = packets.map((packet) => {
        const control = (packet[3] >> 4) & 3;
        if (control !== 1 && control !== 3) throw new Error("unexpected transport layout");
        const start = 4 + (control === 3 ? 1 + packet[4] : 0);
        if (start > 188) throw new Error("invalid adaptation length");
        return { packet, start };
    });
    const pes = Buffer.concat(segments.map(({ packet, start }) => packet.subarray(start)));
    if (!pes.subarray(0, 6).equals(Buffer.from([0, 0, 1, 0xbf, 0, 220])) || pes.length !== 226) {
        throw new Error("unexpected private pes shape");
    }
    if (pes.subarray(6 + 164, 6 + 208).some((byte) => byte !== 0)) {
        throw new Error("gps payload is not empty; use a coordinate-aware anonymizer");
    }
    if (safeGroups.length >= 2) continue;
    const safePes = Buffer.alloc(pes.length);
    pes.copy(safePes, 0, 0, 6);
    // These fields are zero in the source. Keep the original GPS bytes while
    // discarding the unknown surrounding fields, which may retain identifiers.
    pes.copy(safePes, 6 + 164, 6 + 164, 6 + 208);
    let cursor = 0;
    safeGroups.push(
        Buffer.concat(
            segments.map(({ packet, start }) => {
                const safe = Buffer.alloc(188, 0xff);
                packet.copy(safe, 0, 0, 4);
                if (start > 4) {
                    safe[4] = start - 5;
                    if (safe[4] > 0) safe[5] = 0;
                }
                safePes.copy(safe, start, cursor, cursor + 188 - start);
                cursor += 188 - start;
                return safe;
            }),
        ),
    );
}
const temporary = mkdtempSync(join(tmpdir(), "empty-b4k-"));
try {
    const base = join(temporary, "base.ts");
    const run = spawnSync(
        "ffmpeg",
        [
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=320x180:rate=30:duration=2",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=1000:sample_rate=16000:duration=2",
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-crf",
            "35",
            "-c:a",
            "aac",
            "-af",
            "volume=0.1",
            "-f",
            "mpegts",
            base,
        ],
        { encoding: "utf8" },
    );
    if (run.status !== 0) throw new Error(`ffmpeg failed: ${run.stderr}`);
    writeFileSync(destination, Buffer.concat([readFileSync(base), ...safeGroups]));
} finally {
    rmSync(temporary, { recursive: true });
}
console.log(JSON.stringify({ verifiedEmptyGroups: groups.length, retainedGroups: safeGroups.length }));
