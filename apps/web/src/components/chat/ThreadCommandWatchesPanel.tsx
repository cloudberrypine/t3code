/**
 * Fork: the thread's command watches (`watch_command`) in the details panel,
 * fed by the live command-watch subscription, with a way to stop each one.
 */
import type { CommandWatch, EnvironmentId, ThreadId } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { RadioTowerIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { useClientSettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatDayAwareTimestamp } from "../../timestampFormat";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import {
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_ROW_CONTENT_CLASS,
} from "./threadDetailsPanelStyles";

/** Renders nothing when the thread has no watches. */
export function ThreadCommandWatchesPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const watchesQuery = useEnvironmentQuery(
    serverEnvironment.commandWatchesLive({ environmentId: props.environmentId, input: {} }),
  );
  const stopWatch = useAtomCommand(serverEnvironment.stopCommandWatch, {
    label: "thread command watch stop",
  });
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const [stopping, setStopping] = useState<string | null>(null);

  const watches = (watchesQuery.data?.watches ?? []).filter(
    (watch) => watch.threadId === props.threadId,
  );
  // An older server has no command watches; there is nothing to show then.
  if (watches.length === 0) return null;

  const stop = async (watch: CommandWatch) => {
    if (stopping !== null) return;
    setStopping(watch.label);
    const result = await stopWatch({
      environmentId: props.environmentId,
      input: { threadId: watch.threadId, label: watch.label },
    });
    setStopping(null);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not stop the watch",
          description: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  };

  return (
    <ThreadDetailsSection headingId="thread-details-command-watches-heading" title="Watches">
      <ul className="m-0 list-none p-0">
        {watches.map((watch) => (
          <li
            key={watch.label}
            className={cn(
              "group flex items-center rounded-lg py-1.5",
              THREAD_DETAILS_PANEL_ROW_CONTENT_CLASS,
            )}
          >
            <RadioTowerIcon
              className={cn(
                THREAD_DETAILS_PANEL_ICON_CLASS,
                watch.status === "paused" && "opacity-50",
              )}
            />
            <div className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium text-foreground/80">
                {watch.label}
              </span>
              <p className="truncate font-mono text-2xs text-muted-foreground">{watch.command}</p>
              <p className="truncate text-2xs text-muted-foreground">
                {watch.status === "paused" || watch.runningSince === null
                  ? "Paused while the thread is settled"
                  : `Running since ${formatDayAwareTimestamp(watch.runningSince, timestampFormat)}`}
              </p>
            </div>
            <Tooltip>
              <TooltipTrigger
                render={
                  <ThreadDetailsControl
                    size="icon-xs"
                    variant="ghost"
                    part="icon"
                    aria-label={`Stop watching ${watch.label}`}
                    disabled={stopping !== null}
                    onClick={() => void stop(watch)}
                  >
                    <XIcon className="size-3.5" />
                  </ThreadDetailsControl>
                }
              />
              <TooltipPopup>Stop watching</TooltipPopup>
            </Tooltip>
          </li>
        ))}
      </ul>
    </ThreadDetailsSection>
  );
}
