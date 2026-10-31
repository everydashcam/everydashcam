#!/usr/bin/env node
// Re-runnable generator for the README artwork: two app screenshots plus the
// composite hero image that heads the README.
//
// WHAT IT DOES (end to end, self-contained):
//   1. Synthesizes a throwaway 70mai multichannel fixture in os.tmpdir():
//      Front + Back MP4 clips (ffmpeg still-loop over the committed source
//      frames) plus a shared $V02 GPSData000001.txt describing a synthetic
//      winding forest road.
//      Three time-separated trips on one day exercise trip splitting, channel
//      pairing and the speed-colored track end to end; each trip has its own
//      front scene so the sidebar card previews visibly differ.
//   2. Starts Vite preview against the EXISTING dist/ (never rebuilds) and
//      drives it with headless Chromium (Playwright), pre-seeding localStorage
//      exactly like tests/e2e/_fixtures.ts so no onboarding overlay is in
//      frame, EN locale, dark theme.
//   3. Writes to docs/screenshots/:
//        app-desktop.png       - >=3 trips, top trip selected, split front/rear,
//                                map expanded with the speed-colored route. Dark.
//        app-mobile-player.png - a trip paused at the deer-braking moment. Light
//                                theme, so the hero shows both themes at once.
//        readme-hero.webp      - the two shots above composed on a brand-gradient
//                                backdrop; the only image README.md embeds.
//   4. Writes to public/landing/ (shipped with the site, embedded by the
//      .landing-hero-shot composite in index.html - desktop thumb + phone,
//      desktop also feeds the lightbox):
//        app-desktop-{1240,2480}.webp - the desktop shot at 1x/2x display width
//        app-phone-{300,600}.webp     - the mobile shot at 1x/2x display width
//      WebP is encoded by the same headless Chromium (canvas.toDataURL): the
//      homebrew ffmpeg build ships without libwebp, and a PNG of this size is
//      too heavy to ship on the landing.
//
// WHEN TO RE-RUN: whenever the UI those shots depend on changes (trip list /
// player / split view / map) or the brand palette changes.
//
// PRECONDITIONS (exit non-zero with a message if missing):
//   - dist/en/index.html          (build the app first: `npm run build` -
//     this script never rebuilds)
//   - docs/screenshots/frames/    (the committed source frames - the canonical,
//     publishable scenes; swap a scene by replacing a file here)
//   - ffmpeg on PATH (or at /opt/homebrew/bin/ffmpeg)
//
// MANUAL RUN:
//   node scripts/generate-readme-screenshots.mjs
//   HEADFUL=1 node scripts/generate-readme-screenshots.mjs   # visible browser,
//     use if headless SwiftShader renders the map blank on your machine.
//
// Standalone by design (see the "Optional dedup" note in the build spec): the
// only piece shared with scripts/gen-70mai-mc-fixture.mjs is the $V02 row shape
// and the +8h firmware bias; everything else (still-loop encode vs testsrc2,
// clip/trip layout, synthetic geo track) differs, so extracting a shared lib
// would force rewiring the committed fixture generator for negligible gain.
//
// CLI diagnostics go through console.* - this is a scripts/ CLI, not src/ (the
// no-console rule is a src/ rule; sibling scripts print the same way).

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { preview } from "vite";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");

// Committed source frames (see PRECONDITIONS above).
const FRAMES_DIR = join(REPO_ROOT, "docs/screenshots/frames");
// One rear scene is enough: the rear camera is only visible on the selected
// trip's split view; card previews always show the front channel.
const REAR_FRAME = join(FRAMES_DIR, "rear_sample.jpg");
const DIST_INDEX = join(REPO_ROOT, "dist/en/index.html");
const OUT_DIR = join(REPO_ROOT, "docs/screenshots");
// Landing embeds the same two shots as the hero composite (.landing-hero-shot
// in index.html: desktop thumb + phone overlapping its corner; the desktop
// also feeds the full-size lightbox) - shipped from public/, downscaled +
// WebP-encoded below. The filenames carry the pixel width; keep them in sync
// with the srcset there.
const LANDING_OUT_DIR = join(REPO_ROOT, "public/landing");
// Per-variant encode quality: the 2x widths serve displays that render them at
// >= 2 device pixels per CSS pixel, where WebP artifacts sit below visibility -
// so they take a harder quality knob than the 1x files for roughly half the
// bytes. The 2x file is what a retina tablet downloads on the landing critical
// path (hero srcset), so its size is the one that matters on slow networks.
const LANDING_VARIANTS = [
    {
        shot: "desktop",
        base: "app-desktop",
        widths: [
            { width: 1240, quality: 0.82 },
            { width: 2480, quality: 0.6 },
        ],
    },
    {
        shot: "mobile",
        base: "app-phone",
        widths: [
            { width: 300, quality: 0.82 },
            { width: 600, quality: 0.6 },
        ],
    },
];

