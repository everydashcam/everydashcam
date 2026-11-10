// Tooltips that name a control's keyboard shortcut. The key goes only into
// `title`: the same translated label also names overflow menu items and
// visible button text, where a key is noise, and assistive tech gets the key
// from aria-keyshortcuts on the control. Keys are the ones player-hotkeys.ts
// and view-menu.ts listen for.

/** A tooltip in the player bar format, e.g. "Mute (U)". */
export function withShortcutHint(label: string, keys: string): string {
    return `${label} (${keys})`;
}
