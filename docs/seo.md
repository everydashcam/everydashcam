# SEO and URL structure

## URL structure and root redirect

All locale homes, including English, live under `/<lang>/`. Explicit locale
URLs win over saved/browser preferences and remain share-safe. Sources:
[SEO locale config](../src/i18n/seo-config.ts) and
[banner copy](../src/i18n/banner-copy.ts).

- `/` is a locale-selection stub. Its canonical/meta refresh targets the host's
  fallback locale; the client can honor a saved/browser language. Roots stay
  outside sitemap and hreflang.
- Camera pages use `/<lang>/cameras/<slug>/`. Legacy `/cameras/<slug>/`
  redirects to English through generated `_redirects`.
- Privacy, terms and add-my-camera pages use `/<lang>/<document>/` and publish
  only available translations. Explicit locale paths override `?lang=` too.
  Old extension-less addresses select by query, saved preference, then browser
  language; these stubs stay outside sitemap/hreflang.
- Navigation stays on the current host. `hreflang` describes translations
  actually published, including self; `x-default` is the primary English
  version of the same page. HTML and sitemap use the same
  [alternate graph](../vite-plugins/seo-alternates.ts).

Localized documents remain outside service-worker precache; serve their directory
indexes rather than the app shell. Generation and language switching live in
[document-pages.ts](../vite-plugins/document-pages.ts),
[document metadata](../vite-plugins/document-pages-meta.ts) and
[doc-lang.js](../public/doc-lang.js).

## Regional deployment profiles

[deployment-profile.ts](../vite-plugins/deployment-profile.ts) owns build-time
policy. Runtime locale selection does not read private deployment configuration.
Export these variables in the build process; unprefixed Vite dotenv values do
not populate `process.env`.

| Configuration | Search policy |
| --- | --- |
| No mirror configuration | Primary-only site |
| Mirror without `SEO_CUTOVER=1` | Crawlable noindex canary with primary canonicals |
| Cutover without `regionalHreflangs` | Single-owner locale policy for migration compatibility |
| Cutover with `regionalHreflangs` | Both hosts indexable, self-canonical, with a shared regional graph |
| `VITE_NO_INDEX=1` | Staging noindex overrides production policy |

`SEO_MIRROR_CONFIG` supplies `origin`, `localeSegments`, `rootLocaleSegment`
and optional `regionalHreflangs`. In regional mode, the list/map must cover every
indexable locale in `SEO_LOCALES`. Region codes must match each language/script
and be unique across the full graph, including primary aliases. Adding a locale
without its regional pair fails the build.

Synthetic configuration examples live in
[profile tests](../src/i18n/deployment-profile.test.ts) and the
[regional build check](../scripts/test-seo-regional.mjs). Actual mirror settings
stay private.

Build both profiles from the same revision and regional map, with `SEO_CUTOVER=1`,
changing only `DEPLOYMENT_PROFILE`. Each sitemap lists its own host; canonical,
OG, structured data and breadcrumbs describe that regional page. Keep robots
crawlable even for staging/canary, so crawlers can see noindex meta/headers.
Technical noindex pages keep their own policy.

Validate both saved artifacts together:

```sh
npm run check:seo -- /path/to/primary /path/to/mirror
```

`npm run test:seo-regional` checks a synthetic pair. A single-artifact check
cannot confirm the other host's content. Publish through the
[deployment runbook](deploy.md) with a coordinated configuration switch; avoid
one host advertising a graph the other does not publish. Check live HTML,
headers, robots and sitemaps on both hosts afterwards.

Regional annotations are hints, not per-user routing or a ranking guarantee.
Retain HTML alternates as well as sitemap entries. References:
[Google localized pages](https://developers.google.com/search/docs/specialty/international/localized-versions),
[regional sites](https://developers.google.com/search/docs/specialty/international/managing-multi-regional-sites),
[Yandex locale pages](https://yandex.ru/support/webmaster/en/yandex-indexing/locale-pages).

## Content and modification dates

Camera claims follow [GPS evidence](gps-format-coverage.md). Every published
locale needs reviewed camera-specific copy; missing translations fail the build.
Keep homepage examples bounded and local to the page language, linking to the
full catalog. Catalog cards without a local landing explicitly link to English.

Canonical URLs and `lastmod` follow [CLAUDE.md](../CLAUDE.md#seo).
Only independently trackable URL sources receive modification dates. Page
families sharing monolithic content files omit dates rather than marking every
page changed. [git-mtime.ts](../vite-plugins/git-mtime.ts) handles shallow history
and omits dates when history cannot be recovered. Check emitted dates after
changing this logic.

## Verification after deployment

The build runs [check-seo.mjs](../scripts/check-seo.mjs); use `npm run check:seo`
for existing output. Then:

- Inspect representative pages from each changed family/language and both hosts
  in [Search Console](https://support.google.com/webmasters/answer/9012289): fetched
  HTML, rendered content, eligibility and selected canonical.
- Submit each host's own sitemap and monitor exclusions. Submission does not
  guarantee indexing.
- Check [rich results](https://search.google.com/test/rich-results) against visible
  content; never invent ratings/reviews. Valid markup does not guarantee a search
  enhancement.
- Use field Core Web Vitals and query/page/device performance for follow-up.
  Local test success does not establish real-user performance or search demand.
- Verify missing URLs return HTTP 404 and legacy URLs redirect correctly. Use
  the top-level 404 page; `_redirects` cannot provide a 404 rewrite.

## IndexNow

The `INDEXNOW_KEY` Actions secret feeds the ownership-file build plugin and
post-deploy ping. Keep the value and its URL out of the repository, logs,
sitemap, robots and service-worker precache. The served ownership file is
unlinked; serving it does not authorize publishing the secret elsewhere.

The release workflow pings only after production deployment, using the live
sitemap. For a regional host, set `INDEXNOW_ORIGIN` and its matching ownership
key. Staging must never be pinged. The script verifies the live ownership file
before submitting, so a half-deployed key rotation fails clearly.

For an ad-hoc re-ping use [indexnow.yml](../.github/workflows/indexnow.yml), or
`npm run indexnow` with credentials supplied through the environment.
[scripts/indexnow-ping.mjs](../scripts/indexnow-ping.mjs) owns engine endpoints,
retry and status handling. Direct submissions retain per-engine visibility;
a successful ping does not prove indexing.

To rotate a disclosed key:

1. Generate a new value with `openssl rand -hex 16`.
2. Replace the Actions secret for the affected host.
3. Deploy a new production release. Verify its ownership file and chained ping;
   the old ownership file need not remain available.

Google discovery uses Search Console and sitemaps rather than IndexNow.

## Implementation entry points

- [Prerender and sitemap](../vite-plugins/seo-prerender.ts).
- [Camera pages](../vite-plugins/vendor-pages.ts),
  [brand locales](../vite-plugins/supported-brands.ts),
  [homepage selection](../vite-plugins/camera-promotion.ts),
  [catalog](../vite-plugins/camera-catalog.ts).
- [Alternative pages](../vite-plugins/alternative-pages.ts) and
  [feature pages](../vite-plugins/feature-pages.ts).
- [Redirects](../vite-plugins/redirects.ts),
  [ownership file](../vite-plugins/indexnow-key.ts),
  [llms.txt](../vite-plugins/llms-txt.ts).
- Static no-JavaScript content lives in [index.html](../index.html) and is
  localized by prerender.