// A fixed local port; --strictPort makes a clash fail loudly instead of drifting.
const PORT = 4180;
const BASE_URL = `http://localhost:${PORT}`;

// ffmpeg: prefer the homebrew path the mission guarantees, fall back to PATH.
const FFMPEG = existsSync("/opt/homebrew/bin/ffmpeg") ? "/opt/homebrew/bin/ffmpeg" : "ffmpeg";

// Headless by default; HEADFUL=1 forces a visible window (fallback if headless
// SwiftShader renders MapLibre tiles blank).
const HEADFUL = process.env.HEADFUL === "1";

// --- fixture layout constants ---------------------------------------------

const CLIP_SEC = 45; // per-clip footage length; 45s makes trip cards read as real
// multi-minute drives ("18:05 -> 18:08"), not "18:05 -> 18:05"
// Every scene is a still. One frame per second preserves seeking and the full
// timeline without encoding hundreds of identical frames per clip.
const FPS = 1;
// The phone's video occupies about 880 physical pixels in the 3x screenshot.
// Other trips only appear in sidebar previews, which decode to 320px wide.
const HERO_VIDEO_WIDTH = 960;
const PREVIEW_VIDEO_WIDTH = 320;

// 70mai $V02 firmware writes field[0] 8h behind UTC; the parser adds +8h back
// (src/parsers/primitives/csv-70mai.ts GPS_TIMESTAMP_FIRMWARE_OFFSET_SEC). So the
// log must be written 8h BEHIND the intended UTC for the parser to land it right.
const FIRMWARE_BIAS_SEC = 8 * 3600;

// Three trips on ONE UTC day, hours apart (>> the 30s trip-gap threshold in
// src/trips.ts) so they split into three trips; clips inside a trip are
// back-to-back (next start = prev start + CLIP_SEC) so they stitch into one.
// The top (newest) trip C has 4 clips/camera for a non-trivial stitched timeline
// and a longer track. startDistM offsets each trip onto its own stretch of the
// forest polyline so the three routes are visibly distinct.
// startDistM must leave room for the trip's travelled distance on the polyline
// (pointAtDistance clamps at the end - a clamped tail piles records on one spot).
// The newest trip starts at 0 and covers the whole track; trips overlapping the
// same road is realistic (the same stretch driven several times a day).
// frontFrame: the sidebar renders trips newest-first and each card's preview is
// the first frame of its front clip (src/ui/trip-preview.ts) - a distinct scene
// per trip keeps the trip list from looking like one copy-pasted recording.
// 18:05 is the top card AND the selected trip (pairs with rear_sample.png).
const TRIPS = [
    { hhmmss: "081500", clips: 2, startDistM: 200, frontFrame: "cover_3.jpg" },
    { hhmmss: "124000", clips: 2, startDistM: 1200, frontFrame: "cover_2.jpg" },
    { hhmmss: "180500", clips: 4, startDistM: 0, frontFrame: "front_sample.jpg" },
];
const HERO_TRIP_INDEX = TRIPS.length - 1;
// The committed front frame catches a deer in the road. Park both screenshot
// playheads at the instant the synthetic car finishes its emergency stop so
// the frame, readout, graph and map all tell the same story.
const HERO_BRAKE_SEC = 72;
const HERO_BRAKE_START_SEC = 68;
const HERO_ACCEL_START_SEC = 74;
const HERO_ACCEL_END_SEC = 88;

// Winding Black-Forest stretch (Schwarzwaldhochstraße / B500 near Mummelsee),
// hand-traced N->S so vector tiles render green/scenic. Purely synthetic -
// nothing here derives from a real recording. [lat, lon].
const TRACK_ANCHORS = [
    [48.594, 8.205],
    [48.5928, 8.2065],
    [48.5911, 8.2071],
    [48.5895, 8.2068],
    [48.5878, 8.2056],
    [48.5869, 8.2059],
    [48.5858, 8.2077],
    [48.5839, 8.2092],
    [48.5821, 8.209],
    [48.5807, 8.2078],
    [48.579, 8.2075],
    [48.5776, 8.2086],
    [48.5765, 8.2103],
    [48.5747, 8.2111],
    [48.5733, 8.2104],
    [48.5719, 8.209],
    [48.5702, 8.2087],
    [48.5687, 8.21],
    [48.5672, 8.2121],
    [48.5651, 8.213],
    [48.5634, 8.2124],
    [48.5619, 8.2106],
    [48.5603, 8.2101],
    [48.5588, 8.211],
    [48.5574, 8.2127],
    [48.5553, 8.2134],
];

// Cruise around 90 km/h with small, non-periodic-looking corrections. The hero
// trip then has one deliberate story beat: a hard stop for the deer followed by
// a measured acceleration. This drives the chart, telemetry, event strip and
// distance along the route together instead of painting repeated sine waves.
const CRUISE_SPEED_MS = 25;

// --- geo helpers -----------------------------------------------------------

const DEG = Math.PI / 180;
const METERS_PER_DEG_LAT = 111320;

