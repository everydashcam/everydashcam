// PII scrubbing for the Sentry sink. This is the SECOND line of defence:
// curated captures (src/sentry.ts) build allowlisted payloads by hand, but
// breadcrumbs forwarded from the central logger and any raw exception message
// can still carry user data. The project contract is "video never leaves your
// machine" and the ring buffer logs file names / paths WITHOUT filtering (it is
// local). Sentry is the one sink that crosses the network, so everything that
// flows into it passes through here first.
//
// Strategy: a denylist deep-walk that
//  - drops coordinate-bearing keys outright (lat/lon are the most sensitive);
//  - masks file-name / path keys to their extension or a placeholder;
//  - runs every free string through scrubMessage (strips embedded file names,
//    absolute paths, blob URLs, long digit runs that encode timestamps/serials).
//
// All functions are pure and DOM-free so they are unit-tested in the node
// vitest environment (see sentry-scrub.test.ts).

// Media / sidecar extensions the app handles. A bare filename ending in one of
// these is masked to "***.<ext>" - the extension is diagnostically load-bearing
// (drives codec/container expectations) while the basename (which encodes the
// recording date/time, sometimes a serial, and free user text) is the PII.
const MEDIA_EXT =
    "mp4|m4v|mov|ts|m2ts|avi|mkv|webm|insv|360|jdr|chk|lrv|gpx|nmea|map|gps|3gf|rvmi|csv|txt|json|jpg|jpeg|png|webp|everydashcam|dashcamigo";
const MEDIA_EXTENSION_RE = new RegExp(`\\.(${MEDIA_EXT})$`, "i");

