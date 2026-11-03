import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { type OrchestrationV2DomainEvent, RunId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import {
  decideForRelations,
  decideForThread,
  decideForViewer,
  makeWith,
  SETTLE_AFTER_RUN_VIEW_GRACE_MS,
  type SettleAfterRunRelations,
  type SettleAfterRunThread,
} from "./SettleAfterRunService.ts";

const NOW_MS = Date.UTC(2026, 10, 3, 12, 0, 0);
const threadA = ThreadId.make("settle-after-run-thread-a");
const threadB = ThreadId.make("settle-after-run-thread-b");
const runA = RunId.make("settle-after-run-run-a");
const runB = RunId.make("settle-after-run-run-b");
const at = (ms: number) => DateTime.makeUnsafe(ms);
const before = at(NOW_MS - 60_000);
const later = at(NOW_MS + 60_000);

const idleThread: SettleAfterRunThread = {
  archived: false,
  settled: false,
  activeRunId: null,
  pinnedAt: null,
  snoozedAt: null,
  unsettledAt: null,
  latestUserMessageAt: before,
  runs: [{ id: runA, status: "completed", startedAt: before }],
  pendingRuntimeRequests: 0,
  pendingBackgroundTasks: 0,
};
const runningThread: SettleAfterRunThread = {
  ...idleThread,
  activeRunId: runA,
  runs: [{ id: runA, status: "running", startedAt: before }],
};
const noRelations: SettleAfterRunRelations = {
  runningChildThreads: 0,
  unsettledNestedThreads: 0,
  commandWatches: 0,
};
const request = { requestedAt: DateTime.formatIso(at(NOW_MS)), runId: runA };

describe("decideForThread", () => {
  it("waits for the run that was active when the thread asked", () => {
    assert.deepEqual(decideForThread(request, runningThread), {
      type: "wait",
      reason: "the current run",
    });
    assert.deepEqual(
      decideForThread(request, {
        ...runningThread,
        runs: [{ id: runA, status: "waiting", startedAt: before }],
      }),
      { type: "wait", reason: "the current run" },
    );
  });

  it("is ready once that run completed and nothing is pending", () => {
    assert.deepEqual(decideForThread(request, idleThread), { type: "ready" });
    assert.deepEqual(decideForThread({ ...request, runId: null }, idleThread), { type: "ready" });
  });

  it("waits for a queued run, a pending request and background work", () => {
    const queued = {
      ...idleThread,
      runs: [...idleThread.runs, { id: runB, status: "queued" as const, startedAt: null }],
    };
    assert.deepEqual(decideForThread(request, queued), {
      type: "wait",
      reason: "a queued message",
    });
    assert.deepEqual(decideForThread(request, { ...idleThread, pendingRuntimeRequests: 1 }), {
      type: "wait",
      reason: "a pending request or question",
    });
    assert.deepEqual(decideForThread(request, { ...idleThread, pendingBackgroundTasks: 2 }), {
      type: "wait",
      reason: "background work",
    });
  });

  it("is void after a new message, turn, or user pin, snooze or unsettle", () => {
    const drops = (thread: SettleAfterRunThread) => decideForThread(request, thread).type;
    assert.equal(drops({ ...idleThread, latestUserMessageAt: later }), "drop");
    assert.equal(drops({ ...idleThread, pinnedAt: later }), "drop");
    assert.equal(drops({ ...idleThread, snoozedAt: later }), "drop");
    assert.equal(drops({ ...idleThread, unsettledAt: later }), "drop");
    // Another run is active, or ran and finished after the request.
    assert.equal(
      drops({
        ...idleThread,
        runs: [...idleThread.runs, { id: runB, status: "running", startedAt: later }],
      }),
      "drop",
    );
    assert.equal(
      drops({
        ...idleThread,
        runs: [...idleThread.runs, { id: runB, status: "completed", startedAt: later }],
      }),
      "drop",
    );
  });

  it("keeps a pin, snooze or message from before the request", () => {
    assert.deepEqual(
      decideForThread(request, { ...idleThread, pinnedAt: before, snoozedAt: before }),
      { type: "ready" },
    );
  });

  it("is void when the run did not complete, or the thread is gone, archived or settled", () => {
    for (const status of ["interrupted", "failed", "cancelled", "rolled_back"] as const) {
      assert.deepEqual(
        decideForThread(request, {
          ...idleThread,
          runs: [{ id: runA, status, startedAt: before }],
        }),
        { type: "drop", reason: `the run ended ${status}` },
      );
    }
    assert.equal(decideForThread(request, null).type, "drop");
    assert.equal(decideForThread(request, { ...idleThread, archived: true }).type, "drop");
    assert.equal(decideForThread(request, { ...idleThread, settled: true }).type, "drop");
  });
});

describe("decideForRelations and decideForViewer", () => {
  it("waits for a running child, an unsettled nested thread and a command watch", () => {
    assert.deepEqual(decideForRelations(noRelations), { type: "ready" });
    assert.deepEqual(decideForRelations({ ...noRelations, runningChildThreads: 1 }), {
      type: "wait",
      reason: "a running child thread",
    });
    assert.deepEqual(decideForRelations({ ...noRelations, unsettledNestedThreads: 1 }), {
      type: "wait",
      reason: "an unsettled nested thread",
    });
    assert.deepEqual(decideForRelations({ ...noRelations, commandWatches: 1 }), {
      type: "wait",
      reason: "a command watch",
    });
  });

  it("waits while the user viewed the thread recently", () => {
    assert.deepEqual(decideForViewer(undefined, NOW_MS), { type: "ready" });
    assert.deepEqual(decideForViewer(NOW_MS - 1_000, NOW_MS), {
      type: "wait",
      reason: "the user viewing the thread",
    });
    assert.deepEqual(decideForViewer(NOW_MS - SETTLE_AFTER_RUN_VIEW_GRACE_MS, NOW_MS), {
      type: "ready",
    });
  });
});

/** The service with fake threads and events; the state file lives in a temp dir. */
const harness = Effect.fn("settleAfterRunHarness")(function* (options?: {
  readonly statePath?: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* TestClock.setTime(NOW_MS);
  const statePath =
    options?.statePath ??
    path.join(yield* fs.makeTempDirectoryScoped({ prefix: "t3-settle-" }), "settle.json");
  const threads = new Map<ThreadId, SettleAfterRunThread>([
    [threadA, runningThread],
    [threadB, runningThread],
  ]);
  const relations = new Map<ThreadId, SettleAfterRunRelations>();
  const events = yield* PubSub.unbounded<OrchestrationV2DomainEvent>();
  const watchChanges = yield* PubSub.unbounded<void>();
  const settles = yield* Queue.unbounded<ThreadId>();
  const service = yield* makeWith({
    statePath,
    readThread: (threadId) => Effect.sync(() => threads.get(threadId) ?? null),
    readRelations: (threadId) => Effect.sync(() => relations.get(threadId) ?? noRelations),
    events: Stream.fromPubSub(events),
    watchChanges: Stream.fromPubSub(watchChanges),
    settle: (threadId) =>
      Effect.gen(function* () {
        const thread = threads.get(threadId)!;
        threads.set(threadId, { ...thread, settled: true });
        yield* Queue.offer(settles, threadId);
      }),
    settleDelay: Effect.void,
  });
  const event = (type: string, threadId: ThreadId, payload: unknown = {}) =>
    PubSub.publish(events, {
      type,
      threadId,
      occurredAt: DateTime.makeUnsafe(NOW_MS + 1_000),
      payload,
    } as unknown as OrchestrationV2DomainEvent);
  const finishRun = (threadId: ThreadId, thread: Partial<SettleAfterRunThread> = {}) =>
    Effect.gen(function* () {
      threads.set(threadId, { ...idleThread, ...thread });
      yield* event("run.updated", threadId, { id: runA, status: "completed" });
    });
  return {
    service,
    statePath,
    threads,
    relations,
    settles,
    event,
    finishRun,
    watchChanged: PubSub.publish(watchChanges, undefined),
    stored: fs.readFileString(statePath),
  };
});

it.layer(NodeServices.layer)("SettleAfterRunService", (it) => {
  it.effect("settles the thread once its run completes", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      yield* h.service.start();
      const result = yield* h.service.request({ threadId: threadA, requestedByThreadId: threadA });
      assert.deepEqual(result, { settleAfterRun: "pending", waitingFor: "the current run" });
      assert.deepEqual(
        (yield* h.service.list()).map((request) => request.runId),
        [runA],
      );
      yield* h.finishRun(threadA);
      assert.equal(yield* Queue.take(h.settles), threadA);
      // The request ends with the settle.
      yield* h.service
        .list()
        .pipe(Effect.repeat({ until: (requests) => requests.length === 0, times: 100 }));
      assert.deepEqual(yield* h.service.list(), []);
      assert.include(yield* h.stored, '"requests":[]');
    }).pipe(Effect.scoped),
  );

  it.effect("keeps waiting while something is pending and settles once it clears", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      yield* h.service.request({ threadId: threadA, requestedByThreadId: null });
      h.threads.set(threadA, { ...idleThread, pendingRuntimeRequests: 1 });
      assert.deepEqual(yield* h.service.evaluate(threadA), {
        type: "wait",
        reason: "a pending request or question",
      });
      h.threads.set(threadA, idleThread);
      h.relations.set(threadA, { ...noRelations, commandWatches: 1 });
      assert.deepEqual(yield* h.service.evaluate(threadA), {
        type: "wait",
        reason: "a command watch",
      });
      assert.equal((yield* h.service.list()).length, 1);
      assert.equal(yield* Queue.size(h.settles), 0);

      // The watch stopping settles it.
      yield* h.service.start();
      h.relations.set(threadA, noRelations);
      yield* h.watchChanged;
      assert.equal(yield* Queue.take(h.settles), threadA);
    }).pipe(Effect.scoped),
  );

  it.effect("a child thread finishing frees its parent", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      yield* h.service.request({ threadId: threadA, requestedByThreadId: threadA });
      h.relations.set(threadA, { ...noRelations, runningChildThreads: 1 });
      yield* h.service.start();
      yield* h.finishRun(threadA);
      yield* Effect.yieldNow;
      assert.equal(yield* Queue.size(h.settles), 0);
      h.relations.set(threadA, noRelations);
      yield* h.event("run.updated", threadB, { id: runB, status: "completed" });
      assert.equal(yield* Queue.take(h.settles), threadA);
    }).pipe(Effect.scoped),
  );

  it.effect("a pin, snooze or unsettle cancels it, even when undone", () =>
    Effect.gen(function* () {
      for (const type of ["thread.pinned", "thread.snoozed", "thread.unsettled"]) {
        const h = yield* harness();
        yield* h.service.start();
        yield* h.service.request({ threadId: threadA, requestedByThreadId: threadA });
        yield* h.event(type, threadA);
        yield* Effect.yieldNow;
        assert.deepEqual(yield* h.service.list(), [], type);
        yield* h.finishRun(threadA);
        yield* Effect.yieldNow;
        assert.equal(yield* Queue.size(h.settles), 0, type);
      }
    }).pipe(Effect.scoped),
  );

  it.effect("a new message or turn cancels it", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      yield* h.service.request({ threadId: threadA, requestedByThreadId: threadA });
      h.threads.set(threadA, { ...idleThread, latestUserMessageAt: later });
      assert.equal((yield* h.service.evaluate(threadA)).type, "drop");
      assert.deepEqual(yield* h.service.list(), []);

      yield* h.service.request({ threadId: threadB, requestedByThreadId: threadA });
      h.threads.set(threadB, {
        ...idleThread,
        activeRunId: runB,
        runs: [...idleThread.runs, { id: runB, status: "running", startedAt: later }],
      });
      assert.equal((yield* h.service.evaluate(threadB)).type, "drop");
      assert.equal(yield* Queue.size(h.settles), 0);
    }).pipe(Effect.scoped),
  );

  it.effect("cancel_settle_after_run removes it", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      yield* h.service.request({ threadId: threadA, requestedByThreadId: threadA });
      assert.deepEqual(yield* h.service.cancel(threadA), { settleAfterRun: "cancelled" });
      assert.deepEqual(yield* h.service.cancel(threadA), { settleAfterRun: "none" });
      assert.include(yield* h.stored, '"requests":[]');
      yield* h.service.start();
      yield* h.finishRun(threadA);
      yield* Effect.yieldNow;
      assert.equal(yield* Queue.size(h.settles), 0);
    }).pipe(Effect.scoped),
  );

  it.effect("waits while the user is viewing the thread", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      yield* h.service.start();
      yield* h.service.request({ threadId: threadA, requestedByThreadId: threadA });
      yield* h.event("thread.visited", threadA);
      h.threads.set(threadA, idleThread);
      yield* Effect.yieldNow;
      assert.deepEqual(yield* h.service.evaluate(threadA), {
        type: "wait",
        reason: "the user viewing the thread",
      });
      yield* TestClock.adjust(SETTLE_AFTER_RUN_VIEW_GRACE_MS + 60_000);
      assert.equal(yield* Queue.take(h.settles), threadA);
    }).pipe(Effect.scoped),
  );

  it.effect("an already settled thread reports settled without a request", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      h.threads.set(threadA, { ...idleThread, settled: true });
      assert.deepEqual(
        yield* h.service.request({ threadId: threadA, requestedByThreadId: threadA }),
        { settleAfterRun: "settled" },
      );
      assert.deepEqual(yield* h.service.list(), []);
    }).pipe(Effect.scoped),
  );

  it.effect("survives a restart and settles once the server is back", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-settle-restart-" });
      const statePath = path.join(dir, "settle.json");
      yield* Effect.scoped(
        Effect.gen(function* () {
          const before = yield* harness({ statePath });
          yield* before.service.request({ threadId: threadA, requestedByThreadId: threadB });
        }),
      );
      const after = yield* harness({ statePath });
      const restored = yield* after.service.list();
      assert.equal(restored.length, 1);
      assert.equal(restored[0]!.threadId, threadA);
      assert.equal(restored[0]!.runId, runA);
      assert.equal(restored[0]!.requestedByThreadId, threadB);
      // The run ended while the server was down.
      after.threads.set(threadA, idleThread);
      yield* after.service.start();
      assert.equal(yield* Queue.take(after.settles), threadA);
    }).pipe(Effect.scoped),
  );
});
