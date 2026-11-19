# no-gps-h264

Synthetic H.264 clip for the e2e suite, **not** a real recording.

- `clip-no-gps.mp4` - 3s, 640x360, `testsrc2` pattern, no audio, **no GPS**.
  Encoded `libx264` High profile, `yuv420p`.

The point is the **absence of GPS**: this is the fixture for the GPS-dependent
export gate. With no fix
(`recordsHaveGps` false) the export panel disables the telemetry / `.gpx` /
speed / coords / map options, the GPS-track-only switch hides, and the pipeline
omits the `gpmd` track. H.264 (not HEVC) so the assertions run unconditionally on
CI Chrome, not only on a macOS box with OS HEVC decode. See
`tests/e2e/no-gps.spec.ts`.

Regenerate:

```sh
ffmpeg -y -f lavfi -i testsrc2=size=640x360:rate=30:duration=3 \
  -c:v libx264 -profile:v high -pix_fmt yuv420p -g 30 -movflags +faststart \
  tests/testdata/no-gps-h264/clip-no-gps.mp4
```
