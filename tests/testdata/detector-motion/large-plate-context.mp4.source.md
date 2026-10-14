# Synthetic large-plate context fixture

Source: [fixture generator](../../../scripts/make-large-plate-context-fixture.mjs), derived solely from [the synthetic plate scene](plate-motion.mp4.source.md).

Frame 10 is enlarged tenfold with nearest-neighbor sampling and cropped at (1640, 2150) to 1920×1080. The invented plate occupies (360, 390), with size 1200×300 source pixels; its full-frame detector projection is 400×100 pixels. Six identical frames at 30 fps exercise context verification of a genuine large plate, which must retain coverage instead of being rejected solely for its size. `large-plate-context.json` records the exact geometric transform.

Contains no real footage, person, vehicle, GPS, private data or external source material. The repository license applies.
