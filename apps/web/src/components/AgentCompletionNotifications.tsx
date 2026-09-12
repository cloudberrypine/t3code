import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { useEffect, useState } from "react";
import { useClientSettings, useClientSettingsHydrated } from "~/hooks/useSettings";
import { createCompletionTracker } from "~/lib/completionNotifications";
import { useEnvironments } from "~/state/environments";
import { environmentShell } from "~/state/shell";

function EnvironmentCompletionNotifications({ environmentId }: { environmentId: EnvironmentId }) {
  const shell = useAtomValue(environmentShell.stateValueAtom(environmentId));
  const enabled = useClientSettings((settings) => settings.desktopCompletionNotificationsEnabled);
  const hydrated = useClientSettingsHydrated();
  const [track] = useState(createCompletionTracker);
  useEffect(() => {
    const threads =
      shell.status === "live" && Option.isSome(shell.snapshot)
        ? shell.snapshot.value.threads
        : null;
    for (const thread of track(threads, hydrated && enabled)) {
      if (!thread.latestTurn) continue;
      void window.desktopBridge
        ?.showCompletionNotification?.({
          environmentId,
          threadId: thread.id,
          turnId: thread.latestTurn.turnId,
          title: thread.title,
        })
        .catch((error) => console.error("Could not show completion notification", error));
    }
  }, [shell, enabled, hydrated, track, environmentId]);
  return null;
}

export function AgentCompletionNotifications() {
  const { environments } = useEnvironments();
  const navigate = useNavigate();
  useEffect(
    () =>
      window.desktopBridge?.onCompletionNotificationClick?.((input) => {
        void navigate({
          to: "/$environmentId/$threadId",
          params: { environmentId: input.environmentId, threadId: input.threadId },
        });
      }),
    [navigate],
  );
  if (!window.desktopBridge?.showCompletionNotification) return null;
  return environments.map(({ environmentId }) => (
    <EnvironmentCompletionNotifications key={environmentId} environmentId={environmentId} />
  ));
}
