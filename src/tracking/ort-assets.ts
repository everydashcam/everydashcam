/** Immutable binary response, verified before use. */
export interface AssetPart {
    url: string;
    bytes: number;
    sha256: string;
}

/** Parts are in assembly order; small binaries have exactly one part. */
export interface OrtAssets {
    wasm: { bytes: number; parts: AssetPart[] };
}

export interface TrackerAssetManifest {
    ort: { wasm: OrtAssets; webgpu: OrtAssets };
    models: { tracker: AssetPart; plate: AssetPart; face: AssetPart };
}
