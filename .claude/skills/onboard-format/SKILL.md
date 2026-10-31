---
name: onboard-format
description: End-to-end onboarding of a new dashcam GPS data format into everydashcam - or extending existing techniques to cover a new variant. Triggers when the user says "add support for format <X>", "add support for <model>", "here's a sample from <X>, figure it out" and drops a real file (or a folder of files) into private/incoming/. The skill anonymizes samples, adds a primitive/filename technique/source-hint where needed, creates fixtures and tests, and semantically validates that no sensitive data remains in the fixtures. Does not run without a real sample - writing a parser from a format description alone is forbidden.
---

# Onboard Format

End-to-end workflow for onboarding a new camera or GPS data format into everydashcam.

Capability-first architecture: there is no "vendor" concept in the code. A new camera usually reuses existing techniques - it only adds entries to the relevant libraries. Layers:

- `src/parsers/primitives/` - one file = one GPS byte-parsing format.
- `src/parsers/filename/<field>.ts` - flat lists of techniques for time/channel/mode/sequence.
- `src/parsers/gps-source-hints.ts` - flat registry of "filename pattern -> where GPS lives".
- `src/parsers/sidecars/` - basename-paired handlers (GPX/.map/.gps/.3gf).

## When NOT to run

- No real files of the format in `private/incoming/`. Writing a parser from a description without a sample is forbidden. Response: "drop a sample into private/incoming/<hint>/ and call me".
- The user wants to work on the UI / player / map / export - out of scope.
- The user asks to "look at how primitive X is implemented" - that's just reading code, not onboarding.

## Dependencies

- `ffmpeg` in PATH (for anonymizing MP4 video and audio). Check via `ffmpeg -version` right at the start. No ffmpeg - refuse with "brew install ffmpeg" (or the equivalent).
- Existing infrastructure: `src/parsers/primitives/types.ts` (`Extractor` contract), `src/parsers/primitives/index.ts` (registry), `src/parsers/filename/_patterns.ts` (shared regex), `src/parsers/filename/<field>.ts` (techniques), `src/parsers/gps-source-hints.ts` (source hints), `src/parsers/sidecars/` (basename-paired).

## Workflow

### Step 1. Identify the format

- Read the filenames in `incoming/`. Try to identify the GPS storage format and filename pattern from names, hex signatures, MP4 metadata (`software`/`encoder` via `ffprobe`).
- Establish whether names come from the camera, documented export software, or a person who renamed the files. Renamed review clips can validate retained container/GPS bytes, but their descriptive names do not justify filename techniques or source hints. Preserve unknown channel/mode fields when naming evidence is absent.
- If there are several candidates - ask the user.
- Fix a `formatId` (short kebab-case slug, by format not by vendor: `freegps`, `gpmf`, `ligogps`, not `viofo`/`gopro`/`carcam`).

### Step 2. What already works - what needs adding

Run ingest on the sample locally, look at `diagnostic.json`:

- **All four classifierMatches fields are filled, appliedExtractors is non-empty, records exist** - the format is fully covered by existing techniques. Done.
- **Records exist, but some classifierMatches field is null** - check whether the camera or documented export naming actually supplies that field. Add a filename technique in Step 7 only when that evidence exists; a null field alone is not a support gap.
- **appliedExtractors is empty or contains only "generic-datetime"** - none of the existing primitives fired. Go to Step 6 - extend an existing primitive or create a new one.
- **The file was skipped by the pre-filter (logged under `byReason: source:none`)** - the format is declared in `gps-source-hints.ts` as `"none"` because there was no support before. If we're adding it now, update the hint to `"embedded"` (Step 8).

Most new no-name Chinese cameras with a distinctive filename need only a `filename/<field>.ts` addition - the primitive itself already exists (GPMF/freeGPS are the most common).

### Step 3. Gather format information

- Web search: `<formatId> gps format`, `<model> dashcam telemetry`, dashcamtalk.com forums, GitHub repos. Public sources only. Do not upload files.
- Hex analysis of the source file (`xxd` / `od -c`) for binary formats. ASCII markers (`GPS`, `nvtk`, `gpmf`, `bok`, `LIGOGPSINFO`, `freeGPS `, `gpmd`, `pndm`).
- If the format is non-obvious - write `docs/format-<formatId>.md` with the breakdown.

### Step 4. Anonymize the source files

Depending on the type:

