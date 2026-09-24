// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalConsole:off -- A standalone maintainer script that runs outside any Effect runtime and shells out to git, vp, and the desktop artifact builder.
/**
 * Keeps this fork current with the GitHub Releases of the repository it was
 * forked from (the `origin` remote).
 *
 *   node scripts/fork-release.ts check [--json]
 *   node scripts/fork-release.ts merge-and-build [--tag <tag>] [--build-version <version>]
 *
 * `check` reports the newest release, whether HEAD already contains it, and
 * which files a merge would conflict in (via `git merge-tree`, without
 * touching the worktree). `merge-and-build` refuses to start on a dirty
 * worktree or a conflicting merge, records a `backup/pre-merge-<tag>` branch,
 * merges the release tag, reinstalls dependencies, and builds the desktop
 * installer into `release/`. The desktop app's Settings → General → About
 * runs both commands against the checkout it was built from.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const repoRoot = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const RELEASE_REMOTE = "origin";
const RELEASE_OUTPUT_DIR = "release";
// oxlint-disable-next-line t3code/no-global-process-runtime -- A standalone script targets the host it runs on.
const hostPlatform = process.platform;
// oxlint-disable-next-line t3code/no-global-process-runtime -- A standalone script targets the host it runs on.
const hostArch = process.arch;

export interface GitHubRelease {
  readonly tag_name: string;
  readonly name: string | null;
  readonly html_url: string;
  readonly published_at: string | null;
  readonly draft: boolean;
}

export interface ForkReleaseInfo {
  readonly tag: string;
  readonly name: string;
  readonly url: string;
  readonly publishedAt: string | null;
}

export type ForkReleaseCheck =
  | {
      readonly status: "available" | "up-to-date";
      readonly repository: string;
      readonly sourceDir: string;
      readonly currentRelease: string | null;
      readonly latestRelease: ForkReleaseInfo;
      readonly buildVersion: string | null;
      readonly conflicts: readonly string[];
      readonly dirty: boolean;
    }
  | { readonly status: "error"; readonly sourceDir: string; readonly message: string };

/** `owner/repo` for a GitHub HTTPS or SSH remote URL, otherwise null. */
export function parseGitHubRepository(remoteUrl: string): string | null {
  const match = remoteUrl
    .trim()
    .match(
      /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+)\/([^/]+?)(?:\.git)?\/?$/,
    );
  return match ? `${match[1]}/${match[2]}` : null;
}

/** Newest published, non-draft release. Prereleases count: fork releases are all prereleases. */
export function pickLatestRelease(releases: readonly GitHubRelease[]): GitHubRelease | null {
  const published = releases.filter((release) => !release.draft && release.published_at);
  published.sort((a, b) => Date.parse(b.published_at ?? "") - Date.parse(a.published_at ?? ""));
  return published[0] ?? null;
}

/** Desktop build version for a release tag, e.g. `v0.0.41-a` → `0.0.41-a`. */
export function buildVersionFromTag(tag: string): string | null {
  const version = tag.replace(/^v/, "");
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version) ? version : null;
}

/** Tags are passed to git and to a terminal command line, so keep them boring. */
export function isSafeTag(tag: string): boolean {
  return /^[0-9A-Za-z][0-9A-Za-z._/-]*$/.test(tag) && !tag.includes("..");
}

/** Conflicted paths from `git merge-tree --write-tree --name-only --no-messages`. */
export function parseMergeTreeConflicts(stdout: string): string[] {
  const [, ...paths] = stdout.split("\n").map((line) => line.trim());
  return [...new Set(paths.filter((line) => line.length > 0))];
}

function run(
  command: string,
  args: readonly string[],
): { readonly status: number; readonly stdout: string; readonly stderr: string } {
  const result = NodeChildProcess.spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
}

function git(...args: string[]): string {
  const result = run("git", args);
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
  return result.stdout.trim();
}

function gitSucceeds(...args: string[]): boolean {
  return run("git", args).status === 0;
}

