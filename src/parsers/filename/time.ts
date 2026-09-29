// Filename time techniques. Each entry is one variant of extracting a
// camera-local datetime from a filename. Walk picks the first non-null.
//
// Specific patterns first, generic-datetime LAST (it greedily matches any
// embedded YYYYMMDDhhmmss; specific techniques must win).
//
// Return value: a Date built via Date.UTC(...) carrying camera-local fields;
// the orchestrator converts to true UTC via per-fingerprint TZ estimation.

import type { VendorFile } from "../types.js";
import { utcMillisecondsFromParts } from "../internal/calendar.js";
import {
    RX_DATETIME_CHANNEL_TS,
    RX_70MAI,
    RX_BEFERICH,
    RX_BLACKVUE,
    RX_CARCAM,
    RX_DVR_FOUR_CHANNEL,
    RX_DDPAI_EVENT,
    RX_DDPAI_NORMAL,
    RX_DDPAI_TIMELAPSE,
    RX_DDPAI_TIMESTAMP_TOKEN,
    RX_E_ACE,
    RX_ESCORT,
    RX_FITCAMX,
    RX_FORD,
    RX_GENERIC_DATETIME,
    RX_IBOX,
    RX_JUSCAR,
    RX_LIGOGPS_TRAILER_TS,
    RX_MIVUE,
    RX_NAVITEL,
    RX_NEOLINE,
    RX_NEXTBASE,
    RX_NOVATEK_TS,
    RX_NOVATEK_VANTRUE,
    RX_NOVATEK_VIOFO,
    RX_REC_SINGLE,
    RX_SEI_DOUBLE_GPS,
    RX_SEI_DOUBLE_GPS_PATH,
    RX_TESLA_EVENT_FILENAME,
    RX_TESLA_EVENT_FOLDER,
    RX_TESLA_PATH,
    RX_TESLA_PATH_RECENT,
    RX_TESLA_RECENT,
    RX_VUEROID,
    RX_WOLFBOX,
    matchNovatekSingleFilename,
} from "./_patterns.js";
import type { FilenameTimeTechnique } from "./types.js";

function ymdhms(y: number, mo: number, d: number, h: number, mi: number, s: number): Date | null {
    if (y < 2000 || y > 2099) return null;
    const ms = utcMillisecondsFromParts(y, mo, d, h, mi, s);
    return ms === null ? null : new Date(ms);
}

// Most filename formats encode the timestamp as an "YYYYMMDD" run plus an
// "HHMMSS" run (sometimes glued into one 14-char token, sometimes with the
// year split off). Once both runs are isolated the slice math is identical,
// so every such technique funnels through here instead of repeating it.
function ymdHmsFromSplit(ymd: string, hms: string): Date | null {
    return ymdhms(
        Number(ymd.slice(0, 4)),
        Number(ymd.slice(4, 6)),
        Number(ymd.slice(6, 8)),
        Number(hms.slice(0, 2)),
        Number(hms.slice(2, 4)),
        Number(hms.slice(4, 6)),
    );
}

const novatekViofoTime: FilenameTimeTechnique = {
    id: "novatek-viofo-time",
    extract(file: VendorFile): Date | null {
        const m = file.file.name.match(RX_NOVATEK_VIOFO);
        if (!m) return null;
        // Year and MMDD are separate capture groups; glue them into YYYYMMDD.
        return ymdHmsFromSplit(`${m[1]}${m[2]}`, m[3]!);
    },
};

const novatekSingleTime: FilenameTimeTechnique = {
    id: "novatek-single-time",
    extract(file: VendorFile): Date | null {
        const m = matchNovatekSingleFilename(file.file.name);
        if (!m) return null;
        return ymdHmsFromSplit(`${m[1]}${m[2]}`, m[3]!);
    },
};

const novatekTsTime: FilenameTimeTechnique = {
    id: "novatek-ts-time",
    extract(file: VendorFile): Date | null {
        const m = file.file.name.match(RX_NOVATEK_TS);
        if (!m) return null;
        const ts = m[1]!;
        return ymdHmsFromSplit(ts.slice(0, 8), ts.slice(8, 14));
    },
};

