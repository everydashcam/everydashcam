// Browser capability detection. Single source of truth for "can this browser
// run everydashcam, and which features will work".
//
// Why this exists: we advertise "opens anywhere with a browser", but the app
// leans on a handful of modern Web APIs (Web Workers, WebCodecs, WebGL2,
// File System Access, ...). On a browser that lacks one, the user used to hit a
// black frame / dead map / failed export with no explanation. This module
// classifies every capability we depend on so the UI can either block with a
// clear "won't run here" notice (fatal gaps) or proactively explain a limited
// feature (degraded gaps), and so we can collect metrics on real-world gaps.
//
// Pure feature-detection - no UI, no analytics, no DOM mutation. The severity
// policy (which gap is fatal vs degraded) is the one architectural decision
// encoded here; see SEVERITY below for the rationale per capability.
//
// Detection over UA sniffing: every gate decision is made from a real feature
// probe (typeof X, getContext, 'name' in proto), never from the user-agent
// string. identifyBrowser() exists ONLY to tailor the human advice ("update
// Safari" vs "update Chrome") and to bucket metrics - it never decides whether
// a feature is available.

import { createLogger } from "./log.js";

const log = createLogger("capabilities");

/**
 * Severity of a missing capability:
 *  - "blocking" - the core job (load an SD card folder, watch a recording) is
 *    impossible and there is no graceful path. The UI shows a full blocking gate.
 *  - "degraded" - a real, user-visible feature is unavailable but the core still
 *    works. The UI explains it (proactively and/or at the point of use).
 *  - "info"     - either invisible to the user (a ponyfill covers it) or only a
 *    diagnostic signal. Recorded for metrics, never surfaced on its own.
 */
export type CapabilitySeverity = "blocking" | "degraded" | "info";

export type CapabilityId =
    | "secureContext"
    | "webWorker"
    | "wasm"
    | "videoElement"
    | "h264Decode"
    | "webCodecsDecode"
    | "webCodecsEncode"
    | "webgl"
    | "mediaSource"
    | "offscreenCanvas"
    | "fileLoad"
    | "folderPicker"
    | "dndEntries"
    | "fileSystemAccess"
    | "persistentFolder"
    | "serviceWorker"
    | "structuredClone";

/**
 * Severity policy. The comment on each entry is the rationale - this is the
 * contract the UI relies on, kept here so there is one place to revisit if we
 * decide to, say, let sub-WebCodecs browsers do basic playback (already the
 * case: webCodecsDecode is "degraded", not "blocking").
 *
 * Only three capabilities are "blocking", and all three are universal on any
 * browser modern enough to even parse our ES-module bundle - so the blocking
 * gate is a genuine safety net, not an everyday wall. The everyday value is the
 * "degraded" set (no map / no editor / iOS load friction).
 */
