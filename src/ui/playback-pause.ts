// The user's pause, shared by every surface that stops playback (controls,
// frame stepping, export, crop editing, markers). Pausing the element is not
// enough while playback holds it paused for itself to load a source or land
// a seek: the element is already paused, so no 'pause' event records the
// intent, and the deferred resume would start playback again once the load
// lands. The player registers how to cancel those resumes; surfaces call
// pausePlayback without importing the playback core.

import { dom } from "./dom.js";

let cancelDeferredResumes: () => void = () => {};

/** Installs the player's canceller: it drops every resume playback deferred
 *  for itself and records that playback is no longer wanted. */
export function registerPauseIntent(cancel: () => void): void {
    cancelDeferredResumes = cancel;
}

/** Stops playback on the user's behalf, including a resume pending behind a
 *  source load or seek. Harmless on a player that is already stopped. */
export function pausePlayback(): void {
    cancelDeferredResumes();
    if (!dom.player.paused) dom.player.pause();
}
