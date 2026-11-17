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
  path. NOTE: the real F200 PRO rear has no subtitle track at all - the real
  no-telemetry shape is pinned by `real-anonymized-rear.mp4`.
- `real-anonymized.mp4` - real F200 PRO front-file cues with coordinates scrubbed
  to a moving 50.0 N / 30.0 E sentinel (real gsensori counts, timestamps, speed
  and course kept - not PII without coordinates). Produced by
  `scripts/anonymize-thinkware-mp4.mjs` from a private user feedback submission
  (gitignored). Reproduce with that script if the original is re-supplied.
- `real-anonymized-rear.mp4` - the same recording's rear clip rebuilt by
  `scripts/anonymize-mp4.mjs` (testsrc2 video + sine audio, same codec shape,
  no telemetry). Together with `real-anonymized.mp4` it forms the front+rear
  pair for the channel-anchoring regression test
  (`real-anonymized-pair.test.ts`); the pair's real mvhd/duration values are
  documented there.
- `real-anonymized-u3000.mp4` - the first 10 GPS fixes of a real U3000 Pro
  front clip (`REC_20261115_165549_F.MP4`, firmware 1.00.06), coordinates
  scrubbed like `real-anonymized.mp4`. Unlike that fixture it keeps the source
  mvhd stamp (name time + 27 s, as on every REC and PAK file of the sample) and
  the 100 ms cue spacing. `real-anonymized-u3000.test.ts` lists the clip
  metadata read from the sample card.
