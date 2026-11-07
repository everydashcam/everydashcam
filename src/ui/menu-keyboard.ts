interface MenuKeyboardOptions {
    button: HTMLElement;
    menu: HTMLElement;
    itemSelector: string;
    onOpen: () => void;
    /** Closes the menu through its popover, which returns the focus. */
    onClose: () => void;
}

export function initMenuKeyboard(options: MenuKeyboardOptions): () => void {
    const { button, menu, itemSelector, onOpen, onClose } = options;
    const items = (): HTMLElement[] =>
        [...menu.querySelectorAll<HTMLElement>(itemSelector)].filter((item) => item.getClientRects().length > 0);

    function onButtonKeyDown(event: KeyboardEvent): void {
        if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
        event.preventDefault();
        event.stopPropagation();
        onOpen();
        const visible = items();
        (event.key === "ArrowDown" ? visible[0] : visible.at(-1))?.focus();
    }

    function onMenuKeyDown(event: KeyboardEvent): void {
        const visible = items();
        const focused = document.activeElement;
        const index = focused instanceof HTMLElement ? visible.indexOf(focused) : -1;
        let next: number | null = null;
        if (event.key === "ArrowDown") next = index + 1;
        if (event.key === "ArrowUp") next = index - 1;
        if (event.key === "Home") next = 0;
        if (event.key === "End") next = visible.length - 1;
        if (next !== null) {
            event.preventDefault();
            event.stopPropagation();
            visible[(next + visible.length) % visible.length]?.focus();
        } else if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            event.stopPropagation();
            visible[index]?.click();
        } else if (event.key === "Escape" || event.key === "Tab") {
            if (event.key === "Escape") event.preventDefault();
            event.stopPropagation();
            onClose();
        }
    }

    button.addEventListener("keydown", onButtonKeyDown);
    menu.addEventListener("keydown", onMenuKeyDown);
    return () => {
        button.removeEventListener("keydown", onButtonKeyDown);
        menu.removeEventListener("keydown", onMenuKeyDown);
    };
}
