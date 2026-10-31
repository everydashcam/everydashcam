// Generates the PWA install-card images for manifest.webmanifest.
// Manual run (when the brand mark / wordmark changes):
//   node scripts/generate-pwa-install-card.mjs
//
// Why these images exist:
//   Chromium's richer install dialog (Chrome 108+ desktop, 94+ Android) shows
//   the manifest "screenshots" entries. We deliberately do NOT feed it a real
//   app screenshot: in the dialog it gets cropped to a "fragment of the page",
//   which looks unpolished. Instead each "screenshot" slot carries a clean
//   branded logo card (drum icon + EVERY DASHCAM wordmark). Chromium validates
//   screenshots only by geometry (320-3840px per side, max/min <= 2.3, identical
//   aspect ratio per form_factor, JPEG/PNG) - never by content - so a logo card
//   is accepted and rendered just like a screenshot would be.
//
//   wide  -> form_factor:"wide"   -> shown on desktop
//   narrow-> form_factor:"narrow" -> shown on mobile
//
// Implementation:
//   The card is a self-contained HTML document (inline SVG mark + the Chakra
//   Petch wordmark font embedded as a base64 data: URI, so there are no external
//   subresources). Headless Chrome (via scripts/_headless-chrome.mjs) renders it
//   at each form factor and writes the PNG straight to
//   public/. No vite preview / dist needed - the card does not depend on the
//   built app.

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderHtmlToPng } from "./_headless-chrome.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

// Wordmark font, embedded so the card needs no network/file subresources.
// The lockup uses only Latin capitals.
const FONT_PATH = resolve(ROOT, "public/fonts/chakra-petch-700-latin.woff2");
if (!existsSync(FONT_PATH)) {
    console.error(`font not found: ${FONT_PATH}`);
    process.exit(1);
}
const FONT_B64 = readFileSync(FONT_PATH).toString("base64");

const BRAND_CSS = readFileSync(resolve(ROOT, "public/brand-mark.css"), "utf8").replace(
    "/fonts/chakra-petch-700-latin.woff2",
    `data:font/woff2;base64,${FONT_B64}`,
);
const BRAND_MARK_HTML = `<span class="edc-mark" role="img" aria-label="everydashcam"><span class="edc-mark__drums" aria-hidden="true"><span class="edc-mark__drum"><span class="edc-mark__column"><span class="edc-mark__letter">E</span></span></span><span class="edc-mark__drum"><span class="edc-mark__column"><span class="edc-mark__letter">V</span></span></span><span class="edc-mark__drum"><span class="edc-mark__column"><span class="edc-mark__letter">E</span></span></span><span class="edc-mark__drum"><span class="edc-mark__column"><span class="edc-mark__letter">R</span></span></span><span class="edc-mark__drum"><span class="edc-mark__column"><span class="edc-mark__letter">Y</span></span></span></span><span class="edc-mark__word" aria-hidden="true">DASHCAM</span></span>`;
const BRAND_ICON_SVG = readFileSync(resolve(ROOT, "public/assets/mark.svg"), "utf8");

// Card output set. Aspect ratios stay well inside Chromium's <= 2.3 bound
// (1280x800 = 1.60, 824x1464 = 1.78) and within 320-3840px per side. The card
// layout is vmin-based, so the same HTML composes correctly at both sizes.
//
const CARDS = [
    { out: "public/pwa-install-card-wide.png", width: 1280, height: 800 },
    { out: "public/pwa-install-card-narrow.png", width: 824, height: 1464 },
];

// vmin sizing keeps the icon and lockup inside a generous safe zone at both
// form factors, including when the install dialog crops the card.
const cardHtml = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<style>
  ${BRAND_CSS}
  * { box-sizing: border-box; }
  html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; }
  .card {
    width: 100%; height: 100%;
    display: flex; flex-direction: column;
    align-items: center; justify-content: center;
    gap: 6vmin;
    background:
      radial-gradient(58vmin 58vmin at 50% 43%, rgba(255,144,0,0.13), rgba(255,144,0,0) 70%),
      #0a0a0a;
    font-family: "Chakra Petch", system-ui, sans-serif;
  }
  .tile {
    width: 34vmin; height: 34vmin;
    filter: drop-shadow(0 3vmin 4.5vmin rgba(0,0,0,0.55));
  }
  .tile svg { display: block; width: 100%; height: 100%; }
  .wordmark .edc-mark {
    --edc-drum-height: 7.2vmin;
    --edc-drum-width: 6.3vmin;
    --edc-letter-size: 5.6vmin;
    --edc-word-size: 5.6vmin;
    --edc-drum-gap: 0.45vmin;
    --edc-word-gap: 2.16vmin;
    --edc-drum-bg: #2a2621;
    --edc-word-color: #f4f1ea;
  }
</style>
</head>
<body>
  <div class="card">
    <div class="tile">${BRAND_ICON_SVG}</div>
    <div class="wordmark">${BRAND_MARK_HTML}</div>
  </div>
</body>
</html>
`;

for (const card of CARDS) {
    const outPath = resolve(ROOT, card.out);
    console.log(`rendering ${card.width}x${card.height} -> ${outPath}`);
    await renderHtmlToPng({
        html: cardHtml,
        width: card.width,
        height: card.height,
        outPath,
    });
}
console.log("done");
