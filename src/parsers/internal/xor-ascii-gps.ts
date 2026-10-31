// XOR-0xAA ASCII GPS record - one payload format, three carriers.
//
// Every byte is XOR-ed with 0xAA; decrypted, the record opens with the literal
// "XKZD\xfe\xfe" (which is why `f2 e1 f0 ee 54 54` is the signature everywhere)
// and continues as fixed-offset ASCII fields. ExifTool decodes it in three
// places, and they are the same bytes behind different wrappers:
//
//   - inside a freeGPS block (Azdome GS63H, EEEkit) - QuickTimeStream.pl:1652,
//     the `freegps` primitive's Azdome variant, real-sample validated on
//     Roadgid Tube;
//   - as 311-byte records in a top-level `gps0` atom (Lamax S9 dual dashcam) -
//     QuickTimeStream.pl:2724;
//   - as the samples of a `gpmd` track (Rove Stealth 4K) - the `gpmd_Rove`
//     condition at QuickTimeStream.pl:189.
//
// All three route to the same decrypt in upstream (Process_text at :1175 or the
// inline copy in ProcessFreeGPS), so they share one decoder here. Field offsets
// below are into the DECRYPTED text.

import { type GpsRecord, KMH_TO_MS } from "../types.js";
import { ddmmToDegrees, isCoordinateInRange } from "./ddmm.js";
import { utcSecondsFromYmdhms } from "./calendar.js";

/** Encrypted "XKZD\xfe\xfe" - present in every carrier at its own offset. */
export const XOR_ASCII_SIGNATURE = [0xf2, 0xe1, 0xf0, 0xee, 0x54, 0x54] as const;

/** The record cipher: a single-byte XOR, same for every field. */
export const XOR_ASCII_KEY = 0xaa;

/** Minimum decrypted length upstream requires before it will decode. */
export const XOR_ASCII_MIN_LENGTH = 282;

/** Decrypts `length` bytes from `start` into latin1 text. */
export function decryptXorAscii(bytes: Uint8Array, start: number, length: number): string {
    const end = Math.min(start + length, bytes.length);
    const out = new Uint8Array(Math.max(0, end - start));
    for (let i = 0; i < out.length; i++) out[i] = bytes[start + i]! ^ XOR_ASCII_KEY;
    return new TextDecoder("latin1").decode(out);
}

/** True when `bytes` carries the encrypted signature at `offset`. */
export function hasXorAsciiSignature(bytes: Uint8Array, offset: number): boolean {
    if (bytes.length < offset + XOR_ASCII_SIGNATURE.length) return false;
    for (let i = 0; i < XOR_ASCII_SIGNATURE.length; i++) {
        if (bytes[offset + i] !== XOR_ASCII_SIGNATURE[i]) return false;
    }
    return true;
}

// Decrypted layout: 8 bytes of preamble, datetime, one flag byte, a 15-byte
// user label, then the coordinate pair. Coordinates are DD(D) + minutes*1e4,
// hence the /1e4 into ddmmToDegrees.
const RECORD_RX = /^.{8}(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2}).{16}([NS])(\d{8})([EW])(\d{9})(\d{8})?/s;

// Speed forms: the Azdome record carries 8 digits inline after the longitude;
// the EEEkit/Ambarella one puts [-+]\d{4} at 57 and 3 km/h digits at 62.
const EEEKIT_SPEED_RX = /^.{57}[-+]\d{4}(\d{3})/s;

// Accel triples, tried in this order - upstream ignores the firmware tag byte
// and lets the regex validate itself.
const ACCEL_RX_PRIMARY = /^.{65}([-+]\d{3})([-+]\d{3})([-+]\d{3})/s;
const ACCEL_RX_FALLBACK = /^.{173}([-+]\d{3})([-+]\d{3})([-+]\d{3})/s;

/**
 * Decodes one decrypted record. Returns null when the text carries no usable
 * fix - which is normal, not an error: these cameras write accel+datetime-only
 * records whenever GPS has no lock (QuickTimeStream.pl:1706).
 *
 * The accel triple is returned RAW (/100 g, gravity INCLUDED, confirmed on real
 * Roadgid Tube samples). Gravity removal needs the whole file - the per-axis
 * mean is the gravity+tilt estimate - so every caller must subtract the
 * per-file baseline after its parse pass.
 */
export function decodeXorAsciiGpsText(text: string, mp4Filename: string): GpsRecord | null {
    const m = RECORD_RX.exec(text);
    if (!m) return null;

    // Zone is assumed UTC - upstream attaches none, and no sample settles it.
    const unixSeconds = utcSecondsFromYmdhms(
        Number(m[1]),
        Number(m[2]),
        Number(m[3]),
        Number(m[4]),
        Number(m[5]),
        Number(m[6]),
    );
    if (unixSeconds === null) return null;

    const lat = ddmmToDegrees(Number(m[8]) / 1e4) * (m[7] === "N" ? 1 : -1);
    const lon = ddmmToDegrees(Number(m[10]) / 1e4) * (m[9] === "E" ? 1 : -1);
    if (!isCoordinateInRange(lat, "lat") || !isCoordinateInRange(lon, "lon")) return null;

    // km/h per ExifTool's GPSSpeed convention for this branch. The [-+]\d{4}
    // group at 57 looks like altitude, but upstream explicitly distrusts it
    // ("doesn't look right"), so it is never emitted.
    let speedKmh = 0;
    if (m[11] !== undefined) {
        speedKmh = Number(m[11]);
    } else {
        const eeekit = EEEKIT_SPEED_RX.exec(text);
        if (eeekit) speedKmh = Number(eeekit[1]);
    }

    let accel: readonly [number, number, number] = [0, 0, 0];
    const accelMatch = ACCEL_RX_PRIMARY.exec(text) ?? ACCEL_RX_FALLBACK.exec(text);
    if (accelMatch) {
        accel = [Number(accelMatch[1]) / 100, Number(accelMatch[2]) / 100, Number(accelMatch[3]) / 100];
    }

    return {
        unixSeconds,
        active: true,
        lat,
        lon,
        // No track field in this format; bearing 0 is forward-filled downstream.
        bearingDeg: 0,
        speedMs: speedKmh * KMH_TO_MS,
        accelXg: accel[0],
        accelYg: accel[1],
        accelZg: accel[2],
        mp4Filename,
    };
}
