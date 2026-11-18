import { OPENFREEMAP_CREDITS, OSM_CREDITS } from "./map-credits.js";
import type { IControl, Map as MapLibreMap } from "maplibre-gl";

import yandexLogoEn from "../assets/credits/yandex-en.svg?no-inline";
import yandexLogoRu from "../assets/credits/yandex-ru.svg?no-inline";
import { getCurrentLang, t } from "../i18n/index.js";
import { SVG_NS } from "./icons.js";
import type { MapProvider } from "./map-provider.js";

interface MapAttributionOptions {
    avoidPlayerControls?: boolean;
    reserveBottomSpace?: boolean;
}

/** Credits stay visible on every map, including small non-interactive previews. */
export class MapAttributionControl implements IControl {
    private root: HTMLDivElement | null = null;
    private map: MapLibreMap | null = null;
    private cleanupLayout: (() => void) | null = null;
    private layoutFrame: number | null = null;
    private bottomInset = 0;
    private reservedBottom = 0;
    private controlContainer: HTMLElement | null = null;
    private originalBottom = "";

    constructor(
        private provider: MapProvider,
        private readonly options: MapAttributionOptions = {},
    ) {}

    onAdd(map: MapLibreMap): HTMLElement {
        const root = document.createElement("div");
        root.className = "maplibregl-ctrl dc-map-attrib";
        root.setAttribute("aria-label", t("map.ctrl.attribution"));
        this.root = root;
        root.addEventListener("keydown", (event) => {
            const toggle = root.querySelector<HTMLButtonElement>('.dc-map-attrib-toggle[aria-expanded="true"]');
            if (event.key !== "Escape" || !toggle || !toggle.offsetWidth) return;
            event.stopPropagation();
            toggle.setAttribute("aria-expanded", "false");
            toggle.focus();
        });
        root.addEventListener("focusout", (event) => {
            if (!root.contains(event.relatedTarget as Node | null))
                root.querySelector(".dc-map-attrib-toggle")?.setAttribute("aria-expanded", "false");
        });
        this.map = map;
        this.bottomInset = 0;
        this.reservedBottom = 0;
        this.setProvider(this.provider);
        const resize = new ResizeObserver(this.scheduleLayout);
        resize.observe(root);
        resize.observe(map.getContainer());
        const player = map.getContainer().closest(".player-wrap");
        if (this.options.avoidPlayerControls) {
            for (const control of player?.querySelectorAll(".player-bar, .player-chart, .player-readout") ?? []) {
                resize.observe(control);
            }
        }
        const changes = new MutationObserver(this.scheduleLayout);
        if (player && this.options.avoidPlayerControls)
            changes.observe(player, { attributes: true, attributeFilter: ["class"] });
        if (this.options.avoidPlayerControls) {
            document.addEventListener("scroll", this.scheduleLayout, true);
            window.addEventListener("resize", this.scheduleLayout);
            document.addEventListener("playerexpansionchange", this.scheduleLayout);
            window.visualViewport?.addEventListener("resize", this.scheduleLayout);
            window.visualViewport?.addEventListener("scroll", this.scheduleLayout);
        }
        this.cleanupLayout = () => {
            resize.disconnect();
            changes.disconnect();
            document.removeEventListener("scroll", this.scheduleLayout, true);
            window.removeEventListener("resize", this.scheduleLayout);
            document.removeEventListener("playerexpansionchange", this.scheduleLayout);
            window.visualViewport?.removeEventListener("resize", this.scheduleLayout);
            window.visualViewport?.removeEventListener("scroll", this.scheduleLayout);
            if (this.controlContainer) this.controlContainer.style.bottom = this.originalBottom;
            this.controlContainer = null;
        };
        this.scheduleLayout();
        return root;
    }

    onRemove(): void {
        this.cleanupLayout?.();
        this.cleanupLayout = null;
        if (this.layoutFrame !== null) cancelAnimationFrame(this.layoutFrame);
        this.layoutFrame = null;
        this.map = null;
        this.root?.remove();
        this.root = null;
    }

