import type { TrackerAssetManifest } from "./ort-assets.js";

// The same build snapshot feeds the UI, workers and emitted files. Never fall
// back to unversioned URLs: missing metadata must fail before inference.
declare const __DC_TRACKER_ASSETS__: TrackerAssetManifest;
export const TRACKER_ASSETS = __DC_TRACKER_ASSETS__;
