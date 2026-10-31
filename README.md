# everydashcam

<p align="center">
  <a href="https://everydashcam.app">
    <img src="docs/screenshots/readme-hero.webp" alt="everydashcam on desktop (dark theme) and on a phone (light theme): a two-camera trip with front and rear video side by side, a speed and G-force chart, and the speed-colored route on a map">
  </a>
</p>

everydashcam is a browser player and editor for recordings from multiple dashcam
brands. It shows synchronized camera views, GPS tracks, speed and G-force data,
and exports clips. Files are processed on your device.

## Getting started

- [**everydashcam.app**](https://everydashcam.app) — the latest stable release.
- [**beta.everydashcam.app**](https://beta.everydashcam.app) — upcoming changes.
- **Install it** — open any version and install it from your browser. After the
  first visit, it can open without a network connection.

## Features

- **Map and charts:** the route is colored by speed. Hover over the route or
  chart to jump to that moment.
- **Events:** harsh braking is detected from the G-force data and marked on the
  chart.
- **Export:** keep the original video quality, or combine cameras and add speed,
  map and G-force overlays. Keep GPS data in the MP4 or save it as GPX.
- **Blur:** mark faces and license plates yourself, or use beta automatic
  detection and tracking. Processing stays on your device.

See [browser support](docs/browser-support.md) for feature limits by browser
and operating system.

## Supported cameras

See [GPS format coverage](docs/gps-format-coverage.md) for cameras tested with
real recordings and formats implemented from open-source references.

Don't see your camera yet? You can help us add it:

- In the app, turn the card's file list into a report you can send us — see
  [everydashcam.app/add-my-camera](https://everydashcam.app/add-my-camera).
- On GitHub, open a camera-support issue.

For other ways to help, see [Contributing](CONTRIBUTING.md).

## Self-hosting

For a personal or internal installation, see the
[self-hosting guide](docs/self-hosting.md). It covers portable HTML, Node.js,
Docker and internal web servers.

## Built with

- [Mediabunny](https://github.com/Vanilagy/mediabunny) — video playback and MP4
  export.
- [MapLibre GL JS](https://github.com/maplibre/maplibre-gl-js) — the route map.
- [Chart.js](https://github.com/chartjs/Chart.js) — speed and G-force charts.
- [ONNX Runtime](https://github.com/microsoft/onnxruntime) — on-device plate and
  face detection.
- [OpenFreeMap](https://openfreemap.org) — keyless vector map tiles.

## License

The code is licensed under [AGPL-3.0-only](LICENSE). If you make a modified
version available to others over a network, the license requires you to offer
its complete source under the same terms.

The code license does not grant permission to use the **everydashcam** name or
branding for another project or service.
