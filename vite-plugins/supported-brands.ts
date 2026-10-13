import type { Lang } from "../src/i18n/index.js";

// SEO-facing list of supported dashcam brands. Pure SEO surface - this is
// what we want crawlers, AI agents, and SERP rich snippets to see when they
// ask "which dashcams does everydashcam support?".
//
// Why a separate list from the parser registry:
//  - Parser code (src/parsers/) is the technical reality - which byte formats
//    and filename heuristics actually work. That list grows by extraction
//    technique, not by camera brand.
//  - This list is the public-facing brand inventory. It's the answer to "is
//    my dashcam supported?" - which is a different question from "which
//    primitives do we ship". Branding, ordering and presence here is a
//    marketing/SEO decision, not a code decision.
//  - Multiple brands can share a parser (Viofo / Vantrue / Akaso all on
//    Novatek), and one brand can be supported across several parsers
//    (BlackVue X-series embedded vs legacy .gps sidecar). The 1-to-N mapping
//    between brands and parsers makes auto-deriving this list error-prone.
//
// Used by:
//  - vite-plugins/seo-prerender.ts: WebApplication JSON-LD featureList (rich
//    snippet) and localized camera links.
//  - vite-plugins/llms-txt.ts: opening summary of dist/llms.txt.
//  - vite-plugins/vendor-pages.ts: subset with hasLandingPage=true gets the
//    dedicated /cameras/<slug>/ pages (high-volume search terms).
//  - src/ui/brand-mark.ts: the hover animation cycles the full inventory.
//
// Adding a brand: append below. Set hasLandingPage=true ONLY if there's a
// matching reviewed page content ready to render. Catalog order is stable;
// homepage promotion is selected separately in camera-promotion.ts.

// Discriminated union: when hasLandingPage=true the slug is mandatory, when
// false it must NOT be set. The old shape ({ slug?, hasLandingPage: boolean })
// allowed { hasLandingPage: true } without a slug to compile - that entry then
// got silently filtered out by getLandingBrands(), and no landing page was
// rendered for it. The union below makes the invariant typechecked.
export type RecordingCaveat = "optionalGps" | "exportedRecording";

export type SupportedBrand = {
    displayName: string;
    // Real-recording evidence: docs/gps-format-coverage.md. Not a promise for
    // every model or firmware, including within the same product family.
    gpsSamples?: readonly string[];
    recordingCaveat?: RecordingCaveat;
    videoSamples?: readonly string[];
} & ({ hasLandingPage: true; slug: VendorSlug; locales: readonly Lang[] } | { hasLandingPage: false; slug?: never });

// VendorSlug enumerates the brands that have a dedicated landing page. Used
// as a type narrowing in vendor-pages.ts where the VendorContent records are
// keyed by slug.
export type VendorSlug =
    | "70mai"
    | "viofo"
    | "blackvue"
    | "gopro"
    | "garmin"
    | "vantrue"
    | "thinkware"
    | "nextbase"
    | "redtiger"
    | "navitel"
    | "mio"
    | "navman"
    | "fitcamx"
    | "avylet"
    | "izeeker"
    | "compartir"
    | "vueroid"
    | "botslab"
    | "neoline"
    | "escort"
    | "carcam"
    | "beferich"
    | "datakam"
    | "2e-drive"
    | "sony"
    | "hp"
    | "silverstone-f1"
    | "roadgid"
    | "ibox"
    | "ddpai"
    | "blackview"
    | "innovv"
    | "xega"
    | "aspiring"
    | "jooyfact"
    | "rexing";

// A new product locale must not silently multiply every vendor page. The
// rollout list is explicit per brand so only useful, reviewed translations
// enter the sitemap and hreflang graph.
const ALL_VENDOR_LOCALES = [
    "en",
    "ru",
    "de",
    "es",
    "fr",
    "pl",
    "pt",
    "zh",
    "ja",
    "ko",
] as const satisfies readonly Lang[];
const ALL_EXCEPT_PT = ["en", "ru", "de", "es", "fr", "pl", "zh", "ja", "ko"] as const satisfies readonly Lang[];

