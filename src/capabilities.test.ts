// Tests for the capability detector. Real Web APIs are absent under Node-vitest,
// so every probe input is supplied via vi.stubGlobal + a minimal fake document.
// We verify the SEVERITY policy (which gap is blocking vs degraded) and the
// UA classifier, not the browser internals.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
    _resetForTests,
    capabilitySignature,
    classifyWebglRecovery,
    detectCapabilities,
    headlineDegradations,
    identifyBrowser,
} from "./capabilities.js";

interface FakeDocOpts {
    webgl?: boolean;
    /** WebGL1 is available but WebGL2 is not - map-dead, MapLibre needs WebGL2. */
    webgl2?: boolean;
    /** Context exists but shader compile/link fails (broken GPU / software GL). */
    webglCompile?: boolean;
    folderPicker?: boolean;
    h264?: boolean;
    videoEl?: boolean;
    plainInput?: boolean;
}

// Minimal WebGL context stand-in. probeWebGL creates a context, compiles+links a
// trivial program, then releases the context via WEBGL_lose_context. compileOk
// drives getShaderParameter/getProgramParameter so a test can simulate a GPU that
// returns a context but cannot compile shaders.
function fakeGlContext(compileOk: boolean): unknown {
    return {
        VERTEX_SHADER: 1,
        FRAGMENT_SHADER: 2,
        COMPILE_STATUS: 3,
        LINK_STATUS: 4,
        createShader: () => ({}),
        shaderSource: () => {},
        compileShader: () => {},
        getShaderParameter: () => compileOk,
        createProgram: () => ({}),
        attachShader: () => {},
        linkProgram: () => {},
        getProgramParameter: () => compileOk,
        deleteShader: () => {},
        deleteProgram: () => {},
        getExtension: (_name: string) => ({ loseContext: () => {} }),
    };
}

// Minimal document stand-in covering the three elements the probes create.
function fakeDocument(opts: FakeDocOpts = {}): unknown {
    return {
        createElement(tag: string) {
            if (tag === "video") {
                if (opts.videoEl === false) return {};
                return {
                    canPlayType: (_s: string) => (opts.h264 === false ? "" : "maybe"),
                };
            }
            if (tag === "canvas") {
                return {
                    getContext: (type: string) => {
                        if (opts.webgl === false) return null;
                        if (type !== "webgl2" && type !== "webgl") return null;
                        if (type === "webgl2" && opts.webgl2 === false) return null;
                        return fakeGlContext(opts.webglCompile !== false);
                    },
                };
            }
            if (tag === "input") {
                const el: Record<string, unknown> = {};
                // probePlainFileInput sets `input.type = "file"` and checks it stuck.
                // plainInput:false simulates an engine where that assignment is a
                // no-op (the only way the last fallback file-load path can fail).
                if (opts.plainInput === false) {
                    Object.defineProperty(el, "type", { configurable: true, get: () => "text", set: () => {} });
                } else {
                    el.type = "";
                }
                // probeFolderPicker checks `"webkitdirectory" in input`.
                if (opts.folderPicker !== false) el.webkitdirectory = false;
                return el;
            }
            return {};
        },
    };
}

// Stub the full set of globals for a "modern browser" baseline; individual
// tests then knock out one capability to assert the classification.
function stubModernBrowser(over: Partial<Record<string, unknown>> = {}, docOpts: FakeDocOpts = {}): void {
    const defaults: Record<string, unknown> = {
        isSecureContext: true,
        Worker: class {},
        WebAssembly: {},
        VideoDecoder: class {},
        VideoEncoder: class {},
        MediaSource: class {},
        OffscreenCanvas: class {},
        showSaveFilePicker: () => {},
        structuredClone: (x: unknown) => x,
        DataTransferItem: function DataTransferItem() {} as unknown,
        navigator: { userAgent: "Mozilla/5.0 Chrome/130.0 Safari/537.36", serviceWorker: {}, maxTouchPoints: 0 },
        document: fakeDocument(docOpts),
    };
    // webkitGetAsEntry lives on the prototype.
    (defaults.DataTransferItem as { prototype: Record<string, unknown> }).prototype = { webkitGetAsEntry: () => {} };
    const merged = { ...defaults, ...over };
    for (const [k, v] of Object.entries(merged)) {
        if (v === undefined) {
            vi.stubGlobal(k, undefined);
        } else {
            vi.stubGlobal(k, v);
        }
    }
}

