#!/usr/bin/env node
import { box, u32be } from "./_mp4-fixture.mjs";
// Retain two real fixes in an existing GPS carrier, with whole-degree
// coordinates and synthetic video. Copy only understood fields: redundant
// coordinates, labels, unknown headers, original footage and audio are removed.
// Usage: node scripts/anonymize-supported-gps-mp4.mjs <carrier> <input> <output> [--preserve-timing]
// Carriers: type3, vantrue-nmea, garmin-uuid, ligo-json, nextbase-subtitle, xor-ascii, fmas-nofix.
// --preserve-timing retains the movie duration/creation clock and all sanitized
// freeGPS or FMAS records. Other carriers keep the compact two-second mode.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const [carrier, inputPath, outputPath, option, ...extra] = process.argv.slice(2);
assert(carrier && inputPath && outputPath, "usage: <carrier> <input> <output>");
assert(extra.length === 0 && (option === undefined || option === "--preserve-timing"), "unknown option");
const preserveTiming = option === "--preserve-timing";
assert(
    !preserveTiming || ["type3", "vantrue-nmea", "fmas-nofix"].includes(carrier),
    "timing mode needs freegps or fmas",
);
const source = readFileSync(inputPath);
const name = basename(inputPath);
const file = new File([source], name);
const vf = { file, relativePath: name };
const storage = new Map();
globalThis.localStorage = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
    removeItem: (key) => storage.delete(key),
};
const server = await createServer({
    configFile: false,
    envDir: false,
    root: process.cwd(),
    server: { middlewareMode: true, ws: false },
    define: { __PORTABLE__: "false" },
});
const work = mkdtempSync(join(tmpdir(), "supported-gps-fixture-"));

function view(bytes) {
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
}

function roundedDdmm(raw, width) {
    assert(/^\d+(?:\.\d+)?$/.test(raw), "invalid nmea coordinate");
    const value = Number(raw);
    const degrees = Math.floor(value / 100);
    const minutes = value - degrees * 100;
    assert(minutes < 60, "invalid coordinate minutes");
    return `${String(Math.round(degrees + minutes / 60)).padStart(width, "0")}00.00000`;
}

function scrubRmc(text) {
    const fields = text
        .trim()
        .replace(/\*[\da-f]{2}$/i, "")
        .split(",");
    assert(/^\$G[A-Z]RMC$/.test(fields[0]) && fields[2] === "A", "expected active rmc");
    for (const i of [1, 7, 8, 9]) assert(/^[\d.]*$/.test(fields[i]), "unexpected rmc field");
    assert(/^[NS]$/.test(fields[4]) && /^[EW]$/.test(fields[6]), "invalid hemisphere");
    fields[3] = roundedDdmm(fields[3], 2);
    fields[5] = roundedDdmm(fields[5], 3);
    // Unknown extensions and magnetic fields are not needed by this decoder.
    const body = [...fields.slice(0, 10), "", "", "A"].join(",").slice(1);
    let checksum = 0;
    for (const c of body) checksum ^= c.charCodeAt(0);
    return `$${body}*${checksum.toString(16).toUpperCase().padStart(2, "0")}\r\n`;
}

