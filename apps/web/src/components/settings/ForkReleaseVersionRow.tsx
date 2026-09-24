import type { DesktopForkReleaseCheck } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { useCallback, useState } from "react";

import { ensureLocalApi } from "../../localApi";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SettingsRow } from "./settingsLayout";

type ForkReleaseBridge = NonNullable<NonNullable<Window["desktopBridge"]>["forkRelease"]>;

function describeCheck(check: DesktopForkReleaseCheck | null): string {
  if (!check) return "Checks the releases of the repository this fork follows.";
  if ("message" in check) return check.message;
  const { repository, latestRelease } = check;
  if (check.status === "up-to-date") {
    return `Up to date with ${repository} ${latestRelease.tag}.`;
  }
  const base = `${latestRelease.name} is available from ${repository}.`;
  if (check.conflicts.length > 0) {
    return `${base} Merging it would conflict in ${check.conflicts.length} file(s) with your changes.`;
  }
  if (check.dirty) return `${base} Commit or stash local changes in the source checkout first.`;
  return `${base} It merges cleanly with your changes.`;
}

/**
 * About → Version for fork builds without an update feed. "Check for Updates"
 * compares the source checkout with its `origin` repository's newest GitHub
 * release; "Merge and Build" merges that release and builds a new installer
 * in a terminal window (see scripts/fork-release.ts).
 */
export function ForkReleaseVersionRow({
  title,
  forkRelease,
}: {
  title: ReactNode;
  forkRelease: ForkReleaseBridge;
}) {
  const [check, setCheck] = useState<DesktopForkReleaseCheck | null>(null);
  const [isChecking, setIsChecking] = useState(false);
  const [isStarting, setIsStarting] = useState(false);

  const runCheck = useCallback(() => {
    setIsChecking(true);
    void forkRelease
      .check()
      .then(setCheck)
      .catch((error: unknown) =>
        setCheck({
          status: "error",
          sourceDir: null,
          message: error instanceof Error ? error.message : "Update check failed.",
        }),
      )
      .finally(() => setIsChecking(false));
  }, [forkRelease]);

  const mergeAndBuild = useCallback(async () => {
    if (check?.status !== "available" || isStarting) return;
    const { tag } = check.latestRelease;
    setIsStarting(true);
    try {
      const confirmed = await ensureLocalApi().dialogs.confirm(
        [
          `Merge ${check.repository} ${tag} into ${check.sourceDir} and build a new installer?`,
          `The current commit is saved as backup/pre-merge-${tag.replaceAll("/", "-")}. A terminal window shows progress, and the installer is written to the release folder.`,
        ].join("\n\n"),
      );
      if (!confirmed) return;
      await forkRelease.mergeAndBuild(tag);
      toastManager.add(
        stackedThreadToast({
          type: "success",
          title: "Merge and Build started",
          description: "Follow progress in the terminal window.",
        }),
      );
    } catch (error) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not start Merge and Build",
          description: error instanceof Error ? error.message : "Merge and Build failed to start.",
        }),
      );
    } finally {
      setIsStarting(false);
    }
  }, [check, forkRelease, isStarting]);

  const blockedReason =
    check?.status !== "available"
      ? null
      : check.conflicts.length > 0
        ? `Conflicting files:\n${check.conflicts.slice(0, 12).join("\n")}${
            check.conflicts.length > 12 ? `\n…and ${check.conflicts.length - 12} more` : ""
          }`
        : check.dirty
          ? `Uncommitted changes in ${check.sourceDir}`
          : null;

  const control =
    check?.status === "available" ? (
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              size="sm"
              variant="outline"
              disabled={blockedReason !== null || isStarting}
              onClick={() => void mergeAndBuild()}
            >
              Merge and Build
            </Button>
          }
        />
        <TooltipPopup className="whitespace-pre-line">
          {blockedReason ??
            `Build ${check.buildVersion ?? check.latestRelease.tag} from ${check.sourceDir}`}
        </TooltipPopup>
      </Tooltip>
    ) : (
      <Button size="sm" variant="outline" disabled={isChecking} onClick={runCheck}>
        {isChecking
          ? "Checking…"
          : check?.status === "up-to-date"
            ? "Up to Date"
            : "Check for Updates"}
      </Button>
    );

  return <SettingsRow title={title} description={describeCheck(check)} control={control} />;
}
