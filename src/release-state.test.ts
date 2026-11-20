import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CHANGELOG_ENTRIES } from "./changelog/entries.js";

const script = fileURLToPath(new URL("../scripts/check-release-state.mjs", import.meta.url));
const notesScript = fileURLToPath(new URL("../scripts/generate-release-notes.mjs", import.meta.url));
const tag = "v2026.10.07";
let directory: string;
let commit: string;

function git(...args: string[]): string {
    return execFileSync("git", args, { cwd: directory, encoding: "utf8", stdio: "pipe" }).trim();
}

interface Release {
    tag_name: string;
    draft: boolean;
    prerelease: boolean;
}

function check(releases: Release[][] = [], run: Record<string, unknown> | null = {}) {
    writeFileSync(join(directory, "releases.json"), JSON.stringify(releases));
    writeFileSync(
        join(directory, "runs.json"),
        JSON.stringify({
            workflow_runs:
                run === null
                    ? []
                    : [
                          {
                              head_sha: commit,
                              head_branch: "main",
                              event: "push",
                              status: "completed",
                              conclusion: "success",
                              ...run,
                          },
                      ],
        }),
    );
    return spawnSync(process.execPath, [script], {
        cwd: directory,
        encoding: "utf8",
        env: {
            ...process.env,
            PATH: `${directory}:${process.env.PATH}`,
            GITHUB_REF_NAME: tag,
            GITHUB_REPOSITORY: "example/everydashcam",
            GITHUB_OUTPUT: join(directory, "output"),
        },
    });
}

beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "everydashcam-release-state-"));
    git("init", "-b", "main");
    git("config", "user.name", "Test");
    git("config", "user.email", "test@example.invalid");
    git("-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "chore: initial commit");
    commit = git("rev-parse", "HEAD");
    git("-c", "tag.gpgsign=false", "tag", "-a", tag, "-m", "release");
    git("update-ref", "refs/remotes/origin/main", commit);
    // Stub only the external API boundary; preflight and git history run unchanged.
    writeFileSync(
        join(directory, "gh"),
        `#!/bin/sh
case "$*" in
  *"releases?per_page=100"*) cat releases.json ;;
  *"actions/workflows/ci.yml/runs?branch=main&event=push&head_sha=${commit}&per_page=1"*) cat runs.json ;;
  *) exit 2 ;;
esac
`,
        { mode: 0o755 },
    );
});

afterEach(() => rmSync(directory, { recursive: true, force: true }));