const SEVERITY: Record<CapabilityId, CapabilitySeverity> = {
    // Some APIs (FSA, Service Worker, parts of WebCodecs) require a secure
    // context. Production is always HTTPS; only a self-hosted fork on plain
    // HTTP hits this. Core viewing works over HTTP, export degrades - so warn,
    // don't block.
    secureContext: "degraded",
    // The whole ingest pipeline (classify, GPS extract, MP4 index, preview) runs
    // in module Workers with no main-thread fallback. No Worker = can't load
    // anything. Fatal.
    webWorker: "blocking",
    // Universal on the target bar; recorded only as a diagnostic. MapLibre pulls
    // some wasm but the map is itself a degraded feature, so wasm is not its own
    // user-facing gap.
    wasm: "info",
    // No <video> element = nothing to play. Fatal (and universal).
    videoElement: "blocking",
    // Native H.264 playback is the codec every dashcam writes. Detection via
    // canPlayType is unreliable ("maybe"/"") so we DON'T block on it - the
    // per-file codec overlay (empty-state.ts) is the real handler. Surfaced as
    // a degraded hint when the probe is confidently negative.
    h264Decode: "degraded",
    // VideoDecoder: previews, birds-eye frame extraction, and the ingest
    // decodability probe. Core playback uses native <video>, not WebCodecs, so
    // a recording still plays without it - degraded, not fatal.
    webCodecsDecode: "degraded",
    // VideoEncoder: re-encode export (crop / split / overlays / speed). Plain
    // stream-copy export still works without it. Degraded. NOTE: presence here
    // does NOT mean a working H.264 encode - Firefox exposes VideoEncoder but
    // its configure()/encode() throw for H.264 (Bugzilla 1918769), and a
    // software-only machine may have no High-profile encoder at all. The export
    // path confirms real encodability via canReencodeH264()
    // (transcode/capabilities.ts) before running, instead of trusting this
    // presence flag. This flag still drives the coarse proactive "no editor"
    // notice and the metrics signature.
    webCodecsEncode: "degraded",
    // The map needs a usable WebGL2 context - MapLibre has no WebGL1 path, so a
    // blocklisted/ancient GPU or hardware acceleration off kills the map even
    // when WebGL1 still works. No map = video + chart + export keep working;
    // map init is guarded so this no longer throws. Degraded.
    webgl: "degraded",
    // MediaSource / ManagedMediaSource: HEVC and MPEG-TS playback go through MSE
    // remux. Plain MP4/H.264 plays natively without it. Degraded (reactive
    // codec overlay covers the per-file case).
    mediaSource: "degraded",
    // OffscreenCanvas: transcode compositing + preview generation. Subset of the
    // WebCodecs editor surface. Degraded.
    offscreenCanvas: "degraded",
    // At least one way to hand us files. Folder picker OR DnD entries OR a plain
    // multi-file <input>. If NONE work the app cannot start. Fatal (universal).
    fileLoad: "blocking",
    // <input webkitdirectory> folder picker. On iOS the attribute probes true
    // but the picker either does nothing (pre-18.4) or copies the whole tree
    // before the page sees anything (18.4+, see docs/browser-support.md) - the
    // iOS folder warning steers to individual files there. Load friction, not
    // fatal.
    folderPicker: "degraded",
    // DataTransferItem.webkitGetAsEntry for recursive folder drag-and-drop. The
    // picker is the primary path; this is a convenience. Diagnostic only.
    dndEntries: "info",
    // Native File System Access (showSaveFilePicker). The
    // native-file-system-adapter ponyfill transparently covers FF/Safari, so
    // its absence is invisible to the user. Diagnostic only.
    fileSystemAccess: "info",
    // showDirectoryPicker - the persistent-folder mode (remember a folder,
    // reopen it across sessions without re-picking). Chromium-only by vendor
    // choice: Mozilla and WebKit formally rejected the local-disk picker part
    // of File System Access. Everywhere else the feature invisibly degrades
    // to the classic picker plus cached indexing, so absence is not a
    // user-facing gap. Diagnostic only.
    persistentFolder: "info",
    // Service Worker powers the ponyfill's streaming export on FF/Safari. When
    // absent (private mode) the ponyfill falls back to an in-memory Blob, which
    // the export panel already warns about. Diagnostic only.
    serviceWorker: "info",
    // structuredClone: used in a few worker-message paths. Universal on the
    // target bar; diagnostic only.
    structuredClone: "info",
};

/** A single probed capability and its policy severity. */
export interface Capability {
    id: CapabilityId;
    ok: boolean;
    severity: CapabilitySeverity;
}

export interface BrowserInfo {
    /** Rendering engine - the reliable axis for "what to suggest". */
    engine: "blink" | "gecko" | "webkit" | "unknown";
    /** Best-effort product name for the human-readable advice line. */
    name: string;
    os: "windows" | "macos" | "linux" | "android" | "ios" | "unknown";
    isMobile: boolean;
}

export interface CapabilityReport {
    capabilities: Capability[];
    /** ids of failed "blocking" capabilities (empty = app can run). */
    blocking: CapabilityId[];
    /** ids of failed "degraded" capabilities. */
    degraded: CapabilityId[];
    /** true when no blocking capability is missing. */
    ok: boolean;
    browser: BrowserInfo;
}

// --- individual probes -------------------------------------------------------
//
// Each probe is defensive: it must not throw, and when the host object is
// genuinely absent (e.g. running under Node in tests) it returns the
// non-alarming answer (true) unless the test explicitly stubs the global. This
// keeps the report meaningful only where it runs for real - the browser.

function hasGlobal(name: string): boolean {
    return typeof (globalThis as Record<string, unknown>)[name] !== "undefined";
}

function probeSecureContext(): boolean {
    // isSecureContext is defined in every browser context; if it's missing we're
    // not in a browser - don't alarm.
    if (typeof isSecureContext === "undefined") return true;
    return isSecureContext === true;
}

function probeWebWorker(): boolean {
    return hasGlobal("Worker");
}

