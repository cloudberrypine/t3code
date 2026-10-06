/**
 * Fork: Polyzonia's "Play web build" in the thread details panel. Plays the
 * thread's worktree's web build in the integrated browser, beside the
 * project's own scripts (its "Play" runs the desktop build). The play
 * server's page explains a missing, stale or failed build.
 */
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { PlayIcon } from "lucide-react";
import { useCallback, useMemo } from "react";

import { usePlayLinkOpener, useThreadPlayPageUrl } from "../../browser/playLinks";
import { openUrlInPreview } from "../../browser/openFileInPreview";
import { recordVisitForThread } from "../../browserHistoryStore";
import { useProject, useThreadShell } from "../../state/entities";
import { previewEnvironment } from "../../state/preview";
import { useAtomCommand } from "../../state/use-atom-command";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { THREAD_DETAILS_PANEL_ICON_CLASS } from "./threadDetailsPanelStyles";

export function PlayWebBuildControl(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const threadRef = useMemo(
    () => scopeThreadRef(props.environmentId, props.threadId),
    [props.environmentId, props.threadId],
  );
  const thread = useThreadShell(threadRef);
  const project = useProject(
    thread ? scopeProjectRef(thread.environmentId, thread.projectId) : null,
  );
  const url = useThreadPlayPageUrl({
    environmentId: props.environmentId,
    projectRoot: project?.workspaceRoot ?? null,
    worktreePath: thread?.worktreePath ?? null,
  });
  const openPreview = useAtomCommand(previewEnvironment.open, { reportFailure: false });
  const openInPreview = useCallback(
    (target: string) =>
      openUrlInPreview({ threadRef, url: target, openPreview }).then((result) => {
        if (result._tag === "Success") recordVisitForThread(threadRef, target);
        return result;
      }),
    [openPreview, threadRef],
  );
  const openPlayLink = usePlayLinkOpener(props.environmentId, openInPreview);
  if (url === null) return null;
  return (
    <ThreadDetailsControl
      size="xs"
      variant="ghost"
      part="row"
      aria-label="Play web build"
      onClick={() => void openPlayLink(url, true)}
    >
      <PlayIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} />
      <span className="truncate">Play web build</span>
    </ThreadDetailsControl>
  );
}