describe("release preflight", () => {
    it("accepts a first release and peels an annotated tag to its tested commit", () => {
        const result = check();
        expect(result.stderr).toBe("");
        expect(result.status).toBe(0);
        expect(readFileSync(join(directory, "output"), "utf8")).toBe("previous-tag=\n");
    });

    it("selects the newest published version across pages, ignoring drafts and prereleases", () => {
        const result = check([
            [
                { tag_name: "v2026.10.08", draft: true, prerelease: false },
                { tag_name: "v2026.10.09", draft: false, prerelease: true },
                { tag_name: "v2026.10.06.2", draft: false, prerelease: false },
            ],
            [{ tag_name: "v2026.10.06.10", draft: false, prerelease: false }],
        ]);
        expect(result.status, result.stderr).toBe(0);
        expect(readFileSync(join(directory, "output"), "utf8")).toBe("previous-tag=v2026.10.06.10\n");
    });

    it("rejects an already published tag before any publication", () => {
        const result = check([[{ tag_name: tag, draft: false, prerelease: false }]]);
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("already published (immutable)");
    });

    it("rejects an older tag even when it has never been published", () => {
        const result = check([[{ tag_name: "v2026.10.08", draft: false, prerelease: false }]]);
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("does not follow published release");
    });

    it.each([
        null,
        { status: "in_progress", conclusion: null },
        { conclusion: "failure" },
        { conclusion: "cancelled" },
        { head_sha: "another-commit" },
        { head_branch: "feature" },
        { event: "pull_request" },
    ])("rejects missing, incomplete or unrelated CI: %j", (run) => {
        const result = check([], run);
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("successful CI on main is required");
    });

    it("propagates API failures instead of treating them as an absent release", () => {
        writeFileSync(join(directory, "gh"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
        const result = check();
        expect(result.status).not.toBe(0);
    });

    it("rejects a tag outside main", () => {
        git("-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "chore: off main");
        git("-c", "tag.gpgsign=false", "tag", "-f", tag);
        const result = check();
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("merge-base --is-ancestor");
    });

    it("rejects a production rollback before the deployment can run", () => {
        git("-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "chore: already deployed");
        git("update-ref", "refs/remotes/origin/release", "HEAD");
        git("update-ref", "refs/remotes/origin/main", "HEAD");
        git("checkout", "--detach", tag);
        const result = check();
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("merge-base --is-ancestor refs/remotes/origin/release");
    });
});

describe("published changelog baseline", () => {
    const previousTag = "v2026.10.05";

    function commitEntries(ids: string[], subject: string) {
        mkdirSync(join(directory, "src/changelog"), { recursive: true });
        writeFileSync(join(directory, "src/changelog/entries.ts"), ids.map((id) => `    id: "${id}",`).join("\n"));
        git("add", "src/changelog/entries.ts");
        git("-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", subject);
    }

    function generateNotes() {
        git("-c", "tag.gpgsign=false", "tag", "-f", tag);
        return spawnSync(
            process.execPath,
            [notesScript, "--tag", tag, "--previous-tag", previousTag, "--repo", "example/everydashcam"],
            {
                cwd: directory,
                encoding: "utf8",
            },
        );
    }

    it("generates notes for a release without new entries even when it ships a feature", () => {
        commitEntries(
            CHANGELOG_ENTRIES.map((entry) => entry.id),
            "chore: changelog baseline",
        );
        git("-c", "tag.gpgsign=false", "tag", previousTag);
        writeFileSync(join(directory, "src/feature.ts"), "export const feature = true;\n");
        git("add", "src/feature.ts");
        git("-c", "commit.gpgsign=false", "commit", "-m", "feat: visible feature");
        const result = generateNotes();
        expect(result.status, result.stderr).toBe(0);
        const [history, web, portable, portableLinks] = result.stdout.trimEnd().split("\n\n");
        expect(history).toBe(
            `[Changelog](https://github.com/example/everydashcam/blob/${tag}/CHANGELOG.md) · ` +
                `[Compare changes](https://github.com/example/everydashcam/compare/${previousTag}...${tag})`,
        );
        expect(web).toContain("[everydashcam.app](https://everydashcam.app/)");
        expect(portable).toContain("Download the `.html` file for your language from **Assets** below.");
        expect(portableLinks).toContain(
            "[Latest portable downloads](https://github.com/example/everydashcam/releases/latest)",
        );
        expect(portableLinks).toContain("/blob/main/docs/self-hosting.md#open-the-portable-html");
    });

    it("preserves entries added on an abandoned tag for the next published release", () => {
        commitEntries(
            CHANGELOG_ENTRIES.slice(1).map((entry) => entry.id),
            "chore: changelog baseline",
        );
        git("-c", "tag.gpgsign=false", "tag", previousTag);
        commitEntries(
            CHANGELOG_ENTRIES.map((entry) => entry.id),
            "feat: visible feature",
        );
        git("-c", "tag.gpgsign=false", "tag", "v2026.10.06");
        const result = generateNotes();
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout.split("\n\n").slice(0, 2)).toEqual([
            "## What's new",
            `- ${CHANGELOG_ENTRIES[0]!.text.en}`,
        ]);
        expect(result.stdout).not.toContain(CHANGELOG_ENTRIES[1]!.text.en);
    });
});
