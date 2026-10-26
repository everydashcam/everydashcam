// Landing hero-shot lightbox: the composite thumb in the hero's right column
// holds two buttons - the desktop shot (#landing-shot-open) and the phone shot
// overlapping its corner (#landing-shot-open-phone) - and each opens the
// lightbox with ITS full-size variant. A click ANYWHERE inside the open
// lightbox - the image included - or Escape closes it. A picture peek, not a
// workflow modal, so there is no card that should swallow clicks and no close
// button. Scroll-lock, Escape and focus restore come from the shared modal
// manager. DOM lives in index.html (#landing-shot-lightbox).

import { t } from "../i18n/index.js";
import { createLogger } from "../log.js";
import { activateModal, deactivateModal } from "./modal-helper.js";

const log = createLogger("landing-shot");

type ShotVariant = "desktop" | "phone";

interface LightboxShot {
    img: HTMLImageElement;
    /** Hero thumb of the same variant; its file is already downloaded or in flight. */
    thumb: HTMLImageElement | null;
    /** Absolute URL of the full-size file, taken from the lightbox markup. */
    fullSrc: string;
    hasRequestedFull: boolean;
}

let lightboxEl: HTMLElement | null = null;
let shots: Record<ShotVariant, LightboxShot> | null = null;

/**
 * On the first open of a variant, shows the hero thumb's file in the reserved
 * box at once and swaps in the full-size file only after it has loaded and
 * decoded. Without this a slow link opens the lightbox as an empty frame for
 * seconds. Both files share the ratio, so the swap does not move anything.
 * A failed full-size load keeps the thumb and is retried on the next open.
 */
function showThumbUntilFullLoads(shot: LightboxShot): void {
    if (shot.hasRequestedFull) return;
    shot.hasRequestedFull = true;
    const thumbSrc = shot.thumb?.currentSrc ?? "";
    // No hero file chosen yet, or the hero already uses the full-size file
    // (2x screens): the lightbox image loads the full-size file itself.
    if (!thumbSrc || thumbSrc === shot.fullSrc) return;
    shot.img.src = thumbSrc;
    const full = new Image();
    full.src = shot.fullSrc;
    full.decode().then(
        () => {
            shot.img.src = shot.fullSrc;
        },
        (err: unknown) => {
            shot.hasRequestedFull = false;
            log.warn("full-size landing shot failed to load", {
                src: shot.fullSrc,
                err: err instanceof Error ? err.message : String(err),
            });
        },
    );
}

function openShotLightbox(variant: ShotVariant): void {
    if (!lightboxEl || !shots) return;
    shots.desktop.img.hidden = variant !== "desktop";
    shots.phone.img.hidden = variant !== "phone";
    showThumbUntilFullLoads(shots[variant]);
    // The dialog is labelled by the variant on show: the static data-i18n-attr
    // label only covers the pre-open default (desktop).
    lightboxEl.setAttribute(
        "aria-label",
        t(variant === "desktop" ? "landing.hero.shot.alt" : "landing.hero.shot.altPhone"),
    );
    lightboxEl.hidden = false;
    lightboxEl.classList.add("is-open");
    // Nothing focusable inside - focus lands on the root (tabindex=-1),
    // which the manager's trap then pins Tab to.
    activateModal(lightboxEl, { onClose: closeShotLightbox });
}

function closeShotLightbox(): void {
    if (!lightboxEl) return;
    lightboxEl.classList.remove("is-open");
    lightboxEl.hidden = true;
    deactivateModal(lightboxEl);
}

/** Wires the hero-shot thumbs to the lightbox. Safe to call once on startup;
 *  no-op when the landing markup is absent. */
export function initLandingShot(): void {
    lightboxEl = document.getElementById("landing-shot-lightbox");
    if (!lightboxEl) return;
    const desktopImg = lightboxEl.querySelector<HTMLImageElement>(".landing-shot-lightbox-desktop");
    const phoneImg = lightboxEl.querySelector<HTMLImageElement>(".landing-shot-lightbox-phone");
    if (!desktopImg || !phoneImg) return;
    shots = {
        desktop: {
            img: desktopImg,
            thumb: document.querySelector<HTMLImageElement>(".landing-hero-shot-desktop"),
            fullSrc: desktopImg.src,
            hasRequestedFull: false,
        },
        phone: {
            img: phoneImg,
            thumb: document.querySelector<HTMLImageElement>(".landing-hero-shot-phone"),
            fullSrc: phoneImg.src,
            hasRequestedFull: false,
        },
    };
    document.getElementById("landing-shot-open")?.addEventListener("click", () => openShotLightbox("desktop"));
    document.getElementById("landing-shot-open-phone")?.addEventListener("click", () => openShotLightbox("phone"));
    lightboxEl.addEventListener("click", closeShotLightbox);
}
