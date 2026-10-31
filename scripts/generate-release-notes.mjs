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

import { loadChangelogEntries, renderEntryBullet } from "./_changelog-render.mjs";
import { ENTRIES_PATH, entryIdsAt, previousReleaseTag } from "./_release-tags.mjs";
import { compareReleaseTags, isReleaseTag } from "../src/portable/release-tags.mjs";

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

const lines = [];
if (fresh.length > 0) {
    lines.push("## What's new", "", ...fresh.map(renderEntryBullet));
} else {
    lines.push("No changelog entries for this release.");
}
lines.push("");
if (previousTag && repo) {
    lines.push(
        `**Full changelog:** [${previousTag}...${tag}](https://github.com/${repo}/compare/${previousTag}...${tag})`,
    );
} else {
    lines.push(
        `**Full changelog:** [CHANGELOG.md](https://github.com/${repo || "everydashcam/everydashcam"}/blob/${tag}/CHANGELOG.md)`,
    );
}

const notes = `${lines.join("\n").trimEnd()}\n`;
const out = values.out;
if (out) {
    writeFileSync(out, notes);
    console.error(`wrote ${out} (${fresh.length} new entries since ${previousTag ?? "the beginning"})`);
} else {
    process.stdout.write(notes);
}