// Equirectangular metric distance between two [lat, lon] points - fine at the
// ~km scale and speeds here; avoids pulling in a geo dependency.
function metersBetween(a, b) {
    const midLat = ((a[0] + b[0]) / 2) * DEG;
    const dx = (b[1] - a[1]) * Math.cos(midLat) * METERS_PER_DEG_LAT;
    const dy = (b[0] - a[0]) * METERS_PER_DEG_LAT;
    return Math.hypot(dx, dy);
}

// Great-circle initial bearing a->b in degrees [0, 360).
function bearingDeg(a, b) {
    const lat1 = a[0] * DEG;
    const lat2 = b[0] * DEG;
    const dLon = (b[1] - a[1]) * DEG;
    const y = Math.sin(dLon) * Math.cos(lat2);
    const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
    return (Math.atan2(y, x) / DEG + 360) % 360;
}

// Cumulative metric length of the anchor polyline, for distance->point lookup.
const CUM_DIST = (() => {
    const cum = [0];
    for (let i = 1; i < TRACK_ANCHORS.length; i++) {
        cum.push(cum[i - 1] + metersBetween(TRACK_ANCHORS[i - 1], TRACK_ANCHORS[i]));
    }
    return cum;
})();
const TRACK_LENGTH_M = CUM_DIST[CUM_DIST.length - 1];

// Point [lat, lon] at metric distance d along the polyline (clamped to its ends).
function pointAtDistance(d) {
    const dist = Math.max(0, Math.min(d, TRACK_LENGTH_M));
    let seg = 1;
    while (seg < CUM_DIST.length - 1 && CUM_DIST[seg] < dist) seg++;
    const segStart = CUM_DIST[seg - 1];
    const segLen = CUM_DIST[seg] - segStart || 1;
    const frac = (dist - segStart) / segLen;
    const a = TRACK_ANCHORS[seg - 1];
    const b = TRACK_ANCHORS[seg];
    return [a[0] + (b[0] - a[0]) * frac, a[1] + (b[1] - a[1]) * frac];
}

function smoothstep(value) {
    const t = Math.max(0, Math.min(1, value));
    return t * t * (3 - 2 * t);
}

function cruiseSpeedAt(s, tripIdx) {
    const phase = tripIdx * 7.3;
    return (
        CRUISE_SPEED_MS +
        0.52 * Math.sin((s + phase) / 10.7) +
        0.27 * Math.sin((s + phase * 0.4) / 3.9) +
        0.18 * Math.cos((s + phase) / 17.3)
    );
}

// Instantaneous speed (m/s) at footage second s.
function speedAt(s, tripIdx) {
    const cruise = cruiseSpeedAt(s, tripIdx);
    if (tripIdx !== HERO_TRIP_INDEX || s < HERO_BRAKE_START_SEC) return cruise;
    if (s <= HERO_BRAKE_SEC) {
        const braking = smoothstep((s - HERO_BRAKE_START_SEC) / (HERO_BRAKE_SEC - HERO_BRAKE_START_SEC));
        return cruise * (1 - braking);
    }
    if (s < HERO_ACCEL_START_SEC) return 0;
    if (s < HERO_ACCEL_END_SEC) {
        const accelerating = smoothstep((s - HERO_ACCEL_START_SEC) / (HERO_ACCEL_END_SEC - HERO_ACCEL_START_SEC));
        return cruise * accelerating;
    }
    return cruise;
}

// Distance travelled from the trip's start after `s` whole seconds (sum of the
// per-second speed) - integrates the speed profile so faster seconds cover more
// ground. Returns metric distance to add to the trip's startDistM.
function travelledBy(s, tripIdx) {
    let d = 0;
    for (let k = 0; k < s; k++) d += speedAt(k, tripIdx);
    return d;
}

// --- fixture builders ------------------------------------------------------

// UTC calendar day (YYYYMMDD) the fixture clips are stamped with. Must stay in
// the PAST at any hour the generator runs: the trips run to 18:05, and a trip
// ahead of "now" lands in the sidebar's "In the future" bucket. The Playwright
// contexts pin timezoneId "UTC", so the displayed trip time equals the filename
// wall-clock and the day never rolls.
function fixtureDayYYYYMMDD() {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    return yesterday.toISOString().slice(0, 10).replaceAll("-", "");
}

// Wall-clock (YYYYMMDD + HHMMSS) treated as if it were UTC, in unix seconds - the
// 70mai firmware carries no TZ and our parser reconciles it, so a fixed pseudo-UTC
// interpretation keeps the fixture predictable (mirrors gen-70mai-mc-fixture.mjs).
function pseudoUnix(yyyymmdd, hhmmss) {
    const iso =
        `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}` +
        `T${hhmmss.slice(0, 2)}:${hhmmss.slice(2, 4)}:${hhmmss.slice(4, 6)}Z`;
    return Date.parse(iso) / 1000;
}

