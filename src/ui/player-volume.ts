// Volume + mute state, persistence and popover.
// Owns: persisted volume/muted (localStorage round-trip), the mute icon + aria
// state, the slider popover above the mute button, and the slider 'input'
// listener.

import { readLocalStorage, writeLocalStorage } from "../local-storage.js";
import { t } from "../i18n/index.js";
import { dom } from "./dom.js";
import { isCoarsePointer } from "./media-queries.js";
import { state } from "./state.js";

// Volume and mute are persisted under separate keys so each can be read
// independently without JSON parsing a tiny two-field blob. Volume: 0..1
// numeric string. Muted: "1"/"0" - avoid parsing arbitrary "true"/"false".
const VOLUME_STORAGE_KEY = "everydashcam:volume";
const MUTED_STORAGE_KEY = "everydashcam:muted";

function loadStoredVolume(): number | null {
    const raw = readLocalStorage(VOLUME_STORAGE_KEY);
    if (raw === null) return null;
    const v = Number(raw);
    return Number.isFinite(v) && v >= 0 && v <= 1 ? v : null;
}

function loadStoredMuted(): boolean | null {
    const raw = readLocalStorage(MUTED_STORAGE_KEY);
    return raw === "1" ? true : raw === "0" ? false : null;
}

export function persistVolume(v: number): void {
    writeLocalStorage(VOLUME_STORAGE_KEY, String(v));
}

export function persistMuted(m: boolean): void {
    writeLocalStorage(MUTED_STORAGE_KEY, m ? "1" : "0");
}

/**
 * Syncs the volume slider visual to the mute state. On mute=true sets slider
 * to 0 - users intuitively expect "no sound = empty slider". preferredVolume
 * is not changed so unmuting restores the saved level.
 */
export function syncVolumeSliderFromMute(): void {
    if (state.preferredMuted) {
        dom.playerBar.volumeSlider.value = "0";
    } else {
        dom.playerBar.volumeSlider.value = String(state.preferredVolume);
    }
}

// Re-applies state.preferred* to the per-channel <video> elements, honoring
// composition.audioChannel. Injected by player.ts at init (init-callback
// pattern - player.ts imports this module, so a direct import back would be a
// cycle). Until init it is a no-op; init runs before any user interaction.
let applyAudioRouting: () => void = () => {};

export function syncMuteButton(): void {
    // state.preferredMuted, NOT dom.player.muted: the audio source is
    // composition.audioChannel, which may not be the active element - the
    // master is then muted by routing and the button would show "muted"
    // while sound plays.
    const muted = state.preferredMuted;
    const volIcon = dom.playerBar.mute.querySelector<SVGElement>(".i-vol");
    const volXIcon = dom.playerBar.mute.querySelector<SVGElement>(".i-vol-x");
    if (volIcon) volIcon.toggleAttribute("hidden", muted);
    if (volXIcon) volXIcon.toggleAttribute("hidden", !muted);
    const label = muted ? t("player.unmute") : t("player.mute");
    dom.playerBar.mute.setAttribute("aria-label", label);
    dom.playerBar.mute.title = label;
}

/**
 * Toggles mute and persists to state.preferredMuted, then re-applies the
 * audio routing - the actual <video> elements are owned by player.ts'
 * syncAudioRouting (composition.audioChannel decides which element carries
 * sound; writing dom.player.muted directly muted the wrong element whenever
 * the audio source was not the visual master).
 */
export function toggleMuted(): void {
    state.preferredMuted = !state.preferredMuted;
    persistMuted(state.preferredMuted);
    syncVolumeSliderFromMute();
    applyAudioRouting();
    syncMuteButton();
}

/**
 * Applies a 0..1 slider level to the audio state. 0 = mute, leaving
 * preferredVolume intact so the button/unmute restores the prior level; any
 * positive value sets + persists the level and lifts mute. Shared by the bar
 * slider and the kebab-overflow volume row so the mute/unmute rule lives in one
 * place; syncs the bar slider so the collapsed wrap is correct when it reopens.
 */
export function applyVolumeLevel(v: number): void {
    if (!Number.isFinite(v)) return;
    // Slider at 0 is equivalent to mute. Don't write 0 to preferredVolume
    // (nothing to restore on unmute via the button); just enable mute.
    if (v === 0) {
        if (!state.preferredMuted) {
            state.preferredMuted = true;
            persistMuted(true);
            applyAudioRouting();
            syncMuteButton();
        }
        syncVolumeSliderFromMute();
        return;
    }
    state.preferredVolume = v;
    persistVolume(v);
    // Moving off 0 - unmute, else the user drags but hears nothing.
    if (state.preferredMuted) {
        state.preferredMuted = false;
        persistMuted(false);
    }
    applyAudioRouting();
    syncMuteButton();
    syncVolumeSliderFromMute();
}

