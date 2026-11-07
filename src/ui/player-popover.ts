// Player menus stay inside the viewer's clipping boundary, including fullscreen.
// `anchor` may be a getter for a menu that opens from a different button while
// its own one is folded into the overflow menu.
export function initPlayerPopoverPosition(anchor: HTMLElement | (() => HTMLElement), popover: HTMLElement): () => void {
    const anchorElement = typeof anchor === "function" ? anchor : () => anchor;
    const viewer = anchorElement().closest<HTMLElement>(".viewer");
    const bar = anchorElement().closest<HTMLElement>(".player-bar");
    if (!viewer || !bar) return () => {};

    function position(): void {
        if (popover.hidden) return;
        const fullscreen = document.fullscreenElement ?? document.querySelector(".player-expanded");
        const boundary = fullscreen?.contains(popover) ? fullscreen : viewer!;
        const bounds = boundary.getBoundingClientRect();
        const anchorBounds = anchorElement().getBoundingClientRect();
        const padding = 8;
        popover.style.maxWidth = `${Math.max(0, bounds.width - padding * 2)}px`;
        popover.style.maxHeight = `${Math.max(0, anchorBounds.top - Math.max(0, bounds.top) - padding)}px`;
        popover.style.translate = "0px";
        const rect = popover.getBoundingClientRect();
        const left = Math.max(bounds.left + padding, Math.min(rect.left, bounds.right - rect.width - padding));
        popover.style.translate = `${left - rect.left}px`;
    }

    const visibility = new MutationObserver(position);
    visibility.observe(popover, { attributes: true, attributeFilter: ["hidden"] });
    const resize = new ResizeObserver(position);
    resize.observe(viewer);
    resize.observe(bar);
    resize.observe(popover);
    viewer.addEventListener("scroll", position, { passive: true });
    document.addEventListener("fullscreenchange", position);
    document.addEventListener("playerexpansionchange", position);
    return () => {
        visibility.disconnect();
        resize.disconnect();
        viewer.removeEventListener("scroll", position);
        document.removeEventListener("fullscreenchange", position);
        document.removeEventListener("playerexpansionchange", position);
    };
}
