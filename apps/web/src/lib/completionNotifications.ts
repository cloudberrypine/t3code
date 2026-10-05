import type { OrchestrationV2ThreadShell } from "@t3tools/contracts";

type CompletionThread = Pick<
  OrchestrationV2ThreadShell,
  "id" | "title" | "archivedAt" | "latestRunId" | "status"
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
      return (
        enabled &&
        thread.archivedAt === null &&
        thread.status === "completed" &&
        thread.latestRunId !== null &&
        previous?.has(thread.id) &&
        previous.get(thread.id) !== thread.latestRunId
      );
    });
    previous = new Map(
      threads.map((thread) => [
        thread.id,
        thread.status === "completed" ? thread.latestRunId : null,
      ]),
    );
    return completed;
  };
}

type QuestionThread = Pick<
  OrchestrationV2ThreadShell,
  "id" | "title" | "archivedAt" | "pendingRuntimeRequest"
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
      const request = thread.pendingRuntimeRequest;
      const requestId = request?.kind === "user_input" ? request.id : null;
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
