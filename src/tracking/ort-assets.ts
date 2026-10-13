/** Versioned pieces of one WASM binary, in assembly order. */
export interface WasmPart {
    url: string;
    bytes: number;
    sha256: string;
}

/** The module and matching WASM for one runtime, resolved on the main thread. */
export interface OrtAssets {
    moduleUrl: string;
    wasm: { bytes: number; url: string } | { bytes: number; parts: WasmPart[] };
}