export const SUPPORTED_BRANDS: ReadonlyArray<SupportedBrand> = [
    {
        displayName: "70mai",
        slug: "70mai",
        hasLandingPage: true,
        locales: ALL_VENDOR_LOCALES,
        gpsSamples: ["A810", "A510", "M500", "X800", "Pro (D02 / D03)"],
    },
    {
        displayName: "Viofo",
        slug: "viofo",
        hasLandingPage: true,
        locales: ALL_VENDOR_LOCALES,
        gpsSamples: ["A119", "A119 V3", "A119 Mini 2", "A119M Pro", "A329", "A329S", "T130"],
    },
    {
        displayName: "BlackVue",
        slug: "blackvue",
        hasLandingPage: true,
        locales: ALL_EXCEPT_PT,
        gpsSamples: ["DR550GW-2CH"],
        videoSamples: ["DR900X Plus"],
    },
    {
        displayName: "GoPro",
        slug: "gopro",
        hasLandingPage: true,
        locales: ALL_VENDOR_LOCALES,
        gpsSamples: ["HERO5", "HERO6", "MAX"],
        videoSamples: ["HERO7", "HERO8"],
    },
    {
        displayName: "Garmin",
        slug: "garmin",
        hasLandingPage: true,
        locales: ["en", "ru", "de", "es", "fr", "pl", "pt", "zh", "ja"],
    },
    { displayName: "Vantrue", slug: "vantrue", hasLandingPage: true, locales: ALL_EXCEPT_PT, gpsSamples: ["N2X"] },
    {
        displayName: "Thinkware",
        slug: "thinkware",
        hasLandingPage: true,
        locales: ALL_EXCEPT_PT,
        gpsSamples: ["F200 PRO"],
    },
    {
        displayName: "Nextbase",
        slug: "nextbase",
        hasLandingPage: true,
        locales: ["en", "ru", "de", "fr", "pl"],
        gpsSamples: ["322GW"],
    },
    {
        displayName: "REDTIGER",
        slug: "redtiger",
        hasLandingPage: true,
        locales: ["en", "ru", "de", "es"],
        gpsSamples: ["F7NP-4K", "F17"],
    },
    {
        displayName: "NAVITEL",
        slug: "navitel",
        hasLandingPage: true,
        locales: ["en", "ru", "pl"],
        gpsSamples: ["R600 GPS"],
    },
    {
        displayName: "Mio MiVue",
        slug: "mio",
        hasLandingPage: true,
        locales: ["en", "ru", "de", "fr", "pl"],
        gpsSamples: ["955WD Pro"],
    },
    {
        displayName: "Navman MiVue",
        slug: "navman",
        hasLandingPage: true,
        locales: ["en", "ru"],
        gpsSamples: ["150 Safety"],
    },
    {
        displayName: "FITCAMX",
        slug: "fitcamx",
        hasLandingPage: true,
        locales: ["en", "ru", "de", "pl"],
    },
    {
        displayName: "Avylet",
        slug: "avylet",
        hasLandingPage: true,
        locales: ["en", "ru"],
        gpsSamples: ["A1"],
        recordingCaveat: "optionalGps",
    },
    { displayName: "iZEEKER", slug: "izeeker", hasLandingPage: true, locales: ["en", "ru"], gpsSamples: ["iD300"] },
    { displayName: "Compartir", slug: "compartir", hasLandingPage: true, locales: ["en", "ru"], gpsSamples: [] },
    {
        displayName: "Vueroid",
        slug: "vueroid",
        hasLandingPage: true,
        locales: ["en", "ru"],
        gpsSamples: ["S1 4K Infinite"],
    },
    { displayName: "Botslab", slug: "botslab", hasLandingPage: true, locales: ["en", "ru"], gpsSamples: ["G300H Pro"] },
    { displayName: "Neoline", slug: "neoline", hasLandingPage: true, locales: ["en", "ru"], gpsSamples: ["Spectrum"] },
    { displayName: "Juscar", hasLandingPage: false, gpsSamples: [] },
    { displayName: "Escort", slug: "escort", hasLandingPage: true, locales: ["en", "ru"], gpsSamples: ["M2"] },
    {
        displayName: "CARCAM",
        slug: "carcam",
        hasLandingPage: true,
        locales: ["en", "ru"],
        gpsSamples: ["CC-365 (4CH)"],
    },
    { displayName: "Beferich", slug: "beferich", hasLandingPage: true, locales: ["en", "ru"], gpsSamples: ["J18"] },
    {
        displayName: "DATAKAM",
        slug: "datakam",
        hasLandingPage: true,
        locales: ["en", "ru"],
        gpsSamples: ["G5P"],
        recordingCaveat: "exportedRecording",
    },
    {
        displayName: "2E Drive",
        slug: "2e-drive",
        hasLandingPage: true,
        locales: ["en", "ru"],
        gpsSamples: ["730 Magnet"],
    },
    {
        displayName: "ASPIRING",
        slug: "aspiring",
        hasLandingPage: true,
        locales: ["en", "ru"],
        gpsSamples: ["Expert 9"],
    },
    { displayName: "Sony", slug: "sony", hasLandingPage: true, locales: ["en", "ru"], gpsSamples: ["HDR-AS30V"] },
    {
        displayName: "JOOYFACT",
        slug: "jooyfact",
        hasLandingPage: true,
        locales: ["en", "ru"],
        videoSamples: ["A1"],
    },
    { displayName: "HP", slug: "hp", hasLandingPage: true, locales: ["en", "ru"], videoSamples: ["f969x"] },
    {
        displayName: "SilverStone F1",
        slug: "silverstone-f1",
        hasLandingPage: true,
        locales: ["en", "ru"],
        gpsSamples: ["A80-GPS Sky"],
    },
    { displayName: "Roadgid", slug: "roadgid", hasLandingPage: true, locales: ["en", "ru"], gpsSamples: ["Tube"] },
    {
        displayName: "iBOX",
        slug: "ibox",
        hasLandingPage: true,
        locales: ["en", "ru"],
        gpsSamples: ["iCON", "RoadScan 2K WiFi GPS Dual"],
    },
    {
        displayName: "DDPAI",
        slug: "ddpai",
        hasLandingPage: true,
        locales: ["en", "ru"],
        videoSamples: ["MOLA N3", "Z50"],
        gpsSamples: ["Z60 Pro"],
    },
    {
        displayName: "Blackview",
        slug: "blackview",
        hasLandingPage: true,
        locales: ["en", "ru"],
        gpsSamples: ["X5S PRO"],
    },
    {
        displayName: "INNOVV",
        slug: "innovv",
        hasLandingPage: true,
        locales: ["en", "ru"],
        gpsSamples: ["N2", "K3"],
    },
    {
        displayName: "XEGA",
        slug: "xega",
        hasLandingPage: true,
        locales: ["en", "ru"],
        gpsSamples: ["XG-37-AU4G"],
    },
    {
        displayName: "Rexing",
        slug: "rexing",
        hasLandingPage: true,
        locales: ["en", "ru"],
        videoSamples: ["SC4KS"],
    },
    { displayName: "E-ACE", hasLandingPage: false, videoSamples: [] },
    { displayName: "Fujida", hasLandingPage: false, videoSamples: ["Karma Pro Max"] },
    { displayName: "GKU", hasLandingPage: false, videoSamples: ["D900"] },
];

// Brands with a dedicated landing page.
// The discriminated union on SupportedBrand guarantees `slug` is present in
// the true branch.
export function getLandingBrands(): ReadonlyArray<SupportedBrand & { hasLandingPage: true }> {
    return SUPPORTED_BRANDS.filter((b): b is SupportedBrand & { hasLandingPage: true } => b.hasLandingPage);
}

// Comma-separated list of all brand display names. Used in JSON-LD
// featureList - "X, Y, Z vendor support" - so Google's rich snippet for
// everydashcam lists every brand the SEO surface promises to support.
export function getAllBrandsCommaSeparated(): string {
    return SUPPORTED_BRANDS.map((b) => b.displayName).join(", ");
}
