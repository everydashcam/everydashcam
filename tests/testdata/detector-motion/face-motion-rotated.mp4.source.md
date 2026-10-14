# Rotated public-domain portrait motion fixture

Derived only from [the credited public portrait motion fixture](face-motion.mp4.source.md) using [the generator](../../../scripts/make-face-detector-motion-fixture.mjs) with `--rotated`. NASA attribution and public-domain provenance remain in the source links. Contains no user recording or private data.

The original decoded frames are rotated clockwise before H.264 Main encoding at CRF 8. The MP4 display matrix then rotates 90 degrees counter-clockwise: coded dimensions are 360×640 and displayed dimensions are 640×360. Displayed positions, timing, and all ground-truth boxes are exactly those in `face-motion.json`; re-encoding may introduce small compression differences. The test exercises rotation-aware drawing of native reverse-buffer samples.