// Splits a pseudo-unix back into filename fields (UTC), so a clip whose start is
// tripStart + c*CLIP_SEC gets a correct NO{date}-{time}-... name.
function fieldsFromPseudoUnix(unix) {
    const d = new Date(unix * 1000);
    const p = (n, w = 2) => String(n).padStart(w, "0");
    const date = `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`;
    const time = `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
    return { date, time };
}

// Expands TRIPS into a flat clip list with 70mai names + a global counter (same
// counter across the F/B of one clip = the frame-pairing key; increases globally
// in chronological order). Each clip also carries its trip index and the trip's
// startDistM for the track walk.
function planClips(baseDay) {
    const clips = [];
    let counter = 0;
    for (let tripIdx = 0; tripIdx < TRIPS.length; tripIdx++) {
        const trip = TRIPS[tripIdx];
        const tripStart = pseudoUnix(baseDay, trip.hhmmss);
        for (let c = 0; c < trip.clips; c++) {
            counter++;
            const clipStart = tripStart + c * CLIP_SEC;
            const { date, time } = fieldsFromPseudoUnix(clipStart);
            const stem = `NO${date}-${time}-${String(counter).padStart(6, "0")}`;
            clips.push({
                tripIdx,
                clipInTrip: c,
                startDistM: trip.startDistM,
                clipStartPseudoUnix: clipStart,
                frontFrame: trip.frontFrame,
                frontName: `${stem}F.MP4`,
                backName: `${stem}B.MP4`,
            });
        }
    }
    return clips;
}

// Builds the shared $V02 log. One row per (clip, second) at 1 Hz, t=0..CLIP_SEC
// inclusive - the boundary point t=CLIP_SEC coincides with the next clip's t=0
// (same timestamp + position) and dedups downstream, so the track reaches the end
// of the trip. field[9] = the clip's FRONT name for BOTH channels' rows: the log
// only ever names the front file; the parser clones records onto the back camera.
function buildGpsLog(clips) {
    const lines = ["$V02"];
    for (const clip of clips) {
        for (let t = 0; t <= CLIP_SEC; t++) {
            // Footage second within the clip's trip drives position + speed so a
            // trip is one continuous sub-route on the forest polyline.
            const tripSecond = clip.clipInTrip * CLIP_SEC + t;
            const distAlong = clip.startDistM + travelledBy(tripSecond, clip.tripIdx);
            const here = pointAtDistance(distAlong);
            const speed = speedAt(tripSecond, clip.tripIdx); // m/s
            // A full stop produces two identical integrated positions. Keep the
            // last frame aligned with the road by sampling its tangent at least
            // one metre ahead instead of deriving a meaningless 0° bearing.
            const next = pointAtDistance(distAlong + Math.max(speed, 1));
            const bearing = bearingDeg(here, next);
            // Write raw field[0] 8h behind the intended UTC (parser adds +8h back).
            const rawTs = clip.clipStartPseudoUnix - FIRMWARE_BIAS_SEC + t;
            const ax = 0;
            const ay = 100; // Y-up gravity (parser subtracts 1g)
            const az = 0;
            // 13 fields: ts, validity, lat, lon, bearing(x100), speed(cm/s),
            // ax, ay, az, mp4Filename, _, _, _.
            lines.push(
                [
                    rawTs,
                    "A",
                    here[0].toFixed(6),
                    here[1].toFixed(6),
                    Math.round(bearing * 100),
                    Math.round(speed * 100),
                    ax,
                    ay,
                    az,
                    clip.frontName,
                    0,
                    0,
                    0,
                ].join(","),
            );
        }
    }
    return `${lines.join("\n")}\n`;
}

// Decode, scale and convert the JPEG once, then loop the prepared frame in
// memory. An image2 input loop would repeat that work for every video frame.
function encodeClip(frame, out, width) {
    const args = [
        "-y",
        "-framerate",
        String(FPS),
        "-i",
        frame,
        "-t",
        String(CLIP_SEC),
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "28",
        "-pix_fmt",
        "yuv420p",
        "-vf",
        `scale=${width}:-2,format=yuv420p,loop=loop=-1:size=1:start=0`,
        "-an",
        "-movflags",
        "+faststart",
        out,
    ];
    const r = spawnSync(FFMPEG, args, { stdio: "ignore" });
    if (r.status !== 0) throw new Error(`ffmpeg failed for ${out}`);
}

// Materializes the whole fixture tree under the given (already created) temp
// root. The caller owns the dir so its finally-cleanup covers a mid-encode
// ffmpeg failure too - no throwaway clips left behind in os.tmpdir().
function buildFixture(root, baseDay) {
    const startedAt = performance.now();
    const frontDir = join(root, "Normal", "Front");
    const backDir = join(root, "Normal", "Back");
    mkdirSync(frontDir, { recursive: true });
    mkdirSync(backDir, { recursive: true });

    const clips = planClips(baseDay);
    const encodedFrames = new Map();
    const materializeClip = (frame, out, width) => {
        const key = `${frame}:${width}`;
        const encoded = encodedFrames.get(key);
        if (encoded) {
            copyFileSync(encoded, out);
        } else {
            encodeClip(frame, out, width);
            encodedFrames.set(key, out);
        }
    };
    console.log(`preparing ${clips.length * 2} clips (front + back)...`);
    for (const clip of clips) {
        const frontWidth = clip.tripIdx === HERO_TRIP_INDEX ? HERO_VIDEO_WIDTH : PREVIEW_VIDEO_WIDTH;
        materializeClip(join(FRAMES_DIR, clip.frontFrame), join(frontDir, clip.frontName), frontWidth);
        materializeClip(REAR_FRAME, join(backDir, clip.backName), HERO_VIDEO_WIDTH);
    }
    writeFileSync(join(root, "GPSData000001.txt"), buildGpsLog(clips));
    const elapsedSec = ((performance.now() - startedAt) / 1000).toFixed(2);
    console.log(
        `fixture ready in ${elapsedSec}s (${encodedFrames.size} encodes, track length ${TRACK_LENGTH_M.toFixed(0)} m)`,
    );
}

// --- server + browser bootstrap -------------------------------------------

// Vite resolves only once the configured preview server is listening.
function startPreview() {
    return preview({ root: REPO_ROOT, preview: { port: PORT, strictPort: true } });
}

// Launches Chromium, installing the browser once if it is missing.
async function launchBrowser() {
    try {
        return await chromium.launch({ headless: !HEADFUL });
    } catch (err) {
        if (/executable doesn't exist|Executable doesn't exist/i.test(String(err))) {
            console.log("installing Playwright chromium...");
            spawnSync("npx", ["playwright", "install", "chromium"], { cwd: REPO_ROOT, stdio: "inherit" });
            return await chromium.launch({ headless: !HEADFUL });
        }
        throw err;
    }
}

// Mirrors tests/e2e/_fixtures.ts presetLocalStorage: seed BEFORE app code runs so
// no upload-warning / PWA toast / onboarding overlay is ever in frame.
// theme: explicit "dark"/"light" override (src/ui/theme.ts ThemeChoice) - the
// shots must not depend on the machine's OS scheme.
async function presetLocalStorage(context, theme = "dark", marker = null) {
    await context.addInitScript(
        ({ chosenTheme, mapMarker }) => {
            try {
                const now = String(Date.now());
                localStorage.setItem("dc-theme", chosenTheme);
                localStorage.setItem("everydashcam:upload-warning-shown-at", now);
                localStorage.setItem("everydashcam:pwa:toast:shown", "1");
                localStorage.setItem("everydashcam:pwa:toast:dismissedAt", now);
                for (const id of ["ingest", "player", "export", "multichannel"]) {
                    localStorage.setItem(`everydashcam:onboarding:${id}`, "1");
                }
                localStorage.setItem("everydashcam:lang", "en");
                // Metric units: the synthetic track is a German forest road - km/h
                // readouts keep the shot internally consistent (en-US defaults to mph).
                localStorage.setItem("everydashcam:units", "metric");
                if (mapMarker) localStorage.setItem("everydashcam:mapMarker", JSON.stringify(mapMarker));
            } catch {
                /* private mode - ignore */
            }
        },
        { chosenTheme: theme, mapMarker: marker },
    );
}

// The initial empty style can be idle before the real map loads. Require the
// basemap and route, then let labels finish fading into the rendered tiles.
async function waitForMapIdle(page) {
    await page.waitForFunction(
        () => {
            const map = window.__everydashcam?.state?.map;
            if (!map?.getSource("trip-line")) return false;
            const hasBasemap = Object.values(map.getStyle()?.sources ?? {}).some(
                (source) => source.type === "vector" || source.type === "raster",
            );
            return hasBasemap && map.isStyleLoaded() && map.loaded() && map.areTilesLoaded();
        },
        undefined,
        { timeout: 30_000 },
    );
    await page.waitForTimeout(800);
}

async function waitForPaint(page) {
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

// Ingests the fixture folder and waits for the trip cards to appear. Returns the
// count of real trip cards (excludes the "unindexed" note li).
async function ingest(page, fixtureRoot) {
    await page.locator("#folder-input").setInputFiles(fixtureRoot);
    await page.waitForFunction(
        (count) =>
            document.querySelectorAll("li.trip:not(.unindexed-note)").length === count &&
            document.querySelectorAll("li.trip:not(.unindexed-note) .trip-header.has-preview").length === count,
        TRIPS.length,
        { timeout: 30_000 },
    );
    return page.locator("li.trip:not(.unindexed-note)").count();
}

// Selects the top (newest) trip and waits until it is actually active/playable
// (chart rendered, or the total-time readout advanced past 0:00) - mirrors
// _fixtures.ts loadTrip. The app never auto-selects, so this click is required.
async function selectTopTrip(page) {
    await page.locator("li.trip:not(.unindexed-note)").first().click();
    await page.waitForFunction(
        () => {
            const c = document.getElementById("player-chart-canvas");
            if (c && c.getBoundingClientRect().width > 0) return true;
            const total = document.getElementById("player-total");
            return total !== null && total.textContent !== null && total.textContent !== "0:00";
        },
        undefined,
        { timeout: 15_000 },
    );
    await page.waitForFunction(
        () => {
            const button = document.getElementById("player-map");
            return window.__everydashcam?.state?.hasTrack && button instanceof HTMLButtonElement && !button.disabled;
        },
        undefined,
        { timeout: 15_000 },
    );
}

// Seek through the real scrubber rather than reaching into app modules. Pausing
// makes the generated artwork deterministic and leaves the playhead precisely
// on the 0 km/h sample at the deer frame.
async function seekToHeroBrake(page) {
    const play = page.locator("#player-play");
    if ((await play.getAttribute("data-paused")) === "false") {
        await play.click();
        await page.waitForFunction(() => document.getElementById("player-play")?.dataset.paused === "true");
    }
    // 4 jumps to 40% of this 180 s trip (72 s). Unlike a pixel click this is
    // immune to the chart's dynamic left/right plot gutters.
    await page.keyboard.press("4");
    await page.waitForFunction(() => {
        const value = Number(document.getElementById("player-mini-progress")?.getAttribute("aria-valuenow"));
        return Number.isFinite(value) && Math.abs(value - 40) < 1;
    });
    // The progress readout can advance before the new clip has decoded. Wait
    // for both active channel slots, excluding preload and background videos.
    await page.waitForFunction(
        (offset) =>
            ["front", "rear"].every((channel) => {
                const video = document.querySelector(
                    `.video-tile[data-channel="${channel}"] > video[id]:not(.preload-slot)`,
                );
                return (
                    video instanceof HTMLVideoElement &&
                    video.readyState >= 2 &&
                    !video.seeking &&
                    video.paused &&
                    Math.abs(video.currentTime - offset) < 0.1
                );
            }),
        HERO_BRAKE_SEC % CLIP_SEC,
        { timeout: 15_000 },
    );
    await waitForPaint(page);
}

// --- per-screenshot flows --------------------------------------------------

async function shotDesktop(browser, fixtureRoot) {
    const context = await browser.newContext({
        // 800 instead of a common 900: the split tiles are width-limited (4:3 in a
        // half-column next to the expanded map), so extra height only adds black
        // letterbox around them - a squatter window keeps the frame dense.
        viewport: { width: 1440, height: 800 },
        deviceScaleFactor: 2,
        colorScheme: "dark",
        locale: "en-US",
        timezoneId: "UTC", // displayed trip time == filename wall-clock; day never rolls
    });
    await presetLocalStorage(context, "dark", { shape: "sedan", color: "#2f7ee6", size: "medium" });
    const page = await context.newPage();
    await page.goto(`${BASE_URL}/en/`);

    const tripCount = await ingest(page, fixtureRoot);
    if (tripCount < 3) throw new Error(`desktop: expected >=3 trips, got ${tripCount}`);
    await selectTopTrip(page);

    // Split view: focus is the default; the toggle is shown only on multichannel
    // trips. Flip to split so BOTH cameras show at equal size.
    await page.locator("#player-view-mode").click();
    await page.locator("#video-grid").waitFor({ state: "visible" });
    await page.waitForFunction(() => document.getElementById("video-grid")?.dataset.viewMode === "split", undefined, {
        timeout: 5_000,
    });

    // Expand the map: on desktop the mini-map circle is the expand affordance.
    // player-wrap must stay > 768px wide or the container query collapses the
    // expanded layout to map-only (hides the video) - safe at 1440 minus sidebar.
    await page.locator("#mini-map").click();
    await page.waitForFunction(
        () => document.getElementById("player-wrap")?.classList.contains("map-expanded"),
        undefined,
        { timeout: 5_000 },
    );
    // The expand grows the map container via a CSS layout change; fitBounds run
    // before that settles frames against stale (mini-sized) dimensions and pushes
    // the track off-screen. Wait for the layout, then force a resize so fitBounds
    // sees the final expanded size.
    await page.waitForTimeout(500);

    // Whole-route flat view: switch follow to "off" FIRST (stops the rAF chase so
    // it cannot re-center after the fit), then level the pitch/bearing and fit the
    // active trip's whole track so the speed-colored winding line fills the map.
    await page.locator('.map-follow-seg[data-follow-mode="off"]').click();
    await page.evaluate(() => {
        const st = window.__everydashcam.state;
        const map = st.map;
        const coords = st.miniMapData?.coords;
        if (!map || !coords?.length) return;
        map.resize(); // adopt the final expanded container size before fitting
        let minLng = Infinity;
        let minLat = Infinity;
        let maxLng = -Infinity;
        let maxLat = -Infinity;
        for (const [lng, lat] of coords) {
            if (lng < minLng) minLng = lng;
            if (lng > maxLng) maxLng = lng;
            if (lat < minLat) minLat = lat;
            if (lat > maxLat) maxLat = lat;
        }
        map.setPitch(0);
        map.setBearing(0);
        map.fitBounds(
            [
                [minLng, minLat],
                [maxLng, maxLat],
            ],
            { padding: 72, animate: false },
        );
    });
    await seekToHeroBrake(page);
    await waitForMapIdle(page);

    const out = join(OUT_DIR, "app-desktop.png");
    await page.screenshot({ path: out, fullPage: false });
    await context.close();
    return out;
}

async function shotMobilePlayer(browser, fixtureRoot) {
    // Light theme on purpose: next to the dark desktop shot in the hero it
    // shows both themes in one image instead of two copies of the same look.
    const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 3,
        isMobile: true,
        hasTouch: true,
        colorScheme: "light",
        locale: "en-US",
        timezoneId: "UTC",
    });
    await presetLocalStorage(context, "light");
    const page = await context.newPage();
    await page.goto(`${BASE_URL}/en/`);

    const tripCount = await ingest(page, fixtureRoot);
    if (tripCount < 3) throw new Error(`mobile-player: expected >=3 trips, got ${tripCount}`);
    await selectTopTrip(page);

    await seekToHeroBrake(page);

    // Narrow touch toolbars move the map action into the overflow menu.
    const mapButton = page.locator("#player-map");
    if (await mapButton.isVisible()) {
        await mapButton.click();
    } else {
        await page.locator("#player-overflow").click();
        await page.locator("#player-overflow-menu").getByRole("button", { name: /map/i }).click();
    }
    await page.waitForFunction(
        () =>
            document.getElementById("player-wrap")?.classList.contains("map-expanded") &&
            !document.body.classList.contains("map-morphing"),
    );
    await waitForMapIdle(page);

    const out = join(OUT_DIR, "app-mobile-player.png");
    await page.screenshot({ path: out, fullPage: false });
    await context.close();
    return out;
}

// --- landing WebP variants ---------------------------------------------------

// Encodes a PNG buffer as WebP inside the same headless Chromium
// (canvas.toDataURL), downscaling to targetWidth first (null keeps the source
// width). Chromium's native encoder replaces both an image library (a
// dependency for four files) and ffmpeg's libwebp (absent from the slim
// homebrew build this script otherwise relies on).
async function pngToWebp(browser, srcPngBuffer, outPath, targetWidth, quality = 0.82) {
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
        const dataUrl = await page.evaluate(
            async ({ src, width, q }) => {
                const img = new Image();
                img.src = src;
                await img.decode();
                const canvas = document.createElement("canvas");
                canvas.width = width ?? img.naturalWidth;
                canvas.height = Math.round((img.naturalHeight * canvas.width) / img.naturalWidth);
                const ctx = canvas.getContext("2d");
                ctx.imageSmoothingQuality = "high";
                ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
                return canvas.toDataURL("image/webp", q);
            },
            {
                src: `data:image/png;base64,${srcPngBuffer.toString("base64")}`,
                width: targetWidth,
                q: quality,
            },
        );
        // toDataURL silently falls back to PNG if the type is unsupported - that
        // would ship a mislabeled multi-MB file, so fail loudly instead.
        if (!dataUrl.startsWith("data:image/webp")) throw new Error(`webp encode failed for ${outPath}`);
        writeFileSync(outPath, Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64"));
    } finally {
        await context.close();
    }
}

// Emits every landing variant from the two source PNGs.
async function writeLandingVariants(browser, shots) {
    mkdirSync(LANDING_OUT_DIR, { recursive: true });
    for (const { shot, base, widths } of LANDING_VARIANTS) {
        for (const { width, quality } of widths) {
            const out = join(LANDING_OUT_DIR, `${base}-${width}.webp`);
            await pngToWebp(browser, readFileSync(shots[shot]), out, width, quality);
            console.log(`wrote ${out}`);
        }
    }
}

// --- composite hero ---------------------------------------------------------

// Match --dc-accent without depending on the app build for the hero artwork.
const HERO_ACCENT_RGB = "255, 144, 0";

// Composes the two screenshots on a brand-gradient backdrop into the single
// image README.md embeds. Rendered by the same Playwright Chromium as the
// shots (viewport = logical canvas, DSF picks the output resolution): the
// screenshots are inlined as data: URIs so the document is self-contained.
async function composeHero(browser, desktopPng, mobilePng) {
    const b64 = (path) => readFileSync(path).toString("base64");
    // 1600x780 logical, DSF 1.25 -> 2000x975 output: ~2.4x of the ~830px
    // GitHub README column, crisp on retina without a multi-MB file.
    const html = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  * { box-sizing: border-box; margin: 0; }
  html, body { width: 1600px; height: 780px; overflow: hidden; background: transparent; }
  .composition {
    width: 100%; height: 100%;
    display: flex; align-items: center; justify-content: center;
    background:
      radial-gradient(ellipse 700px 440px at 24% 26%, rgba(${HERO_ACCENT_RGB}, 0.20), rgba(${HERO_ACCENT_RGB}, 0) 75%),
      radial-gradient(ellipse 620px 410px at 82% 76%, rgba(${HERO_ACCENT_RGB}, 0.14), rgba(${HERO_ACCENT_RGB}, 0) 75%);
    /* Fade the glows and shadows into any host theme, keeping both shots opaque. */
    mask-image:
      linear-gradient(to right, transparent, #000 6%, #000 94%, transparent),
      linear-gradient(to bottom, transparent, #000 6%, #000 94%, transparent);
    mask-composite: intersect;
  }
  img { display: block; }
  .desktop {
    width: 1120px; border-radius: 14px;
    border: 1px solid rgba(255,255,255,0.10);
    box-shadow: 0 30px 80px rgba(0,0,0,0.30);
  }
  .phone {
    width: 260px; border-radius: 24px;
    border: 1px solid rgba(255,255,255,0.14);
    box-shadow: 0 24px 60px rgba(0,0,0,0.35);
    /* Overlap the desktop's right edge and hang below its bottom - reads as a
       foreground device, not two pasted rectangles. */
    margin-left: -56px; margin-top: 100px;
    position: relative; z-index: 2;
  }
</style></head>
<body>
  <div class="composition">
    <img class="desktop" src="data:image/png;base64,${b64(desktopPng)}">
    <img class="phone" src="data:image/png;base64,${b64(mobilePng)}">
  </div>
</body></html>`;

    const context = await browser.newContext({
        viewport: { width: 1600, height: 780 },
        deviceScaleFactor: 1.25,
        colorScheme: "dark",
    });
    const page = await context.newPage();
    await page.setContent(html);
    // data: URIs decode async - a shot before both images are painted would
    // show gradient-only gaps.
    await page.waitForFunction(() => Array.from(document.images).every((img) => img.complete && img.naturalWidth > 0));
    await waitForPaint(page);
    const heroPng = await page.screenshot({ fullPage: false, omitBackground: true });
    await context.close();
    // Keep retina dimensions and alpha: flattening onto a fixed color would
    // bring back a visible rectangle on other host themes.
    const out = join(OUT_DIR, "readme-hero.webp");
    await pngToWebp(browser, heroPng, out, null, 0.9);
    return out;
}

