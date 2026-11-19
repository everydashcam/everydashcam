# mkv-h264

Synthetic Matroska clip for the e2e suite, **not** a real recording.

- `clip-h264.mkv` - 3s, 640x360, `testsrc2` pattern, H.264 (Main) video + 48kHz
  stereo AAC audio (1kHz sine), **no GPS**.

The point is the **container**: browsers do not play Matroska through
`<video>.src` (only WebM), so every `.mkv` is forced through the per-file
MSE-remux backend - mediabunny demuxes it, the worker remuxes to fragmented MP4.
H.264 (not HEVC) so the playback + stream-copy export assertions run on CI
Chrome, not only on a macOS box with OS HEVC decode. The AAC track exercises the
"copy the audio out of MKV" path. IMA ADPCM in MKV is decoded by the app itself
and has its own fixture under `tests/testdata/audio-export/`. See
`tests/e2e/mkv.spec.ts`.

Regenerate:

```sh
node scripts/make-mkv-fixture.mjs tests/testdata/mkv-h264/clip-h264.mkv 3
```
