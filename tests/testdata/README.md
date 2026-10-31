# Public test data

Committed fixtures exercise parser, playback, export and inference behavior.
They include synthetic scenes, anonymized recordings and credited public assets.
Original user recordings remain under ignored `private/`.

## Evidence and reproduction

Keep provenance in a directory README or a neighboring `*.source.md`: source
URL, acquisition date, stated model/firmware, license or explicit permission,
and the generator/anonymizer needed to reproduce the fixture. Synthetic
fixtures should identify their generator and synthetic origin. Preserve credits
for derived public assets.

Choose size and duration for the regression: a small parser fixture and a
motion/long-export fixture have different needs. Do not shorten a sample in a
way that removes the behavior being tested.

## Privacy and validation

Anonymize real recordings even when publicly posted. Replace original footage
and audio; scrub coordinates, identifiers and opaque payloads with the
appropriate `scripts/anonymize-*` tool. A generic video transcode alone does
not scrub embedded telemetry. Verify both the intended parser behavior and the
absence of source private data.

See [testing guidance](../../.claude/rules/testing.md) for real/synthetic evidence
requirements and semantic validation. Default suites must not depend on private
originals.
