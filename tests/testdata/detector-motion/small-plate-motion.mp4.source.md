# Synthetic small-plate detection fixture

Source: [fixture generator](../../../scripts/make-small-plate-motion-fixture.mjs), derived solely from [the synthetic plate scene](plate-motion-long.mp4.source.md).

The mathematical scene is resized to 256×144 and placed at (780, 600) on a uniform 1920×1080 canvas. The invented plate is 48×12 source pixels and moves 16 pixels per frame, including across a detector tile overlap. It appears from 1.2 to 1.6 seconds. Annotation coordinates describe the exact continuous resize transform. This is a resolution and tracking regression, not a natural dashcam accuracy benchmark.

Contains no real footage, person, vehicle, GPS, private data or external source material. The repository license applies.
