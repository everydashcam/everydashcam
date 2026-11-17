import { RX_THINKWARE } from "./_patterns.js";
import type { VendorFile } from "../types.js";
import type { FilenameTechnique } from "./types.js";

// Whether the name records the moment an event triggered the clip rather than
// the clip's first frame. Such a clip starts before its name by the camera's
// pre-event buffer, whose length can depend on a setting the file does not
// record, so the name alone cannot place its start.

// Thinkware event (EVT) and parking (PAK) clips. Thinkware documents 10 s
// before and 10 s after the trigger for buffered parking modes, while Energy
// Saving wakes after an impact and has no buffer. The U3000 PRO sample's PAK
// clips start 9-10 s before their names.
const thinkwareTriggerName: FilenameTechnique<boolean> = {
    id: "thinkware-trigger-name",
    extract(file: VendorFile): boolean | null {
        const mode = file.file.name.match(RX_THINKWARE)?.[1]?.toUpperCase();
        return mode === "PAK" || mode === "EVT" ? true : null;
    },
};

export const FILENAME_NAMES_TRIGGER: readonly FilenameTechnique<boolean>[] = [thinkwareTriggerName];
