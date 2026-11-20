// Emits the GitHub release notes for a tag: the changelog entries added since
// the previous published release, rendered as English markdown. Wired into
// .github/workflows/release.yml (gh release create --notes-file); runnable
// locally for a preview:
//
//   node scripts/generate-release-notes.mjs --tag v2026.08.08 [--previous-tag TAG] [--out FILE]
//
// "Added since" is a diff of entry ids between this revision's entries.ts and
// the previous release tag's - not a date comparison, so same-day tags and
// late-dated entries attribute unambiguously. CI passes --previous-tag from
// GitHub releases, since a failed, unpublished tag must not consume entries.
// Without the option, local previews use the previous v* tag. Requires tags
// in the clone (CI checks out with fetch-depth: 0).

import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { PORTABLE_PRIMARY_ORIGIN } from "../src/portable/manifest.mjs";
import { compareReleaseTags, isReleaseTag } from "../src/portable/release-tags.mjs";
import { loadChangelogEntries } from "./_changelog-render.mjs";
import { ENTRIES_PATH, entryIdsAt, previousReleaseTag } from "./_release-tags.mjs";

const { values } = parseArgs({
    options: {
        tag: { type: "string" },
        repo: { type: "string" },
        "previous-tag": { type: "string" },
        out: { type: "string" },
    },
});

const tag = values.tag ?? process.env.GITHUB_REF_NAME;
if (!tag?.startsWith("v")) {
    console.error("usage: generate-release-notes.mjs --tag v<yyyy>.<mm>.<dd>[.<n>] [--out FILE]");
    process.exit(1);
}
// Repo slug for the compare link; empty means "skip the link" (local preview
// outside CI without --repo).
const repo = values.repo ?? process.env.GITHUB_REPOSITORY ?? "";

const previousTag = values["previous-tag"] ?? previousReleaseTag(tag);
if (previousTag && (!isReleaseTag(previousTag) || compareReleaseTags(previousTag, tag) >= 0)) {
    throw new Error(`previous release tag ${previousTag} must precede ${tag}`);
}

// Entry ids present at the previous tag (extraction contract: entryIdsAt in
// _release-tags.mjs). Absent file (the release predates the changelog) = no
// ids, every current entry counts as new.
let previousIds = new Set();
if (previousTag) {
    const oldIds = entryIdsAt(previousTag);
    if (oldIds) previousIds = new Set(oldIds);
    else console.error(`note: ${ENTRIES_PATH} absent at ${previousTag} - treating all entries as new`);
}

const entries = await loadChangelogEntries();
const fresh = entries.filter((entry) => !previousIds.has(entry.id));

const repoUrl = `https://github.com/${repo || "everydashcam/everydashcam"}`;
const historyLinks = [`[Changelog](${repoUrl}/blob/${tag}/CHANGELOG.md)`];
if (previousTag && repo) {
    historyLinks.push(`[Compare changes](${repoUrl}/compare/${previousTag}...${tag})`);
}

const sections = [];
if (fresh.length > 0) {
    sections.push(["## What's new", "", ...fresh.map((entry) => `- ${entry.text.en}`)].join("\n"));
}
sections.push(
    historyLinks.join(" · "),
    `**Use the latest web version** at [everydashcam.app](${PORTABLE_PRIMARY_ORIGIN}/).`,
    "**Or use the portable edition.** Download the `.html` file for your language from **Assets** below. " +
        "Open it in a desktop browser and select your recordings folder.",
    `[Latest portable downloads](${repoUrl}/releases/latest) · ` +
        `[Portable guide](${repoUrl}/blob/main/docs/self-hosting.md#open-the-portable-html)`,
);

const notes = `${sections.join("\n\n")}\n`;
const out = values.out;
if (out) {
    writeFileSync(out, notes);
    console.error(`wrote ${out} (${fresh.length} new entries since ${previousTag ?? "the beginning"})`);
} else {
    process.stdout.write(notes);
}
