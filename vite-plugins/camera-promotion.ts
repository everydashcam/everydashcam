import type { Lang } from "../src/i18n/index.js";
import { getLandingBrands, type VendorSlug } from "./supported-brands.js";

// Editorial homepage selection. Publishing a camera page never grows this list.
const HOMEPAGE_CAMERAS: readonly VendorSlug[] = ["70mai", "viofo", "blackvue", "gopro", "garmin"];

export function getHomepageCameras(lang: Lang) {
    const published = getLandingBrands();
    return HOMEPAGE_CAMERAS.flatMap((slug) => {
        const brand = published.find((candidate) => candidate.slug === slug);
        return brand?.locales.includes(lang) ? [brand] : [];
    });
}
