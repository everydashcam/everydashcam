# Audio export fixtures

These clips contain generated test bars and a 440 Hz tone, no camera recordings,
locations or personal data. Duration: two seconds. Video: H.264, 160 × 96, 10 fps.

`__fixtures__/aac-main/20260101_120000.TS` is a **negative profile-signaling fixture**. Its
ADTS headers declare AAC Main (`mp4a.40.1`) while its payload was encoded as LC.
It reproduces the demuxer/muxer compatibility failure; it does not establish
support for decoding a real AAC Main recording. Every ADTS profile field was
changed from 1 to 0 (the stored field is the audio object type minus one).

Generate its unmodified source with:

```sh
ffmpeg -f lavfi -i 'testsrc2=size=160x96:rate=10' \
  -f lavfi -i 'sine=frequency=440:sample_rate=48000' -t 2 \
  -c:v libx264 -profile:v baseline -pix_fmt yuv420p -g 10 \
  -c:a aac -b:a 64k -ac 2 -f mpegts source.ts
```

`__fixtures__/pcm-u8/20260101_120000.mov` copies that source's video through Mediabunny's
`MovOutputFormat`, shifting the first video timestamp to zero. Its audio is
16,000 unsigned PCM bytes at 8 kHz, mono:
`round(128 + 60 * sin(2 * PI * 440 * sampleIndex / 8000))`.
The writer cannot copy unsigned PCM into MP4, but Mediabunny can decode it
without WebCodecs. Browser tests verify conversion to AAC/Opus, non-silent
decoded output, and unchanged video packets.

`__fixtures__/opus/20260101_120000.mkv` contains valid stereo Opus audio with
decoder pre-skip. Its first decoded sample starts after its first encoded packet.
Browser tests change the export quality to exercise audio decoding and verify
that the resulting MP4 retains an audible soundtrack while re-encoding video.
This covers the existing Matroska input support, not a new recording format.

`__fixtures__/ima-adpcm/20260101_120000.mkv` is a two-second, audio-only
Matroska clip: a 440 Hz tone at 32 kHz, mono, IMA ADPCM in `A_MS/ACM`. Unit
tests use it to check that feeding the Matroska ADPCM reader in steps produces
the same samples as one range. Its 1024-byte blocks last about 63.8 ms, while
Matroska stores their timestamps to the millisecond. Generate it with:

```sh
ffmpeg -f lavfi -i 'sine=frequency=440:sample_rate=32000' -t 2 -ac 1 \
  -c:a adpcm_ima_wav -map_metadata -1 -fflags +bitexact \
  tests/testdata/audio-export/__fixtures__/ima-adpcm/20260101_120000.mkv
```

Generate the Opus clip with:

```sh
ffmpeg -f lavfi -i 'testsrc2=size=160x96:rate=10' \
  -f lavfi -i 'sine=frequency=440:sample_rate=48000' -t 2 \
  -c:v libx264 -profile:v baseline -pix_fmt yuv420p -g 10 \
  -c:a libopus -b:a 96k -ac 2 -map_metadata -1 -fflags +bitexact \
  tests/testdata/audio-export/__fixtures__/opus/20260101_120000.mkv
```
