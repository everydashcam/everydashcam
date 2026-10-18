// llms.txt generator. Outputs dist/llms.txt - a markdown index of the site
// targeted at LLM agents / answer engines (Claude, Perplexity, and observably
// ChatGPT/SearchGPT). Google has stated they do not consume llms.txt; the
// adoption rate sits around 10% as of 2026 but the file is cheap to produce
// and Anthropic / Perplexity confirmed support, so it's net positive for
// the AI-discovery surface.
//
// Generated once at build, in English only - LLMs reliably understand English
// summaries about non-English content, and pulling the index in every locale
// would just bloat the file without changing retrieval quality. The locale
// list itself is published inside the index so an agent can navigate to the
// per-locale homepage when the user's query is in another language.
//
// Format follows https://llmstxt.org/ - H1 site title, optional blockquote
// summary, then H2 sections with markdown link lists.

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Plugin } from "vite";
import { REPO_URL, getDefaultSeoLocale, getIndexableSeoLocales } from "../src/i18n/seo-config.js";
import { getAlternativeListings } from "./alternative-pages.js";
import {
    canonicalLocaleUrl,
    currentSiteOrigin,
} from "./deployment-profile.js";
import { getFeatureListings } from "./feature-pages.js";
import { SUPPORTED_BRANDS, getAllBrandsCommaSeparated } from "./supported-brands.js";
import { VENDOR_LIST } from "./vendor-list.js";

