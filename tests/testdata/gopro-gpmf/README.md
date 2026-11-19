# GoPro GPMF samples

Fragments trimmed to 2 seconds from GoPro/gpmf-parser's official GPMF samples.

## Source

- **Repo**: https://github.com/gopro/gpmf-parser/tree/main/samples
- **License**: Apache-2.0 OR MIT (dual license from the gopro/gpmf-parser
  repo - compatible with the project's invariant).
- **Date obtained**: 2026-05-01.
- Each file is `https://github.com/gopro/gpmf-parser/raw/main/samples/<name>.mp4`.

## What's inside

| File | Model | What's in the gpmd track |
|------|--------|------------------|
| `hero5-trimmed.mp4` | HERO5 (2017-04-17) | GPS5 18Hz, full fix, real San Diego track |
| `hero6-trimmed.mp4` | HERO6 (2018-01-24) | GPS5 18Hz, full fix, San Diego |
| `hero8-trimmed.mp4` | HERO8 (2019-11-18) | GPS5 18Hz, **GPSF=0 on every sample (firmware quirk)** with otherwise valid coordinates. |

`hero7.mp4` from the gpmf-parser samples is NOT included in our corpus - the
plugin yields 0 records for it (likely the whole file is no-fix). hero5/6/8
cover the scenarios we care about.

`max-heromode.mp4` (HERO Max in hero mode) also worked in the trial run, but
is not included in the trimmed corpus: it carries the same GPS5 as hero5/6/max
and hero7 - nothing extra for the tests.

`max-360mode.mp4` (HERO Max 360°) is not wired in - the specific 360 stream
isn't needed right now.

## Anonymization

These files are **public under Apache 2.0**. Coordinates in the gpmd track
point to San Diego (the GoPro lab parking lot), which is publicly known
information. **No anonymization was required**; we only trimmed the
duration to 2 seconds via `scripts/trim-mp4.mjs --keep-data-tag gpmd`
for compactness (4-11 MB originals -> ~700KB each).

What's in the trim:
- video (avc1) - 2 sec of the original H.264 (San Diego location, partly
  the GoPro lab, irrelevant by nature).
- audio (aac) - 2 sec of the original audio.
- gpmd (data) - 2 sec of GPMF data = ~36 GPS points (18Hz x 2).
- tmcd, fdsc - **dropped** (ffmpeg does not remux them into MP4 output
  without a re-encode, and they are not needed for parser tests).

## Use in tests

The clips are shared real GPMF inputs for extractor dispatch, container,
MSE and browser tests; search for `gopro-gpmf` to find them. No test pins
their parsed records with a snapshot.
