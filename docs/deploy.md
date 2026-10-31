# Official deployment runbook

Operate the official everydashcam.app and beta.everydashcam.app deployments
with this guide. For personal or internal installations, use
[self-hosting](self-hosting.md).

## Pages project and build

The `everydashcam` Cloudflare Pages project uses Direct Upload: GitHub Actions
builds the site and Wrangler uploads `dist/`. Dashboard build settings do not
build this project. The Pages production branch must be `release`; `main`
is the preview branch. Use Node from [`.nvmrc`](../.nvmrc).

Configuration belongs in GitHub Actions. The workflow `env:` blocks and
[`.env.example`](../.env.example) own the variable contract:

- `CLOUDFLARE_API_TOKEN` needs Cloudflare Pages: Edit; it and
  `CLOUDFLARE_ACCOUNT_ID` are Actions secrets. Deploy jobs skip without them.
- Production and staging use separate Sentry DSNs/projects. An absent DSN
  compiles reporting out. Source-map upload is bounded and non-fatal; hosted
  DevTools maps are published independently and excluded from PWA precache.
  Portable omits maps.
- IndexNow key storage, rotation and post-deploy submission follow
  [SEO](seo.md#indexnow).
- Regional builds must use the same source revision and regional map. Validate
  both artifacts before a coordinated cutover; see
  [deployment profiles](seo.md#regional-deployment-profiles). Actual mirror
  configuration stays in private deployment settings.

## Deployment pipeline

| Entry point | Purpose |
| --- | --- |
| [ci.yml](../.github/workflows/ci.yml) | Required checks for the source revision |
| [deploy.yml](../.github/workflows/deploy.yml) | Every `main` push builds and deploys staging |
| [release.yml](../.github/workflows/release.yml) | A `v*` tag publishes release artifacts and deploys production, followed by `release` promotion and IndexNow |
| [indexnow.yml](../.github/workflows/indexnow.yml) | Manual re-ping without deployment |

Only the release workflow moves the machine-managed `release` branch. Never
commit to it or force-push it. Production requires successful CI on the tagged
commit; staging is independent of CI. Preflight rules live in
[check-release-state.mjs](../scripts/check-release-state.mjs).

Before uploading, workflows run
[retain-deployment-assets.mts](../scripts/retain-deployment-assets.mts) against
the live origin. This keeps the previous release's immutable assets available
to existing tabs. Missing or corrupt previous assets fail publication; a source
without a deployment manifest warns and retains nothing. Never silently bypass
retention to make a failed deployment pass.

For non-atomic hosts, `deployment-assets.json` must remain `publishing` until
all pages and the service worker are uploaded, then become `complete`. Use the
retention script's current/retained inventories; do not infer assets from service
worker source. Atomic hosts do not need an intermediate publication state.

Hosted updates install a complete shell before activation and wait for all
controlled windows to close. Users should finish exports, close all app windows
and tabs, then reopen; refresh alone may not activate an update. Asset retention
covers the predecessor, not arbitrarily old tabs. A dashboard-only rollback
cannot add newer assets to an old artifact: use the recovery procedure below.

Resource caches are disposable; settings and notes must remain independent of
cleanup. Cache policy lives in [sw.ts](../src/sw.ts) and
[sw-tracker-cache.ts](../src/sw-tracker-cache.ts); binary size/hash verification
lives in [asset-loader.ts](../src/tracking/asset-loader.ts).
Exercise offline/update behavior against production builds. Ordinary Vite dev
retires old workers; restart it after replacing inference dependencies or models.

## Hosted recovery

Restore a saved `hosted-dist-primary-<tag>-<attempt>` Actions artifact. It
contains production configuration and portable downloads. The GitHub Release
archive is a separate self-host build and is not a production recovery artifact.
Select the successful run and artifact explicitly:

```sh
recovery_run="<actions-run-id>"
recovery_artifact="hosted-dist-primary-<tag>-<attempt>"
gh run download "$recovery_run" --name "$recovery_artifact" --dir recovery-dist
node --experimental-strip-types scripts/retain-deployment-assets.mts recovery-dist https://everydashcam.app
npx wrangler@4.114.0 pages deploy recovery-dist --project-name=everydashcam --branch=release
node scripts/smoke-portable-downloads.mjs
```

Use a checkout with the current retention script, Node from `.nvmrc`, configured
Cloudflare credentials and the Wrangler version pinned in the deployment
workflow. Verify the artifact's release identity before uploading. Artifacts
without the explicit public-asset inventory need rebuilding with current
deployment tooling. For staging, use the beta artifact, beta origin,
`--branch=main` and the smoke-check environment from `deploy.yml`.

A recovery upload does not move `release`; the next normal release restores
that branch's record. After GitHub Release publication, retry a transient deploy
failure by rerunning only the failed `deploy` job. A full rerun rejects the
already published tag.

If live metadata or an asset is unavailable:

1. Use the immutable Cloudflare deployment URL for the same live release as
   the retention source; verify its release identity first.
2. If that deployment is unavailable too, download the live release's saved
   hosted artifact into a separate `previous-dist` and serve it locally:

   ```sh
   python3 -m http.server 4179 --bind 127.0.0.1 --directory previous-dist
   ```

3. Run retention against `http://127.0.0.1:4179`, then upload and smoke-check.
   Local sources undergo the same manifest, size and hash validation.

Without a verified source, compatibility with existing tabs cannot be preserved.

## Custom domains

- Attach `everydashcam.app` and `www.everydashcam.app` to the Pages project,
  with active certificates and proxied CNAMEs to `everydashcam.pages.dev`.
- Attach `beta.everydashcam.app`, then set its proxied CNAME target to
  `main.everydashcam.pages.dev`. Both the Pages association and the proxied
  branch alias are required; an unproxied record serves production. See
  [Cloudflare's branch-domain guide](https://developers.cloudflare.com/pages/how-to/custom-branch-aliases/).
- Keep `www` attached and proxied, with a zone Single Redirect:

  | Setting | Value |
  | --- | --- |
  | Match | `http.host eq "www.everydashcam.app"` |
  | Target | `concat("https://everydashcam.app", http.request.uri.path)` |
  | Status | `301` |
  | Preserve query string | Enabled |

  Verify a nested URL and its query after changes:

  ```sh
  curl -sI "https://www.everydashcam.app/en/cameras/70mai/?ref=test"
  ```

  Expect 301 to the same path/query on `everydashcam.app`.

The `pages.dev` alias remains available but is not advertised. Canonical policy
is generated by the build; no hostname-redirect middleware is configured here.

## Releases

Follow the [release skill](../.claude/skills/release/SKILL.md) to prepare and
publish. Tags use `v<yyyy>.<mm>.<dd>`, zero-padded, with `.<n>` for additional
releases that day. Tag the pushed `main` commit validated on staging and by CI.
Never overwrite a published release; corrections require a new tag.

The workflow publishes an environment-free self-host build as a versioned zip,
fixed-name `everydashcam.tar.gz`, `SHA256SUMS`, and the GHCR image. The fixed
archive name supports the install URL in [self-hosting](self-hosting.md).
Production uses a separate configured build. Release notes derive from the
user-facing changelog; new entries are optional. A manual workflow run builds
artifacts without publishing a release or pushing an image.

Portable HTML is built/tested once and shared by the Release and primary site.
Release publication precedes production deployment, so links never advertise
unpublished files. Stable `/downloads/portable/<locale>.html` URLs redirect to
current versioned artifacts; recovery artifacts contain only current portable
files, while older versions remain in GitHub Releases. Hosts without `_redirects`
must publish equivalent stable paths. See
[portable-downloads.ts](../vite-plugins/portable-downloads.ts) and
[smoke-portable-downloads.mjs](../scripts/smoke-portable-downloads.mjs).

### Release integrity and registry access

- Enable release immutability in repository settings. The workflow attaches
  assets to a draft, attests them, then publishes once. User verification
  commands live in [self-hosting](self-hosting.md#verify-a-downloaded-release).
- GHCR package visibility and Actions access are independent of repository
  visibility. After a transfer or repository recreation, verify public pulls
  and the new repository's push access. Image push happens before release
  publication; a manual dry run does not exercise registry permissions.
- Workflow provenance attestation is gated on repository visibility. Do not
  promise it for a private-repository build where the step is skipped.

Build/plugin configuration, headers and routing live in
[vite.config.ts](../vite.config.ts), [public/_headers](../public/_headers) and
[vite-plugins/redirects.ts](../vite-plugins/redirects.ts). Use these sources for
changing values; no extra SPA-fallback rule or backend is required.
