import { throwIfCancelled } from "../../abort-signals.js";
import { matchDdpaiVideo, parseDdpaiNmea, RX_DDPAI_GPX_NAME } from "../internal/ddpai-nmea.js";
import { type ParsedRecords, type VendorFile, WrongFormatError } from "../types.js";
import type { Primitive, PrimitiveVideoRef } from "./types.js";

const TAR_BLOCK_BYTES = 512;
const decoder = new TextDecoder();

interface TarMember {
    name: string;
    size: number;
    isFile: boolean;
}

function tarText(bytes: Uint8Array): string {
    return decoder.decode(bytes).split("\0", 1)[0]!.trim();
}

function octal(bytes: Uint8Array): number | null {
    const text = tarText(bytes);
    if (!/^[0-7]+$/.test(text)) return null;
    const value = Number.parseInt(text, 8);
    return Number.isSafeInteger(value) ? value : null;
}

function readHeader(bytes: Uint8Array): TarMember | null {
    if (bytes.length !== TAR_BLOCK_BYTES) return null;
    const storedChecksum = octal(bytes.subarray(148, 156));
    let checksum = 0;
    for (let i = 0; i < bytes.length; i++) checksum += i >= 148 && i < 156 ? 32 : bytes[i]!;
    const size = octal(bytes.subarray(124, 136));
    if (storedChecksum !== checksum || size === null) return null;
    return {
        name: tarText(bytes.subarray(0, 100)),
        size,
        isFile: bytes[156] === 0 || bytes[156] === 48,
    };
}

function videoNamesForArchive(source: VendorFile, videos: readonly PrimitiveVideoRef[]): string[] {
    const sameSource = videos.filter((video) => source.sourceKey !== undefined && video.sourceKey === source.sourceKey);
    const scoped = sameSource.length > 0 ? sameSource : videos;
    const root = /^((?:.*\/)?)(?:103|203)gps\//i.exec(source.relativePath)?.[1]?.toLowerCase();
    const sameRoot =
        root === undefined
            ? []
            : scoped.filter((video) => {
                  const videoRoot = /^((?:.*\/)?)(?:100|200)video\//i.exec(video.relativePath)?.[1]?.toLowerCase();
                  return videoRoot === root;
              });
    // Choose front/rear only within this card before the dispatcher resolves
    // an exact owner. Another card's front must not outrank this card's rear.
    return (sameRoot.length > 0 ? sameRoot : scoped).map((video) => video.name);
}

export const nmeaTarPrimitive: Primitive = {
    id: "nmea-tar",
    displayName: "NMEA TAR archive",
    kind: "log-sidecar",
    async marker(file) {
        if (!/^\d{14}_\d{2,7}(?:_[DT])?\.git$/i.test(file.file.name)) return false;
        const probe = new Uint8Array(await file.file.slice(0, TAR_BLOCK_BYTES + 32).arrayBuffer());
        const header = readHeader(probe.subarray(0, TAR_BLOCK_BYTES));
        return (
            header?.isFile === true &&
            RX_DDPAI_GPX_NAME.test(header.name) &&
            decoder.decode(probe.subarray(TAR_BLOCK_BYTES)).startsWith("$GPSCAMTIME ")
        );
    },
    async parse(file, _index, signal, context): Promise<ParsedRecords> {
        const records: ParsedRecords["records"] = [];
        const knownVideos =
            context?.knownVideos === undefined ? undefined : videoNamesForArchive(file, context.knownVideos);
        let position = 0;
        let members = 0;
        while (position + TAR_BLOCK_BYTES <= file.file.size) {
            throwIfCancelled(signal);
            const bytes = new Uint8Array(await file.file.slice(position, position + TAR_BLOCK_BYTES).arrayBuffer());
            // End-of-archive padding may itself be followed by recycled bytes.
            if (bytes.every((value) => value === 0)) break;
            const header = readHeader(bytes);
            if (!header) throw new WrongFormatError("invalid nmea tar header");
            const start = position + TAR_BLOCK_BYTES;
            const end = start + header.size;
            if (!Number.isSafeInteger(end) || end > file.file.size)
                throw new WrongFormatError("truncated nmea tar member");
            position = start + Math.ceil(header.size / TAR_BLOCK_BYTES) * TAR_BLOCK_BYTES;
            // Only flat, regular GPX entries are meaningful; never resolve archive paths.
            if (!header.isFile || !RX_DDPAI_GPX_NAME.test(header.name)) continue;
            const text = await file.file.slice(start, end).text();
            throwIfCancelled(signal);
            if (!text.startsWith("$GPSCAMTIME ")) continue;
            members++;
            const owner =
                knownVideos === undefined
                    ? header.name.replace(/(?:_[DT])?\.gpx$/i, ".mp4")
                    : matchDdpaiVideo(header.name, knownVideos);
            if (owner === null) continue;
            for (const record of parseDdpaiNmea(text, header.name, owner)) records.push(record);
        }
        if (members === 0) throw new WrongFormatError("no nmea members in tar archive");
        return { records, skipped: [] };
    },
};