export function llmsTxtPlugin(): Plugin {
    return {
        name: "everydashcam-llms-txt",
        apply: "build",
        closeBundle() {
            const distDir = resolve(process.cwd(), "dist");
            const defaultLocale = getDefaultSeoLocale();
            const defaultLocaleHome = canonicalLocaleUrl(defaultLocale);
            const currentOrigin = currentSiteOrigin();

            // Language count and names derived from SEO_LOCALES so the prose
            // cannot drift when a locale is added. SeoLocale carries no display
            // name, so the English names come from Intl.DisplayNames - explicit
            // "en" because this file is English-only by design.
            const indexableLocales = getIndexableSeoLocales();
            const languageNames = new Intl.DisplayNames("en", { type: "language" });
            const languageList = indexableLocales
                .map((loc) => languageNames.of(loc.hreflang) ?? loc.hreflang)
                .join(", ");

            const lines: string[] = [];

            lines.push("# everydashcam");
            lines.push("");
            lines.push(
                `> Web-based dashcam recording viewer. Plays MP4, MOV and MPEG-TS footage from ${getAllBrandsCommaSeparated()} dashcams. A synchronized GPS map and speed/G-force chart are available when the recordings contain readable GPS or motion data; support varies by model and recording. Joins the minute-long clips dashcams write into continuous trips and can save any selected range as a single merged MP4. Runs entirely in the user's browser - files are read locally via the File System Access API, nothing is uploaded.`,
            );
            lines.push("");
            lines.push(
                `everydashcam is free and ad-free: no ads, no account or sign-up, no paid tier. It is open source under the AGPL-3.0-only license - the source is at ${REPO_URL}, and prebuilt releases can be self-hosted on any static server. The interface is available in ${indexableLocales.length} languages: ${languageList}. Each language has its own URL prefix; the root URL is a language-neutral redirect that lands every visitor on their preferred locale.`,
            );
            lines.push("");

            lines.push("## Key features");
            lines.push("");
            lines.push("- Groups the minute-long clips on the SD card into trips automatically (by timestamps, filenames and GPS)");
            lines.push("- Plays a whole trip continuously across file boundaries - one timeline and scrubber per trip, not per file");
            lines.push("- Shows the GPS route on a map synchronized with the video, plus a speed / G-force chart");
            lines.push("- Auto-detects events (hard braking, impact) and marks them on the chart");
            lines.push("- Plays multi-camera recordings (front / rear / interior) side by side, in sync");
            lines.push("- Exports any selected range - including a range spanning several clips - as a single merged MP4, without re-encoding when no overlays are applied");
            lines.push("- Optional burned-in overlays on export: speed, coordinates, mini-map");
            lines.push("- Saves the GPS track as .gpx or embeds it inside the exported MP4; captures stills as PNG");
            lines.push("");

            lines.push("## Core pages");
            lines.push("");
            lines.push(`- [Main app (English)](${defaultLocaleHome}): drop the SD-card folder into the browser to watch recordings as continuous trips with a GPS map and speed chart`);
            lines.push(`- [Supported cameras](${canonicalLocaleUrl(defaultLocale, "cameras/")}): list of supported dashcam brands with per-vendor format details`);
            lines.push(`- [Alternatives](${canonicalLocaleUrl(defaultLocale, "alternatives/")}): how everydashcam compares to Dashcam Viewer, CamGeoPlayer and Telemetry Overlay`);
            lines.push(`- [Privacy policy](${canonicalLocaleUrl(defaultLocale, "privacy/")}): data handling, analytics opt-out, GDPR / CCPA stance`);
            lines.push(`- [Terms of use](${canonicalLocaleUrl(defaultLocale, "terms/")}): hosted-service terms - free, as-is / no warranty, recordings stay the user's`);
            lines.push(
                `- [Sitemap](${currentOrigin}/sitemap.xml): canonical URLs owned by this origin`,
            );
            lines.push("");

            lines.push("## Dashcam brands with dedicated pages");
            lines.push("");
            for (const vendor of VENDOR_LIST) {
                lines.push(
                    `- [${vendor.displayName}](${canonicalLocaleUrl(defaultLocale, `cameras/${vendor.slug}/`)}): supported model families, local playback and recording details for ${vendor.displayName} dashcams`,
                );
            }
            lines.push("");

            lines.push("## Tools everydashcam can replace");
            lines.push("");
            lines.push(
                `everydashcam is a free, in-browser alternative to common dashcam tools. Each page is a fair, sourced comparison (including where the other tool is still the better pick), not a takedown:`,
            );
            lines.push("");
            for (const alt of getAlternativeListings()) {
                lines.push(
                    `- [${alt.displayName} alternative](${canonicalLocaleUrl(defaultLocale, `alternatives/${alt.slug}/`)}): how everydashcam compares to ${alt.displayName} for viewing dashcam footage`,
                );
            }
            lines.push("");

            lines.push("## Guides");
            lines.push("");
            lines.push(
                "Task-focused pages for things people do with dashcam footage - free and entirely in the browser:",
            );
            lines.push("");
            for (const feature of getFeatureListings()) {
                lines.push(`- [${feature.name}](${canonicalLocaleUrl(defaultLocale, `${feature.slug}/`)})`);
            }
            lines.push("");

            lines.push("## All supported brands");
            lines.push("");
            lines.push(
                "Beyond the brands with dedicated pages above, everydashcam also plays recordings from:",
            );
            lines.push("");
            for (const brand of SUPPORTED_BRANDS) {
                if (brand.hasLandingPage) continue;
                lines.push(`- ${brand.displayName}`);
            }
            lines.push("");

            lines.push("## Available languages");
            lines.push("");
            lines.push(
                "Each language has a localized homepage. Dedicated brand pages are available in the languages most relevant to each camera community.",
            );
            lines.push("");
            for (const loc of indexableLocales) {
                const home = canonicalLocaleUrl(loc);
                lines.push(`- [${loc.hreflang}](${home}): ${loc.contentLanguage}`);
            }
            lines.push("");

            lines.push("## What everydashcam does not do");
            lines.push("");
            lines.push("- Cloud storage of recordings (everything stays on the user's device)");
            lines.push("- Account or sign-up (none required, none offered)");
            lines.push("- Native mobile app (it's a web app; works in any modern browser)");
            lines.push("- Paid features or subscriptions (entirely free)");
            lines.push("- Ads (the app shows none, in any form)");
            lines.push("- Live streaming from the dashcam (offline file playback only)");
            lines.push("");

            lines.push("## Technical context");
            lines.push("");
            lines.push("- Files are read locally with the File System Access API; decoded with WebCodecs");
            lines.push("- Map uses MapLibre with OpenFreeMap (Liberty style) base tiles");
            lines.push("- Export pipeline uses mediabunny for stream-copy MP4 muxing when re-encoding is not needed");
            lines.push("- Export overlays burn current speed, coordinates and a mini-map directly onto each frame (re-encode path)");
            lines.push("- Embedded GPS formats supported include GPMF, freeGPS, PNDM, LigoGPS, NMEA-in-MP4 and several others");
            lines.push(`- The root URL ${currentOrigin}/ is a language-neutral redirect; every locale (including English) lives under /<lang>/.`);
            lines.push("");

            const defaultLang = defaultLocale.hreflang;
            lines.push(`Default locale: ${defaultLang} at ${defaultLocaleHome}`);
            lines.push("");

            writeFileSync(resolve(distDir, "llms.txt"), lines.join("\n"));
        },
    };
}
