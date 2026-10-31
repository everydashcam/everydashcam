interface PopoverOptions {
    button: HTMLElement;
    panel: HTMLElement;
    /** Optional inner card when the panel includes an outside-click backdrop. */
    contains?: (target: Node) => boolean;
    show?: () => void;
    hide?: () => void;
    afterOpen?: () => void;
}

interface PopoverController {
    readonly isOpen: boolean;
    open(): void;
    close(restoreFocus?: boolean): void;
    toggle(): void;
}

let active: PopoverController | null = null;

/** Opening a dialog or another popover releases the current menu's listeners. */
export function closeActivePopover(): void {
    active?.close();
}

/** Shared dismissal and focus ownership; geometry and menu contents stay with
 * the feature. Listeners exist only while a popover is open. */
export function createPopover(options: PopoverOptions): PopoverController {
    const { button, panel } = options;
    let isOpen = false;
    const outside = (event: Event): void => {
        const target = event.target;
        if (
            target instanceof Node &&
            (button.contains(target) || (options.contains ? options.contains(target) : panel.contains(target)))
        )
            return;
        controller.close();
    };
    const keydown = (event: KeyboardEvent): void => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        controller.close(true);
    };
    const controller: PopoverController = {
        get isOpen() {
            return isOpen;
        },
        open() {
            if (isOpen) return;
            closeActivePopover();
            if (options.show) options.show();
            else panel.hidden = false;
            isOpen = true;
            active = controller;
            button.setAttribute("aria-expanded", "true");
            document.addEventListener("pointerdown", outside, true);
            document.addEventListener("click", outside, true);
            document.addEventListener("keydown", keydown, true);
            options.afterOpen?.();
        },
        close(restoreFocus = false) {
            if (!isOpen) return;
            const hadFocus = panel.contains(document.activeElement);
            isOpen = false;
            if (active === controller) active = null;
            document.removeEventListener("pointerdown", outside, true);
            document.removeEventListener("click", outside, true);
            document.removeEventListener("keydown", keydown, true);
            if (options.hide) options.hide();
            else panel.hidden = true;
            button.setAttribute("aria-expanded", "false");
            if ((restoreFocus || hadFocus) && button.isConnected) button.focus({ preventScroll: true });
        },
        toggle() {
            if (isOpen) controller.close();
            else controller.open();
        },
    };
    return controller;
}
