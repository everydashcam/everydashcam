export declare function sha256Hex(bytes: Uint8Array): string;
export declare function matchesArtifactIntegrity(
    bytes: Uint8Array,
    expected: { bytes: number; sha256: string },
): boolean;
