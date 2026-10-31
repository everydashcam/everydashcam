// Shared HTML escaping helpers for build-time HTML generation.
//
// Used by both seo-prerender (re-rendering data-i18n / data-i18n-attr in
// the landing) and vendor-pages (generating vendor landing HTML). XSS isn't
// the threat model here - all input is build-time-controlled text from
// our own dicts and vendor data - but proper escaping keeps the output
// HTML5-valid for any future content that may contain `<`, `&` or `"`.

// Escapes < and > as well as the strictly required & and ": a stray "</script>"
// or "<style" inside a double-quoted attribute value is technically valid HTML,
// but keeps naive scanners (and humans) from misreading the markup. One shared
// strict implementation, used by every build-time HTML generator.
export function escapeAttr(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function escapeText(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// JSON.stringify does not escape "<" / "</script>" inside string values. If a
// dict or vendor template ever contains "</script>", the embedded JSON-LD
// payload would prematurely close the surrounding <script> tag and break the
// page. Replacing "<" with the unicode escape keeps the JSON valid for parsers
// and inert as HTML.
export function stringifyJsonLd(value: unknown): string {
    return JSON.stringify(value).replace(/</g, "\\u003c");
}

/** Controlled templates must fail the build when a required marker drifts. */
export function assertHtmlMatchCount(html: string, pattern: RegExp, expected: number, label: string): void {
    const count = Array.from(html.matchAll(new RegExp(pattern.source, `${pattern.flags.replace(/g/g, "")}g`))).length;
    if (count !== expected) throw new Error(`html template: expected ${expected} ${label}, found ${count}`);
}