// --- main ------------------------------------------------------------------

function checkPreconditions() {
    const missing = [];
    if (!existsSync(DIST_INDEX)) missing.push(`dist/en/index.html (build first: npm run build)`);
    for (const path of [...new Set(TRIPS.map((trip) => join(FRAMES_DIR, trip.frontFrame))), REAR_FRAME]) {
        if (!existsSync(path)) missing.push(`source frame ${path}`);
    }
    const ff = spawnSync(FFMPEG, ["-version"], { stdio: "ignore" });
    if (ff.error || ff.status !== 0) missing.push(`ffmpeg (install via 'brew install ffmpeg')`);
    if (missing.length) {
        console.error("cannot generate screenshots, missing preconditions:");
        for (const m of missing) console.error(`  - ${m}`);
        process.exit(1);
    }
}

async function main() {
    const startedAt = performance.now();
    checkPreconditions();
    mkdirSync(OUT_DIR, { recursive: true });

    let tempRoot;
    let fixtureRoot;
    let server;
    let browser;
    try {
        // The randomized mkdtemp name is visible in the shot: the sidebar names
        // the folder the trips came from. Nest a plausible card folder inside it
        // so the screenshot reads like a real SD card, not a scratch directory.
        tempRoot = mkdtempSync(join(tmpdir(), "everydashcam-readme-"));
        fixtureRoot = join(tempRoot, "DASHCAM_SD");
        mkdirSync(fixtureRoot, { recursive: true });
        buildFixture(fixtureRoot, fixtureDayYYYYMMDD());
        server = await startPreview();
        browser = await launchBrowser();

        const desktop = await shotDesktop(browser, fixtureRoot);
        console.log(`wrote ${desktop}`);
        const mobilePlayer = await shotMobilePlayer(browser, fixtureRoot);
        console.log(`wrote ${mobilePlayer}`);
        const hero = await composeHero(browser, desktop, mobilePlayer);
        console.log(`wrote ${hero}`);
        await writeLandingVariants(browser, { desktop, mobile: mobilePlayer });
        const elapsedSec = ((performance.now() - startedAt) / 1000).toFixed(2);
        console.log(
            `done in ${elapsedSec}s: 2 screenshots + hero in docs/screenshots/, landing WebP set in public/landing/`,
        );
    } finally {
        if (browser) await browser.close().catch(() => {});
        if (server) await server.close();
        if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
    }
}

main().catch((err) => {
    console.error(err?.stack || String(err));
    process.exit(1);
});
