export declare function fourCC(value: string): Buffer;
export declare function u32be(value: number): Buffer;
export declare function box(type: string, payload: Uint8Array): Buffer;
export declare function readBoxHeader(
    fd: number,
    offset: number,
    fileSize: number,
): {
    type: string;
    size: number;
    headerSize: number;
} | null;
export declare function u32le(value: number): Buffer;
export declare function findByteOffsets(bytes: Buffer, marker: Uint8Array, end?: number): number[];
export declare function readBoxBytes(fd: number, header: { offset: number; size: number }): Buffer;
export declare function findFirstChild(
    fd: number,
    parent: { offset: number; size: number; headerSize: number },
    fileSize: number,
    type: string,
): { offset: number; type: string; size: number; headerSize: number } | null;