try {
    const log = await server.ssrLoadModule("/src/log.ts");
    log.setLogRules("*=error");
    const { buildMp4Index, loadTrackSampleBuffers } = await server.ssrLoadModule("/src/parsers/internal/mp4-index.ts");
    const { iterBoxes, findBox, readMediaTimescale, readSampleDurationsInTicks } = await server.ssrLoadModule(
        "/src/parsers/internal/mp4-walker.ts",
    );
    const { classifyFiles, dispatchParseVideoEmbeddedGps } = await server.ssrLoadModule("/src/parsers/registry.ts");
    const index = await buildMp4Index(file);
    const original = await dispatchParseVideoEmbeddedGps(await classifyFiles([vf]));
    assert(original.errors.length === 0, "source must parse successfully");
    assert(
        carrier === "fmas-nofix" ? original.records.length === 0 : original.records.length >= 2,
        "unexpected source fix count",
    );
    const duration = preserveTiming ? index.durationSec : 2;
    assert(Number.isFinite(duration) && duration > 0 && duration <= 3600, "invalid source duration");
    // Only a color is derived from the basename; no text from the input is
    // rendered. Distinct footage prevents content deduplication of camera pairs.
    const color = createHash("sha256").update(name).digest("hex").slice(0, 6);
    const pattern = preserveTiming
        ? `color=c=0x${color}:size=320x180:rate=2:duration=${duration}`
        : "testsrc2=size=320x180:rate=2:duration=2";

    const videoPath = join(work, "video.mp4");
    execFileSync("ffmpeg", [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        pattern,
        "-an",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-map_metadata",
        "-1",
        videoPath,
    ]);
    const video = readFileSync(videoPath);
    const videoMoov = [...iterBoxes(view(video), 0, video.length)].find((b) => b.type === "moov");
    assert(videoMoov && videoMoov.end === video.length, "generated moov must be last");
    if (preserveTiming) {
        const mvhd = findBox(view(video), videoMoov.payloadStart, videoMoov.end, "mvhd");
        assert(mvhd && video[mvhd.payloadStart] === 0, "expected generated version-zero movie header");
        const clock = index.createdUtc ? index.createdUtc.getTime() / 1000 + 2082844800 : 0;
        assert(Number.isInteger(clock) && clock >= 0 && clock <= 0xffffffff, "creation clock exceeds generated header");
        // Copy this scalar only. The original moov can contain identifying or
        // position-bearing private atoms and must never be transplanted.
        video.writeUInt32BE(clock, mvhd.payloadStart + 4);
    }
    const base = video.subarray(0, videoMoov.start);
    const moovPayload = video.subarray(videoMoov.payloadStart);
    function appendTrack(samples, track, timing = null) {
        const timescale = timing?.timescale ?? 1000;
        const deltas = timing?.deltas ?? samples.map(() => 2000 / samples.length);
        assert(
            deltas.length === samples.length && deltas.every((n) => Number.isInteger(n) && n > 0),
            "invalid sample timing",
        );
        const trackTicks = deltas.reduce((sum, ticks) => sum + ticks, 0);
        const runs = [];
        for (const delta of deltas) {
            const last = runs.at(-1);
            if (last && last.delta === delta) last.count++;
            else runs.push({ count: 1, delta });
        }
        const hdlr = Buffer.alloc(33);
        hdlr.write(track.handlerType, 8, "ascii");
        const mdhd = Buffer.alloc(24);
        mdhd.writeUInt32BE(timescale, 12);
        mdhd.writeUInt32BE(trackTicks, 16);
        const tkhd = Buffer.alloc(84);
        tkhd.writeUInt32BE(7);
        tkhd.writeUInt32BE(2, 12);
        tkhd.writeUInt32BE(Math.round((trackTicks / timescale) * 1000), 20);
        const entry = Buffer.alloc(46);
        entry.writeUInt32BE(entry.length);
        entry.write(track.sampleFormat, 4, "ascii");
        entry.writeUInt16BE(1, 14);
        const stco = box("stco", Buffer.concat([u32be(0), u32be(1), u32be(0)]));
        const stbl = box(
            "stbl",
            Buffer.concat([
                box("stsd", Buffer.concat([u32be(0), u32be(1), entry])),
                box(
                    "stts",
                    Buffer.concat([
                        u32be(0),
                        u32be(runs.length),
                        ...runs.flatMap((r) => [u32be(r.count), u32be(r.delta)]),
                    ]),
                ),
                box("stsc", Buffer.concat([u32be(0), u32be(1), u32be(1), u32be(samples.length), u32be(1)])),
                box("stsz", Buffer.concat([u32be(0), u32be(samples[0].length), u32be(samples.length)])),
                stco,
            ]),
        );
        const trak = box(
            "trak",
            Buffer.concat([
                box("tkhd", tkhd),
                box("mdia", Buffer.concat([box("mdhd", mdhd), box("hdlr", hdlr), box("minf", stbl)])),
            ]),
        );
        const moov = box("moov", Buffer.concat([moovPayload, trak]));
        moov.writeUInt32BE(base.length + moov.length + 8, moov.lastIndexOf(stco) + 16);
        return Buffer.concat([base, moov, box("mdat", Buffer.concat(samples))]);
    }
    let output;

    if (carrier === "type3" || carrier === "vantrue-nmea") {
        const { parseFreeGpsBlock } = await server.ssrLoadModule("/src/parsers/internal/freegps.ts");
        const atoms = [];
        const times = new Set();
        const fixKey = (record) => JSON.stringify([record.unixSeconds, record.lat, record.lon, record.speedMs]);
        const remaining = new Map();
        if (preserveTiming) {
            for (const record of original.records) {
                const key = fixKey(record);
                remaining.set(key, (remaining.get(key) ?? 0) + 1);
            }
        }
        for (
            let at = source.indexOf("freeGPS ");
            at >= 0 && (preserveTiming || atoms.length < 2);
            at = source.indexOf("freeGPS ", at + 8)
        ) {
            assert(at >= 4, "missing free atom header");
            const size = source.readUInt32BE(at - 4);
            assert(size >= 128 && size <= 65536 && at - 4 + size <= source.length, "invalid free atom");
            const raw = source.subarray(at, at - 4 + size);
            const records = parseFreeGpsBlock(view(raw), name, source.readUInt32LE(at - 4));
            if (records.length !== 1 || !records[0].active || (!preserveTiming && times.has(records[0].unixSeconds)))
                continue;
            // An extra raw atom can lie beyond the camera's GPS index. Keep
            // the indexed track, including repeats, without adding a slack fix.
            if (preserveTiming) {
                const key = fixKey(records[0]);
                const count = remaining.get(key) ?? 0;
                if (count === 0) continue;
                remaining.set(key, count - 1);
            }
            const clean = Buffer.alloc(raw.length);
            raw.copy(clean, 0, 0, 12);
            if (carrier === "type3") {
                const layouts = [
                    { dt: 44, status: 68, lat: 72, lon: 76, end: 88 },
                    { dt: 16, status: 40, lat: 44, lon: 48, end: 72 },
                    { dt: 12, status: 36, lat: 40, lon: 44, end: 56 },
                ];
                const layout = layouts.find(
                    (l) =>
                        raw[l.status] === 65 &&
                        [78, 83].includes(raw[l.status + 1]) &&
                        [69, 87].includes(raw[l.status + 2]),
                );
                assert(layout, "unsupported type3 geometry");
                raw.copy(clean, layout.dt, layout.dt, layout.end);
                // These fixtures use DDmm floats, not affine/decimal-degree Type3 variants.
                for (const [offset, decoded] of [
                    [layout.lat, records[0].lat],
                    [layout.lon, records[0].lon],
                ]) {
                    const value = raw.readFloatLE(offset);
                    const degrees = Math.floor(value / 100) + (value % 100) / 60;
                    assert(Math.abs(degrees - Math.abs(decoded)) < 0.00001, "unsupported coordinate transform");
                    clean.writeFloatLE(Math.round(degrees) * 100, offset);
                }
            } else {
                const text = raw.toString("latin1");
                const match = /\$G[A-Z]RMC,[^\0\r\n]+/.exec(text);
                assert(match && match.index < 512, "missing embedded rmc");
                const sentence = scrubRmc(match[0]);
                assert(sentence.length <= raw.length - match.index, "rmc exceeds block");
                // Keep the Type15 geometry and measured accel, never its duplicate coordinates.
                assert(
                    raw[24] === 65 && [78, 83].includes(raw[36]) && [69, 87].includes(raw[52]),
                    "unsupported nmea preamble",
                );
                for (const i of [24, 36, 52]) clean[i] = raw[i];
                raw.copy(clean, 88, 88, 100);
                clean.write(sentence, match.index, "ascii");
            }
            const atom = Buffer.alloc(size);
            atom.writeUInt32BE(size);
            clean.copy(atom, 4);
            atoms.push(atom);
            times.add(records[0].unixSeconds);
        }
        assert(atoms.length >= 2, "not enough active fixes");
        assert(
            [...remaining.values()].every((count) => count === 0),
            "missing indexed source fixes",
        );
        output = Buffer.concat([video, ...atoms]);
    } else if (carrier === "garmin-uuid") {
        const { findGarminUuidBox } = await server.ssrLoadModule("/src/parsers/internal/garmin-uuid.ts");
        const gps = findGarminUuidBox(index);
        assert(gps && index.moovView, "missing garmin uuid");
        const raw = Buffer.from(
            index.moovView.buffer,
            index.moovView.byteOffset + gps.payloadStart,
            gps.end - gps.payloadStart,
        );
        const payload = Buffer.alloc(33 + 40);
        raw.copy(payload, 0, 0, 16);
        let count = 0;
        for (let at = 33; at + 20 <= raw.length && count < 2; at += 20) {
            const lat = (raw.readInt32BE(at + 12) * 180) / 2 ** 31;
            const lon = (raw.readInt32BE(at + 16) * 180) / 2 ** 31;
            if (Math.abs(lat) > 90 || (lat === 0 && lon === 0)) continue;
            const target = 33 + count * 20;
            raw.copy(payload, target, at, at + 6);
            payload.writeInt32BE(Math.round((Math.round(lat) * 2 ** 31) / 180), target + 12);
            payload.writeInt32BE(Math.round((Math.round(lon) * 2 ** 31) / 180), target + 16);
            count++;
        }
        assert(count === 2, "not enough garmin fixes");
        output = Buffer.concat([base, box("moov", Buffer.concat([moovPayload, box("uuid", payload)]))]);
    } else if (carrier === "ligo-json") {
        const { hasGkuMarker, hasLigoJsonMarker, gkuJsonStart } = await server.ssrLoadModule(
            "/src/parsers/internal/ligo-json.ts",
        );
        const udta = index.topLevelUdtaAtoms.find((a) => a.head && (hasGkuMarker(a.head) || hasLigoJsonMarker(a.head)));
        assert(udta, "missing json carrier");
        const raw = source.subarray(udta.offset + udta.headerSize, udta.offset + udta.size);
        const start = hasGkuMarker(raw) ? gkuJsonStart(raw) : 0;
        assert(start >= 0 && start < raw.length, "invalid json offset");
        const records = [
            ...raw
                .subarray(start)
                .toString("latin1")
                .matchAll(/LIGOGPSINFO (\{[^}\r\n]{0,1024}\})/g),
        ]
            .map((m) => JSON.parse(m[1]))
            .filter((r) => r.status === "A")
            .slice(0, 2);
        assert(records.length === 2, "not enough ligo json fixes");
        const payload = Buffer.alloc(start + records.length * 512);
        if (start) {
            payload.writeUInt32LE(start);
            raw.copy(payload, 4, 4, 8);
            payload.write("__V35AX_QVDATA__", 8, "ascii");
        }
        for (const [i, record] of records.entries()) {
            const clean = {};
            for (const key of [
                "Hour",
                "Minute",
                "Second",
                "Year",
                "Month",
                "Day",
                "Speed",
                "GsensorX",
                "GsensorY",
                "GsensorZ",
                "MHour",
                "MMinute",
                "MSecond",
                "MYear",
                "MMonth",
                "MDay",
            ]) {
                if (!(key in record)) continue;
                assert(/^-?\d+(?:\.\d+)?$/.test(String(record[key])), "unexpected json field");
                clean[key] = record[key];
            }
            for (const key of ["status", "NS", "EW"]) {
                assert(/^[ANSEW]$/.test(record[key]), "unexpected json flag");
                clean[key] = record[key];
            }
            for (const key of ["Latitude", "Longitude"]) clean[key] = String(Math.round(Number(record[key])));
            clean.OLatitude = "0";
            clean.OLongitude = "0";
            const text = `LIGOGPSINFO ${JSON.stringify(clean)}`;
            assert(text.length <= 512, "json record exceeds slot");
            payload.write(text, start + i * 512, "ascii");
        }
        output = Buffer.concat([video, box("udta", payload)]);
    } else if (carrier === "nextbase-subtitle") {
        const { findNextbaseSubtitleTrack, detectNextbaseVariant } = await server.ssrLoadModule(
            "/src/parsers/internal/nextbase-subtitle-extract.ts",
        );
        const track = await findNextbaseSubtitleTrack(vf, index);
        assert(track, "missing nextbase subtitle track");
        const rawSamples = await loadTrackSampleBuffers(file, index, track);
        const samples = [];
        for (const buffer of rawSamples ?? []) {
            const raw = Buffer.from(buffer);
            const variant = detectNextbaseVariant(raw);
            if (!variant) continue;
            assert(variant.id === "nextbase-fmt1", "unsupported subtitle geometry");
            const at = 2 + variant.rmcOffset;
            const sentence = raw
                .subarray(at, at + 128)
                .toString("latin1")
                .split("\0")[0];
            if (!/^\$GPRMC,[^,]*,A,/.test(sentence)) continue;
            const clean = Buffer.alloc(290);
            raw.copy(clean, 0, 0, 2);
            // The ASCII clock and three accel integers are understood; GGA and padding are cleared.
            assert(/^\d{14}\0{2}$/.test(raw.subarray(6, 22).toString("latin1")), "unexpected subtitle clock");
            raw.copy(clean, 6, 6, 34);
            clean.write(scrubRmc(sentence), at, "ascii");
            samples.push(clean);
            if (samples.length === 20) break;
        }
        assert(samples.length === 20, "not enough subtitle fixes");
        output = appendTrack(samples, track);
    } else if (carrier === "fmas-nofix") {
        const { hasFmasFirstSamplePrefix, decodeFmasSample } = await server.ssrLoadModule(
            "/src/parsers/internal/vantrue-fmas.ts",
        );
        const track = index.tracks.find((t) => t.sampleFormat === "gpmd");
        assert(track, "missing fmas metadata track");
        const rawSamples = await loadTrackSampleBuffers(file, index, track);
        assert(rawSamples && rawSamples.length >= 2, "not enough fmas samples");
        for (const buffer of rawSamples) {
            const raw = Buffer.from(buffer);
            assert(raw.length === 276 && hasFmasFirstSamplePrefix(raw), "unsupported fmas sample");
            assert(raw.toString("ascii", 72, 84) === "OFNIMMASSAMM", "missing fmas anchor");
            assert(raw[120] !== 65 && decodeFmasSample(view(raw), name) === null, "source contains a fix");
        }
        const samples = (preserveTiming ? rawSamples : rawSamples.slice(0, 2)).map((buffer) => {
            const raw = Buffer.from(buffer);
            const clean = Buffer.alloc(raw.length);
            for (const [start, end] of [
                [0, 8],
                [72, 84],
                [96, 103],
                [120, 123],
            ])
                raw.copy(clean, start, start, end);
            return clean;
        });
        const timing = preserveTiming
            ? {
                  timescale: readMediaTimescale(index.moovView, track.trakBox),
                  deltas: readSampleDurationsInTicks(index.moovView, track.trakBox),
              }
            : null;
        assert(!timing || (timing.timescale > 0 && timing.deltas), "missing source track timing");
        output = appendTrack(samples, track, timing);
    } else if (carrier === "xor-ascii") {
        const generated = join(work, "xor.mp4");
        execFileSync(
            process.execPath,
            [fileURLToPath(new URL("./anonymize-xor-ascii-mp4.mjs", import.meta.url)), inputPath, generated],
            { stdio: "pipe" },
        );
        output = readFileSync(generated);
    } else {
        throw new Error("unsupported carrier");
    }

    const anonymized = { file: new File([output], name), relativePath: name };
    if (preserveTiming) {
        const outputIndex = await buildMp4Index(anonymized.file);
        assert.equal(outputIndex.durationSec, index.durationSec, "movie duration changed");
        assert.equal(outputIndex.createdUtc?.getTime(), index.createdUtc?.getTime(), "creation clock changed");
    }
    const parsed = await dispatchParseVideoEmbeddedGps(await classifyFiles([anonymized]));
    assert(
        (carrier === "fmas-nofix" ? parsed.records.length === 0 : parsed.records.length >= 2) &&
            parsed.errors.length === 0 &&
            parsed.skipped.length === 0,
        "anonymized parse failed",
    );
    assert.deepEqual(parsed.appliedExtractors, original.appliedExtractors, "carrier selection changed");
    if (preserveTiming) {
        assert.deepEqual(
            parsed.records.map((r) => [r.unixSeconds, r.speedMs]),
            original.records.map((r) => [r.unixSeconds, r.speedMs]),
            "indexed source clock/speed sequence changed",
        );
    }
    let previous = -Infinity;
    for (const record of parsed.records) {
        assert(record.active && record.unixSeconds >= previous, "invalid fixture clock/fix");
        previous = record.unixSeconds;
        assert(
            Math.abs(record.lat - Math.round(record.lat)) < 1e-6 &&
                Math.abs(record.lon - Math.round(record.lon)) < 1e-6,
            "coordinates are not whole degrees",
        );
        const candidates = original.records.filter((r) => Math.abs(r.unixSeconds - record.unixSeconds) < 1e-4);
        assert(candidates.length > 0, "source clock changed");
        assert(
            candidates.some((r) => Math.abs(r.speedMs - record.speedMs) < 1e-6),
            "source speed changed",
        );
        assert(
            candidates.every((r) => Math.abs(r.lat - record.lat) > 1e-6 && Math.abs(r.lon - record.lon) > 1e-6),
            "source coordinate survived",
        );
    }
    assert(output.length < 5_000_000, "fixture exceeds size limit");
    writeFileSync(outputPath, output);
    console.log(
        JSON.stringify({
            carrier,
            originalRecords: original.records.length,
            fixtureRecords: parsed.records.length,
            bytes: output.length,
            privacyVerified: true,
        }),
    );
} finally {
    await server.close();
    rmSync(work, { recursive: true, force: true });
}
