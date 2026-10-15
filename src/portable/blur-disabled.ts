// Portable builds replace the automatic blur clients at this boundary. Empty
// read state preserves shared manual-blur rendering; execution fails loudly.
import type * as Assets from "../ui/blur-assets.js";
import type * as Detect from "../ui/blur-detect.js";
import type * as Track from "../ui/blur-track.js";
import { DETECTION_QUALITY_DEFAULT } from "../tracking/detection-sampling.js";
import { DETECTION_POLICIES } from "../tracking/detector-policy.js";

function unavailable(): never {
    throw new Error("automatic blur is unavailable in the portable edition");
}

function unsubscribe(): void {}

export const subscribeBlurAssets: typeof Assets.subscribeBlurAssets = () => unsubscribe;
export const subscribeBlurDetect: typeof Detect.subscribeBlurDetect = () => unsubscribe;
export const subscribeTrackPasses: typeof Track.subscribeTrackPasses = () => unsubscribe;
export const cancelTrackPass: typeof Track.cancelTrackPass = () => {};
export const cancelTrackPassesExceptTrip: typeof Track.cancelTrackPassesExceptTrip = () => {};
export const trackPassOf: typeof Track.trackPassOf = () => null;
export const toggleTrackPass: typeof Track.toggleTrackPass = unavailable;
export const detectAvailable: typeof Detect.detectAvailable = () => false;
export const detectEnabled: typeof Detect.detectEnabled = () => false;
export const detectQuality: typeof Detect.detectQuality = () => DETECTION_QUALITY_DEFAULT;
export const detectThreshold: typeof Detect.detectThreshold = (kind) => DETECTION_POLICIES[kind].seedScoreMin;
export const anyDetectEnabled: typeof Detect.anyDetectEnabled = () => false;
export const detectPassState: typeof Detect.detectPassState = () => null;
export const detectCounts: typeof Detect.detectCounts = () => null;
export const detectFindings: typeof Detect.detectFindings = () => [];
export const detectUncertainFindings: typeof Detect.detectUncertainFindings = () => [];
export const detectRegions: typeof Detect.detectRegions = () => [];
export const detectStyle: typeof Detect.detectStyle = () => null;
export const detectStale: typeof Detect.detectStale = () => false;
export const captureDetectExportRequest: typeof Detect.captureDetectExportRequest = () => null;
export const ensureDetectPass: typeof Detect.ensureDetectPass = unavailable;
export const ensureDetectRegionsForExport: typeof Detect.ensureDetectRegionsForExport = unavailable;
export const setDetectEnabled: typeof Detect.setDetectEnabled = unavailable;
export const setDetectQuality: typeof Detect.setDetectQuality = unavailable;
export const setDetectThreshold: typeof Detect.setDetectThreshold = unavailable;
export const setDetectStyle: typeof Detect.setDetectStyle = unavailable;
export const detectAssetGroups: typeof Detect.detectAssetGroups = () => [];
export const blurAssetsBlockedOffline: typeof Assets.blurAssetsBlockedOffline = () => false;
export const blurAssetsDownloadMb: typeof Assets.blurAssetsDownloadMb = () => 0;
export const blurAssetsNeedDownload: typeof Assets.blurAssetsNeedDownload = () => false;
export const blurAssetsReady: typeof Assets.blurAssetsReady = () => false;
export const blurAssetsState: typeof Assets.blurAssetsState = () => ({
    phase: "idle",
    progress: 0,
    activeGroups: null,
});
export const downloadBlurAssets: typeof Assets.downloadBlurAssets = unavailable;
