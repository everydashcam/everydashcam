import { RX_THINKWARE } from "./_patterns.js";
import type { VendorFile } from "../types.js";
import type { FilenameTechnique } from "./types.js";

// Whether a filename family's container creation time (mvhd) is not a clock
// for the clip. Such a file starts by its name and GPS alone: a wrong stamp
// would outrank the name on every clip without a GPS fix.

// Thinkware names every clip from the clock its OSD and GPS agree with. On the
// U3000 Pro sample the Ambarella-muxed REC and PAK files stamp mvhd 27 s after
// that time, the same on all 16 files. A cold start or a garage drive therefore
// placed REC 27 s late and tore it from the interior camera. The F200 PRO stamps
// the name time in local fields, and the U3000 Pro interior (EXT) stamps it in
// UTC, so the name carries all the container clock adds for the whole family.
const thinkwareContainerClock: FilenameTechnique<boolean> = {
    id: "thinkware-container-clock",
    extract(file: VendorFile): boolean | null {
        return RX_THINKWARE.test(file.file.name) ? true : null;
    },
};

export const FILENAME_IGNORED_CONTAINER_CLOCK: readonly FilenameTechnique<boolean>[] = [thinkwareContainerClock];
