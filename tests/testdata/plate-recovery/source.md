# Synthetic plate recovery fixture

Source: [generator](../../../scripts/make-plate-recovery-fixture.mjs), using only [the procedural car scene](../detector-motion/plate-motion.mp4.source.md).

The invented AB123CD plate is 120×30 pixels on a 1920×1080 canvas. The car moves left abruptly between discovery scans and exits through the image edge. Frame annotations cover only the visible plate fragment. The sequence contains no real footage or external material; the repository license applies. This is a pipeline regression, not an accuracy benchmark.
