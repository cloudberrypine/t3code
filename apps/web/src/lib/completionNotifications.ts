import type { OrchestrationThreadShell } from "@t3tools/contracts";

type CompletionThread = Pick<
  OrchestrationThreadShell,
  "id" | "title" | "archivedAt" | "latestTurn"
>;

/** Observe live snapshots without replaying history when opening or reconnecting the app. */
export function createCompletionTracker() {
  let previous: Map<string, string | null> | null = null;
  return (threads: readonly CompletionThread[] | null, enabled: boolean) => {
    if (threads === null) {
      previous = null;
      return [];
    }
    const completed = threads.filter((thread) => {
      const turn = thread.latestTurn;
      return (
        enabled &&
        thread.archivedAt === null &&
        turn?.state === "completed" &&
        previous?.has(thread.id) &&
        previous.get(thread.id) !== turn.turnId
      );
    });
    previous = new Map(
      threads.map((thread) => [
        thread.id,
        thread.latestTurn?.state === "completed" ? thread.latestTurn.turnId : null,
      ]),
    );
    return completed;
  };
}

type QuestionThread = Pick<
  OrchestrationThreadShell,
  "id" | "title" | "archivedAt" | "updatedAt" | "hasPendingUserInput" | "latestUserInputRequestId"
>;

/** Questions can arrive while the same turn keeps running or has already finished. */
export function createQuestionTracker() {
  let previous: Map<string, string | null> | null = null;
  return (threads: readonly QuestionThread[] | null, enabled: boolean) => {
    if (threads === null) {
      previous = null;
      return [];
    }
    const notifications: { thread: QuestionThread; requestId: string }[] = [];
    const next = new Map<string, string | null>();
    for (const thread of threads) {
      // Older servers expose only the pending flag. Keep its identity stable until answered.
      const requestId = thread.hasPendingUserInput
        ? (thread.latestUserInputRequestId ?? previous?.get(thread.id) ?? thread.updatedAt)
        : null;
      next.set(thread.id, requestId);
      if (
        enabled &&
        thread.archivedAt === null &&
        requestId !== null &&
        previous?.has(thread.id) &&
        previous.get(thread.id) !== requestId
      ) {
        notifications.push({ thread, requestId });
      }
    }
    previous = next;
    return notifications;
  };
}
