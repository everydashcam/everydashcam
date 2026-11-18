// Minimal Matroska (EBML) track-header reader for what mediabunny does not
// expose: the CodecPrivate bytes of an audio track whose codec it cannot name.
// Under the A_MS/ACM codec ID those bytes are a WAVEFORMATEX, and its
// wFormatTag is the only thing telling IMA ADPCM from MS ADPCM, G.711 and the
// other ACM codecs that share the ID.
//
// Element layout: https://www.matroska.org/technical/elements.html

const EBML_ID_SEGMENT = 0x18538067;
const EBML_ID_TRACKS = 0x1654ae6b;
const EBML_ID_TRACK_ENTRY = 0xae;
const EBML_ID_TRACK_TYPE = 0x83;
const EBML_ID_CODEC_ID = 0x86;
const EBML_ID_CODEC_PRIVATE = 0x63a2;
const EBML_ID_CLUSTER = 0x1f43b675;
const MATROSKA_TRACK_TYPE_AUDIO = 2;

// Muxers write Tracks before the first Cluster, a few kilobytes into the file.
// The window bounds the read for a file that places them elsewhere.
const HEADER_WINDOW_BYTES = 1 << 20;

/** Header fields of a Matroska audio track. */
export interface MatroskaAudioTrackHeader {
    codecId: string;
    /** Raw CodecPrivate payload, or null when the track has none. */
    codecPrivate: Uint8Array | null;
}

interface EbmlElement {
    id: number;
    dataStart: number;
    /** End of the payload, clamped to the read window; an unknown size runs to it. */
    dataEnd: number;
}

/**
 * Header of the file's first audio track, read from its leading megabyte, or
 * null when no audio TrackEntry appears there (no audio, a malformed header, or
 * Tracks placed after the window). Read errors propagate.
 */
export async function readMatroskaFirstAudioTrack(file: Blob): Promise<MatroskaAudioTrackHeader | null> {
    const bytes = new Uint8Array(await file.slice(0, HEADER_WINDOW_BYTES).arrayBuffer());
    for (const top of iterElements(bytes, 0, bytes.byteLength)) {
        if (top.id !== EBML_ID_SEGMENT) continue;
        for (const child of iterElements(bytes, top.dataStart, top.dataEnd)) {
            if (child.id === EBML_ID_CLUSTER) return null;
            if (child.id !== EBML_ID_TRACKS) continue;
            for (const entry of iterElements(bytes, child.dataStart, child.dataEnd)) {
                if (entry.id !== EBML_ID_TRACK_ENTRY) continue;
                const header = readAudioTrackEntry(bytes, entry);
                if (header) return header;
            }
            return null;
        }
        return null;
    }
    return null;
}

/** The entry's header when it is an audio track with a codec ID, else null. */
function readAudioTrackEntry(bytes: Uint8Array, entry: EbmlElement): MatroskaAudioTrackHeader | null {
    let trackType: number | null = null;
    let codecId: string | null = null;
    let codecPrivate: Uint8Array | null = null;
    for (const field of iterElements(bytes, entry.dataStart, entry.dataEnd)) {
        const payload = bytes.subarray(field.dataStart, field.dataEnd);
        if (field.id === EBML_ID_TRACK_TYPE) trackType = readUnsigned(payload);
        else if (field.id === EBML_ID_CODEC_ID) codecId = readAscii(payload);
        else if (field.id === EBML_ID_CODEC_PRIVATE) codecPrivate = payload;
    }
    if (trackType !== MATROSKA_TRACK_TYPE_AUDIO || codecId === null) return null;
    return { codecId, codecPrivate };
}

/** Child elements of [start, end). Stops at a malformed header; an unknown
 *  size is accepted only for the element it ends the scan with. */
function* iterElements(bytes: Uint8Array, start: number, end: number): Generator<EbmlElement> {
    let offset = start;
    while (offset < end) {
        const id = readVint(bytes, offset, end, true);
        if (!id) return;
        const size = readVint(bytes, offset + id.length, end, false);
        if (!size) return;
        const dataStart = offset + id.length + size.length;
        const dataEnd = size.value === null ? end : Math.min(end, dataStart + size.value);
        yield { id: id.value!, dataStart, dataEnd };
        if (size.value === null) return;
        offset = dataStart + size.value;
    }
}

/**
 * EBML variable-length integer at `offset`: an element ID keeps its length
 * marker, a size drops it. A size of all ones is "unknown" (value null).
 */
function readVint(
    bytes: Uint8Array,
    offset: number,
    end: number,
    isId: boolean,
): { value: number | null; length: number } | null {
    if (offset >= end) return null;
    const first = bytes[offset]!;
    const length = first === 0 ? 0 : 8 - Math.floor(Math.log2(first));
    if (length === 0 || length > (isId ? 4 : 8) || offset + length > end) return null;
    let value = isId ? first : first & (0xff >> length);
    let isAllOnes = value === 0xff >> length;
    for (let i = 1; i < length; i++) {
        const byte = bytes[offset + i]!;
        value = value * 256 + byte;
        isAllOnes &&= byte === 0xff;
    }
    return { value: !isId && isAllOnes ? null : value, length };
}

function readUnsigned(payload: Uint8Array): number {
    let value = 0;
    for (const byte of payload) value = value * 256 + byte;
    return value;
}

function readAscii(payload: Uint8Array): string {
    let text = "";
    for (const byte of payload) {
        if (byte === 0) break;
        text += String.fromCharCode(byte);
    }
    return text;
}