const novatekVantrueTime: FilenameTimeTechnique = {
    id: "novatek-vantrue-time",
    extract(file: VendorFile): Date | null {
        const m = file.file.name.match(RX_NOVATEK_VANTRUE);
        if (!m) return null;
        return ymdHmsFromSplit(m[1]!, m[2]!);
    },
};

const mai70Time: FilenameTimeTechnique = {
    id: "70mai-time",
    extract(file: VendorFile): Date | null {
        const m = file.file.name.match(RX_70MAI);
        if (!m) return null;
        // ymdhms (not raw Date.UTC): a corrupt name like month "99" must
        // return null, not silently roll over to a wrong date.
        const [, y, mo, d, h, mi, s] = m;
        return ymdhms(+y!, +mo!, +d!, +h!, +mi!, +s!);
    },
};

const beferichTime: FilenameTimeTechnique = {
    id: "beferich-time",
    extract(file: VendorFile): Date | null {
        const m = file.file.name.match(RX_BEFERICH);
        if (!m) return null;
        // Named technique (not just the generic-datetime fallback) so the file
        // reads as "beferich-time" in diagnostics - the ford-time rationale.
        return ymdhms(+m[1]!, +m[2]!, +m[3]!, +m[4]!, +m[5]!, +m[6]!);
    },
};

const blackvueTime: FilenameTimeTechnique = {
    id: "blackvue-time",
    extract(file: VendorFile): Date | null {
        const m = file.file.name.match(RX_BLACKVUE);
        if (!m) return null;
        // Funnel through the shared split helper - it carries the range
        // validation a raw Date.UTC silently rolls over on.
        return ymdHmsFromSplit(m[1]!, m[2]!);
    },
};

const carcamTime: FilenameTimeTechnique = {
    id: "carcam-time",
    extract(file: VendorFile): Date | null {
        const m = file.file.name.match(RX_CARCAM);
        if (!m) return null;
        return ymdHmsFromSplit(m[1]!, m[2]!);
    },
};

const dvrFourChannelTime: FilenameTimeTechnique = {
    id: "dvr-four-channel-time",
    extract(file: VendorFile): Date | null {
        const m = file.file.name.match(RX_DVR_FOUR_CHANNEL);
        return m ? ymdHmsFromSplit(m[1]!, m[2]!) : null;
    },
};

const recSingleTime: FilenameTimeTechnique = {
    id: "rec-single-time",
    extract(file: VendorFile): Date | null {
        const m = file.file.name.match(RX_REC_SINGLE);
        if (!m) return null;
        return ymdHmsFromSplit(m[1]!, m[2]!);
    },
};

const seiDoubleGpsTime: FilenameTimeTechnique = {
    id: "sei-double-gps-time",
    extract(file: VendorFile): Date | null {
        if (!RX_SEI_DOUBLE_GPS.test(file.file.name)) return null;
        const path = file.relativePath.match(RX_SEI_DOUBLE_GPS_PATH);
        if (!path) return null;
        return ymdHmsFromSplit(`20${path[2]}`, file.file.name.slice(0, 6));
    },
};

const neolineTime: FilenameTimeTechnique = {
    id: "neoline-time",
    extract(file: VendorFile): Date | null {
        const m = file.file.name.match(RX_NEOLINE);
        if (!m) return null;
        return ymdHmsFromSplit(m[1]!, m[2]!);
    },
};

const vueroidTime: FilenameTimeTechnique = {
    id: "vueroid-time",
    extract(file: VendorFile): Date | null {
        const m = file.file.name.match(RX_VUEROID);
        if (!m) return null;
        return ymdHmsFromSplit(m[1]!, m[2]!);
    },
};

function ddpaiTimestampFromToken(name: string): Date | null {
    const m = name.match(RX_DDPAI_TIMESTAMP_TOKEN);
    if (!m) return null;
    const t = m[1]!;
    return ymdHmsFromSplit(t.slice(0, 8), t.slice(8, 14));
}

const ddpaiTime: FilenameTimeTechnique = {
    id: "ddpai-time",
    extract(file: VendorFile): Date | null {
        if (
            !RX_DDPAI_NORMAL.test(file.file.name) &&
            !RX_DDPAI_TIMELAPSE.test(file.file.name) &&
            !RX_DDPAI_EVENT.test(file.file.name)
        ) {
            return null;
        }
        return ddpaiTimestampFromToken(file.file.name);
    },
};

