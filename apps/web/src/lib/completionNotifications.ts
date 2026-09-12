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
