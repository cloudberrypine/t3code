import type { OrchestrationV2Checkpoint, RunId } from "@t3tools/contracts";

/** Source navigation must read the two snapshots of the selected run, not today's worktree. */
export function checkpointFileRevision(
  checkpoints: readonly OrchestrationV2Checkpoint[],
  runId: RunId,
) {
  const head = checkpoints.find(
    (checkpoint) =>
      checkpoint.runId === runId &&
      checkpoint.appRunOrdinal !== null &&
      checkpoint.status === "ready",
  );
  if (!head) return null;
  const base = checkpoints.find(
    (checkpoint) => checkpoint.id === head.parentCheckpointId && checkpoint.status === "ready",
  );
  return base ? { baseRef: base.ref, headRef: head.ref, baseRefMode: "exact" as const } : null;
}