function fetchReleaseTag(tag: string): void {
  git("fetch", "--quiet", "--no-tags", RELEASE_REMOTE, `+refs/tags/${tag}:refs/tags/${tag}`);
}

async function fetchReleases(repository: string): Promise<GitHubRelease[]> {
  const token = process.env.GITHUB_TOKEN?.trim();
  const response = await fetch(`https://api.github.com/repos/${repository}/releases?per_page=30`, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "t3code-fork-release",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub releases request for ${repository} failed with ${response.status}.`);
  }
  return (await response.json()) as GitHubRelease[];
}

function mergeConflicts(tag: string): string[] {
  const result = run("git", [
    "merge-tree",
    "--write-tree",
    "--name-only",
    "--no-messages",
    "HEAD",
    `refs/tags/${tag}`,
  ]);
  if (result.status === 0) return [];
  if (result.status === 1) return parseMergeTreeConflicts(result.stdout);
  throw new Error(`git merge-tree failed: ${result.stderr.trim()}`);
}

export async function checkForkRelease(): Promise<ForkReleaseCheck> {
  try {
    const remoteUrl = git("remote", "get-url", RELEASE_REMOTE);
    const repository = parseGitHubRepository(remoteUrl);
    if (!repository) {
      throw new Error(`The ${RELEASE_REMOTE} remote (${remoteUrl}) is not a GitHub repository.`);
    }
    const releases = await fetchReleases(repository);
    const latest = pickLatestRelease(releases);
    if (!latest) throw new Error(`${repository} has no published releases.`);
    if (!isSafeTag(latest.tag_name)) throw new Error(`Unsupported release tag ${latest.tag_name}.`);

    fetchReleaseTag(latest.tag_name);
    const merged = gitSucceeds(
      "merge-base",
      "--is-ancestor",
      `refs/tags/${latest.tag_name}`,
      "HEAD",
    );
    const currentRelease =
      releases
        .filter((release) => !release.draft && isSafeTag(release.tag_name))
        .sort((a, b) => Date.parse(b.published_at ?? "") - Date.parse(a.published_at ?? ""))
        .find(
          (release) =>
            gitSucceeds(
              "rev-parse",
              "--verify",
              "--quiet",
              `refs/tags/${release.tag_name}^{commit}`,
            ) &&
            gitSucceeds("merge-base", "--is-ancestor", `refs/tags/${release.tag_name}`, "HEAD"),
        )?.tag_name ?? null;

    return {
      status: merged ? "up-to-date" : "available",
      repository,
      sourceDir: repoRoot,
      currentRelease,
      latestRelease: {
        tag: latest.tag_name,
        name: latest.name?.trim() || latest.tag_name,
        url: latest.html_url,
        publishedAt: latest.published_at,
      },
      buildVersion: buildVersionFromTag(latest.tag_name),
      conflicts: merged ? [] : mergeConflicts(latest.tag_name),
      dirty: git("status", "--porcelain", "--untracked-files=no").length > 0,
    };
  } catch (error) {
    return {
      status: "error",
      sourceDir: repoRoot,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function desktopBuildTarget(): readonly [platform: string, target: string] {
  if (hostPlatform === "win32") return ["win", "nsis"];
  if (hostPlatform === "darwin") return ["mac", "dmg"];
  return ["linux", "AppImage"];
}

function runInherited(command: string, args: readonly string[]): void {
  console.log(`\n> ${command} ${args.join(" ")}`);
  const result = NodeChildProcess.spawnSync(command, args, {
    cwd: repoRoot,
    stdio: "inherit",
    // `vp` is a .cmd shim on Windows.
    shell: hostPlatform === "win32" && command === "vp",
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${command} ${args.join(" ")} exited with ${result.status}.`);
}

