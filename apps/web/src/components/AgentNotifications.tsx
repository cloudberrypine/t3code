import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import { TurnId, type EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { useEffect, useState } from "react";
import { useClientSettings, useClientSettingsHydrated } from "~/hooks/useSettings";
import { createCompletionTracker, createQuestionTracker } from "~/lib/completionNotifications";
import { useEnvironments } from "~/state/environments";
import { environmentShell } from "~/state/shell";

function EnvironmentAgentNotifications({ environmentId }: { environmentId: EnvironmentId }) {
  const shell = useAtomValue(environmentShell.stateValueAtom(environmentId));
  const enabled = useClientSettings((settings) => settings.desktopCompletionNotificationsEnabled);
  const hydrated = useClientSettingsHydrated();
  const [track] = useState(createCompletionTracker);
  const [trackQuestions] = useState(createQuestionTracker);
  useEffect(() => {
    const threads =
      shell.status === "live" && Option.isSome(shell.snapshot)
        ? shell.snapshot.value.threads
        : null;
    for (const thread of track(threads, hydrated && enabled)) {
      if (!thread.latestRunId) continue;
      void window.desktopBridge
        ?.showAgentNotification?.({
          kind: "completed",
          environmentId,
          threadId: thread.id,
          turnId: TurnId.make(thread.latestRunId),
          title: thread.title,
        })
        .catch((error) => console.error("Could not show completion notification", error));
    }
    for (const { thread, requestId } of trackQuestions(threads, hydrated && enabled)) {
      void window.desktopBridge
        ?.showAgentNotification?.({
          kind: "question",
          environmentId,
          threadId: thread.id,
          requestId,
          title: thread.title,
        })
        .catch((error) => console.error("Could not show question notification", error));
    }
  }, [shell, enabled, hydrated, track, trackQuestions, environmentId]);
  return null;
}

export function AgentNotifications() {
  const { environments } = useEnvironments();
  const navigate = useNavigate();
  useEffect(
    () =>
      window.desktopBridge?.onAgentNotificationClick?.((input) => {
        void navigate({
          to: "/$environmentId/$threadId",
          params: { environmentId: input.environmentId, threadId: input.threadId },
        });
      }),
    [navigate],
  );
  if (!window.desktopBridge?.showAgentNotification) return null;
  return environments.map(({ environmentId }) => (
    <EnvironmentAgentNotifications key={environmentId} environmentId={environmentId} />
  ));
}
