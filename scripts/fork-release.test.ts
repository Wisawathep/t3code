import { assert, it } from "@effect/vitest";

import {
  buildVersionFromTag,
  isSafeTag,
  parseGitHubRepository,
  parseMergeTreeConflicts,
  pickLatestRelease,
  type GitHubRelease,
} from "./fork-release.ts";

const release = (tag: string, publishedAt: string | null, draft = false): GitHubRelease => ({
  tag_name: tag,
  name: `T3 Code ${tag}`,
  html_url: `https://github.com/o/r/releases/tag/${tag}`,
  published_at: publishedAt,
  draft,
});

it("reads owner/repo from GitHub HTTPS and SSH remotes", () => {
  assert.strictEqual(
    parseGitHubRepository("https://github.com/Type-Delta/t3code.git"),
    "Type-Delta/t3code",
  );
  assert.strictEqual(
    parseGitHubRepository("https://github.com/Type-Delta/t3code"),
    "Type-Delta/t3code",
  );
  assert.strictEqual(
    parseGitHubRepository("git@github.com:Type-Delta/t3code.git"),
    "Type-Delta/t3code",
  );
  assert.strictEqual(
    parseGitHubRepository("ssh://git@github.com/Type-Delta/t3code.git"),
    "Type-Delta/t3code",
  );
  assert.strictEqual(parseGitHubRepository("https://gitlab.com/o/r.git"), null);
});

it("picks the newest published release, including prereleases but not drafts", () => {
  const latest = pickLatestRelease([
    release("v0.0.40-a", "2026-09-16T03:11:45Z"),
    release("v0.0.41-a", "2026-09-30T00:00:00Z", true),
    release("v0.0.40-c", "2026-09-16T10:19:21Z"),
    release("v0.0.40-b", null),
  ]);
  assert.strictEqual(latest?.tag_name, "v0.0.40-c");
  assert.strictEqual(pickLatestRelease([]), null);
});

it("derives desktop build versions from release tags", () => {
  assert.strictEqual(buildVersionFromTag("v0.0.40-c"), "0.0.40-c");
  assert.strictEqual(buildVersionFromTag("0.1.0"), "0.1.0");
  assert.strictEqual(buildVersionFromTag("release-2026"), null);
});

it("only accepts tags that are safe on a git and terminal command line", () => {
  assert.isTrue(isSafeTag("v0.0.40-c"));
  assert.isTrue(isSafeTag("release/v1.2.3"));
  assert.isFalse(isSafeTag("-v1"));
  assert.isFalse(isSafeTag("v1 && calc"));
  assert.isFalse(isSafeTag("v1/../x"));
});

it("lists each conflicted path from merge-tree output once", () => {
  assert.deepStrictEqual(
    parseMergeTreeConflicts(
      "4b825dc642cb6eb9a060e54bf8d69288fbee4904\nFORK.md\nsrc/a.ts\nFORK.md\n",
    ),
    ["FORK.md", "src/a.ts"],
  );
});
