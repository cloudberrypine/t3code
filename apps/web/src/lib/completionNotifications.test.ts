import { describe, expect, it } from "vite-plus/test";
import { ThreadId, TurnId, type OrchestrationLatestTurnState } from "@t3tools/contracts";
import { createCompletionTracker } from "./completionNotifications";

function thread(id: string, state: OrchestrationLatestTurnState, turn = "turn-1") {
  return {
    id: ThreadId.make(id),
    title: `Thread ${id}`,
    archivedAt: null,
    latestTurn: {
      turnId: TurnId.make(turn),
      state,
      requestedAt: "2026-09-12T10:00:00Z",
      startedAt: null,
      completedAt: state === "completed" ? "2026-09-12T10:01:00Z" : null,
      assistantMessageId: null,
    },
  };
}

describe("completion notifications", () => {
  it("ignores historical completions and notifies once for each newly completed turn", () => {
    const track = createCompletionTracker();
    expect(track([thread("a", "completed"), thread("b", "running")], true)).toEqual([]);
    expect(
      track([thread("a", "completed"), thread("b", "completed")], true).map((t) => t.id),
    ).toEqual(["b"]);
    expect(track([thread("b", "completed")], true)).toEqual([]);
    expect(track([thread("b", "completed", "turn-2")], true).map((t) => t.id)).toEqual(["b"]);
  });

  it("ignores disabled, failed, interrupted, archived and newly discovered historical turns", () => {
    const track = createCompletionTracker();
    track([thread("a", "running"), thread("b", "running")], true);
    expect(
      track([thread("a", "error"), thread("b", "interrupted"), thread("old", "completed")], true),
    ).toEqual([]);
    expect(track([thread("a", "completed")], false)).toEqual([]);
    expect(track([thread("a", "completed")], true)).toEqual([]);
    expect(
      track([{ ...thread("a", "completed", "turn-2"), archivedAt: "2026-09-12T10:02:00Z" }], true),
    ).toEqual([]);
  });

  it("resets its baseline on reconnect and keeps environments independent", () => {
    const local = createCompletionTracker();
    const remote = createCompletionTracker();
    local([thread("same", "running")], true);
    remote([thread("same", "running")], true);
    expect(local([thread("same", "completed")], true)).toHaveLength(1);
    expect(remote([thread("same", "completed")], true)).toHaveLength(1);
    local(null, true);
    expect(local([thread("same", "completed", "turn-2")], true)).toEqual([]);
    local([thread("same", "running", "turn-3")], true);
    expect(local([thread("same", "completed", "turn-3")], true)).toHaveLength(1);
  });
});