const eaceTime: FilenameTimeTechnique = {
    id: "e-ace-time",
    extract(file: VendorFile): Date | null {
        const m = file.file.name.match(RX_E_ACE);
        if (!m) return null;
        return ymdHmsFromSplit(m[1]!, m[2]!);
    },
};

const escortTime: FilenameTimeTechnique = {
    id: "escort-time",
    extract(file: VendorFile): Date | null {
        const m = file.file.name.match(RX_ESCORT);
        if (!m) return null;
        const date = m[1]!;
        const hhmm = m[2]!;
        const y = Number(date.slice(0, 4));
        const mo = Number(date.slice(4, 6));
        const d = Number(date.slice(6, 8));
        const h = Number(hhmm.slice(0, 2));
        const mi = Number(hhmm.slice(2, 4));
        if (y < 2000 || y > 2099) return null;
        const ms = utcMillisecondsFromParts(y, mo, d, h, mi, 0);
        return ms === null ? null : new Date(ms);
    },
};

const fitcamxTime: FilenameTimeTechnique = {
    id: "fitcamx-time",
    extract(file: VendorFile): Date | null {
        const m = file.file.name.match(RX_FITCAMX);
        if (!m) return null;
        const ts = m[1]!;
        return ymdHmsFromSplit(ts.slice(0, 8), ts.slice(8, 14));
    },
};

const ligoGpsTrailerTsTime: FilenameTimeTechnique = {
    id: "ligogps-trailer-ts-time",
    extract(file: VendorFile): Date | null {
        const m = file.file.name.match(RX_LIGOGPS_TRAILER_TS);
        if (!m) return null;
        const ts = m[1]!;
        return ymdHmsFromSplit(ts.slice(0, 8), ts.slice(8, 14));
    },
};

const iboxTime: FilenameTimeTechnique = {
    id: "ibox-time",
    extract(file: VendorFile): Date | null {
        const m = file.file.name.match(RX_IBOX);
        if (!m) return null;
        const [, yy, mm, dd, hms] = m;
        // 2-digit year: <70 -> 2000+, else 1900+. All known samples are 21st century.
        const yyNum = Number(yy);
        const year = yyNum < 70 ? 2000 + yyNum : 1900 + yyNum;
        const month = Number(mm);
        const day = Number(dd);
        const hour = Number(hms!.slice(0, 2));
        const minute = Number(hms!.slice(2, 4));
        const second = Number(hms!.slice(4, 6));
        const ms = utcMillisecondsFromParts(year, month, day, hour, minute, second);
        return ms === null ? null : new Date(ms);
    },
};

const juscarTime: FilenameTimeTechnique = {
    id: "juscar-time",
    extract(file: VendorFile): Date | null {
        const m = file.file.name.match(RX_JUSCAR);
        if (!m) return null;
        return ymdHmsFromSplit(m[1]!, m[2]!);
    },
};

