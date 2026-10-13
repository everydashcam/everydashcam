// Fetches self-hosted woff2 fonts from the Google Fonts CDN into public/fonts/
// and generates src/styles/fonts.css with local @font-face rules.
//
// Run (one-off, when adding/changing fonts):
//   node scripts/fetch-fonts.mjs
//
// Why self-host:
//  - Privacy: every visitor to the Google Fonts CDN shows up in their access
//    logs. Self-hosting removes that data-leak channel.
//  - Single source of truth: after self-hosting, CSP 'self' covers fonts,
//    no need to whitelist fonts.googleapis.com / fonts.gstatic.com.
//  - Performance: a single HTTP/2 connection to our origin instead of a
//    separate handshake to the Google CDN.
//
// Variable fonts:
//  - Inter and JetBrains Mono use the variable version (axis wght).
//    One woff2 file per subset covers the requested weight range.
//  - Chakra Petch is reserved for the logo at one weight.
//
// Text font subsets are downloaded as-is. Thanks to `unicode-range` in
// @font-face, the browser picks the subset whose characters appear on the
// current page - so the user only downloads the subsets their language
// actually needs. So there's no such thing as "extra" subsets in the repo -
// they only take up space in the commit, not on the client. The Chakra Petch
// logo uses only Latin capitals; public/brand-mark.css owns its font face.

import { mkdir, readdir, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const FONTS_OUT_DIR = resolve(ROOT, "public", "fonts");
const CSS_OUT_PATH = resolve(ROOT, "src", "styles", "fonts.css");

// Range syntax wght@MIN..MAX triggers a variable response from Google Fonts;
// a single wght@N (like Chakra Petch) yields the static version.
const GOOGLE_FONTS_URL =
    "https://fonts.googleapis.com/css2?family=Chakra+Petch:wght@700&family=Inter:wght@400..900&family=JetBrains+Mono:wght@400..700&display=swap";

// A modern Chrome UA - needed so Google Fonts serves woff2 instead of legacy
// woff/eot/ttf for old browsers. Same UA for variable fonts - Google decides
// static/variable by URL syntax, not by UA.
const UA =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

async function cleanFontsDir() {
    // Delete all old woff2 files before the new fetch - otherwise, after
    // changing the set (e.g. static -> variable), orphaned files stay in the
    // repo, end up in dist/, and needlessly bloat CF's immutable cache.
    const entries = await readdir(FONTS_OUT_DIR).catch(() => []);
    for (const name of entries) {
        if (name.endsWith(".woff2")) await unlink(resolve(FONTS_OUT_DIR, name));
    }
}

async function main() {
    await mkdir(FONTS_OUT_DIR, { recursive: true });
    await cleanFontsDir();

    console.log(`fetching css from Google Fonts...`);
    const cssRes = await fetch(GOOGLE_FONTS_URL, { headers: { "User-Agent": UA } });
    if (!cssRes.ok) throw new Error(`google fonts css fetch failed: ${cssRes.status}`);
    const css = await cssRes.text();

    // Each @font-face block is preceded by a comment naming the subset:
    //   /* cyrillic */
    //   @font-face { font-family: 'Inter'; ... src: url(...) ... }
    const blockRe = /\/\*\s*([\w-]+)\s*\*\/\s*(@font-face\s*\{[\s\S]*?\})/g;
    const blocks = [...css.matchAll(blockRe)];
    if (blocks.length === 0) throw new Error("no @font-face blocks parsed - google fonts response format changed?");

    console.log(`parsed ${blocks.length} @font-face blocks`);

    const localCssBlocks = [];

    for (const [, subset, block] of blocks) {
        const family = block.match(/font-family:\s*['"]([^'"]+)['"]/)?.[1];
        const style = block.match(/font-style:\s*([^;]+);/)?.[1]?.trim();
        // Variable fonts come with font-weight as a range ("400 900"),
        // static ones as a single number ("400"). Keep as-is.
        const weight = block.match(/font-weight:\s*([^;]+);/)?.[1]?.trim();
        const url = block.match(/src:\s*url\(([^)]+)\)/)?.[1];
        const unicodeRange = block.match(/unicode-range:\s*([^;]+);/)?.[1]?.trim();

        if (!family || !weight || !url) {
            console.warn(
                `skipped block (incomplete): family=${family} weight=${weight} url=${url ? "present" : "missing"}`,
            );
            continue;
        }

        // The logo uses Latin capitals only; its shared stylesheet owns the font face.
        if (family === "Chakra Petch" && subset !== "latin") continue;

        const slug = family.toLowerCase().replace(/\s+/g, "-");
        // Variable: "400 900" -> "var" in the filename. Without this the
        // space in weight would break the name ("inter-400 900-latin.woff2")
        // and the URL would need a space in it.
        const weightTag = weight.includes(" ") ? "var" : weight;
        const filename = `${slug}-${weightTag}-${subset}.woff2`;
        const localPath = resolve(FONTS_OUT_DIR, filename);

        console.log(`  ${family} ${weight} ${subset} -> ${filename}`);
        const woffRes = await fetch(url);
        if (!woffRes.ok) throw new Error(`woff2 fetch failed for ${filename}: ${woffRes.status}`);
        const buf = Buffer.from(await woffRes.arrayBuffer());
        await writeFile(localPath, buf);

        if (family === "Chakra Petch") continue;

        localCssBlocks.push(
            `/* ${subset} */
@font-face {
    font-family: "${family}";
    font-style: ${style ?? "normal"};
    font-weight: ${weight};
    font-display: swap;
    src: url("/fonts/${filename}") format("woff2");
    unicode-range: ${unicodeRange};
}`,
        );
    }

    const header = `/* Self-hosted fonts. Generated by scripts/fetch-fonts.mjs from the Google Fonts CDN.
 * To update weights/subfamilies - edit the URL in the script and run:
 *   node scripts/fetch-fonts.mjs
 * Files live in public/fonts/, Vite copies them into dist/fonts/ as-is.
 *
 * Inter and JetBrains Mono are variable (axis wght), one file per subset
 * covers the whole font-weight range. The logo face lives in brand-mark.css.
 *
 * Do not edit this file by hand - it gets overwritten by the script.
 */
`;
    const finalCss = '@import "./font-stacks.css";\n\n' + header + localCssBlocks.join("\n\n") + "\n";
    await writeFile(CSS_OUT_PATH, finalCss);
    console.log(`\nwrote ${CSS_OUT_PATH} (${localCssBlocks.length} @font-face rules)`);
    console.log(`woff2 files in ${FONTS_OUT_DIR}`);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