    setProvider(provider: MapProvider): void {
        const root = this.root;
        const unchanged = this.provider === provider && root?.hasChildNodes();
        this.provider = provider;
        if (!root || unchanged) return;
        root.replaceChildren();
        root.classList.toggle("dc-map-attrib--yandex", provider === "yandex");
        root.hidden = provider === "route-only";
        if (provider === "route-only") {
            if (this.options.reserveBottomSpace) {
                this.reservedBottom = 0;
                this.map?.setPadding({ bottom: 0 });
            }
        } else if (provider === "yandex") {
            const logo = attributionLink("https://yandex.ru/maps/", "");
            logo.className = "dc-map-logo";
            logo.title = t("map.yandex.open");
            const image = document.createElement("img");
            const lang = getCurrentLang() === "ru" ? "ru" : "en";
            image.src = lang === "ru" ? yandexLogoRu : yandexLogoEn;
            image.alt = lang === "ru" ? "Яндекс" : "Yandex";
            image.width = lang === "ru" ? 88 : 91;
            image.height = 48;
            logo.append(image);
            root.append(logo);
        } else {
            const text = document.createElement("div");
            text.className = "dc-map-attrib-text";
            text.innerHTML = provider === "openfreemap" ? OPENFREEMAP_CREDITS : OSM_CREDITS;
            if (this.options.reserveBottomSpace) {
                const toggle = document.createElement("button");
                toggle.type = "button";
                toggle.className = "dc-map-attrib-toggle";
                const label = document.createElement("span");
                label.textContent = "© OpenStreetMap";
                toggle.title = t("map.ctrl.attribution");
                toggle.setAttribute("aria-label", `${label.textContent} · ${toggle.title}`);
                toggle.setAttribute("aria-expanded", "false");
                text.id = `${this.map!.getContainer().id}-credits`;
                toggle.append(label, curvedCredit(label.textContent, `${text.id}-arc`));
                toggle.setAttribute("aria-controls", text.id);
                toggle.addEventListener("click", () => {
                    toggle.setAttribute("aria-expanded", String(toggle.getAttribute("aria-expanded") !== "true"));
                });
                root.append(toggle);
            }
            root.append(text);
        }
        this.scheduleLayout();
    }

    private scheduleLayout = (): void => {
        if (this.layoutFrame !== null) return;
        this.layoutFrame = requestAnimationFrame(() => {
            this.layoutFrame = null;
            this.updateLayout();
        });
    };

    private updateLayout(): void {
        const root = this.root;
        const map = this.map;
        if (!root?.isConnected || !map || root.offsetHeight === 0) return;
        const container = map.getContainer();
        const mapBounds = container.getBoundingClientRect();
        const credits = root.getBoundingClientRect();
        if (this.options.reserveBottomSpace) {
            const bottom =
                container.dataset.radar || container.dataset.shape === "circle" ? 0 : Math.ceil(credits.height);
            if (bottom !== this.reservedBottom) {
                this.reservedBottom = bottom;
                map.setPadding({ bottom });
            }
        }
        if (!this.options.avoidPlayerControls) return;
        const viewport = window.visualViewport;
        let visibleBottom = Math.min(
            mapBounds.bottom,
            viewport ? viewport.offsetTop + viewport.height : window.innerHeight,
        );
        const viewer = container.closest(".viewer")?.getBoundingClientRect();
        if (viewer) visibleBottom = Math.min(visibleBottom, viewer.bottom);
        const controls =
            container
                .closest(".player-wrap")
                ?.querySelectorAll<HTMLElement>(".player-bar, .player-chart, .player-readout") ?? [];
        for (const control of controls) {
            if (control.offsetHeight === 0) continue;
            const bounds = control.getBoundingClientRect();
            if (
                bounds.left < credits.right &&
                bounds.right > credits.left &&
                bounds.bottom > mapBounds.top &&
                bounds.top < mapBounds.bottom &&
                Number(getComputedStyle(control).opacity) > 0
            ) {
                visibleBottom = Math.min(visibleBottom, bounds.top);
            }
            // Follow the short fullscreen chrome transition, never map rendering.
            if (control.getAnimations().some((animation) => animation.playState === "running")) this.scheduleLayout();
        }
        const maxInset = Math.max(0, credits.top + this.bottomInset - mapBounds.top);
        const inset = Math.min(maxInset, Math.max(0, mapBounds.bottom - visibleBottom));
        if (inset === this.bottomInset) return;
        this.bottomInset = inset;
        if (!this.controlContainer) {
            this.controlContainer = container.querySelector<HTMLElement>(".maplibregl-control-container");
            this.originalBottom = this.controlContainer?.style.bottom ?? "";
        }
        if (this.controlContainer) this.controlContainer.style.bottom = `${inset}px`;
    }
}

function curvedCredit(label: string, pathId: string): SVGSVGElement {
    // Crop the lower arc of the 180-unit radar so the button only covers the caption.
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "-55 49 110 39");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS(SVG_NS, "path");
    path.id = pathId;
    path.setAttribute("d", "M -84 0 A 84 84 0 0 0 84 0");
    path.setAttribute("fill", "none");
    const text = document.createElementNS(SVG_NS, "text");
    text.setAttribute("text-anchor", "middle");
    const caption = document.createElementNS(SVG_NS, "textPath");
    caption.setAttribute("href", `#${pathId}`);
    caption.setAttribute("startOffset", "50%");
    caption.textContent = label;
    text.append(caption);
    svg.append(path, text);
    return svg;
}

function attributionLink(href: string, label: string): HTMLAnchorElement {
    const link = document.createElement("a");
    link.href = href;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = label;
    return link;
}