// === Volume slider popover ===
//
// The hover surface is the whole .player-mute-wrap (mute button + popover) so
// the cursor can move freely between the button and the slider without losing
// hover. focus/focusout added for keyboard accessibility (after Tab on the
// slider).
//
// The trailing hide-timer covers fast cursor movement between the button and
// the popover - mouseleave can register on the wrap before the cursor reaches
// the popover. CSS ::before pseudo-element fills the 4px visual gap.
let hideVolumeTimer: ReturnType<typeof setTimeout> | null = null;

// Touch has no hover, so the slider is unreachable from the bar by tapping mute
// (which only toggles). On coarse pointers a tap ALSO reveals the popover; this
// idle timer dismisses it, reset on each slider interaction. Kept distinct from
// the 120ms hover-gap timer above so the two mechanisms don't fight.
const COARSE_VOLUME_DISMISS_MS = 3000;
let coarseDismissTimer: ReturnType<typeof setTimeout> | null = null;

function armCoarseDismiss(): void {
    if (coarseDismissTimer) clearTimeout(coarseDismissTimer);
    coarseDismissTimer = setTimeout(() => {
        coarseDismissTimer = null;
        dom.playerBar.volumePopover.hidden = true;
    }, COARSE_VOLUME_DISMISS_MS);
}

function showVolumePopover(): void {
    if (hideVolumeTimer) {
        clearTimeout(hideVolumeTimer);
        hideVolumeTimer = null;
    }
    dom.playerBar.volumePopover.hidden = false;
}

function hideVolumePopover(): void {
    // Don't hide if focus is still inside the wrapper (user tabbed to the
    // slider) - it would break keyboard navigation.
    if (dom.playerBar.muteWrap.contains(document.activeElement)) return;
    if (hideVolumeTimer) clearTimeout(hideVolumeTimer);
    hideVolumeTimer = setTimeout(() => {
        hideVolumeTimer = null;
        // Double-check: focus may have returned during the delay.
        if (dom.playerBar.muteWrap.contains(document.activeElement)) return;
        dom.playerBar.volumePopover.hidden = true;
    }, 120);
}

/**
 * Wires up volume/mute UI: restores persisted values into state, syncs the
 * slider to that state, and installs all popover + slider + mute-button
 * listeners. `deps.applyAudioRouting` is player.ts' syncAudioRouting - every
 * preference change goes through it instead of poking dom.player directly
 * (see toggleMuted for why).
 */
export function initPlayerVolume(deps: { applyAudioRouting: () => void }): void {
    applyAudioRouting = deps.applyAudioRouting;
    // Restore persisted volume/mute from a previous session. localStorage
    // empty or blocked -> keep state defaults.
    const storedVolume = loadStoredVolume();
    if (storedVolume !== null) state.preferredVolume = storedVolume;
    const storedMuted = loadStoredMuted();
    if (storedMuted !== null) state.preferredMuted = storedMuted;
    syncVolumeSliderFromMute();

    dom.playerBar.mute.addEventListener("click", () => {
        toggleMuted();
        // Touch: also reveal the slider (unreachable by hover) and arm an idle
        // dismiss. The mute toggle above still happens - one tap does both.
        if (isCoarsePointer()) {
            showVolumePopover();
            armCoarseDismiss();
        }
    });

    dom.playerBar.muteWrap.addEventListener("mouseenter", showVolumePopover);
    dom.playerBar.muteWrap.addEventListener("mouseleave", hideVolumePopover);
    dom.playerBar.muteWrap.addEventListener("focusin", showVolumePopover);
    dom.playerBar.muteWrap.addEventListener("focusout", hideVolumePopover);

    // Touch: tapping outside the mute cluster dismisses the revealed slider.
    document.addEventListener("pointerdown", (e) => {
        if (dom.playerBar.volumePopover.hidden || !isCoarsePointer()) return;
        const target = e.target;
        if (target instanceof Node && dom.playerBar.muteWrap.contains(target)) return;
        dom.playerBar.volumePopover.hidden = true;
        if (coarseDismissTimer) {
            clearTimeout(coarseDismissTimer);
            coarseDismissTimer = null;
        }
    });

    dom.playerBar.volumeSlider.addEventListener("input", () => {
        // Reset the touch idle-dismiss on any slider interaction.
        if (coarseDismissTimer) armCoarseDismiss();
        applyVolumeLevel(Number(dom.playerBar.volumeSlider.value));
    });
}