describe("detectCapabilities", () => {
    beforeEach(() => {
        _resetForTests();
    });
    afterEach(() => {
        vi.unstubAllGlobals();
        _resetForTests();
    });

    it("modern browser: ok, no blocking, no degraded", () => {
        stubModernBrowser();
        const report = detectCapabilities();
        expect(report.ok).toBe(true);
        expect(report.blocking).toEqual([]);
        expect(report.degraded).toEqual([]);
    });

    it("no Worker → blocking, not ok", () => {
        stubModernBrowser({ Worker: undefined });
        const report = detectCapabilities();
        expect(report.ok).toBe(false);
        expect(report.blocking).toContain("webWorker");
    });

    it("no <video> element → blocking, not ok", () => {
        stubModernBrowser({}, { videoEl: false });
        const report = detectCapabilities();
        expect(report.ok).toBe(false);
        expect(report.blocking).toContain("videoElement");
    });

    it("no folder picker + no DnD entries + no plain file input → fileLoad blocking", () => {
        // The only blocking probe with a composite OR (folderPicker || dndEntries
        // || plainInput). DataTransferItem present but its prototype lacks
        // webkitGetAsEntry → dndEntries false; folderPicker + plainInput off too.
        stubModernBrowser(
            { DataTransferItem: function DataTransferItem() {} },
            { folderPicker: false, plainInput: false },
        );
        const report = detectCapabilities();
        expect(report.ok).toBe(false);
        expect(report.blocking).toContain("fileLoad");
    });

    it("no WebCodecs (decode+encode) → degraded, still ok", () => {
        stubModernBrowser({ VideoDecoder: undefined, VideoEncoder: undefined });
        const report = detectCapabilities();
        expect(report.ok).toBe(true);
        expect(report.degraded).toContain("webCodecsDecode");
        expect(report.degraded).toContain("webCodecsEncode");
    });

    it("no WebGL at all → degraded (map), still ok", () => {
        stubModernBrowser({}, { webgl: false });
        const report = detectCapabilities();
        expect(report.ok).toBe(true);
        expect(report.degraded).toContain("webgl");
    });

    it("WebGL1 only (no WebGL2) → degraded (map), still ok", () => {
        // MapLibre has no WebGL1 path, so a working WebGL1 context is worth
        // nothing to the map - the probe must not be fooled by it.
        stubModernBrowser({}, { webgl2: false });
        const report = detectCapabilities();
        expect(report.ok).toBe(true);
        expect(report.degraded).toContain("webgl");
    });

    it("WebGL context exists but shader compile fails → degraded (map), still ok", () => {
        // The real-world case behind the Sentry "Could not compile fragment shader"
        // crash: a Windows/ANGLE or software GL returns a context (so the old
        // create-only probe passed) but cannot compile shaders, so MapLibre threw
        // uncaught on its first render. The probe now compiles a trivial program and
        // degrades gracefully instead.
        stubModernBrowser({}, { webglCompile: false });
        const report = detectCapabilities();
        expect(report.ok).toBe(true);
        expect(report.degraded).toContain("webgl");
    });

    it("no folder picker (iOS-like) but file input present → degraded folderPicker, fileLoad still ok", () => {
        stubModernBrowser({}, { folderPicker: false });
        const report = detectCapabilities();
        expect(report.degraded).toContain("folderPicker");
        // A plain <input type=file> still works, so loading is possible.
        expect(report.blocking).not.toContain("fileLoad");
    });

    it("confidently-negative H.264 probe → degraded h264Decode", () => {
        stubModernBrowser({}, { h264: false });
        const report = detectCapabilities();
        expect(report.degraded).toContain("h264Decode");
    });

    it("insecure context → degraded secureContext, still ok", () => {
        stubModernBrowser({ isSecureContext: false });
        const report = detectCapabilities();
        expect(report.ok).toBe(true);
        expect(report.degraded).toContain("secureContext");
    });

    it("memoized: repeated calls return the same object", () => {
        stubModernBrowser();
        const a = detectCapabilities();
        const b = detectCapabilities();
        expect(a).toBe(b);
    });

    it("capabilitySignature lists every capability with 0/1", () => {
        stubModernBrowser({ VideoEncoder: undefined });
        const sig = capabilitySignature(detectCapabilities());
        expect(sig).toContain("webCodecsEncode:0");
        expect(sig).toContain("webWorker:1");
    });
});

