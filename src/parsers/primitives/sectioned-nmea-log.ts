// Recording-scoped NMEA log. A timestamped @Sonygps header opens each clip,
// followed by an option line and ordinary GGA/RMC sentences. The header knows
// the clip start but not its filename, so records carry a temporary
// recordingAssociation until MP4 creation metadata becomes available.

import { throwIfCancelled } from "../../abort-signals.js";
import { forwardFillBearingsIfAllZero } from "../../parser.js";
import { utcMillisecondsFromParts } from "../internal/calendar.js";
import { parseNmeaText } from "../internal/nmea.js";
import { type ParsedRecords, type SkippedLine, type VendorFile, WrongFormatError } from "../types.js";
import type { Primitive } from "./types.js";

const FORMAT_ID = "sectioned-nmea-log";
const RX_LOG_NAME = /\.log$/i;
const RX_MARKER = /^@Sonygps\/ver/i;
const RX_RECORDING_HEADER =
    /^@Sonygps\/ver\d+(?:\.\d+)?\/wgs-84\/(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.(\d{1,3})\/$/i;
const MARKER_PROBE_BYTES = 512;

interface RecordingSection {
    startUtc: number;
    startLine: number;
    lines: string[];
}

export const sectionedNmeaLogPrimitive: Primitive = {
    id: FORMAT_ID,
    displayName: "Sectioned NMEA log",
    kind: "log-sidecar",

    async marker(file: VendorFile): Promise<boolean> {
        if (!RX_LOG_NAME.test(file.file.name)) return false;
        const head = await file.file.slice(0, MARKER_PROBE_BYTES).text();
        return head
            .replace(/^\uFEFF/, "")
            .split(/\r?\n/)
            .some((line) => RX_MARKER.test(line.trim()));
    },

    async parse(file: VendorFile, _index, signal): Promise<ParsedRecords> {
        throwIfCancelled(signal);
        const text = await file.file.text();
        throwIfCancelled(signal);
        return parseSectionedNmeaLog(text, file, signal);
    },
};

function parseSectionedNmeaLog(text: string, file: VendorFile, signal?: AbortSignal): ParsedRecords {
    const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
    const records: ParsedRecords["records"] = [];
    const skipped: SkippedLine[] = [];
    let current: RecordingSection | null = null;
    let sawMarker = false;
    let validHeaders = 0;
    let sectionIndex = 0;

    const flush = (): void => {
        if (!current) return;
        throwIfCancelled(signal);

        // The source scope alone identifies one picker/drop, not one log. Keep
        // the path too so two card copies selected under one parent cannot
        // merge equal section indices before association has a chance to reject
        // an ambiguous recording time.
        const sourceIdentity = `${file.sourceKey ?? ""}:${file.relativePath}`;
        const placeholder = `[${FORMAT_ID}:${sourceIdentity}:${current.startUtc}:${sectionIndex}]`;
        const parsed = parseNmeaText(current.lines.join("\n"), placeholder);
        for (const item of parsed.skipped) {
            skipped.push({ ...item, line: current.startLine + item.line });
        }
        for (const record of parsed.records) {
            record.recordingAssociation = {
                startUtc: current.startUtc,
                extractorId: FORMAT_ID,
                ...(file.sourceKey === undefined ? {} : { sourceKey: file.sourceKey }),
            };
        }
        forwardFillBearingsIfAllZero(parsed.records);
        for (const record of parsed.records) records.push(record);
        sectionIndex++;
    };

    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i]!;
        const trimmed = raw.trim();
        if (!RX_MARKER.test(trimmed)) {
            if (current) current.lines.push(raw);
            continue;
        }

        sawMarker = true;
        flush();
        current = null;
        const startUtc = parseRecordingStart(trimmed);
        if (startUtc === null) {
            skipped.push({ line: i + 1, raw, reason: "bad recording header" });
            continue;
        }
        validHeaders++;
        current = { startUtc, startLine: i + 1, lines: [] };
    }
    flush();

    if (!sawMarker || validHeaders === 0) {
        throw new WrongFormatError(`no timestamped @Sonygps recording header found in ${file.file.name}`);
    }
    return { records, skipped };
}

function parseRecordingStart(header: string): number | null {
    const match = RX_RECORDING_HEADER.exec(header);
    if (!match) return null;
    const [, year, month, day, hour, minute, second, fraction] = match;
    const wholeMs = utcMillisecondsFromParts(
        Number(year),
        Number(month),
        Number(day),
        Number(hour),
        Number(minute),
        Number(second),
        true,
    );
    if (wholeMs === null) return null;
    const fractionMs = Number(fraction!.padEnd(3, "0"));
    return (wholeMs + fractionMs) / 1000;
}