function probeWasm(): boolean {
    return hasGlobal("WebAssembly");
}

function probeVideoElement(): boolean {
    if (typeof document === "undefined") return true;
    try {
        return typeof document.createElement("video").canPlayType === "function";
    } catch {
        return false;
    }
}

function probeH264(): boolean {
    if (typeof document === "undefined") return true;
    try {
        const v = document.createElement("video");
        // Baseline 3.0 - the lowest profile any dashcam emits. "" means "no";
        // "maybe"/"probably" both count as yes (canPlayType is deliberately
        // vague, so we only treat a hard empty string as a negative).
        const verdict = v.canPlayType('video/mp4; codecs="avc1.42E01E"');
        return verdict !== "";
    } catch {
        // If the probe itself throws, don't claim H.264 is missing - the
        // per-file overlay will catch a real decode failure.
        return true;
    }
}

function probeWebCodecsDecode(): boolean {
    return hasGlobal("VideoDecoder");
}

function probeWebCodecsEncode(): boolean {
    return hasGlobal("VideoEncoder");
}

/**
 * True if a WebGL2 context can be created AND used. This is what decides whether
 * the map can render: MapLibre requires WebGL2 and has no WebGL1 fallback, so a
 * WebGL1-only machine is map-dead however well that context works. Exported so
 * map.ts can preflight with the exact same probe (one source of truth) instead
 * of relying on MapLibre's throw-vs-error-event behaviour.
 */
export function probeWebGL(): boolean {
    if (typeof document === "undefined") return true;
    try {
        const gl = document.createElement("canvas").getContext("webgl2");
        if (gl == null) return false;
        // Creating a context is NOT enough. Some Windows/ANGLE setups and software
        // fallbacks hand back a context that then fails to COMPILE shaders - Sentry
        // caught "Could not compile fragment shader" thrown from MapLibre's very
        // first render (the trivial background layer), AFTER this probe passed and
        // the map was built, so it surfaced as an uncaught rAF crash instead of the
        // graceful "no map" degradation. A driver that cannot compile+link a minimal
        // program cannot run MapLibre, so gating on it here is faithful with no
        // false-positive risk (anything that can render a map clears it trivially).
        const canRender = canCompileTrivialProgram(gl);
        // Free the probe's GPU context immediately rather than waiting for GC -
        // browsers cap simultaneously-live WebGL contexts and force-lose the
        // oldest when the cap is hit, which could kill a real MapLibre/snapshot
        // context. This probe runs from map init, mini-map init and export
        // snapshots, so several throwaway contexts can pile up.
        gl.getExtension("WEBGL_lose_context")?.loseContext();
        return canRender;
    } catch {
        return false;
    }
}

/**
 * Compiles + links a minimal shader program on `gl`, returning false on any
 * compile/link failure. This is the exact operation MapLibre does on its first
 * render; a broken GPU (context exists, shader compiler unusable) fails it, so
 * probeWebGL can degrade to "no map" instead of letting MapLibre throw mid-render.
 * GLSL ES 3.00, the version MapLibre emits, so a driver that rejects 3.00
 * specifically is still caught. Never throws.
 */
function canCompileTrivialProgram(gl: WebGL2RenderingContext): boolean {
    const vsSrc = "#version 300 es\nvoid main(){gl_Position=vec4(0.0,0.0,0.0,1.0);}";
    const fsSrc = "#version 300 es\nprecision mediump float;\nout vec4 c;\nvoid main(){c=vec4(0.0);}";
    const vs = gl.createShader(gl.VERTEX_SHADER);
    const fs = gl.createShader(gl.FRAGMENT_SHADER);
    if (!vs || !fs) {
        if (vs) gl.deleteShader(vs);
        if (fs) gl.deleteShader(fs);
        return false;
    }
    try {
        gl.shaderSource(vs, vsSrc);
        gl.compileShader(vs);
        if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) return false;
        gl.shaderSource(fs, fsSrc);
        gl.compileShader(fs);
        if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) return false;
        const prog = gl.createProgram();
        if (!prog) return false;
        gl.attachShader(prog, vs);
        gl.attachShader(prog, fs);
        gl.linkProgram(prog);
        const linked = gl.getProgramParameter(prog, gl.LINK_STATUS) === true;
        gl.deleteProgram(prog);
        return linked;
    } finally {
        gl.deleteShader(vs);
        gl.deleteShader(fs);
    }
}