describe("headlineDegradations", () => {
    beforeEach(() => _resetForTests());
    afterEach(() => {
        vi.unstubAllGlobals();
        _resetForTests();
    });

    it("includes map/editor gaps, excludes invisible ones", () => {
        // Knock out webgl (headline) and decode (headline); serviceWorker is
        // info-only so it is never a headline.
        stubModernBrowser({ VideoDecoder: undefined, serviceWorker: undefined }, { webgl: false });
        const report = detectCapabilities();
        const headline = headlineDegradations(report);
        expect(headline).toContain("webgl");
        expect(headline).toContain("webCodecsDecode");
        expect(headline).not.toContain("serviceWorker");
    });
});

// classifyWebglRecovery: only called when WebGL is already degraded, decides
// whether the gap is a fixable setting (-> "turn the map on" modal) or a genuine
// capability gap (-> quiet notice). Layers a software-renderer string, a WebGPU
// adapter cross-check, and a desktop+recognized-browser heuristic.
const DESKTOP_CHROME_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36";
const IPHONE_UA =
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

// Renderer-info constants (UNMASKED_RENDERER_WEBGL = 0x9246, RENDERER = 0x1f01);
// the fake returns the same string for either parameter.
function glWithRenderer(renderer: string | null): unknown {
    return {
        RENDERER: 0x1f01,
        getExtension: (name: string) => {
            if (name === "WEBGL_debug_renderer_info") return { UNMASKED_RENDERER_WEBGL: 0x9246 };
            if (name === "WEBGL_lose_context") return { loseContext: () => {} };
            return null;
        },
        getParameter: (p: number) => (p === 0x9246 || p === 0x1f01 ? renderer : null),
    };
}

function stubWebglRecoveryEnv(opts: { gl?: unknown; ua?: string; gpuAdapter?: "present" | "null" | "none" }): void {
    const ua = opts.ua ?? DESKTOP_CHROME_UA;
    const gpu =
        opts.gpuAdapter === "present"
            ? { requestAdapter: async () => ({}) }
            : opts.gpuAdapter === "null"
              ? { requestAdapter: async () => null }
              : undefined;
    vi.stubGlobal("document", {
        createElement: (tag: string) => (tag === "canvas" ? { getContext: () => opts.gl ?? null } : {}),
    });
    vi.stubGlobal("navigator", { userAgent: ua, gpu, maxTouchPoints: /iPhone|iPad/.test(ua) ? 5 : 0 });
}

