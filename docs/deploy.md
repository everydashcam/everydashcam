# Official deployment runbook

This document operates the official everydashcam.app and beta.everydashcam.app
deployments. It is a maintainer runbook for everydashcam's own
infrastructure, not a recipe for launching another public instance. For a
personal or internal installation, use [the self-hosting guide](self-hosting.md).

## Pages project and build

The `everydashcam` Pages project uses
[Direct Upload](https://developers.cloudflare.com/pages/get-started/direct-upload/).
GitHub Actions builds the site and Wrangler uploads the resulting `dist/`.

| Setting | Value |
|---------|-------|
| Pages project | `everydashcam` |
| Production branch | `release` |
| Preview branch | `main` |
| Build command in Actions | `npm run build` |
| Upload directory | `dist` |
| Node.js version | `.nvmrc` |

Build variables and secrets belong in GitHub Actions. The workflow `env:`
blocks and `.env.example` define the current contract:

- `VITE_SENTRY_DSN` enables crash reporting in production;
  `VITE_SENTRY_DSN_STAGING` does the same for staging. An absent or empty DSN
  compiles the SDK out. The built CSP permits only the configured ingest origin.
- `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, and `SENTRY_PROJECT` enable production
  source-map upload; staging uses `SENTRY_PROJECT_STAGING`. Upload is bounded
  and non-fatal. Web builds publish source maps for DevTools independently of
  Sentry credentials; maps stay out of the PWA precache. Portable HTML omits them.
  The upload command uses the explicit `@sentry/cli` dependency in
  [package.json](../package.json), independently of the bundler plugin's internal CLI.
- `INDEXNOW_KEY` enables the production ownership file and post-deploy ping.
  Its storage and rotation rules live in [the SEO guide](seo.md#indexnow).
- `DEPLOYMENT_PROFILE`, `SEO_CUTOVER`, and `SEO_MIRROR_CONFIG` control the
  build-time search policy. Regional pairs require the same `regionalHreflangs`
  map and source revision in both builds. Validate both artifacts before a
  coordinated cutover; see [regional deployment profiles](seo.md#regional-deployment-profiles).
  Keep the actual mirror configuration in private deployment settings.

The production Pages alias is `https://everydashcam.pages.dev`. Publishing
uses the workflows below; dashboard build settings do not build this project.

## Deployment pipeline (who does what)

The official deployment is two-tier, with one working branch:

- **`main`** is the only branch anyone commits to. Every push deploys
  staging: `deploy.yml` builds with the staging env and uploads `dist/` as a
  `main` branch deployment, reachable via the branch alias
  `main.everydashcam.pages.dev` - the staging domain (beta.everydashcam.app) is a
  CNAME to that alias (see "Staging domain" below).
- **`release`** is machine-managed: only the `promote` job of `release.yml`
  moves it, fast-forwarding to the commit a `v*` tag points at, so the repo
  records what production runs (it also creates the branch on the first
  promotion). Never commit to or force-push it by hand. The name doubles as
  the Pages project's production branch: the production deploy uploads with
  `--branch=release`, and matching the project's production-branch setting is
  what marks a deployment *production* rather than *preview*.

GitHub Actions owns the whole chain; the Pages project only serves what is
uploaded:

- `ci.yml` - typecheck / lint / unit / e2e on pushes to `main` and PRs.
- `deploy.yml` - staging build + `wrangler pages deploy` on every `main` push.
- `release.yml` (on `v*` tags) - the production build + deploy, the `release`
  promote, the self-host artifacts, and the chained IndexNow ping.
- `indexnow.yml` - the manual re-ping button.

Wrangler deploys to the Direct Upload project by name with
`CLOUDFLARE_API_TOKEN` (custom token, permission "Cloudflare Pages: Edit") +
`CLOUDFLARE_ACCOUNT_ID` - both GH Actions secrets; without them the deploy
jobs self-skip. Build env vars live in the workflow files, not the CF dashboard
- the `env:` blocks of `deploy.yml` and the `deploy` job of `release.yml` are
the current set.

Deployment constraints:

- **Production requires successful CI on the tagged commit.** Wait for CI on
  `main` before tagging. Staging remains independent of CI. Release preflight
  rules live in `scripts/check-release-state.mjs`; a failed preflight publishes
  nothing. If CI is still running, wait for it to pass before retrying the run.
- **The IndexNow ping must run post-deploy**, never as a build step: engines
  fetch the submitted URLs and the key file when they process a ping, so the
  script reads the live sitemap, not `dist/`. It runs as the `ping` job
  chained after `deploy` in release.yml - its failure cannot fail the deploy
  it follows. Secrets: where `INDEXNOW_KEY` lives, why it is in no file, and
  how the ping pre-flights it - `docs/seo.md`, "IndexNow".
- A deployment can briefly serve new HTML before its assets are available.
  First visits use bounded startup recovery. Controlled launches use the complete
  shell installed with their active service worker; incomplete updates never
  replace it. Updates wait until all controlled windows close, preserving local
  recordings and running exports. A ready-update notice asks users to finish work,
  close all app windows and tabs, and reopen. Refresh alone need not activate an update.
- The build emits `deployment-assets.json` for the current release's code,
  bundled media, map styles/sprites and inference binaries. Bundled filenames come
  from Vite output; stable public assets have a separate inventory and may change.
  The deployment workflows run `scripts/retain-deployment-assets.mts` against the
  currently published origin
  before uploading. It verifies and copies the previous release's immutable
  files, excluding HTML, service workers and configuration. Its `files` list stays
  current-only; `retainedFiles` records the copied generation for cleanup when a
  recovery artifact is reused. For hosts that replace files individually, a
  `publication: "publishing"` manifest protects both inventories until all pages
  and the service worker have been uploaded and the host writes `"complete"`.
  Retention carries both inventories from an interrupted publication; after a
  completed publication a new generation retains only that release's `files`.
  Retrying the same generation preserves its already retained predecessor.
  Atomic hosts need no intermediate manifest. Transient network failures get three bounded
  attempts; missing or corrupt previous assets fail publication instead of silently
  reducing compatibility. A source without a deployment manifest emits a warning
  and retains no previous files; there is no service-worker source parsing fallback.
- Recovery/rollback uses the same retention step before uploading the selected
  hosted artifact: it keeps that artifact's code alongside the currently live
  release. A dashboard-only rollback cannot add newer assets to an old artifact;
  newer tabs may then need to finish work and reopen the app. Do not promise that
  an uncached asset from an arbitrarily old tab remains downloadable. Follow
  [Hosted recovery](#hosted-recovery) when restoring an artifact or when the live
  origin cannot supply valid retention data.
- Cache Storage is disposable. Workbox installs the complete precache before an
  update can activate, retires obsolete revisions on activation, and bounds
  runtime and tracker caches with expiration. Application code uses native SRI
  on downloads; locale shells use a build marker because the hosting edge can
  append analytics. Cached responses are not rehashed on every read. Online
  navigation restores missing precache entries. Binary readiness separately
  requires size and SHA-256 verification in `src/tracking/asset-loader.ts`, both
  before consent-gated warming finishes and before inference. Settings and notes
  are independent of resource-cache cleanup. Installed Apple web apps can have
  separate storage from browser tabs; each instance checks its own assets.
- Tracker binaries migrate from the legacy cache into Workbox with expiration
  metadata; the source is deleted only after the copy completes. The tracker
  cache uses an entry-count LRU limit, not a byte budget or a release whitelist.
  This preserves recently used binaries for newer pages controlled by an older
  worker and for rollback; it can retain more than two releases. The limit lives
  in `src/sw-tracker-cache.ts`, and quota errors can purge this disposable cache.
- Ordinary Vite development does not register an offline worker. Its dev entry
  retires old registrations before importing the app and preserves preferences.
  Inference binaries and runtime glue come from one snapshot; restart Vite after
  replacing dependencies or ONNX models. Map styles and sprites in `public/styles/` remain live during
  development; edit them and reload without restarting. Exercise offline/update
  behavior with production builds.

## Hosted recovery

Use the saved `hosted-dist-primary-<tag>-<attempt>` Actions artifact, which contains
production configuration and portable downloads. The GitHub Release archive is a
separate self-host build. Select the successful run and artifact explicitly:

```sh
recovery_run="<actions-run-id>"
recovery_artifact="hosted-dist-primary-<tag>-<attempt>"
gh run download "$recovery_run" --name "$recovery_artifact" --dir recovery-dist
node --experimental-strip-types scripts/retain-deployment-assets.mts recovery-dist https://everydashcam.app
npx wrangler@4.114.0 pages deploy recovery-dist --project-name=everydashcam --branch=release
node scripts/smoke-portable-downloads.mjs
```

Run these commands from a checkout with the current retention script, Node from
`.nvmrc`, and configured Cloudflare credentials. Verify that the selected artifact
has the release being restored. Older artifacts without the explicit public asset
inventory must be rebuilt with current deployment tooling; the retention script
rejects them instead of guessing which files are immutable. The retention step
adds the currently live release's files so its existing tabs can finish work. Use the equivalent beta
artifact, origin, and `--branch=main` for staging. A recovery upload does not move
the machine-managed `release` branch; the next normal release restores its record.

If live metadata or an old asset is unavailable, use the immutable Cloudflare
deployment URL for that same live release as the retention source. Verify its
release identity before substituting `https://<deployment-id>.everydashcam.pages.dev`
for the origin above. If that deployment is unavailable too, download the live
release's saved hosted artifact into a separate `previous-dist` directory and
serve it locally in another terminal:

```sh
python3 -m http.server 4179 --bind 127.0.0.1 --directory previous-dist
```

Then run the same retention step against `http://127.0.0.1:4179`, followed by the
upload and smoke check. The local source still undergoes manifest, size and hash
validation. Do not silently skip retention or substitute an unrelated release:
without a verified source, compatibility with existing tabs cannot be preserved.
For a transient failure after GitHub Release publication, rerun only the failed
`deploy` job; rerunning the full workflow rejects the already published tag.

## Custom domains

Keep `everydashcam.app` and `www.everydashcam.app` attached to the
`everydashcam` Pages project, with active certificates and proxied CNAMEs to
`everydashcam.pages.dev`. Cloudflare flattens the apex CNAME. The apex serves
the production deployment; `www` redirects to it at the edge.

### Staging domain

After a successful `main` deployment, attach `beta.everydashcam.app` under
Pages -> Custom domains. Once active, set its proxied CNAME target to
`main.everydashcam.pages.dev`. Both the Pages association and the proxied
branch-alias record are required; an unproxied record serves production.
See Cloudflare's [custom branch domain guide](https://developers.cloudflare.com/pages/how-to/custom-branch-aliases/).

### www -> apex redirect

Use a [Single Redirect](https://developers.cloudflare.com/rules/url-forwarding/single-redirects/settings/)
in the `everydashcam.app` zone:

| Setting | Value |
|---------|-------|
| Match expression | `http.host eq "www.everydashcam.app"` |
| Target URL expression | `concat("https://everydashcam.app", http.request.uri.path)` |
| Status | `301` |
| Preserve query string | Enabled |

Keep `www` proxied and retain its Pages custom-domain association. The rule
preserves every path and query string while changing the hostname to the
canonical apex. Check a nested URL after changing the rule:

```sh
curl -sI "https://www.everydashcam.app/en/cameras/70mai/?ref=test"
# expect: HTTP/2 301
#         location: https://everydashcam.app/en/cameras/70mai/?ref=test
```

## Handling `everydashcam.pages.dev`

Cloudflare hands every project a `pages.dev` subdomain and it cannot be removed.
Options:

### Option A - ignore (default)

Just do not advertise it. The HTML already carries
`<link rel="canonical" href="https://everydashcam.app/">`, so search engines follow
the canonical and do not surface `pages.dev` duplicates.

- **Pro:** nothing to do.
- **Con:** anyone who learns the `everydashcam.pages.dev` URL can open the app there.
  Same content.

### Option B - 301 redirect via a Pages Function

Create `functions/_middleware.js` at the repo root (Cloudflare Pages picks up the
`functions/` folder as middleware/routes automatically):

```js
// functions/_middleware.js
export const onRequest = async ({ request, next }) => {
    const url = new URL(request.url);
    // The production pages.dev URL has exactly one subdomain segment before
    // pages.dev. Preview deploys (for PR/branch) carry a commit-hash prefix -
    // do not redirect those, so they stay reviewable.
    if (url.hostname === "everydashcam.pages.dev") {
        url.hostname = "everydashcam.app";
        return Response.redirect(url.toString(), 301);
    }
    return next();
};
```

- **Pro:** pages.dev visitors land on the custom domain; search engines lose all
  interest in pages.dev.
- **Con:** this adds a production middleware path that must be maintained and
  tested with the rest of the deployment.

### Option C - Cloudflare Access password gate

Pages -> Project settings -> Access -> Configure access policy -> apply to all
preview deployments or to the whole site. You can allow an email list or OTP. Free
for up to 50 users.

- **Pro:** the pages.dev URL becomes private (visible only to invited users).
- **Con:** overkill if you only want it out of public sight; you log in on every
  visit.

## Releases (production deploy + prebuilt self-host artifacts)

A `v*` tag is the single promotion ritual: `.github/workflows/release.yml`
builds and uploads the production site (the `deploy` job - see "Deployment
pipeline"), fast-forwards the `release` branch to the tagged commit, and
publishes one build of `dist/` in
three forms: a versioned zip + a fixed-name `everydashcam.tar.gz`
(plus `SHA256SUMS`) on a GitHub Release, and a container image at
`ghcr.io/everydashcam/everydashcam` (`latest` + the tag; packaged from the same
already-built `dist/` via `docker/Dockerfile.prebuilt`, not an in-Docker
rebuild). The fixed asset name is load-bearing: the install one-liner in
`docs/self-hosting.md` relies on `releases/latest/download/`. The
artifact build gets no env vars, so crash reporting is compiled out (the
production site build in the `deploy` job carries the production env). The
release notes are generated at tag time from the user-facing changelog.
See `.claude/skills/release/SKILL.md` for release preparation. To cut a release,
tag the `main` commit staging has validated:

```sh
git fetch origin
git tag v2026.07.25 origin/main   # convention: v<yyyy>.<mm>.<dd>[.<n>], zero-padded
git push origin v2026.07.25
```

A manual run of the workflow (workflow_dispatch) builds the same archives as
a run artifact without publishing a release or pushing an image - use it to
dry-run the pipeline.

Portable HTML is built and tested once, then shared by the GitHub Release and
the primary website. Production deployment follows release publication so its
download links and update metadata cannot advertise an unpublished release.
Website download links use stable locale URLs such as
`/downloads/portable/en.html`, with a temporary 302 redirect to the current
versioned artifact. Deployments and recovery artifacts contain only the current
portable files; archived versions remain in GitHub Releases. Update metadata
keeps the versioned paths understood by previously downloaded portable files.
Hosts that do not apply `_redirects` must publish the current artifact under
the same stable path themselves; the Object Storage mirror uploads it as a
revalidating copy. See `vite-plugins/portable-downloads.ts` and
`scripts/smoke-portable-downloads.mjs` for publication and download verification.

The ghcr.io package is created by the first tag run and keeps the visibility it
had then - it is never re-synced with the repo, so check package Settings after
any visibility change or a private repo leaves users with a failing `docker
pull`. The package is account-scoped and outlives the repository: deleting the
repo leaves it orphaned, and a re-created repo's `GITHUB_TOKEN` cannot push into
that namespace until the package is deleted or granted Actions access to the new
repo. The image push runs *before* the release is published, so this failure
mode costs the whole release, and a `workflow_dispatch` dry-run does not catch
it (it builds without pushing).

### Release integrity

One-time setup, before the first tag: repo Settings -> General -> Releases ->
enable **release immutability**. Published releases then get platform-locked
assets and tags (nothing - including this account - can swap a published zip
or move its tag), plus an auto-generated signed release attestation.
Consequences the workflow is built around:

- Assets lock at publish time, so the workflow attaches them to a draft and
  publishes once. A published release can never be updated: to re-release,
  cut a new tag (`v2026.07.25` -> `v2026.07.25.1`); a re-run on a released tag
  fails on purpose.
- The workflow also attests build provenance
  (`actions/attest-build-provenance`, the assets listed in that step's
  `subject-path` bound to this repo/workflow/commit via Sigstore). User-facing verification
  commands live in `docs/self-hosting.md`. Attestations are free on public
  repos but require Enterprise Cloud on a private one, so the step is gated on
  repo visibility - a private repo publishes a release without provenance
  rather than failing the job.
- Optional defense-in-depth: a tag ruleset on `v*` (Settings -> Rules:
  Restrict deletions + Block force pushes) protects not-yet-released tags;
  note a repo admin can delete the ruleset, so it guards against accidents,
  not a compromised owner - the immutability above is the real lock.

## What the repo ships for deployment

- `vite.config.ts` - the production build (minifiers, vendor splitting, the
  SEO/SW/CSP plugin chain, public source maps and `SENTRY_*`-gated instrumentation).
  Each choice is commented at its site in the file.
- `public/_headers` - cache-control + security headers + CSP in enforce mode
  (the current allowlist and its rationale live in the file itself).
- `src/sw.ts` - Workbox service worker. `vite-plugin-pwa` bundles it and injects
  the final precache manifest through `vite-plugins/sw-precache.ts`.
- `public/manifest.webmanifest` - PWA-installable.
- `public/fonts/` - self-hosted woff2 fonts (generated by `node scripts/fetch-fonts.mjs`).
- `.nvmrc` - the Node version used by the GitHub Actions builds.

## What is not needed

- A hand-written `_redirects` - the build already emits `dist/_redirects`
  (legacy `/cameras/` 301s, see `vite-plugins/redirects.ts`), and the app is a
  single page with no client-side routing, so no SPA-fallback entry is needed
  on top. (`_redirects` in CF Pages cannot filter by host - for a
  `pages.dev -> custom domain` redirect use Option B above.)
- Cloudflare Workers outside Pages - it is static assets plus optional middleware,
  there is no backend.
- API keys for core functionality - viewing and export run locally.
  `VITE_SENTRY_DSN` is public, not secret (it is visible in the bundle
  anyway), kept in env only for multi-environment convenience.
