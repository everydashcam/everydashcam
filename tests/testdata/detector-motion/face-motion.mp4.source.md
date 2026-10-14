# Public-domain portrait motion fixture

Credit: NASA. Image source, verified public-domain status, exact crop, and
original source hash are recorded in [the portrait provenance](face-source.png.source.md).
This is a test-only transformation and does not imply NASA endorsement.

Generated with [the fixture generator](../../../scripts/make-face-detector-motion-fixture.mjs)
from `face-source.png` over a constant synthetic background. Contains no user
recording, audio, location, or timestamps from the original photograph.

The visible face is manually annotated in the source crop. Those coordinates
are translated exactly into every video frame in `face-motion.json`. The face
appears from 0.2 to 0.6 seconds and moves 40 pixels per frame, so once-per-second
discovery misses its entire appearance. Blank frames before and after the
appearance check that masks are not projected into unobserved time.

Generated 2026-10-14. Camera model/firmware: not applicable.
