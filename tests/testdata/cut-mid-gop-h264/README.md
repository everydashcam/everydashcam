# cut-mid-gop-h264

Synthetic H.264 clip for the e2e suite, **not** a real recording.

- `clip-cut-mid-gop.mp4` - 1.7s, 320x180, `testsrc2` pattern, no audio, no GPS.
  Encoded `libx264` High profile, `yuv420p`, with its first ten packets dropped.

The point is that the track **starts inside a GOP**: its first packet (0.33s) is
not a key frame, and the first key frame comes at 1.0s. A lookup at the track's
first timestamp finds nothing to decode from, so a trip preview has to fall back
to the first key frame. See the preview test in
`tests/e2e/progressive-ingest.spec.ts`.

It lives in its own directory because tests drop `no-gps-h264` as a whole folder.

Regenerate:

```sh
ffmpeg -y -f lavfi -i testsrc2=size=320x180:rate=30:duration=2 \
  -c:v libx264 -profile:v high -pix_fmt yuv420p -g 30 -movflags +faststart \
  -bsf:v "noise=drop='lt(n,10)'" -fflags +bitexact -flags:v +bitexact \
  tests/testdata/cut-mid-gop-h264/clip-cut-mid-gop.mp4
```
