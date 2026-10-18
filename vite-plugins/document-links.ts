/** Localize shared document links before a hosted or portable page is emitted. */
export function localizeDocumentLinks(html: string, localeSegment: string): string {
    return html.replace(
        /href="\/(?:en\/)?(privacy|terms|add-my-camera)\/?"/g,
        (_match, slug: string) => `href="/${localeSegment}/${slug}/"`,
    );
}
