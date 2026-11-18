// Build the contents from the sections shipped by this edition. Migration and
// privacy visibility are resolved before the navigation is initialized.
export function initSettingsNavigation(modal: HTMLElement): () => void {
    const content = modal.querySelector<HTMLElement>(".settings-content")!;
    const links = modal.querySelector<HTMLElement>(".settings-nav__links")!;
    const jump = modal.querySelector<HTMLSelectElement>("#settings-jump")!;
    const sections = Array.from(content.querySelectorAll<HTMLElement>(".export-modal-section:not([hidden])"));
    const items = sections.map((section) => {
        const heading = section.querySelector<HTMLElement>(".settings-section-title")!;
        const key = heading.dataset.i18n!;
        section.id ||= key.replaceAll(".", "-");
        heading.tabIndex = -1;
        const link = document.createElement("a");
        link.href = `#${section.id}`;
        link.textContent = heading.textContent;
        link.addEventListener("click", (event) => {
            event.preventDefault();
            navigate(section, heading);
        });
        links.append(link);
        jump.add(new Option(heading.textContent ?? "", section.id));
        return { link, section, heading };
    });

    let selected: HTMLElement | undefined;
    function select(section: HTMLElement): void {
        if (selected === section) return;
        selected = section;
        jump.value = section.id;
        for (const item of items) {
            if (item.section === section) item.link.setAttribute("aria-current", "location");
            else item.link.removeAttribute("aria-current");
        }
    }

    // A short section near the end may not reach the top of the pane.
    // Keep the explicit destination selected until the user scrolls again.
    let destinationTop = -1;
    function navigate(section: HTMLElement, heading: HTMLElement): void {
        content.scrollTop = section.offsetTop;
        destinationTop = content.scrollTop;
        select(section);
        heading.focus({ preventScroll: true });
    }
    jump.addEventListener("change", () => {
        const item = items.find(({ section }) => section.id === jump.value);
        if (item) navigate(item.section, item.heading);
    });
    content.addEventListener(
        "scroll",
        () => {
            if (modal.hidden || content.scrollTop === destinationTop) return;
            destinationTop = -1;
            const top = content.getBoundingClientRect().top + 2;
            const current =
                content.scrollTop + content.clientHeight >= content.scrollHeight - 1
                    ? items.at(-1)
                    : (items.findLast(({ section }) => section.getBoundingClientRect().top <= top) ?? items[0]);
            if (current) select(current.section);
        },
        { passive: true },
    );
    return () => {
        content.scrollTop = 0;
        destinationTop = 0;
        if (items[0]) select(items[0].section);
    };
}