describe("classifyWebglRecovery", () => {
    afterEach(() => vi.unstubAllGlobals());

    it("software renderer (SwiftShader) -> recoverable, hardware acceleration off", async () => {
        stubWebglRecoveryEnv({ gl: glWithRenderer("Google SwiftShader"), gpuAdapter: "none" });
        const v = await classifyWebglRecovery();
        expect(v.recoverable).toBe(true);
        expect(v.reason).toBe("softwareRendering");
        expect(v.renderer).toBe("Google SwiftShader");
    });

    it("software renderer (llvmpipe) -> recoverable, softwareRendering", async () => {
        stubWebglRecoveryEnv({
            gl: glWithRenderer("Mesa/X.org -- llvmpipe (LLVM 15.0.6, 256 bits)"),
            gpuAdapter: "none",
        });
        const v = await classifyWebglRecovery();
        expect(v.recoverable).toBe(true);
        expect(v.reason).toBe("softwareRendering");
    });

    it("no context + WebGPU adapter present -> recoverable, gpuAlive", async () => {
        // The blocklist case: WebGL is dead but a live GPU answers WebGPU, so the
        // failure is config/policy, not a missing GPU.
        stubWebglRecoveryEnv({ gl: null, gpuAdapter: "present" });
        const v = await classifyWebglRecovery();
        expect(v.recoverable).toBe(true);
        expect(v.reason).toBe("gpuAlive");
    });

    it("no context + no WebGPU + desktop Chrome -> recoverable via modernDesktop heuristic", async () => {
        // The most common recoverable case (acceleration off on Chromium) yields a
        // null context and no readable signal; only desktop+real-browser saves it.
        stubWebglRecoveryEnv({ gl: null, gpuAdapter: "none", ua: DESKTOP_CHROME_UA });
        const v = await classifyWebglRecovery();
        expect(v.recoverable).toBe(true);
        expect(v.reason).toBe("modernDesktop");
    });

    it("hardware renderer name but WebGL broken + desktop -> modernDesktop, not softwareRendering", async () => {
        stubWebglRecoveryEnv({
            gl: glWithRenderer("ANGLE (NVIDIA, NVIDIA GeForce RTX 3080 Direct3D11 vs_5_0 ps_5_0, D3D11)"),
            gpuAdapter: "none",
        });
        const v = await classifyWebglRecovery();
        expect(v.recoverable).toBe(true);
        expect(v.reason).toBe("modernDesktop");
        expect(v.renderer).toContain("RTX 3080");
    });

    it("no context + no WebGPU + mobile Safari -> NOT recoverable (absent)", async () => {
        stubWebglRecoveryEnv({ gl: null, gpuAdapter: "none", ua: IPHONE_UA });
        const v = await classifyWebglRecovery();
        expect(v.recoverable).toBe(false);
        expect(v.reason).toBe("absent");
    });

    it("WebGPU requestAdapter resolving null is NOT treated as a live GPU", async () => {
        stubWebglRecoveryEnv({ gl: null, gpuAdapter: "null", ua: IPHONE_UA });
        const v = await classifyWebglRecovery();
        expect(v.recoverable).toBe(false);
        expect(v.reason).toBe("absent");
    });

    it("unknown browser, no signal -> NOT recoverable (absent)", async () => {
        stubWebglRecoveryEnv({ gl: null, gpuAdapter: "none", ua: "SomeRandomBot/1.0" });
        const v = await classifyWebglRecovery();
        expect(v.recoverable).toBe(false);
        expect(v.reason).toBe("absent");
    });
});

describe("identifyBrowser", () => {
    it("Chrome on Windows", () => {
        const b = identifyBrowser(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
        );
        expect(b.engine).toBe("blink");
        expect(b.name).toBe("Chrome");
        expect(b.os).toBe("windows");
        expect(b.isMobile).toBe(false);
    });

    it("Edge before Chrome (UA contains both)", () => {
        const b = identifyBrowser(
            "Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 Edg/130.0",
        );
        expect(b.name).toBe("Edge");
        expect(b.engine).toBe("blink");
    });

    it("Firefox on Linux", () => {
        const b = identifyBrowser("Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0");
        expect(b.engine).toBe("gecko");
        expect(b.name).toBe("Firefox");
        expect(b.os).toBe("linux");
    });

    it("Safari on iPhone", () => {
        const b = identifyBrowser(
            "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
        );
        expect(b.engine).toBe("webkit");
        expect(b.name).toBe("Safari");
        expect(b.os).toBe("ios");
        expect(b.isMobile).toBe(true);
    });

    it.each([
        ["Firefox", "FxiOS/130.0"],
        ["Edge", "EdgiOS/130.0"],
        ["Chrome", "CriOS/130.0.0.0"],
    ])("keeps %s branding while recognizing its iOS WebKit engine", (name, token) => {
        const b = identifyBrowser(
            `Mozilla/5.0 (iPhone; CPU iPhone OS 16_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) ${token} Mobile/15E148 Safari/605.1.15`,
        );
        expect(b).toEqual({ engine: "webkit", name, os: "ios", isMobile: true });
    });

    it("Safari on macOS", () => {
        const b = identifyBrowser(
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
        );
        expect(b.engine).toBe("webkit");
        expect(b.name).toBe("Safari");
        expect(b.os).toBe("macos");
    });
});
