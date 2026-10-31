import { createHash } from "node:crypto";

export function sha256Hex(bytes) {
    return createHash("sha256").update(bytes).digest("hex");
}

/** Check the published bytes, before decompression or HTML decoding. */
export function matchesArtifactIntegrity(bytes, expected) {
    return bytes.byteLength === expected.bytes && sha256Hex(bytes) === expected.sha256;
}
