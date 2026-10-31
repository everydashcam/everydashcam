# Run everydashcam privately

This guide is for personal and internal installations: a local computer, a home
network or an organization's private server. everydashcam is a static web app, so
you can open a portable HTML, run a prebuilt release, use the Docker image,
copy the files to an internal web server or build the project yourself. Recordings stay in the
browser whichever route you choose.

The project is not distributed as a white-label product. These instructions do
not grant permission to publish a separate service under the everydashcam name,
logo or brand mark. The exact code-license and branding boundary is summarized
at the end of this guide.

If you only want everydashcam to work offline, you may not need to host it.
[everydashcam.app](https://everydashcam.app) can be installed from the browser and
keeps working without a connection after the first visit. Continue below when
you need a private installation you control.

## Choose a setup

- **Node.js is already installed:** [download and run a release](#run-a-release-with-nodejs).
- **You want a file you can open directly:** [use the portable HTML](#open-the-portable-html).
- **You prefer a container:** [run the Docker image](#run-with-docker).
- **You already have nginx, Caddy, a NAS or an internal web server:** download a
  release and follow the [server requirements](#serve-it-on-an-internal-web-server).
- **You want to change the code:** [build from source](#build-from-source).
- **You want Yandex Maps:** [set up your own API key](#enable-yandex-maps).

## Open the portable HTML

The portable edition is a beta distribution.

Choose **Use offline → Download file** on the website, or download the dated HTML
for your language from the [latest release](https://github.com/everydashcam/everydashcam/releases/latest).
Each HTML is a complete application. No server, installation, companion files
or first online visit is needed.

You can keep it on your dashcam's memory card. Connect the card to your computer,
open the HTML in a desktop browser, and select the recordings folder in the app.
Opening the HTML does not grant access to adjacent recordings automatically.
The recorder does not run the application, and formatting the card erases the
HTML along with its other files.

The portable edition includes playback, GPS, charts, notes, manual blur and
clip export. Automatic face/plate detection, object following, PWA installation,
analytics and remote crash reporting are omitted. Editing and export still
depend on the browser's media capabilities; the app explains unavailable
features. The direct-file workflow has been verified in desktop Chromium.
Native save dialogs and direct file opening in Firefox, Safari and mobile
browsers have not been verified.

The map tries online backgrounds automatically. If no provider is reachable,
the route and markers remain visible on a local background; the app retries
when connectivity returns. Select **Route only** to keep the map local.
After startup the app also makes a small, credential-free request to the primary
everydashcam website to check for a
newer portable release. It sends no recording information or local notes.
An unavailable endpoint does not block playback or export and does not mean
your copy is current. The check never downloads a new HTML automatically.

The update notice offers a new dated file. Save and open that file when you are
ready; it does not replace the running copy or reload an open trip. The language
is fixed in each HTML, including after renaming or moving it.

Browser storage is local to that browser and may depend on the file's location.
Copying the HTML does not transfer notes, settings or remembered folder access.
Export your notes file before changing computers, browsers or HTML filenames,
then import it into the new copy. Keep that notes file separately from the HTML;
the app merges imported notes with existing notes. A read-only card can still
be viewed; save exports and notes to a writable location.

Use the [release verification commands](#verify-a-downloaded-release) with the
HTML filename to verify its origin. License texts and third-party notices are
embedded in the HTML.

## Run a release with Node.js

The following commands download the latest release into a `everydashcam` folder
and start a local server.

macOS or Linux:

```sh
curl -fsSL https://github.com/everydashcam/everydashcam/releases/latest/download/everydashcam.tar.gz | tar -xz && npx serve everydashcam
```

Windows PowerShell (`curl.exe` and `tar` are included with current Windows
versions):

```powershell
curl.exe -fsSL https://github.com/everydashcam/everydashcam/releases/latest/download/everydashcam.tar.gz -o everydashcam.tar.gz; tar -xzf everydashcam.tar.gz; npx serve everydashcam
```

Open the local address printed by `npx serve`.

Prefer a regular download? Get `everydashcam-<version>.zip` from the
[latest release](https://github.com/everydashcam/everydashcam/releases/latest),
unzip it and run `npx serve everydashcam`. Extract an update into a fresh folder
so files left over from an older release cannot remain in the installation.

The release archives are built from the same tagged commit as the official
release. They are a separate, environment-free build without the hosted site's
analytics or optional crash reporting. At runtime, they only contact the map
tile service.

### Verify a downloaded release

Every release includes `SHA256SUMS` and signed build provenance. With the
[GitHub CLI](https://cli.github.com) installed and signed in, replace `<tag>`
with the release tag and `<archive>` with the downloaded filename.

For releases through `v2026.10.09`, verify build provenance with the original
owner and signing workflow:

```sh
gh attestation verify dashcamigo.tar.gz --owner amkulikov \
  --signer-workflow amkulikov/dashcamigo/.github/workflows/release.yml
```

These attestations are available under the original owner's account. Repository
lookup returns 404 after the transfer, which also prevents
`gh release verify-asset` from checking these historical releases.

For later releases, use the new repository and signing workflow:

```sh
gh release verify-asset <tag> <archive> -R everydashcam/everydashcam
gh attestation verify <archive> -R everydashcam/everydashcam \
  --signer-workflow everydashcam/everydashcam/.github/workflows/release.yml
```

The release check confirms that the archive matches the immutable GitHub release.
The attestation check confirms that the named release workflow built it from the
recorded commit. The same commands work for the zip archive and portable HTML
when you substitute the downloaded filename.

## Run with Docker

The published image supports amd64 and arm64 and needs no volumes or environment
variables:

```sh
docker run -d --name everydashcam -p 8080:80 ghcr.io/everydashcam/everydashcam
```

For an existing installation, replace the old `ghcr.io/amkulikov/dashcamigo`
image with the image above. The old image remains available without updates.

Open [localhost:8080](http://localhost:8080).

With Docker Compose:

```yaml
# docker-compose.yml
services:
  everydashcam:
    image: ghcr.io/everydashcam/everydashcam
    ports:
      - "8080:80"
    restart: unless-stopped
```

The image is stateless, so there is nothing to back up. `latest` follows the
newest release; versioned `v*` tags match
[GitHub Releases](https://github.com/everydashcam/everydashcam/releases).

To build the image from your checkout instead:

```sh
docker build -t everydashcam .
docker run -d --name everydashcam -p 8080:80 everydashcam
```

If other devices will open the app through a NAS or home server, read
[HTTPS and local networks](#https-and-local-networks) before exposing it.

## Build from source

You need Git and the Node.js version required by `package.json`:

```sh
git clone https://github.com/everydashcam/everydashcam.git
cd everydashcam
npm ci
npm run build
npx serve dist
```

Open the address printed by `npx serve`. The build needs no accounts, API keys
or local configuration.

To build the portable HTML files, run `npm run build:portable` and open a file
from `dist-portable/` directly in the browser. For one language, use
`npm run build:portable -- --locale ru`. After building, `npm run dev` exposes
these public portable files through the download button on matching language
pages. Restart the development server after rebuilding the portable files.

To include Yandex in the portable viewer, pass your browser key explicitly:

```sh
PORTABLE_YANDEX_TILES_API_KEY=YOUR_TILES_API_KEY npm run build:portable
```

The key is included in the HTML and its map requests, just as in a hosted
browser build. Portable builds do not read `.env` files. Without this variable,
the other map providers remain available. Yandex is a viewer option; video
export uses the other providers.

All environment variables are optional and documented in `.env.example`. With
none set, crash reporting is left out of the build. The build only needs network
access to install npm packages; fonts and map styles are already in the
repository. A source archive without Git history also builds successfully, but
omits version and page-modification metadata.

`npx serve` is recommended because it handles everydashcam's extension-less URLs.
`npm run preview` and `python3 -m http.server -d dist` can serve directory-index
pages such as `/en/privacy/`. Older links such as `/privacy` also need clean
HTML URL resolution; a basic file server needs an additional rewrite rule.

## Enable Yandex Maps

Build your own hosted app to enable Yandex Maps. Its browser assets in the
published release archives and Docker image contain no Yandex key. Separately
bundled portable HTML may include the public browser key supplied to its build.
Adding a key to a running server or container cannot change built browser assets.

1. Follow the [Yandex Tiles API quickstart](https://yandex.ru/maps-api/docs/tiles-api/quickstart.html)
   to obtain a key for the **Tiles API** package. Wait for the key to activate.
2. If the key's settings offer
   [domain restrictions](https://yandex.ru/maps-api/docs/tiles-api/limit.html),
   configure them for the addresses people will use to open your installation.
   If the field is absent, continue without it. The key is public in the browser;
   restrictions do not make it private or guarantee protection against reuse.
   Yandex documents these restrictions as applying only to billable requests.
   Requests come from each visitor's device, so do not restrict the key to the
   hosting server's IP.
3. Insert the key using one of the build methods below, then select **Yandex
   Maps** in the app's map settings.

For an npm build, create `.env.local` next to `package.json` and replace the
placeholder with your key:

```dotenv
VITE_YANDEX_TILES_API_KEY=YOUR_TILES_API_KEY
```

Run `npm run build` and serve the resulting `dist/` as described above.
`.env.local` is ignored by Git; other optional settings are documented in
[`.env.example`](../.env.example).

For a Docker build from your checkout, pass the key as a build argument:

```sh
docker build --build-arg VITE_YANDEX_TILES_API_KEY=YOUR_TILES_API_KEY -t everydashcam .
```

Run this image using the [Docker instructions](#run-with-docker). Docker builds
exclude local `.env` files, and `docker run -e` cannot supply this build setting.
Rebuild and replace the served files or image whenever you change the key.

## Serve it on an internal web server

Copy the contents of the release folder or `dist/` to the root of the site.
Subpath deployments such as `https://example.com/everydashcam/` are not supported.

Your server needs these rules:

- Serve a directory index for locale paths such as `/en/` and `/ru/`. The root
  path redirects to the appropriate locale. This also applies to localized
  documents such as `/en/privacy/`, `/en/terms/`, and `/en/add-my-camera/`.
- Resolve extension-less pages to their HTML files. For nginx, use
  `try_files $uri $uri.html $uri/ =404`.
- Send `/sw.js` with `Cache-Control: max-age=0, must-revalidate` so returning
  browsers pick up updates promptly.
- Cache hashed files under `/assets/` indefinitely; their names change whenever
  their contents do.
- Send `Cross-Origin-Opener-Policy: same-origin` and
  `Cross-Origin-Embedder-Policy: require-corp` with every response, as
  everydashcam.app does. The app's offline service worker adds both to the
  responses it serves, but the first visit and browsers that do not run it rely
  on the server. In nginx, repeat them in every `location` that has its own
  `add_header`.

The committed `docker/nginx.conf` is the complete reference for rewrites,
cache and isolation headers and the 404 page. `public/_headers` contains the
production security and caching headers, including the Content Security Policy.

## HTTPS and local networks

Some editing and export features require a secure browser context:

- `http://localhost` counts as secure, so a local installation works fully over
  plain HTTP.
- A plain HTTP address on your local network does not. Video, the route, charts
  and original-quality export keep working, but editing, previews, some export
  options and offline caching are unavailable.

Use HTTPS through your web server or reverse proxy when other devices connect
to everydashcam over the network. The app also explains this limitation when it
detects an insecure address.

## Network access for server installations

See the [privacy policy](https://everydashcam.app/privacy) for map-service requests.

Without an internet connection, the basemap is blank, but the route, markers,
chart and video continue to work. Nothing else is contacted unless you enable
an optional integration from `.env.example`.

## License and branding

Exports that include overlays carry the everydashcam.app watermark. Original
quality exports are left untouched.

The source code is available under the AGPL-3.0-only license. If a modified
version is made available to other people over a network, the license requires
its complete source to be offered under the same terms. The **everydashcam** name,
logo and brand mark are not included in that license and may not identify a
fork, mirror, rehosted copy or separate hosted service. See
[README.md](../README.md#license) and [LICENSE](../LICENSE) for the binding
terms.
