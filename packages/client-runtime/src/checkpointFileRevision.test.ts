import {
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  NodeId,
  RunId,
  ThreadId,
  type OrchestrationV2Checkpoint,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { expect, it } from "vite-plus/test";
import { checkpointFileRevision } from "./checkpointFileRevision.ts";

const runId = RunId.make("selected-run");
function checkpoint(
  id: string,
  overrides: Partial<OrchestrationV2Checkpoint> = {},
): OrchestrationV2Checkpoint {
  return {
    id: CheckpointId.make(id),
    threadId: ThreadId.make("thread"),
    scopeId: CheckpointScopeId.make("scope"),
    runId,
    nodeId: NodeId.make("node"),
    parentCheckpointId: null,
    ordinalWithinScope: 0,
    appRunOrdinal: null,
    ref: CheckpointRef.make(`refs/t3/checkpoints/${id}`),
    status: "ready",
    files: [],
    capturedAt: DateTime.makeUnsafe("2026-10-05T00:00:00Z"),
    ...overrides,
  };
}

it("uses the selected run's explicit parent, not adjacent checkpoints from other scopes", () => {
  const base = checkpoint("base");
  const other = checkpoint("other", {
    scopeId: CheckpointScopeId.make("other-scope"),
    appRunOrdinal: 2,
    runId: RunId.make("other-run"),
  });
  const head = checkpoint("head", { parentCheckpointId: base.id, appRunOrdinal: 1 });
  expect(checkpointFileRevision([other, head, base], runId)).toEqual({
    baseRef: base.ref,
    headRef: head.ref,
    baseRefMode: "exact",
  });
});

it("does not navigate using missing or unready snapshots", () => {
  const base = checkpoint("base");
  const head = checkpoint("head", { parentCheckpointId: base.id, appRunOrdinal: 1 });
  expect(checkpointFileRevision([base], runId)).toBeNull();
  expect(checkpointFileRevision([head], runId)).toBeNull();
  expect(checkpointFileRevision([base, { ...head, status: "stale" }], runId)).toBeNull();
  expect(checkpointFileRevision([{ ...base, status: "missing" }, head], runId)).toBeNull();
  expect(checkpointFileRevision([base, head], RunId.make("unknown"))).toBeNull();
});