- **Text log sidecar** (CSV/NMEA/SRT/GPX) - write or extend `scripts/anonymize-<formatId>-log.mjs`. Example: `scripts/anonymize-70mai-log.mjs`. Principles:
  - Round coordinates to whole degrees (precision ~110 km).
  - **Do NOT shift timestamps** (without coordinates and video these aren't sensitive).
  - **Do NOT rename** filenames referenced in log fields.
  - Trim to ~50 records (a readable snapshot).
- **MP4** - `node scripts/anonymize-mp4.mjs <input> <output>`. ffmpeg: video -> testsrc2 + overlay, audio -> 1 kHz sine at -20 dB, duration -> 2 sec.
- **Embedded GPS inside MP4** (Novatek-bok, GPMF, Thinkware-tail, VIOFO SRT) - a format-specific zeroizer script `scripts/anonymize-<formatId>-mp4.mjs` (e.g. `anonymize-novatek-mp4.mjs`, `anonymize-thinkware-mp4.mjs`, `anonymize-vantrue-mp4.mjs`). If none fits the format - **create one in this same session**, otherwise the MP4 fixture contains real coordinates.
- **Sidecar formats** (GPX, standalone SRT) - text processing as in the first bullet.

### Step 5. Semantic fixture validation

The most important step. If even one item fails - **stop**.

1. **Parse the anonymized file** through the existing primitive or a temporary code stub:
   - lat/lon ~= 0 / integer / missing - **not** original.
   - Record count is plausible.
   - Timestamp is monotonic.
2. **Binary grep the MP4 for ASCII markers**: `strings <fixture>.mp4 | grep -E 'pattern'`. Specific patterns:
   - NMEA prefixes: `\$GP[A-Z]{3}`.
   - 4-byte MP4 box headers: `nvtk`, `gpmf`, `bok `, `gps ` - always with char context.
   - Plaintext coordinates: `\b[0-9]{1,3}\.[0-9]{4,}` (5+ digits after the decimal point).
   - City names of the user's known region.
3. **Compare parsed records** of the original and the anonymized version: every sensitive field must differ.
4. **Fixture size** - MP4 < 5 MB at 2 sec duration.

### Step 6. Primitive (if a new one or an extension is needed)

`src/parsers/primitives/<formatId>.ts` following the pattern of existing ones:

- **Thin wrapper** (gpmf/pndm/free-gps-box/ligogps/nmea-subtitle/navitel-tail/rvmi): delegates to `internal/<x>-extract.ts`.
- **With quirks** (csv-70mai with the 8h bias and Y-up; freegps with structural+streaming): full parsing inside the primitive.
- **Log-sidecar** (csv-70mai): marker by filename + signature check, parse reads the whole file.

Contract - `Extractor` from `primitives/types.ts`:
- `id` - stable slug (`"csv-70mai"`, `"gpmf"`, `"freegps"`). Must describe the format, not the brand.
- `displayName` - human-readable label for diagnostics.
- `kind` - `"video-embedded"` or `"log-sidecar"`.
- `marker(file, index?)` - cheap check (Mp4Index marker or a ~256-byte content probe).
- `parse(file, index?)` - full parse. Throws `WrongFormatError` on a false-positive marker.
- `cloneAcrossGroup?(file)` - optional: a group key for byte-identical streams (Juscar front/rear).

Firmware quirks (timestamp bias, Y-up gravity removal) live INSIDE `parse()`. One format - one spec plus quirks. No global side effects; the primitive is a pure object.

Error texts - English, lowercase, no trailing period. Comments - English, explain WHY.

### Step 7. Filename techniques

If the format has a distinctive filename pattern (different from the generic `YYYYMMDDhhmmss`):

1. Add a regex to `src/parsers/filename/_patterns.ts` (or, if the pattern is shared with other fields, it's already there).
2. For each field where something can be extracted - add an entry to the corresponding `src/parsers/filename/<field>.ts`:
   - `time.ts` - if the name has a datetime.
   - `channel.ts` - if the name or path has a channel indicator.
   - `mode.ts` - if the name or folder has a mode indicator.
   - `sequence.ts` - if the name has a counter/sequence.
3. Technique id in the form `<formatId>-<field>` (`"my-camera-time"`, `"my-camera-channel"`). Stable, shows up in diagnostics.
4. Array order: specific patterns before generic ones. `generic-datetime` is always last in `time.ts`.

Filenames are in the camera's local TZ; UTC conversion is done by the orchestrator via `estimateTzByFingerprint`.

A technique often already exists and works across several brands (e.g. `single-letter-suffix-FRI` for BlackVue + iBox). Before adding a new one - check whether an existing one fits.

### Step 8. GPS source hint

Add an entry to `src/parsers/gps-source-hints.ts`:

```ts
{ id: "my-camera", matches: (f) => RX_MY_CAMERA.test(f.file.name), source: "..." }
```

- `"embedded"` - GPS inside the MP4 (the primitive will extract it).
- `"log-sidecar"` - GPS in a separate CSV/text with self-binding (mp4Filename in the log line).
- `"basename-sidecar"` - GPS in a file sharing the same basename (GPX/.map/.gps/.3gf).
- `"none"` - the format is known not to carry GPS in our corpus (e.g. a model that theoretically has embedded GPS but no extractor is implemented yet).

`"none"` is a claim about every model/firmware variant matched by the rule, not
about one clip. A no-fix or status-only sample proves only that the sample has no
records. Check for optional-GPS variants first; if any may share the filename
shape, keep the probe enabled with `"embedded"` or leave the format `"unknown"`.

The hint saves 16 MB of header IO for files with no embedded GPS. If not specified - default "unknown" - we'll try embedded (safe but slower).

### Step 9. Sidecar handler (optional, for basename-paired formats)

If the format is a sidecar file bound to the MP4 by basename (GPX, .map, .gps, .3gf), and NOT self-binding (like the 70mai CSV) - create `src/parsers/sidecars/<formatId>.ts`:

- Implements `SidecarHandler` (or `AccelSidecarHandler` for accel-only): `id`, `matches(file, knownVideos)`, `parse(file, mp4Filename)`.
- Registers in `src/parsers/registry.ts` in the `SIDECARS` (or `ACCEL_SIDECARS`) array.
- Self-binding formats go into primitives/ with kind="log-sidecar".

### Step 10. Synthetic samples

In `src/parsers/__fixtures__/<formatId>/`:

- `synthetic-happy.<ext>` - 5-10 valid records, "happy path".
- `synthetic-edge.<ext>` - broken fields, NaN, empty lines, off-by-one.
- `synthetic-wrong-format.<ext>` - correct name/marker, but content from another format -> `WrongFormatError`.

For binary formats - build it programmatically (not by hand in hex).

### Step 11. Tests

- `src/parsers/primitives/<formatId>.test.ts` (if a new primitive): marker positive/negative, parse end-to-end, parse on edge cases, parse on wrong-format -> WrongFormatError, quirks check if any, cloneAcrossGroup table if implemented.
- `src/parsers/filename/<field>.test.ts` - the existing index.test.ts covers the walk; per-technique tests aren't required if behavior is obvious from the regex.
- `src/parsers/gps-source-hints.test.ts` - add an entry to the matrix: one new-camera file + check of `classifyGpsSource()` and `shouldTryEmbeddedGps()`.
- Real-anonymized fixture test in `src/parsers/__fixtures__/<formatId>/real-anonymized.test.ts` - end-to-end on the anonymized sample.

### Step 12. Run tests and typecheck

- `npm test` - all green.
- `npm run typecheck` - clean.
- `npm run check` - biome clean.
- Fix anything that's red.

### Step 13. Present to the user

Show:
- `git status` + list of new/changed files.
- What was added / which techniques were reused from existing ones.
- Diff of the snapshots (especially real-anonymized).
- Output of the semantic validation (Step 5) - confirmation that nothing sensitive leaked.

Wait for an explicit "ok, commit". Do not commit or push automatically.

### Step 14. Clean up incoming/

After explicit confirmation - **ask again** "delete the sources from private/incoming/<formatId>/?" and delete only after one more confirmation.

## Done criteria

- The file from the anonymized sample parses and the records make sense (coordinates, monotonic timestamp, realistic speed).
- All tests are green.
- For non-trivial binary formats there is a `docs/format-<formatId>.md`.
- Step 5 (semantic validation) passed.
- The user confirmed.

## What this skill does NOT do

- Does not commit or push without explicit consent.
- Does not write a primitive from a format description without a file.
- Does not work with files outside `private/incoming/` or an explicitly given path.
- Does not touch UI / player / map - outside the parsers' scope.
- Does not add a fixture if even one semantic-validation item fails.
- Does not delete sources automatically - only after double confirmation.
- Does not create vendor objects. This is a capability-first architecture: one file - one capability (primitive / technique / hint), not a "camera bundle".