async function mergeAndBuild(options: { tag?: string; buildVersion?: string }): Promise<void> {
  const check = await checkForkRelease();
  if (check.status === "error") throw new Error(check.message);
  const tag = options.tag ?? check.latestRelease.tag;
  if (!isSafeTag(tag)) throw new Error(`Unsupported release tag ${tag}.`);
  const buildVersion = options.buildVersion ?? buildVersionFromTag(tag);
  if (!buildVersion)
    throw new Error(`Cannot derive a build version from ${tag}; pass --build-version.`);

  console.log(`Source:  ${repoRoot}`);
  console.log(`Release: ${check.repository} ${tag}`);
  if (check.dirty) {
    throw new Error(
      "The checkout has uncommitted changes to tracked files. Commit or stash them first.",
    );
  }

  if (tag !== check.latestRelease.tag) fetchReleaseTag(tag);
  if (gitSucceeds("merge-base", "--is-ancestor", `refs/tags/${tag}`, "HEAD")) {
    console.log(`HEAD already contains ${tag}; skipping the merge.`);
  } else {
    const conflicts = mergeConflicts(tag);
    if (conflicts.length > 0) {
      throw new Error(
        `Merging ${tag} would conflict in ${conflicts.length} file(s); nothing was changed:\n  ${conflicts.join("\n  ")}`,
      );
    }
    const backup = `backup/pre-merge-${tag.replaceAll("/", "-")}`;
    git("branch", "--force", backup, "HEAD");
    console.log(`Saved the current HEAD as ${backup}.`);
    const merge = run("git", [
      "merge",
      "--no-ff",
      "--no-edit",
      "-m",
      `chore(fork): merge ${check.repository} release ${tag}`,
      `refs/tags/${tag}`,
    ]);
    if (merge.status !== 0) {
      run("git", ["merge", "--abort"]);
      throw new Error(`git merge failed and was aborted:\n${merge.stderr || merge.stdout}`);
    }
    console.log(`Merged ${tag} into ${git("rev-parse", "--abbrev-ref", "HEAD")}.`);
  }

  runInherited("vp", ["i"]);
  // A local install can rewrite peer hashes in the lockfile; keep the merged
  // lockfile so the checkout stays clean for the next Merge and Build.
  git("checkout", "--", "pnpm-lock.yaml");
  const [platform, target] = desktopBuildTarget();
  runInherited(process.execPath, [
    "scripts/build-desktop-artifact.ts",
    "--platform",
    platform,
    "--target",
    target,
    "--arch",
    hostArch,
    "--build-version",
    buildVersion,
    "--output-dir",
    RELEASE_OUTPUT_DIR,
  ]);

  const outputDir = NodePath.join(repoRoot, RELEASE_OUTPUT_DIR);
  console.log(`\nDone. Installer for ${buildVersion} is in ${outputDir}`);
  if (hostPlatform === "win32") {
    NodeChildProcess.spawn("explorer.exe", [outputDir], {
      detached: true,
      stdio: "ignore",
    }).unref();
  }
}

function readFlag(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

async function main(args: readonly string[]): Promise<void> {
  const [command, ...rest] = args;
  if (command === "check") {
    const result = await checkForkRelease();
    if (rest.includes("--json")) {
      console.log(JSON.stringify(result));
    } else if (result.status === "error") {
      console.error(result.message);
    } else {
      console.log(
        `${result.repository}: latest ${result.latestRelease.tag}, HEAD contains ${result.currentRelease ?? "no release"} (${result.status}).`,
      );
      if (result.conflicts.length > 0)
        console.log(`Would conflict in:\n  ${result.conflicts.join("\n  ")}`);
    }
    process.exitCode = result.status === "error" ? 1 : 0;
    return;
  }
  if (command === "merge-and-build") {
    const tag = readFlag(rest, "--tag");
    const buildVersion = readFlag(rest, "--build-version");
    await mergeAndBuild({
      ...(tag ? { tag } : {}),
      ...(buildVersion ? { buildVersion } : {}),
    });
    return;
  }
  console.error(
    "Usage: node scripts/fork-release.ts check [--json]\n       node scripts/fork-release.ts merge-and-build [--tag <tag>] [--build-version <version>]",
  );
  process.exitCode = 2;
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(
      `\nMerge and Build stopped: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
}
