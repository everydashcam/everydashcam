import type { FileIdentity } from "./types.js";

/**
 * Builds the cross-session identity for a file discovered at `relativePath`
 * (relative to the remembered folder root, filename included). Reads only
 * File metadata, never bytes.
 */
export function fileIdentityOf(file: File, relativePath: string): FileIdentity {
    return { relativePath, size: file.size, lastModified: file.lastModified };
}

// NUL separator: no filesystem allows NUL in a path, so joining fields with it
// cannot collide across field boundaries (e.g. size 1 + mtime 12 vs size 11 +
// mtime 2). Built via fromCharCode to keep the source file free of raw NUL bytes.
const KEY_SEPARATOR = String.fromCharCode(0);

/** Stable string form of an identity, used in IndexedDB keys and TripAnchor. */
export function fileIdentityKey(identity: FileIdentity): string {
    return [identity.relativePath, identity.size, identity.lastModified].join(KEY_SEPARATOR);
}

/** Reverses fileIdentityKey at recovery boundaries. Returns null for legacy or
 * malformed keys rather than manufacturing an identity that could attach a
 * note to the wrong recording. */
export function parseFileIdentityKey(key: string): FileIdentity | null {
    const parts = key.split(KEY_SEPARATOR);
    if (parts.length !== 3) return null;
    const relativePath = parts[0]!;
    const sizeText = parts[1]!;
    const lastModifiedText = parts[2]!;
    // fileIdentityKey emits canonical decimal integers. Number("") and
    // Number("1e3") would otherwise accept malformed external anchors that no
    // key produced by this app can contain. Only the time may be negative:
    // Chromium reports a picked file without an OS time as 1601-01-01.
    if (!/^(0|[1-9]\d*)$/.test(sizeText) || !/^(0|-?[1-9]\d*)$/.test(lastModifiedText)) return null;
    const size = Number(sizeText);
    const lastModified = Number(lastModifiedText);
    if (relativePath.length === 0 || !Number.isSafeInteger(size) || !Number.isSafeInteger(lastModified)) {
        return null;
    }
    return { relativePath, size, lastModified };
}
