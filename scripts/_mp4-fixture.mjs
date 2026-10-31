// Binary construction/reading shared by anonymizers; GPS/privacy transforms stay local.
import { readSync } from "node:fs";

export function fourCC(value) {
    return Buffer.from(value, "ascii");
}
export function u32be(value) {
    const bytes = Buffer.alloc(4);
    bytes.writeUInt32BE(value);
    return bytes;
}
export function box(type, payload) {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(payload.length + 8);
    head.write(type, 4, 4, "ascii");
    return Buffer.concat([head, payload]);
}

export function readBoxHeader(fd, offset, fileSize) {
    const buf = Buffer.alloc(Math.min(16, fileSize - offset));
    readSync(fd, buf, 0, buf.length, offset);
    if (buf.length < 8) return null;
    let size = buf.readUInt32BE(0);
    const type = buf.toString("ascii", 4, 8);
    let headerSize = 8;
    if (size === 1) {
        if (buf.length < 16) return null;
        const hi = buf.readUInt32BE(8);
        const lo = buf.readUInt32BE(12);
        size = hi * 0x100000000 + lo;
        headerSize = 16;
    } else if (size === 0) {
        size = fileSize - offset;
    }
    if (size < headerSize || offset + size > fileSize) return null;
    return { type, size, headerSize };
}

export function u32le(value) {
    const bytes = Buffer.alloc(4);
    bytes.writeUInt32LE(value);
    return bytes;
}

export function findFirstChild(fd, parent, fileSize, type) {
    let pos = parent.offset + parent.headerSize;
    const end = parent.offset + parent.size;
    while (pos + 8 <= end) {
        const header = readBoxHeader(fd, pos, fileSize);
        if (!header) return null;
        if (header.type === type) return { offset: pos, ...header };
        pos += header.size;
    }
    return null;
}

export function readBoxBytes(fd, header) {
    const bytes = Buffer.alloc(header.size);
    readSync(fd, bytes, 0, header.size, header.offset);
    return bytes;
}

export function findByteOffsets(bytes, marker, end = bytes.length) {
    if (!marker.length) throw new Error("empty byte marker");
    const offsets = [];
    for (
        let offset = bytes.indexOf(marker);
        offset !== -1 && offset < end;
        offset = bytes.indexOf(marker, offset + marker.length)
    ) {
        offsets.push(offset);
    }
    return offsets;
}
