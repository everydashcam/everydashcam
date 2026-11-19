# Thinkware F-series subtitle GPS fixtures

The GPS/G-sensor telemetry is embedded in a tx3g subtitle track (handler
`text`), one cue per sample:

```
gsensori,<range>,<sens>,X,Y,Z;[GxRMC,...*cc;]CAR,<obd>
```

NMEA is written **without** a leading `$`, segments are `;`-delimited, accel is
~10 Hz and GPS ~1 Hz. The real F200 PRO writes GPS only in the **front** file;
its rear carries **no subtitle track at all** (video+audio only). The U3000 Pro
rear carries a byte-identical copy of the front track, and its interior camera
(`incabin_rec/EXT_..._I`) has no subtitle track. Parsed by
`src/parsers/internal/sbtl-nmea-extract.ts`.

## Files

- `build-synthetic.mjs` - builds `synthetic-fseries.mp4` (synthetic cues:
  accel-only warm-up, a 50N/30E track, a `GNRMC` talker, a void fix) and
  `synthetic-rear.mp4` (accel every cue, no RMC). Also exports `buildSbtlMp4()`
  reused by the anonymizer.
- `synthetic-fseries.mp4` - the synthetic front fixture.
- `synthetic-rear.mp4` - a synthetic accel-only-cues track (no RMC). Pins the
  "telemetry track without GPS yields no records -> WrongFormatError" extractor
  path. NOTE: the real F200 PRO rear has no subtitle track at all - the
  front+rear pair test pins that shape.
- `real-anonymized.mp4` - real F200 PRO front-file cues with coordinates scrubbed
  to a moving 50.0 N / 30.0 E sentinel (real gsensori counts, timestamps, speed
  and course kept - not PII without coordinates). Produced by
  `scripts/anonymize-thinkware-mp4.mjs` from a private user feedback submission
  (gitignored). Reproduce with that script if the original is re-supplied.
- The rear of the same recording has no fixture of its own. Its anonymized
  rebuild (`scripts/anonymize-mp4.mjs`, testsrc2 video + sine audio, no
  telemetry) matches the shared `tests/testdata/dashcam-viewer-corpus/MOV_0581.mp4`
  byte for byte apart from the encoder version string, so the tests use that
  clip. With `real-anonymized.mp4` it forms the front+rear pair for the
  channel-anchoring regression test (`real-anonymized-pair.test.ts`); the
  pair's real mvhd/duration values are documented there.
- `real-anonymized-u3000.mp4` - the first 10 GPS fixes of a real U3000 Pro
  front clip (`REC_20261115_165549_F.MP4`, firmware 1.00.06), coordinates
  scrubbed like `real-anonymized.mp4`. Unlike that fixture it keeps the source
  mvhd stamp (name time + 27 s, as on every REC and PAK file of the sample) and
  the 100 ms cue spacing. `real-anonymized-u3000.test.ts` lists the clip
  metadata read from the sample card.
