// The id of the newest changelog entry, duplicated out of entries.ts on
// purpose: the topbar "What's new" badge needs it at startup, while the full
// entry list (all locales, whole history) stays in a lazy chunk behind the
// modal. entries.test.ts fails when this constant drifts from
// CHANGELOG_ENTRIES[0].id; the changelog skill updates both together.

export const LATEST_CHANGELOG_ID = "2026-10-20.2";
