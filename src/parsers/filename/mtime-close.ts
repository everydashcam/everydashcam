import { RX_THINKWARE } from "./_patterns.js";
import type { VendorFile } from "../types.js";
import type { FilenameTechnique } from "./types.js";

// Whether the camera's file modification time marks the moment it closed the
// clip, on the clock its file names use. Read straight from the card, mtime
// minus the clip duration is then the clip's first frame on that clock. A copy
// can replace mtime with the copy time, so a declaration alone is not trusted:
// see estimateTriggerNamedStartOffsets.

// Thinkware U3000 PRO, read from a card opened directly: REC mtime is the name
// time plus the clip duration to the second, and PAK mtime minus the duration
// matches the first GPS fix and the OSD of each clip. EVT mtime falls 11 s
// after its name, as a 10 s pre-event buffer predicts. The interior camera
// (EXT) stamps mtime when it opens a clip, so it is not declared.
const thinkwareMtimeClose: FilenameTechnique<boolean> = {
    id: "thinkware-mtime-close",
    extract(file: VendorFile): boolean | null {
        const mode = file.file.name.match(RX_THINKWARE)?.[1]?.toUpperCase();
        return mode === "REC" || mode === "PAK" || mode === "EVT" ? true : null;
    },
};

export const FILENAME_MTIME_CLOSES_CLIP: readonly FilenameTechnique<boolean>[] = [thinkwareMtimeClose];
