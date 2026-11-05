// Recording constants of comma.ai openpilot, from its loggerd sources
// (openpilot/system/loggerd/loggerd.h). Kept apart from the log decoder so the
// video layer can use them without loading log parsing code.

/** MAIN_FPS: every camera stream, including the qcamera preview, runs at 20 fps. */
export const OPENPILOT_FRAME_RATE = 20;

/** SEGMENT_LENGTH: loggerd rotates every stream to a new segment each minute.
 *  Only the last segment of a route is shorter. */
export const OPENPILOT_SEGMENT_SEC = 60;
