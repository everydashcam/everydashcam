# Public-domain portrait motion at 60 fps

Derived from [the credited portrait fixture](face-motion.mp4.source.md) with [the generator](../../../scripts/make-face-detector-motion-fixture.mjs) using `--60fps`. The original NASA attribution applies. Contains no user recording or private data.

Each original 30 fps frame is repeated twice, with H.264 Main encoding at CRF 8. Duration and geometry match `face-motion.json`; each box holds for two 60 fps frames. Tests verify 30 Hz detection and copied masks on unchecked neighboring frames without loading ViTTrack.
