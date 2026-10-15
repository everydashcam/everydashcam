---
name: changelog
description: Maintain the factual user-facing changelog - the "What's new" panel, CHANGELOG.md and the GitHub release notes all read from one source (src/changelog/entries.ts). Triggers when the user says "update the changelog", "обнови changelog", or as the pre-tag step of release prep (docs/deploy.md). Reads git history since the newest entry, drafts coarse user-visible behavior changes in every locale, appends them, bumps the badge id and regenerates CHANGELOG.md.
---

# Changelog

One source of truth: `src/changelog/entries.ts`. Everything else derives from it:

- The in-app "What's new" panel renders the per-locale texts (`src/ui/whats-new-modal.ts`).
- The topbar badge compares `src/changelog/latest.ts` against the user's acknowledgment.
- `CHANGELOG.md` is generated - never edit it by hand (`npm run generate:changelog`).
- GitHub release notes are generated at tag time by `.github/workflows/release.yml` from the entries added since the previous published release. New entries are optional; see `.claude/skills/release/SKILL.md` for release preparation.

The id format and ordering rules are stated in `src/changelog/id.ts`; `src/changelog/entries.test.ts` enforces them.

## When NOT to run

- Nothing user-visible changed since the newest entry (infra, refactors, docs, tests, CI). An empty release is fine - the notes generator emits a neutral fallback.
- The user asks to change the panel UI or the generators - that is regular feature work, not changelog maintenance.

## Workflow

### 1. Collect the candidate window

The newest entry's coverage boundary is the last commit that touched `entries.ts`:

```sh
git log --oneline "$(git log -1 --format=%H -- src/changelog/entries.ts)"..HEAD
```

If `entries.ts` has never been touched in the window you were asked about, fall back to `git log --oneline <last-release-tag>..HEAD`.

### 2. Filter to what a driver notices

Keep only changes to product behavior that a driver can notice: new camera/format support, new capabilities and settings, concrete workflow changes, and fixes of bugs a user could have hit. Drop refactors, internal renames, test/CI/docs work, and perf work with no observable effect.

Visibility alone does not clear the bar. Do not add entries for copy rewrites, visual polish, layout tuning, landing/marketing changes, or SEO content unless they fix a concrete usability failure or change how the user completes a task. Do not turn internal work into an inferred benefit just to fill the release. An empty changelog is correct when behavior did not change.

Coarse strokes are the point: merge related commits into ONE entry ("Improved trip cards", not three bullets about corner buttons). A typical release yields 0-5 entries, one sentence each. When unsure whether something clears the bar, it does not.

### 3. Draft and categorize

- Categories: `support` (new cameras/formats), `feature` (new capability or setting), `improvement` (existing flow got better), `fix`.
- Write English and Russian first. English is the source of truth for meaning.
- Use the shortest factual sentence that still identifies the change. Prefer
  one clause and aim for 6-12 English words; go longer only when a condition is
  needed to identify the behavior.
- Describe the visible result, not the implementation, sequencing, safeguards,
  or every sub-fix behind it. If a draft chains details with "and", remove the
  secondary detail unless both outcomes independently deserve changelog entries.
- Treat the changelog as a release ledger, not a marketing surface. State the changed behavior literally and stop. Do not add reassurance, benefit framing, product promises, or adjectives such as "cleaner", "clearer", "smoother", "better", or "more reliable". Use "faster" only when the entry can name the concrete operation that became faster and the change is supported by evidence.
- Before translating, do a compression pass over both English and Russian:
  1. Remove release-time filler such as "now", "currently", "теперь", and
     "сейчас" unless time itself is part of the change.
  2. Replace evaluative wording such as "works correctly", "stays smooth",
     "работает правильно", or "остаётся плавным" with the observable behavior
     or former failure: "restarts", "no longer stalls", "перезапускается",
     "больше не зависает".
  3. Delete every modifier whose removal leaves the same fact.
  4. Read each locale's text on its own: it must make clear what was added,
     improved, or fixed without a category prefix or icon. The app shows
     categories as icons. Keep words such as "Added", "Improved", or "Fixed"
     when needed to preserve that meaning, even if generated Markdown repeats
     the category label.
- Use the terse version as the translation source. Example: prefer "Playback no
  longer stalls between clips at higher speeds" over "Playback now stays smooth
  when moving between clips, including at higher speeds."
- Do not re-announce an unchanged product property (privacy, local processing, offline use, and so on) merely because landing copy now emphasizes it.
- `.claude/rules/voice.md` still governs plain vocabulary, product terms, locale register, and typography. Its outcome-first rule does not require promotional wording: include enough mechanics to identify the changed behavior precisely.
- Prefer a factual condition and result. For example: "The map now switches to a backup source when the primary source is unavailable." Do not inflate it to "The map keeps working through outages" or add a landing-copy entry saying privacy is now explained more clearly.
- Translate to the remaining locales. Reuse each locale's established product vocabulary - check how `src/i18n/<lang>.ts` names trips, recordings, cameras before inventing a term.
- Naming a camera brand requires a real sample behind the support claim, same bar as the landing copy.

### 4. Land the data

- New ids: `<yyyy-mm-dd>.<n>` where the date is the day the change landed on main (the commit date, not today) and `<n>` orders entries within that day - higher = newer. Prepend entries newest-first.
- Update `LATEST_CHANGELOG_ID` in `src/changelog/latest.ts` to the new `entries[0].id`.
- Regenerate: `npm run generate:changelog`.
- Verify: `npx vitest run src/changelog` and `npm run typecheck`.

### 5. Review gate

Show the user the drafted entries (en + ru) BEFORE committing - the "coarse enough, user-relevant enough" judgment is theirs. Commit entries.ts + latest.ts + CHANGELOG.md together in one commit.