/** Creates a throwaway canvas and returns a WebGL2 -> WebGL1 -> experimental
 *  context, or null when none can be acquired. For DIAGNOSTICS only, hence the
 *  WebGL1 fallback the map itself no longer has: a WebGL1-only machine cannot
 *  run the map but can still name its GPU, which is what decides whether the
 *  failure is worth an actionable modal. The caller releases the context via
 *  WEBGL_lose_context. Callers must guard `typeof document` first. */
function acquireAnyWebglContext(): WebGLRenderingContext | null {
    const canvas = document.createElement("canvas");
    return (canvas.getContext("webgl2") ??
        canvas.getContext("webgl") ??
        canvas.getContext("experimental-webgl")) as WebGLRenderingContext | null;
}

/** Why WebGL is missing, and whether the user can plausibly turn it back on.
 *  Produced by classifyWebglRecovery(); the capability gate uses it to choose
 *  between an actionable "turn the map on" modal and a quiet "no map" notice. */
export interface WebglRecoveryVerdict {
    /** true when indirect signals say a usable GPU is present and the WebGL
     *  failure looks like a setting / policy / blocklist the user can flip. */
    recoverable: boolean;
    /** Coarse cause, for analytics + the diagnostic log. Never shown raw - the
     *  modal copy is generic (see the webglEnable.* i18n keys). */
    reason: "softwareRendering" | "gpuAlive" | "modernDesktop" | "absent";
    /** Unmasked GPU renderer string when readable, else null. Log-only. */
    renderer: string | null;
}

// Renderer names that mean "this WebGL context renders on the CPU" - i.e.
// hardware acceleration is off or the GPU is blocklisted, not absent. Matched
// case-insensitively against UNMASKED_RENDERER_WEBGL (or RENDERER).
const SOFTWARE_RENDERER_RE = /swiftshader|llvmpipe|softpipe|software|basic render|microsoft basic/i;

/**
 * Reads the GPU renderer string from a throwaway WebGL context, or null when no
 * context can be created or the string is hidden. Note the modern-Chromium
 * twist: since Chrome 137 removed the automatic SwiftShader fallback, "hardware
 * acceleration off" now hands back a NULL context (not a software one), so a
 * null here is common and uninformative on its own - which is exactly why
 * classifyWebglRecovery() cross-checks other signals. Firefox with
 * resistFingerprinting also returns null. Releases the context. Never throws.
 */
function readWebglRenderer(): string | null {
    if (typeof document === "undefined") return null;
    try {
        const gl = acquireAnyWebglContext();
        if (gl == null) return null;
        let renderer: unknown = null;
        // WEBGL_debug_renderer_info exposes the UNMASKED name ("ANGLE (NVIDIA...)",
        // "Google SwiftShader", "Mesa llvmpipe"). Privacy-gated in some browsers;
        // fall back to plain RENDERER, which newer Firefox fills with the real name.
        const ext = gl.getExtension("WEBGL_debug_renderer_info") as { UNMASKED_RENDERER_WEBGL: number } | null;
        if (ext) renderer = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL);
        if (typeof renderer !== "string" || renderer === "") renderer = gl.getParameter(gl.RENDERER);
        gl.getExtension("WEBGL_lose_context")?.loseContext();
        return typeof renderer === "string" && renderer !== "" ? renderer : null;
    } catch {
        return null;
    }
}

/**
 * True if a WebGPU adapter can be acquired - a positive "a real GPU is present"
 * signal. Used ONLY as positive corroboration: a missing adapter does NOT imply
 * no GPU (dual-GPU laptops return null while WebGL works fine), so we never gate
 * negatively on it. Async - requestAdapter() returns a promise. Never throws.
 */
async function webgpuAdapterPresent(): Promise<boolean> {
    try {
        const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
        if (!gpu || typeof gpu.requestAdapter !== "function") return false;
        const adapter = await gpu.requestAdapter();
        return adapter != null;
    } catch {
        return false;
    }
}