const mivueTime: FilenameTimeTechnique = {
    id: "mivue-time",
    extract(file: VendorFile): Date | null {
        const m = file.file.name.match(RX_MIVUE);
        if (!m) return null;
        // 2-digit year, 2000-based (ymdhms caps at 2099). YYMMDD-HHMMSS order
        // verified against the GPS clock on a real Navman sample - see RX_MIVUE.
        return ymdhms(2000 + Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
    },
};

const navitelTime: FilenameTimeTechnique = {
    id: "navitel-time",
    extract(file: VendorFile): Date | null {
        const m = file.file.name.match(RX_NAVITEL);
        if (!m) return null;
        // 2-digit year, 2000-based (Navitel ships since ~2007; ymdhms caps at
        // 2099, plenty before a 4-digit-year firmware appears). ymdhms also
        // brings the range validation raw Date.UTC lacks.
        return ymdhms(2000 + Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
    },
};

const nextbaseTime: FilenameTimeTechnique = {
    id: "nextbase-time",
    extract(file: VendorFile): Date | null {
        const m = file.file.name.match(RX_NEXTBASE);
        if (!m) return null;
        // 2-digit year is unconditionally 2000-based - upstream prepends a
        // literal "20" (nb-dashcam-tools src/clipmergewidget.cpp:214), and
        // ymdhms caps at 2099 anyway, so a pivot would be moot. Without this
        // technique the name is unusable: generic-datetime aligns the year as
        // 1809/2010-style garbage (rejected or, worse, valid-but-wrong).
        return ymdHmsFromSplit(`20${m[1]}`, m[2]!);
    },
};

const wolfboxTime: FilenameTimeTechnique = {
    id: "wolfbox-time",
    extract(file: VendorFile): Date | null {
        const m = file.file.name.match(RX_WOLFBOX);
        if (!m) return null;
        const hms = m[4]!;
        return ymdhms(
            Number(m[1]),
            Number(m[2]),
            Number(m[3]),
            Number(hms.slice(0, 2)),
            Number(hms.slice(2, 4)),
            Number(hms.slice(4, 6)),
        );
    },
};

const teslaTime: FilenameTimeTechnique = {
    id: "tesla-time",
    extract(file: VendorFile): Date | null {
        const lower = file.relativePath.toLowerCase();
        if (!RX_TESLA_PATH.test(lower)) return null;
        if (RX_TESLA_PATH_RECENT.test(lower)) {
            // Recent: timestamp in the filename.
            const m = file.file.name.match(RX_TESLA_RECENT);
            if (!m) return null;
            return ymdhms(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
        }
        // Saved/Sentry: timestamp in the parent folder.
        if (!RX_TESLA_EVENT_FILENAME.test(file.file.name)) return null;
        const segments = file.relativePath.split("/");
        if (segments.length < 2) return null;
        const parent = segments[segments.length - 2]!;
        const fm = parent.match(RX_TESLA_EVENT_FOLDER);
        if (!fm) return null;
        return ymdhms(Number(fm[1]), Number(fm[2]), Number(fm[3]), Number(fm[4]), Number(fm[5]), Number(fm[6]));
    },
};

const fordTime: FilenameTimeTechnique = {
    id: "ford-time",
    extract(file: VendorFile): Date | null {
        const m = file.file.name.match(RX_FORD);
        if (!m) return null;
        // Named technique (not just the generic-datetime fallback) so the file
        // reads as "ford-time" in diagnostics and the family is self-contained.
        return ymdhms(+m[1]!, +m[2]!, +m[3]!, +m[4]!, +m[5]!, +m[6]!);
    },
};

const genericDatetimeTime: FilenameTimeTechnique = {
    id: "generic-datetime",
    extract(file: VendorFile): Date | null {
        const m = file.file.name.match(RX_GENERIC_DATETIME);
        if (!m) return null;
        const [, y, mo, d, h, mi, s] = m;
        return ymdhms(+y!, +mo!, +d!, +h!, +mi!, +s!);
    },
};

const datetimeChannelTsTime: FilenameTimeTechnique = {
    id: "datetime-channel-ts-time",
    extract(file: VendorFile): Date | null {
        const m = file.file.name.match(RX_DATETIME_CHANNEL_TS);
        return m ? ymdHmsFromSplit(m[1]!, m[2]!) : null;
    },
};

/**
 * Time-extraction techniques in walk order.
 *
 * Order: specific patterns first; generic-datetime last as a permissive
 * fallback. Within the specific group, ordering is mostly insensitive because
 * regexes are disjoint; the few "wide" ones (e-ace catches any
 * `\d{8}_\d{6}.mp4`) come after their narrower neighbours to keep diagnostics
 * stable.
 */
export const FILENAME_TIME: readonly FilenameTimeTechnique[] = [
    datetimeChannelTsTime,
    mai70Time,
    beferichTime,
    blackvueTime,
    carcamTime,
    dvrFourChannelTime,
    recSingleTime,
    seiDoubleGpsTime,
    ddpaiTime,
    novatekViofoTime,
    novatekVantrueTime,
    novatekSingleTime,
    novatekTsTime,
    eaceTime,
    escortTime,
    fitcamxTime,
    ligoGpsTrailerTsTime,
    iboxTime,
    juscarTime,
    mivueTime,
    navitelTime,
    neolineTime,
    nextbaseTime,
    vueroidTime,
    wolfboxTime,
    teslaTime,
    fordTime,
    genericDatetimeTime,
];
