import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";
import {
  ThreadId,
  RunId,
  RuntimeRequestId,
  type OrchestrationV2ShellThreadStatus,
} from "@t3tools/contracts";
import { createCompletionTracker, createQuestionTracker } from "./completionNotifications";

function thread(id: string, state: OrchestrationV2ShellThreadStatus, turn = "turn-1") {
  return {
    id: ThreadId.make(id),
    title: `Thread ${id}`,
    archivedAt: null,
    latestRunId: RunId.make(turn),
    status: state,
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
      track([thread("a", "failed"), thread("b", "interrupted"), thread("old", "completed")], true),
    ).toEqual([]);
    expect(track([thread("a", "completed")], false)).toEqual([]);
    expect(track([thread("a", "completed")], true)).toEqual([]);
    expect(
      track(
        [
          {
            ...thread("a", "completed", "turn-2"),
            archivedAt: DateTime.makeUnsafe("2026-09-12T10:02:00Z"),
          },
        ],
        true,
      ),
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

function questionThread(requestId: string | null, overrides = {}) {
  return {
    ...thread("a", "running"),
    updatedAt: "2026-09-12T15:17:24.255Z",
    pendingRuntimeRequest:
      requestId === null
        ? null
        : {
            id: RuntimeRequestId.make(requestId),
            kind: "user_input" as const,
            createdAt: DateTime.makeUnsafe("2026-09-12T15:17:24.255Z"),
          },
    ...overrides,
  };
}

describe("question notifications", () => {
  it("notifies for each new async question while the same turn continues running", () => {
    const track = createQuestionTracker();
    track([questionThread(null)], true);
    const question = questionThread("codex-async:thread:item-1");
    expect(track([question], true)).toEqual([
      { thread: question, requestId: "codex-async:thread:item-1" },
    ]);
    expect(track([question], true)).toEqual([]);
    expect(track([questionThread("codex-async:thread:item-2")], true)).toHaveLength(1);
    expect(track([questionThread(null)], true)).toEqual([]);
    expect(track([questionThread("codex-async:thread:item-3")], true)).toHaveLength(1);
  });

  it("does not require a materialized turn and supports blocking questions", () => {
    const track = createQuestionTracker();
    track([questionThread(null, { latestRunId: null })], true);
    expect(track([questionThread("request-1", { latestRunId: null })], true)).toHaveLength(1);
  });

  it("does not replay questions on initial load, reconnect, enabling, or unarchiving", () => {
    const track = createQuestionTracker();
    expect(track([questionThread("old")], true)).toEqual([]);
    expect(track([questionThread("disabled")], false)).toEqual([]);
    expect(track([questionThread("disabled")], true)).toEqual([]);
    expect(
      track([questionThread("archived", { archivedAt: "2026-09-12T15:18:00.000Z" })], true),
    ).toEqual([]);
    expect(track([questionThread("archived")], true)).toEqual([]);
    track(null, true);
    expect(track([questionThread("reconnected")], true)).toEqual([]);
    expect(track([questionThread("next")], true)).toHaveLength(1);
  });

  it("keeps environments independent and suppresses newly discovered history", () => {
    const local = createQuestionTracker();
    const remote = createQuestionTracker();
    local([questionThread(null)], true);
    remote([questionThread(null)], true);
    expect(local([questionThread("same")], true)).toHaveLength(1);
    expect(remote([questionThread("same")], true)).toHaveLength(1);
    expect(local([questionThread("other", { id: ThreadId.make("other") })], true)).toEqual([]);
  });

  it("does not treat approval requests as questions", () => {
    const track = createQuestionTracker();
    track([questionThread(null)], true);
    const request = questionThread("approval");
    expect(
      track(
        [
          {
            ...request,
            pendingRuntimeRequest: { ...request.pendingRuntimeRequest!, kind: "command" },
          },
        ],
        true,
      ),
    ).toEqual([]);
  });
});
