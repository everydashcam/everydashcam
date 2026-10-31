/** Compares a complete marker without reading beyond a view or a record boundary. */
export function matchesBytesAt(
    bytes: Uint8Array | DataView,
    offset: number,
    marker: ArrayLike<number>,
    end = bytes.byteLength,
): boolean {
    if (offset < 0 || offset + marker.length > Math.min(end, bytes.byteLength)) return false;
    if (bytes instanceof DataView) {
        for (let i = 0; i < marker.length; i++) if (bytes.getUint8(offset + i) !== marker[i]) return false;
    } else {
        for (let i = 0; i < marker.length; i++) if (bytes[offset + i] !== marker[i]) return false;
    }
    return true;
}

/** Finds a complete nonempty marker in [from, to), relative to the supplied view. */
export function findByteSequence(bytes: Uint8Array, marker: Uint8Array, from = 0, to = bytes.length): number {
    const end = Math.min(to, bytes.length);
    const lastStart = end - marker.length;
    if (marker.length === 0 || from > lastStart) return -1;
    // Bound the native search too: a short probe must not scan the remaining video.
    const window = end < bytes.length ? bytes.subarray(0, end) : bytes;
    outer: for (let offset = window.indexOf(marker[0]!, from); offset >= 0 && offset <= lastStart; ) {
        for (let index = 1; index < marker.length; index++) {
            if (bytes[offset + index] !== marker[index]) {
                offset = window.indexOf(marker[0]!, offset + 1);
                continue outer;
            }
        }
        return offset;
    }
    return -1;
}
