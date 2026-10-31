export interface Mp4BoxHeader {
    type: string;
    size: number;
    headerSize: 8 | 16;
}

/** Reads a box header from buffered bytes. `remaining` is the containing
 * region's size from this offset; it can exceed the buffer for a file probe.
 * Size zero consumes that region. Payload loading remains the caller's job. */
export function readMp4BoxHeader(
    view: DataView,
    offset = 0,
    remaining = view.byteLength - offset,
): Mp4BoxHeader | null {
    if (remaining < 8 || offset < 0 || offset + 8 > view.byteLength) return null;
    let size = view.getUint32(offset);
    let headerSize: 8 | 16 = 8;
    const type = String.fromCharCode(
        view.getUint8(offset + 4),
        view.getUint8(offset + 5),
        view.getUint8(offset + 6),
        view.getUint8(offset + 7),
    );
    if (size === 1) {
        if (remaining < 16 || offset + 16 > view.byteLength) return null;
        size = view.getUint32(offset + 8) * 0x100000000 + view.getUint32(offset + 12);
        headerSize = 16;
    } else if (size === 0) {
        size = remaining;
    }
    return size < headerSize || size > remaining ? null : { type, size, headerSize };
}
