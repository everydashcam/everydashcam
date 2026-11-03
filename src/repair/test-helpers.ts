// Test-only builders for repaired recordings. Kept beside the repair code so
// export and transcode tests exercise the same file that ingest hands them.

import { findBox, iterBoxes, readHandlerType } from "../parsers/internal/mp4-walker.js";
import { repairPhantomTracks } from "./phantom-track.js";

/**
 * Returns `file` as ingest delivers an unfinished recording whose audio chunks
 * were never written: the audio track's chunk offsets are zeroed, as observed
 * after a failed finalization, then phantom-track repair empties that track.
 * Its sample entry and decoder configuration stay intact. Throws when the file
 * has no `stco` audio table or the repair does not recognize the defect.
 */
export async function withRepairedPhantomAudio(file: File): Promise<File> {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const view = new DataView(bytes.buffer);
    const moov = findBox(view, 0, view.byteLength, "moov");
    if (!moov) throw new Error("fixture has no moov");
    let isAudioBroken = false;
    for (const trak of iterBoxes(view, moov.payloadStart, moov.end)) {
        if (trak.type !== "trak" || readHandlerType(view, trak) !== "soun") continue;
        const mdia = findBox(view, trak.payloadStart, trak.end, "mdia");
        const minf = mdia && findBox(view, mdia.payloadStart, mdia.end, "minf");
        const stbl = minf && findBox(view, minf.payloadStart, minf.end, "stbl");
        const stco = stbl && findBox(view, stbl.payloadStart, stbl.end, "stco");
        if (!stco) throw new Error("fixture audio has no stco table");
        const chunkCount = view.getUint32(stco.payloadStart + 4);
        for (let i = 0; i < chunkCount; i++) view.setUint32(stco.payloadStart + 8 + i * 4, 0);
        isAudioBroken = true;
    }
    if (!isAudioBroken) throw new Error("fixture has no audio track");
    const repaired = await repairPhantomTracks(new File([bytes], file.name));
    if (repaired?.neutralized.join() !== "soun") throw new Error("phantom audio repair did not apply");
    return repaired.file;
}
