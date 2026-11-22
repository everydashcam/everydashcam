# mkv-vp9

Synthetic Matroska clip for the e2e suite, **not** a real recording.

- `clip-vp9.mkv` - 3s, 640x360, `testsrc2` pattern, VP9 video + 48kHz stereo AAC
  audio (1kHz sine), **no GPS**.

No dashcam records VP9; the point is a tool re-export in a codec other than
H.264/HEVC. Such packets must reach the per-file MSE remux untouched - the
empty-packet filter applies only to H.264/HEVC. VP9 decodes in software on
every runner, including CI Chrome. See `tests/e2e/mkv.spec.ts`.

Regenerate:

```sh
node scripts/make-mkv-fixture.mjs tests/testdata/mkv-vp9/clip-vp9.mkv 3 vp9
```
