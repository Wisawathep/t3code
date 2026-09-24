// @effect-diagnostics nodeBuiltinImport:off -- Runs the source checkout's Node script and opens a visible terminal for the long merge-and-build.
import { DesktopForkReleaseCheckSchema, type DesktopForkReleaseCheck } from "@t3tools/contracts";
import * as NodeChildProcess from "node:child_process";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";

import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

const FORK_RELEASE_SCRIPT = "scripts/fork-release.ts";
const CHECK_TIMEOUT_MS = 120_000;

const AppPackageMetadata = Schema.Struct({ t3codeSourceDir: Schema.optional(Schema.String) });
const decodeAppPackageMetadata = Schema.decodeEffect(Schema.fromJsonString(AppPackageMetadata));
const decodeCheck = Schema.decodeEffect(Schema.fromJsonString(DesktopForkReleaseCheckSchema));

/** Mirrors `isSafeTag` in scripts/fork-release.ts; the tag lands on a terminal command line. */
export function isSafeReleaseTag(tag: string): boolean {
  return /^[0-9A-Za-z][0-9A-Za-z._/-]*$/.test(tag) && !tag.includes("..");
}

/**
 * The checkout this build came from: the repo root in development, or the
 * `t3codeSourceDir` the artifact builder embeds in the packaged app manifest.
 * `null` when it is unknown or no longer holds the fork-release script.
 */
const resolveSourceDir = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  let sourceDir: string | undefined = environment.rootDir;
  if (environment.isPackaged) {
    sourceDir = yield* fileSystem
      .readFileString(environment.path.join(environment.appRoot, "package.json"))
      .pipe(
        Effect.flatMap(decodeAppPackageMetadata),
        Effect.map((metadata) => metadata.t3codeSourceDir?.trim() || undefined),
        Effect.orElseSucceed(() => undefined),
      );
  }
  if (!sourceDir) return null;
  const hasScript = yield* fileSystem
    .exists(environment.path.join(sourceDir, FORK_RELEASE_SCRIPT))
    .pipe(Effect.orElseSucceed(() => false));
  return hasScript ? sourceDir : null;
});

function runCheckScript(sourceDir: string): Promise<string> {
  return new Promise((resolve, reject) => {
    NodeChildProcess.execFile(
      "node",
      [FORK_RELEASE_SCRIPT, "check", "--json"],
      { cwd: sourceDir, timeout: CHECK_TIMEOUT_MS, windowsHide: true },
      // The script prints its JSON result even when it exits non-zero.
      (error, stdout) =>
        stdout.trim() ? resolve(stdout) : reject(error ?? new Error("No output.")),
    );
  });
}

function openTerminal(sourceDir: string, platform: NodeJS.Platform, tag: string): Promise<void> {
  const script = `node ${FORK_RELEASE_SCRIPT} merge-and-build --tag ${tag}`;
  const windowsScript = `node ${FORK_RELEASE_SCRIPT.replaceAll("/", "\\")} merge-and-build --tag ${tag}`;
  const quotedDir = `'${sourceDir.replaceAll("'", `'\\''`)}'`;
  const [command, args, verbatim] =
    platform === "win32"
      ? ([
          "cmd.exe",
          [`/d /c start "T3 Code - Merge and Build" cmd.exe /k ${windowsScript}`],
          true,
        ] as const)
      : platform === "darwin"
        ? ([
            "/usr/bin/osascript",
            [
              "-e",
              `tell application "Terminal" to do script ${JSON.stringify(`cd ${quotedDir} && ${script}`)}`,
              "-e",
              'tell application "Terminal" to activate',
            ],
            false,
          ] as const)
        : ([
            "x-terminal-emulator",
            ["-e", "sh", "-c", `cd ${quotedDir} && ${script}; exec sh`],
            false,
          ] as const);
  return new Promise((resolve, reject) => {
    const child = NodeChildProcess.spawn(command, [...args], {
      cwd: sourceDir,
      detached: true,
      stdio: "ignore",
      windowsVerbatimArguments: verbatim,
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

export const checkForkRelease = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.FORK_RELEASE_CHECK_CHANNEL,
  payload: Schema.Void,
  result: DesktopForkReleaseCheckSchema,
  handler: Effect.fn("desktop.ipc.forkRelease.check")(function* () {
    const sourceDir = yield* resolveSourceDir;
    if (!sourceDir) {
      return {
        status: "unavailable",
        sourceDir: null,
        message: "This build does not know which source checkout it was built from.",
      } satisfies DesktopForkReleaseCheck;
    }
    return yield* Effect.tryPromise(() => runCheckScript(sourceDir)).pipe(
      Effect.flatMap(decodeCheck),
      Effect.catch((cause) =>
        Effect.succeed({
          status: "error",
          sourceDir,
          message: `Could not run ${FORK_RELEASE_SCRIPT} with Node.js: ${String(cause)}`,
        } satisfies DesktopForkReleaseCheck),
      ),
    );
  }),
});

export const mergeAndBuildForkRelease = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.FORK_RELEASE_MERGE_AND_BUILD_CHANNEL,
  payload: Schema.String,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.forkRelease.mergeAndBuild")(function* (tag) {
    if (!isSafeReleaseTag(tag)) return yield* Effect.die(new Error(`Unsupported tag ${tag}.`));
    const sourceDir = yield* resolveSourceDir;
    if (!sourceDir) return yield* Effect.die(new Error("The source checkout is unavailable."));
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    yield* Effect.tryPromise(() => openTerminal(sourceDir, environment.platform, tag)).pipe(
      Effect.orDie,
    );
  }),
});