/**
 * Decides whether a missing-WebGL situation is recoverable (a setting the user
 * can flip) vs a genuine capability gap. Call ONLY when the `webgl` capability is
 * degraded (probeWebGL() already returned false). No single signal is reliable
 * (see docs/browser-support.md), so this layers three in decreasing confidence:
 *   1. a software renderer string -> hardware acceleration is off (recoverable);
 *   2. a live WebGPU adapter while WebGL is dead -> the GPU stack is up, so the
 *      WebGL failure is config / policy / blocklist (recoverable);
 *   3. a desktop OS + a recognized browser -> in 2025+ "no WebGL at all" on a
 *      desktop browser is overwhelmingly a config issue, not a GPU too old for it
 *      (every desktop GPU of the last decade does WebGL). This is the load-bearing
 *      heuristic: the most common recoverable case (Chromium with acceleration
 *      off) yields a null context and no readable signal, so only the context -
 *      desktop + a real browser - tells it apart from a genuinely incapable GPU.
 * Anything else (mobile, unknown browser, no GPU signal) is treated as a real gap
 * - not recoverable - so the caller shows a quiet notice instead of an enable
 * walkthrough that would not help. Async, never throws.
 */
export async function classifyWebglRecovery(): Promise<WebglRecoveryVerdict> {
    const renderer = readWebglRenderer();
    if (renderer && SOFTWARE_RENDERER_RE.test(renderer)) {
        return { recoverable: true, reason: "softwareRendering", renderer };
    }
    if (await webgpuAdapterPresent()) {
        return { recoverable: true, reason: "gpuAlive", renderer };
    }
    const browser = identifyBrowser();
    if (!browser.isMobile && browser.name !== "") {
        return { recoverable: true, reason: "modernDesktop", renderer };
    }
    return { recoverable: false, reason: "absent", renderer };
}

function probeMediaSource(): boolean {
    // ManagedMediaSource is the iOS-Safari form; either is enough for our MSE
    // remux backend.
    return hasGlobal("MediaSource") || hasGlobal("ManagedMediaSource");
}

function probeOffscreenCanvas(): boolean {
    return hasGlobal("OffscreenCanvas");
}

function probeFolderPicker(): boolean {
    if (typeof document === "undefined") return true;
    try {
        return "webkitdirectory" in document.createElement("input");
    } catch {
        return false;
    }
}

function probeDndEntries(): boolean {
    if (typeof DataTransferItem === "undefined") return true;
    return "webkitGetAsEntry" in DataTransferItem.prototype;
}

function probePlainFileInput(): boolean {
    if (typeof document === "undefined") return true;
    try {
        const input = document.createElement("input");
        input.type = "file";
        return input.type === "file";
    } catch {
        return false;
    }
}

function probeFileLoad(): boolean {
    // Any one path to receive files is enough to start.
    return probeFolderPicker() || probeDndEntries() || probePlainFileInput();
}

function probeFileSystemAccess(): boolean {
    return hasGlobal("showSaveFilePicker");
}

function probePersistentFolder(): boolean {
    return hasGlobal("showDirectoryPicker");
}

function probeServiceWorker(): boolean {
    return typeof navigator !== "undefined" && "serviceWorker" in navigator;
}

function probeStructuredClone(): boolean {
    return hasGlobal("structuredClone");
}

const PROBES: Record<CapabilityId, () => boolean> = {
    secureContext: probeSecureContext,
    webWorker: probeWebWorker,
    wasm: probeWasm,
    videoElement: probeVideoElement,
    h264Decode: probeH264,
    webCodecsDecode: probeWebCodecsDecode,
    webCodecsEncode: probeWebCodecsEncode,
    webgl: probeWebGL,
    mediaSource: probeMediaSource,
    offscreenCanvas: probeOffscreenCanvas,
    fileLoad: probeFileLoad,
    folderPicker: probeFolderPicker,
    dndEntries: probeDndEntries,
    fileSystemAccess: probeFileSystemAccess,
    persistentFolder: probePersistentFolder,
    serviceWorker: probeServiceWorker,
    structuredClone: probeStructuredClone,
};

const CAPABILITY_ORDER: readonly CapabilityId[] = Object.keys(PROBES) as CapabilityId[];

/**
 * Lightweight user-agent classification for advice, metrics and narrow engine
 * workarounds. Feature availability uses probes instead. The engine axis is
 * coarse and order-sensitive: Edge before Chrome, Chrome before Safari.
 */
