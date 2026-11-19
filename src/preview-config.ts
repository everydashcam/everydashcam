export const PREVIEW_WIDTH_PX = 320;
export const PREVIEW_HEIGHT_PX = 180;
export const PREVIEW_JPEG_QUALITY = 0.7;

/** Format of trip previews kept across sessions (persist/index-cache.ts). Bump
 *  with any change above or to how a preview is cut, so stored ones read as
 *  absent instead of showing the old look. */
export const PREVIEW_CACHE_FORMAT = 1;
