---
name: ui-polish
description: Review and refine existing everydashcam interfaces in the browser. Use for targeted UI polish, responsive layout, and interaction reviews of import, trip lists, playback, dialogs, and export.
---

# UI polish

Work through the requested user flow in the running app before choosing fixes.
Prioritize controls that miss, obscure content, lose focus, or misrepresent state.
Keep the existing visual language; a different aesthetic is not itself a defect.

## Project entry points

- Use [tokens](../../../src/styles/tokens.css) and neighboring component styles
  for sizing, color, type, and feedback.
- Use [modal-helper](../../../src/ui/modal-helper.ts) for dialog focus and
  keyboard ownership; retain each feature's show/hide and cancellation lifecycle.
- Choose fixtures and browser setup from the [e2e guide](../../../tests/e2e/README.md).
  Verification scope belongs in [CLAUDE.md](../../../CLAUDE.md#verification);
  shared viewer changes also follow the [portable guide](../../rules/portable.md).

## Check the interaction, not just the screenshot

Apply the relevant checks to the requested surface, without expanding every task
into a whole-app audit.

| Surface | Checks that catch real failures here |
| --- | --- |
| Import and dialogs | Exercise Cancel and Escape while a picker is pending and while files are being read. A native picker and our overlay have separate lifecycles: cancelling the overlay cannot close the picker. Follow late selections and the next import. When a warning remains above background work, completion underneath must not steal its focus; Tab, Escape, and return focus belong to the foreground dialog. |
| Trip lists | Inspect collapsed and expanded cards, long filenames, missing previews, and enough trips to scroll. Expand, inspect file details, select a trip, then return to the list. Nested actions must not also start playback. Reserve space for the full action target so labels and neighboring actions remain reachable. |
| Playback and export | Try touch controls in a wide tablet layout as well as a narrow phone layout. Drag both ends of a very short export range and ranges near the timeline edges. Visible grips must own distinct hit areas and dragging must preserve the grab position. |

Test the edges of small controls with actual taps or clicks; a passing center
click or a large bounding box does not prove that another element cannot steal
the hit. Keep the button's hit area stationary when rotating or animating its
glyph. Size touch controls by pointer capability, including desktop-style tablet
layouts, rather than relying only on a phone-width breakpoint.

## Inspect the changed states

- Check the affected layout in both themes and in English and Russian. Include
  narrow portrait and short landscape when relevant; watch long words, filenames,
  timestamps, safe-area clearance, and control overlap. Use existing type tokens
  before forcing word breaks or changing copy to hide a layout problem.
- Walk keyboard focus, pressed, disabled, busy, and empty/error states that the
  flow actually reaches. A focus ring must remain visible against its immediate
  surface, including primary buttons.
- Compare normal and reduced motion. Decorative loops and flashes should stop
  under reduced motion while static labels and progress remain understandable.
  Keep repeated playback/list actions immediate; add motion only when it conveys
  useful state. Transition named properties and leave hit geometry stable.

## Close the review

Reproduce each issue before editing and repeat the interaction after the fix.
Add a focused regression test for behavior that is easy to reintroduce, such as
focus loss or overlapping grips; a small visual adjustment can be verified on
screen. Distinguish device emulation from testing on physical hardware.