export function identifyBrowser(ua?: string): BrowserInfo {
    const s = (ua ?? (typeof navigator !== "undefined" ? navigator.userAgent : "") ?? "").toLowerCase();

    // OS first - it drives part of the advice (e.g. iOS folder gap, Linux codecs).
    let os: BrowserInfo["os"] = "unknown";
    if (
        /iphone|ipad|ipod/.test(s) ||
        (/macintosh/.test(s) && typeof navigator !== "undefined" && (navigator.maxTouchPoints ?? 0) > 1)
    ) {
        // iPadOS 13+ reports a desktop "Macintosh" UA; maxTouchPoints>1 tells it
        // apart from a real Mac.
        os = "ios";
    } else if (/android/.test(s)) {
        os = "android";
    } else if (/windows/.test(s)) {
        os = "windows";
    } else if (/macintosh|mac os x/.test(s)) {
        os = "macos";
    } else if (/linux|x11|cros/.test(s)) {
        os = "linux";
    }

    const isMobile = os === "ios" || os === "android" || /mobi/.test(s);

    let engine: BrowserInfo["engine"] = "unknown";
    // Empty when we can't name the browser - the advice copy then uses its
    // generic "use a recent browser" wording (ICU select on a "known" flag)
    // instead of an awkward untranslated "your browser".
    let name = "";
    if (/firefox|fxios/.test(s)) {
        engine = /fxios/.test(s) ? "webkit" : "gecko";
        name = "Firefox";
    } else if (/edg\//.test(s) || /edga|edgios/.test(s)) {
        engine = /edgios/.test(s) ? "webkit" : "blink";
        name = "Edge";
    } else if (/opr\/|opera/.test(s)) {
        engine = "blink";
        name = "Opera";
    } else if (/samsungbrowser/.test(s)) {
        engine = "blink";
        name = "Samsung Internet";
    } else if (/chrome|crios|chromium/.test(s)) {
        // crios = Chrome on iOS (WebKit underneath), still branded "Chrome".
        engine = os === "ios" ? "webkit" : "blink";
        name = "Chrome";
    } else if (/safari/.test(s)) {
        // The branded Chrome/Firefox tokens have already been handled above.
        engine = "webkit";
        name = "Safari";
    }

    return { engine, name, os, isMobile };
}

let cached: CapabilityReport | null = null;

/**
 * Detects all capabilities and classifies them by the SEVERITY policy. Memoized
 * for the tab lifetime (capabilities do not change within a session). Never
 * throws - a probe that errors counts as "not ok".
 */
export function detectCapabilities(): CapabilityReport {
    if (cached) return cached;
    cached = computeReport();
    return cached;
}

function computeReport(): CapabilityReport {
    const capabilities: Capability[] = CAPABILITY_ORDER.map((id) => {
        let ok: boolean;
        try {
            ok = PROBES[id]();
        } catch (err) {
            log.debug("probe threw", { id, err: String(err) });
            ok = false;
        }
        return { id, ok, severity: SEVERITY[id] };
    });

    const blocking = capabilities.filter((c) => !c.ok && c.severity === "blocking").map((c) => c.id);
    const degraded = capabilities.filter((c) => !c.ok && c.severity === "degraded").map((c) => c.id);

    const report: CapabilityReport = {
        capabilities,
        blocking,
        degraded,
        ok: blocking.length === 0,
        browser: identifyBrowser(),
    };

    // Always record the full pass/fail signature: no backend means the ring
    // buffer is the only diagnostic channel for "broken for this user" reports
    // (CLAUDE.md), and the signature is exactly what we'd read there. warn level
    // when blocking so it stands out in a downloaded log.
    const line = { signature: capabilitySignature(report), blocking, degraded };
    if (blocking.length > 0) log.warn("capabilities", line);
    else log.info("capabilities", line);

    return report;
}

/**
 * The subset of degraded gaps worth surfacing proactively (a clear loss the
 * user would otherwise hit blindly): no map, no editor/export, iOS load
 * friction. Invisible degradations (ponyfill-covered FSA/SW) and reactive ones
 * (per-file codec, HEVC/TS via MSE) are deliberately excluded - they are
 * explained at the point of use instead.
 */
export function headlineDegradations(report: CapabilityReport): CapabilityId[] {
    const HEADLINE: readonly CapabilityId[] = ["webgl", "webCodecsDecode", "webCodecsEncode", "h264Decode"];
    return report.degraded.filter((id) => HEADLINE.includes(id));
}

/** Compact "id:0/1" string of all capabilities, for a single metrics payload. */
export function capabilitySignature(report: CapabilityReport): string {
    return report.capabilities.map((c) => `${c.id}:${c.ok ? 1 : 0}`).join(",");
}

/** Test-only reset of the memoized report. */
export function _resetForTests(): void {
    cached = null;
}
