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

/** Session and runtime caches identify the entire binary, including every part. */
export function ortAssetKey(assets: OrtAssets): string {
    return assets.wasm.parts.map((part) => part.sha256).join("|");
}

export interface TrackerAssetManifest {
    ort: { wasm: OrtAssets; webgpu: OrtAssets };
    models: { tracker: AssetPart; plate: AssetPart; face: AssetPart };
}
