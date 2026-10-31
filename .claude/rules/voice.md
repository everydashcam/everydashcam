---
paths:
  - "src/i18n/**/*"
  - "vite-plugins/**/*"
  - "index.html"
  - "public/*.html"
---

# Tone of voice

This file owns user-visible wording in the UI, errors and marketing pages.
English owns meaning; localization mechanics and translation completeness
follow [CLAUDE.md](../../CLAUDE.md#localization).

## Audience and vocabulary

Write for drivers opening their recordings. State what happened and what they
can do, using short, direct, warm sentences. Avoid corporate apologies,
buzzwords and implementation terms such as codec, container, remux, parser,
worker, buffer or sidecar in everyday UI.

| Implementation wording | User-facing wording |
| --- | --- |
| Failed to decode this codec | Can't play this video |
| GPS sidecar / telemetry | GPS data |
| Parsing the folder | Reading your recordings |
| Buffer allocation failed | This video is too large for your browser |

Technical terms are appropriate in these four places:

1. The feedback diagnostic report body, which is intended for maintainers.
2. A control or concept the user acts on, such as resolution or GPS.
3. Troubleshooting where the exact term helps the user fix the problem.
   For example, WebGL matches browser settings and diagnostic tools; pair
   it with a plain action. See [WebGL help](../../src/ui/webgl-enable-modal.ts).
4. Explicit, opt-in technical details, such as the
   [per-clip details panel](../../src/ui/file-details.ts). Everyday clip rows
   still use plain language.

Write **everydashcam** in lowercase, including at the start of a sentence;
uppercase is reserved for the visual logo.

| Concept | English | Note |
| --- | --- | --- |
| Whole stitched drive | trip | RU «поездка»; not session or video |
| Short source file | clip | Clips join into a trip |
| Source videos collectively | recordings | RU «записи» |
| Physical front/rear/interior view | camera | Channel is an internal term |
| Line on the map | route | RU «маршрут» |
| GPS data / GPX | GPS track | RU «трек» |
| Speed over time | speed chart | |
| Detected hard brake / impact | event | Not G-spike |
| Whole-trip scrubber | timeline | One per trip |
| Data drawn onto video | overlay | |
| Cut time / frame area | trim / crop | Keep distinct |
| Save the result | export / save | |

In the export panel, **clip** also means the trimmed piece being saved;
keep that established meaning within the export flow.

## Errors

Show a localized message saying what happened and what to do next. Never
pass a raw exception or stack into UI copy. Log the original cause locally.
If no user action can help, point to feedback.

| Raw failure | User-facing message |
| --- | --- |
| Decode error 0x80004005 | Can't play this video. Send us a sample and we'll look into it. |
| NotAllowedError | Couldn't save the file — the download was blocked. |

Use friendly `*.error.*` keys and error classifiers. The export `onError`
hook takes an `I18nKey` and parameters, so changing language can re-localize
an already visible error.

## Register and typography

- Use second person and contractions: “Couldn't open this file.”
- Product UI uses the informal register: RU «ты», FR «tu», DE «du».
  Landing-page FAQ uses the formal register where established, such as FR
  «vous». Match neighboring copy within the same surface.
- No decorative emoji. Functional warning/check markers are acceptable when
  they convey the same meaning in every locale.
- Preserve deliberate typography in product copy: em dash, middot, arrows,
  approximation signs and non-breaking hyphens. Do not normalize these to ASCII.

## Marketing and SEO pages

Adapt wording to each language while preserving the English facts, names,
dates and comparison verdicts. Precise technical terms may be useful on
these pages; the everyday UI simplification does not apply wholesale.
Published locales and reviewed camera-specific copy follow
[CLAUDE.md](../../CLAUDE.md#localization).

Honest competitor comparisons are welcome. Frame unsupported cameras as an
invitation to contribute a real sample rather than ending on a concession:
“If everydashcam doesn't read your camera yet, send a sample to
feedback@everydashcam.app — we add formats from real recordings.”

## Review

Read changed English and Russian copy on the actual affected screens.
Both must carry the same tone. Translation placeholders follow the
[deferred-work rule](../../CLAUDE.md#deferred-work); key parity alone does
not prove a translation is complete.
