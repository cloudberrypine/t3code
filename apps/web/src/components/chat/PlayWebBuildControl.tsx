/**
 * Fork: Polyzonia's "Play web build" in the thread details panel. Plays the
 * thread's worktree's web build in the integrated browser, beside the
 * project's own scripts (its "Play" runs the desktop build). The play
 * server's page explains a missing, stale or failed build.
 */
import { useAtomValue } from "@effect/atom-react";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { PlayIcon } from "lucide-react";
import { useGT } from "gt-react";
import { useEffect } from "react";

import { usePlayLinkOpener, useThreadPlayState } from "../../browser/playLinks";
import { openUrlInPreview } from "../../browser/openFileInPreview";
import { recordVisitForThread } from "../../browserHistoryStore";
import { isCommandPaletteOpen } from "../../commandPaletteBus";
import { type ShortcutMatchContext, shortcutLabelForCommand } from "../../keybindings";
import { useProject, useThreadShell } from "../../state/entities";
import { previewEnvironment } from "../../state/preview";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { isPlayWebBuildShortcut, PLAY_WEB_BUILD_COMMAND } from "./playWebBuildShortcut";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { THREAD_DETAILS_PANEL_ICON_CLASS } from "./threadDetailsPanelStyles";

/**
 * Plays the thread's web build: `loading` while the play server is being
 * checked, null when it does not serve the thread's project.
 */
function usePlayWebBuild(
  threadRef: ScopedThreadRef,
): { readonly loading: true } | { readonly loading: false; readonly play: () => void } | null {
  const thread = useThreadShell(threadRef);
  const project = useProject(
    thread ? scopeProjectRef(thread.environmentId, thread.projectId) : null,
  );
  const state = useThreadPlayState({
    environmentId: threadRef.environmentId,
    projectRoot: project?.workspaceRoot ?? null,
    worktreePath: thread?.worktreePath ?? null,
  });
  const openPreview = useAtomCommand(previewEnvironment.open, { reportFailure: false });
  const openInPreview = (target: string) =>
    openUrlInPreview({ threadRef, url: target, openPreview }).then((result) => {
      if (result._tag === "Success") recordVisitForThread(threadRef, target);
      return result;
    });
  const openPlayLink = usePlayLinkOpener(threadRef.environmentId, openInPreview);
  const url = state?.status === "ready" ? state.url : null;
  const loading = state?.status === "loading";
  if (loading) return { loading: true };
  return url === null ? null : { loading: false, play: () => void openPlayLink(url, true) };
}

export function PlayWebBuildControl(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const gt = useGT();
  const threadRef = scopeThreadRef(props.environmentId, props.threadId);
  const playWebBuild = usePlayWebBuild(threadRef);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  if (playWebBuild === null) return null;
  const shortcutLabel = shortcutLabelForCommand(keybindings, PLAY_WEB_BUILD_COMMAND);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <ThreadDetailsControl
            size="xs"
            variant="ghost"
            part="row"
            aria-label={gt("Play web build")}
            disabled={playWebBuild.loading}
            {...(playWebBuild.loading ? {} : { onClick: playWebBuild.play })}
          />
        }
      >
        <PlayIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} />
        <span className="truncate">{gt("Play web build")}</span>
      </TooltipTrigger>
      <TooltipPopup side="top">
        {playWebBuild.loading
          ? gt("Checking the play server…")
          : shortcutLabel
            ? gt("Play web build ({shortcut})", { shortcut: shortcutLabel })
            : gt("Play web build")}
      </TooltipPopup>
    </Tooltip>
  );
}

/**
 * The "Play web build" shortcut for the open thread, whether or not the
 * details panel shows its row. ChatView renders it with its shortcut context.
 */
export function PlayWebBuildShortcut(props: {
  readonly threadRef: ScopedThreadRef;
  readonly getShortcutContext: (target: EventTarget | null) => Partial<ShortcutMatchContext>;
}) {
  const { getShortcutContext } = props;
  const playWebBuild = usePlayWebBuild(props.threadRef);
  const play = playWebBuild?.loading === false ? playWebBuild.play : null;
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a window keydown listener for the play shortcut while the thread is open
  useEffect(() => {
    if (play === null) return;
    const handler = (event: KeyboardEvent) => {
      if (isCommandPaletteOpen()) return;
      const context = getShortcutContext(event.target);
      if (!isPlayWebBuildShortcut(event, keybindings, { context })) return;
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) play();
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [getShortcutContext, keybindings, play]);
  return null;
}