// Unquoted filenames cannot be separated reliably from surrounding prose when
// they contain spaces. Keep user filenames in structured fields at call sites.
const FILENAME_RE = new RegExp(`[^\\s/\\\\:"'<>|?*=]+\\.(${MEDIA_EXT})\\b`, "gi");
const QUOTED_FILENAME_RE = new RegExp(`(["'\x60])(?:(?!\\1)[^\\r\\n])+\\.(${MEDIA_EXT})\\1`, "gi");
const WIN_PATH_RE = /[A-Za-z]:[/\\][^\s"')]+/g;
// Unix paths under user/volume roots - the segments that carry a person's name
// or a labeled SD card.
const UNIX_PATH_RE = /\/(?:Users|home|Volumes|media|mnt|storage|var|private|tmp|root|sdcard)\/[^\s"')]+/gi;
// Opaque object URLs - no PII by themselves but noise and origin-correlatable.
const BLOB_URL_RE = /blob:[^\s"')]+/gi;
const FILE_URL_RE = /file:\/\/[^\s"')]+/gi;
// Map tile paths disclose location even without a query string. General log
// messages need no URL; stack frames retain sanitized asset paths separately.
const RESOURCE_URL_RE = /(?:https?|everydashcam-tile):\/\/[^\s"')]+/gi;
const DATA_URL_RE = /data:[^\s"')]+/gi;
const EMAIL_RE = /[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi;
// A decimal lat,lon pair in free text (>=3 decimals each, to avoid masking
// innocuous small decimals). We never put coordinates in messages by design,
// but this is a cheap last-ditch guard for a future log line that does.
const COORD_PAIR_RE = /-?\d{1,3}\.\d{3,}\s*,\s*-?\d{1,3}\.\d{3,}/g;
// Runs of 8+ digits encode capture timestamps (20240115...) or serials.
const LONG_DIGITS_RE = /\d{8,}/g;

// Object keys whose value is a coordinate - dropped entirely. Whole-degree
// rounding is the project's anonymize convention, but a crash report has no
// use for location at all, so we drop rather than coarsen.
const DROP_KEY_RE = /^(lat|lon|lng|latitude|longitude|coord|coords|coordinate|coordinates|gps|geo)$/i;
const SECRET_KEY_RE = /^(password|passwd|secret|token|accessToken|apiKey|authorization|cookie|cookies|email)$/i;
// Object keys whose value is a file name / path / URL - masked to extension.
// Deliberately broad and substring-based: ANY key containing "name" (incl.
// `worker_name`, `extractorName`, ...) gets its value masked to "***". When a
// log field / tag carries a known-safe diagnostic identifier, do not loosen
// this regex - name the key so it does not match (e.g. `worker`, `pool`,
// `extractor`). Loosening risks leaking a real file name; renaming costs
// nothing.
const FILENAME_KEY_RE = /(file|name|path|url|src|href|folder|directory)/i;

const MAX_DEPTH = 5;
const MAX_ARRAY = 50;
const MAX_STRING = 1024;

/**
 * Masks a file name / path to a supported media or sidecar extension. Returns
 * "***" for other values, including dotted folder labels and URLs.
 */
export function maskFilename(value: string): string {
    // Take the basename across both separator styles.
    const base = value.split(/[/\\]/).pop() ?? value;
    const extension = MEDIA_EXTENSION_RE.exec(base)?.[1];
    return extension ? `***.${extension.toLowerCase()}` : "***";
}

/**
 * Redacts PII from a free-text string: embedded media file names, absolute
 * paths, blob URLs and long digit runs. Keeps the stable, diagnostic stem of an
 * error message ("demuxer seek failed", "allocation failed"). Truncates to
 * MAX_STRING so a pathological message cannot bloat an event.
 */
export function scrubMessage(input: string): string {
    if (!input) return input;
    // Redact before truncating: cutting a long filename before its extension
    // would otherwise prevent the filename matcher from recognizing it.
    if (input.length > MAX_STRING * 16) return "[message too long]";
    let s = input;
    s = s.replace(
        QUOTED_FILENAME_RE,
        (_match, quote: string, ext: string) => `${quote}***.${ext.toLowerCase()}${quote}`,
    );
    s = s.replace(BLOB_URL_RE, "blob:[redacted]");
    s = s.replace(FILE_URL_RE, "[path]");
    s = s.replace(RESOURCE_URL_RE, "[url]");
    s = s.replace(DATA_URL_RE, "data:[redacted]");
    s = s.replace(WIN_PATH_RE, "[path]");
    s = s.replace(UNIX_PATH_RE, "[path]");
    // Filenames after paths so a path's leaf does not get double-processed in a
    // confusing way (the path is already collapsed to [path]).
    s = s.replace(FILENAME_RE, (m) => {
        const dot = m.lastIndexOf(".");
        return `***.${m.slice(dot + 1).toLowerCase()}`;
    });
    s = s.replace(COORD_PAIR_RE, "[coords]");
    s = s.replace(LONG_DIGITS_RE, "#");
    s = s.replace(EMAIL_RE, "[email]");
    return s.slice(0, MAX_STRING);
}

/**
 * Deep-walks an arbitrary value and returns a scrubbed copy safe to send to
 * Sentry. Drops coordinate keys, masks file-name keys, scrubs every free
 * string, caps depth / array length / string length, and tolerates cycles.
 * Non-plain values (functions, symbols) are stringified to their type.
 */
export function scrubValue(value: unknown): unknown {
    return walk(value, 0, new WeakSet());
}

function walk(value: unknown, depth: number, seen: WeakSet<object>, isFilename = false): unknown {
    if (value === null || value === undefined) return value;
    const t = typeof value;
    if (t === "string") return isFilename ? maskFilename(value as string) : scrubMessage(value as string);
    if (t === "number" || t === "boolean") return value;
    if (t === "bigint") return scrubMessage(`${value}`);
    if (t === "function" || t === "symbol") return `[${t}]`;
    if (depth >= MAX_DEPTH) return "[truncated]";

    if (Array.isArray(value)) {
        if (seen.has(value)) return "[circular]";
        seen.add(value);
        const out = value.slice(0, MAX_ARRAY).map((v) => walk(v, depth + 1, seen, isFilename));
        if (value.length > MAX_ARRAY) out.push(`[+${value.length - MAX_ARRAY} more]`);
        return out;
    }

    if (t === "object") {
        const obj = value as Record<string, unknown>;
        if (seen.has(obj)) return "[circular]";
        seen.add(obj);
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(obj)) {
            if (DROP_KEY_RE.test(k) || SECRET_KEY_RE.test(k.replace(/[_-]/g, ""))) continue;
            const safeKey = MEDIA_EXTENSION_RE.test(k) ? maskFilename(k) : scrubMessage(k);
            out[safeKey] = walk(v, depth + 1, seen, FILENAME_KEY_RE.test(k));
        }
        return out;
    }
    return `[${t}]`;
}

// Minimal structural shapes of the Sentry event/breadcrumb we mutate. Kept
// local (not imported from @sentry/browser) so this module stays a DOM-free,
// dependency-free leaf that the node test environment can import directly.
interface ScrubbableBreadcrumb {
    message?: string;
    category?: string;
    data?: Record<string, unknown>;
    [k: string]: unknown;
}
interface ScrubbableStacktrace {
    frames?: Array<{
        filename?: string;
        abs_path?: string;
        function?: string;
        vars?: unknown;
        pre_context?: unknown;
        context_line?: unknown;
        post_context?: unknown;
        [k: string]: unknown;
    }>;
    [k: string]: unknown;
}
interface ScrubbableEvent {
    message?: string | { formatted?: string; message?: string };
    logentry?: { message?: string; params?: unknown[] };
    request?: { url?: string; method?: string; [k: string]: unknown };
    user?: unknown;
    exception?: {
        values?: Array<{
            type?: string;
            value?: string;
            mechanism?: Record<string, unknown>;
            stacktrace?: ScrubbableStacktrace;
            [k: string]: unknown;
        }>;
    };
    debug_meta?: { images?: Array<{ code_file?: string; debug_file?: string | null; [k: string]: unknown }> };
    breadcrumbs?: ScrubbableBreadcrumb[];
    extra?: Record<string, unknown>;
    contexts?: Record<string, unknown>;
    tags?: Record<string, unknown>;
    // Custom grouping key. Caller-supplied (sentry.ts CaptureContext.fingerprint)
    // and applied to the event by the SDK BEFORE beforeSend, so it is the one
    // field that would otherwise cross the network unscrubbed.
    fingerprint?: string[];
    [k: string]: unknown;
}

/**
 * Scrubs a breadcrumb in place and returns it. Used from beforeBreadcrumb and
 * when forwarding the central logger into Sentry.
 */
export function scrubBreadcrumb<T extends ScrubbableBreadcrumb>(bc: T): T {
    if (typeof bc.message === "string") bc.message = scrubMessage(bc.message);
    if (typeof bc.category === "string") bc.category = scrubMessage(bc.category);
    if (bc.data && typeof bc.data === "object") bc.data = scrubValue(bc.data) as Record<string, unknown>;
    return bc;
}

// Source-map lookup needs the exact asset basename (including numeric hashes).
// Keep HTTP(S) asset locations, but never credentials, query state or local paths.
function scrubSourceLocation(value: string): string {
    const withoutState = value.split(/[?#]/, 1)[0] ?? "";
    if (/^file:/i.test(value) || /^[A-Za-z]:[/\\]/.test(value) || value.search(UNIX_PATH_RE) >= 0) {
        return "[path]";
    }
    if (/^blob:/i.test(value)) return "blob:[redacted]";
    if (/^data:/i.test(value)) return "data:[redacted]";
    if (/^https?:\/\//i.test(withoutState)) {
        try {
            const url = new URL(withoutState);
            url.username = "";
            url.password = "";
            return url.toString();
        } catch {
            return "[url]";
        }
    }
    return withoutState
        .replace(BLOB_URL_RE, "blob:[redacted]")
        .replace(FILE_URL_RE, "[path]")
        .replace(DATA_URL_RE, "data:[redacted]")
        .replace(WIN_PATH_RE, "[path]")
        .replace(UNIX_PATH_RE, "[path]");
}

function scrubStacktrace(stacktrace: ScrubbableStacktrace): void {
    for (const frame of stacktrace.frames ?? []) {
        if (typeof frame.filename === "string") frame.filename = scrubSourceLocation(frame.filename);
        if (typeof frame.abs_path === "string") frame.abs_path = scrubSourceLocation(frame.abs_path);
        if (typeof frame.function === "string") frame.function = scrubMessage(frame.function);
        // Local variables and inline source are unnecessary for uploaded source
        // maps and can contain recording data from generated worker code.
        delete frame.vars;
        delete frame.pre_context;
        delete frame.context_line;
        delete frame.post_context;
    }
}

/**
 * Scrubs a full Sentry error event in place and returns it. Used from
 * beforeSend. Removes private request/user data, scrubs diagnostic fields and
 * retains stack/source-map metadata needed to resolve application frames.
 */
export function scrubEvent<T extends ScrubbableEvent>(event: T): T {
    // Keep only routing metadata. Body, query_string, env, headers and cookies
    // can all disclose private data, regardless of the SDK collection options.
    if (event.request) {
        const { url, method } = event.request;
        event.request = {
            ...(typeof url === "string" ? { url: scrubSourceLocation(url) } : {}),
            ...(typeof method === "string" ? { method: scrubMessage(method) } : {}),
        };
    }
    delete event.user;

    if (typeof event.message === "string") {
        event.message = scrubMessage(event.message);
    } else if (event.message && typeof event.message === "object") {
        if (typeof event.message.formatted === "string")
            event.message.formatted = scrubMessage(event.message.formatted);
        if (typeof event.message.message === "string") event.message.message = scrubMessage(event.message.message);
    }
    if (event.logentry) {
        if (typeof event.logentry.message === "string") event.logentry.message = scrubMessage(event.logentry.message);
        if (event.logentry.params) event.logentry.params = scrubValue(event.logentry.params) as unknown[];
    }

    if (event.exception?.values) {
        for (const v of event.exception.values) {
            if (typeof v.type === "string") v.type = scrubMessage(v.type);
            if (typeof v.value === "string") v.value = scrubMessage(v.value);
            if (v.mechanism) v.mechanism = scrubValue(v.mechanism) as Record<string, unknown>;
            if (v.stacktrace) scrubStacktrace(v.stacktrace);
        }
    }
    for (const image of event.debug_meta?.images ?? []) {
        if (typeof image.code_file === "string") image.code_file = scrubSourceLocation(image.code_file);
        if (typeof image.debug_file === "string") image.debug_file = scrubSourceLocation(image.debug_file);
    }

    if (Array.isArray(event.breadcrumbs)) {
        for (const bc of event.breadcrumbs) scrubBreadcrumb(bc);
    }

    if (event.extra && typeof event.extra === "object") {
        event.extra = scrubValue(event.extra) as Record<string, unknown>;
    }
    if (event.contexts && typeof event.contexts === "object") {
        // Preserve only valid SDK-generated IDs verbatim. The rest of the trace
        // context can contain arbitrary data and needs the same scrubbing.
        const trace = event.contexts.trace;
        event.contexts = scrubValue(event.contexts) as Record<string, unknown>;
        const scrubbedTrace = event.contexts.trace;
        if (trace && typeof trace === "object" && scrubbedTrace && typeof scrubbedTrace === "object") {
            for (const [key, length] of [
                ["trace_id", 32],
                ["span_id", 16],
                ["parent_span_id", 16],
            ] as const) {
                const id = (trace as Record<string, unknown>)[key];
                if (typeof id === "string" && new RegExp(`^[a-f0-9]{${length}}$`, "i").test(id)) {
                    (scrubbedTrace as Record<string, unknown>)[key] = id;
                } else {
                    delete (scrubbedTrace as Record<string, unknown>)[key];
                }
            }
        }
    }
    if (event.tags && typeof event.tags === "object") {
        event.tags = scrubValue(event.tags) as Record<string, unknown>;
    }
    // fingerprint is set by the SDK before beforeSend and is visible in the
    // issue list - scrub it so the "no PII in fingerprint" contract is enforced,
    // not just hand-checked at the call sites.
    if (Array.isArray(event.fingerprint)) {
        event.fingerprint = event.fingerprint.map((f) => (typeof f === "string" ? scrubMessage(f) : f));
    }

    return event;
}
