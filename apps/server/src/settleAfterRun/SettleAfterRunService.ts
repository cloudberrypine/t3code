/**
 * Fork: settle after run (`t3_thread_organize` action `settle_after_run`). A thread cannot settle
 * itself, because its last step always runs inside its own active run, which settle refuses. A
 * request is recorded instead, and the thread is settled with an ordinary `thread.settle` once
 * that run has completed and nothing else is pending.
 *
 * Requests are kept in `<state dir>/settle-after-run.json` rather than in the thread projection,
 * as command watches are: a separate file keeps upstream's orchestrator and migrations untouched,
 * and `migrate-dev-db` copies only the database.
 */
import {
  CommandId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { turnItemUpdateCanEndBackgroundWork } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { writeFileStringAtomically } from "../atomicWrite.ts";
import * as CommandWatchService from "../commandWatch/CommandWatchService.ts";
import * as ServerConfig from "../config.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";

const STATE_FILE = "settle-after-run.json";
/** A user who looked at the thread this recently may still be reading it. */
export const SETTLE_AFTER_RUN_VIEW_GRACE_MS = 2 * 60 * 1_000;
/** Wait after a run ends before settling, so the visit of a user watching it can arrive. */
export const SETTLE_AFTER_RUN_DELAY_MS = 5_000;
const RECHECK_INTERVAL = "1 minute";

export class SettleAfterRunError extends Data.TaggedError("SettleAfterRunError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const StoredRequest = Schema.Struct({
  threadId: ThreadId,
  /** ISO time the request was made. Messages, turns and user actions after it cancel it. */
  requestedAt: Schema.String,
  /** The run that was active when the request was made, or null for an idle thread. */
  runId: Schema.NullOr(RunId),
  requestedByThreadId: Schema.NullOr(ThreadId),
});
export type SettleAfterRunRequest = typeof StoredRequest.Type;
const StateFile = Schema.Struct({ requests: Schema.Array(StoredRequest) });
const decodeStateFile = Schema.decodeUnknownEffect(Schema.fromJsonString(StateFile));
const encodeStateFile = Schema.encodeEffect(Schema.fromJsonString(StateFile));

/** What the tool reports back. */
export const SettleAfterRunResult = Schema.Struct({
  settleAfterRun: Schema.Literals(["pending", "settled", "cancelled", "none"]),
  /** For a pending request: what it waits for now. */
  waitingFor: Schema.optional(Schema.String),
});
export type SettleAfterRunResult = typeof SettleAfterRunResult.Type;

type RunStatus = OrchestrationV2Run["status"];
const ACTIVE_RUN_STATUSES: ReadonlySet<RunStatus> = new Set([
  "preparing",
  "starting",
  "running",
  "waiting",
]);

/** The parts of a thread a decision reads. `null` from the reader means the thread is gone. */
export interface SettleAfterRunThread {
  readonly archived: boolean;
  readonly settled: boolean;
  /** The latest run that is preparing, starting, running or waiting. */
  readonly activeRunId: RunId | null;
  readonly pinnedAt: DateTime.Utc | null;
  readonly snoozedAt: DateTime.Utc | null;
  readonly unsettledAt: DateTime.Utc | null;
  readonly latestUserMessageAt: DateTime.Utc | null;
  readonly runs: ReadonlyArray<{
    readonly id: RunId;
    readonly status: RunStatus;
    readonly startedAt: DateTime.Utc | null;
  }>;
  readonly pendingRuntimeRequests: number;
  readonly pendingBackgroundTasks: number;
  /**
   * The thread's updatedAt when it has no settle override, for upstream's `thread.auto-settle`,
   * which refuses if the thread changed since (a pin, snooze or message under the thread lock).
   * Null for a thread the user once unsettled, which takes a plain settle.
   */
  readonly settleSnapshotAt: DateTime.Utc | null;
}

/** Other threads and watches that keep it open. Read only when nothing on the thread does. */
export interface SettleAfterRunRelations {
  readonly runningChildThreads: number;
  readonly unsettledNestedThreads: number;
  readonly commandWatches: number;
}

export type SettleAfterRunDecision =
  | { readonly type: "drop"; readonly reason: string }
  | { readonly type: "wait"; readonly reason: string }
  | { readonly type: "ready" };

const after = (value: DateTime.Utc | null, thresholdMs: number) =>
  value !== null && DateTime.toEpochMillis(value) > thresholdMs;

/**
 * Everything on the thread itself: whether the request is void, still waits, or may go on to
 * the relations check.
 */
export function decideForThread(
  request: Pick<SettleAfterRunRequest, "requestedAt" | "runId">,
  thread: SettleAfterRunThread | null,
): SettleAfterRunDecision {
  if (thread === null) return { type: "drop", reason: "the thread is gone" };
  if (thread.archived) return { type: "drop", reason: "the thread is archived" };
  if (thread.settled) return { type: "drop", reason: "the thread is settled" };
  const requestedAtMs = Date.parse(request.requestedAt);
  if (after(thread.latestUserMessageAt, requestedAtMs)) {
    return { type: "drop", reason: "a new message arrived" };
  }
  if (after(thread.pinnedAt, requestedAtMs)) return { type: "drop", reason: "it was pinned" };
  if (after(thread.snoozedAt, requestedAtMs)) return { type: "drop", reason: "it was snoozed" };
  if (after(thread.unsettledAt, requestedAtMs)) {
    return { type: "drop", reason: "it was unsettled" };
  }
  const newTurn = thread.runs.some(
    (run) =>
      run.id !== request.runId &&
      (ACTIVE_RUN_STATUSES.has(run.status) || after(run.startedAt, requestedAtMs)),
  );
  if (newTurn) return { type: "drop", reason: "a new turn started" };
  const ownRun = thread.runs.find((run) => run.id === request.runId);
  if (ownRun !== undefined) {
    if (ACTIVE_RUN_STATUSES.has(ownRun.status) || ownRun.status === "queued") {
      return { type: "wait", reason: "the current run" };
    }
    // A run that did not complete was stopped or broke: the user should see it.
    if (ownRun.status !== "completed") {
      return { type: "drop", reason: `the run ended ${ownRun.status}` };
    }
  }
  if (thread.runs.some((run) => run.status === "queued")) {
    return { type: "wait", reason: "a queued message" };
  }
  if (thread.pendingRuntimeRequests > 0) {
    return { type: "wait", reason: "a pending request or question" };
  }
  if (thread.pendingBackgroundTasks > 0) return { type: "wait", reason: "background work" };
  return { type: "ready" };
}

export function decideForRelations(relations: SettleAfterRunRelations): SettleAfterRunDecision {
  if (relations.runningChildThreads > 0) return { type: "wait", reason: "a running child thread" };
  if (relations.unsettledNestedThreads > 0) {
    return { type: "wait", reason: "an unsettled nested thread" };
  }
  if (relations.commandWatches > 0) return { type: "wait", reason: "a command watch" };
  return { type: "ready" };
}

export function decideForViewer(
  lastViewedAtMs: number | undefined,
  nowMs: number,
): SettleAfterRunDecision {
  return lastViewedAtMs !== undefined && nowMs - lastViewedAtMs < SETTLE_AFTER_RUN_VIEW_GRACE_MS
    ? { type: "wait", reason: "the user viewing the thread" }
    : { type: "ready" };
}

/** The orchestrator seams, so the request logic can be tested on its own. */
export interface SettleAfterRunDependencies {
  readonly statePath: string;
  readonly readThread: (
    threadId: ThreadId,
  ) => Effect.Effect<SettleAfterRunThread | null, SettleAfterRunError>;
  readonly readRelations: (
    threadId: ThreadId,
  ) => Effect.Effect<SettleAfterRunRelations, SettleAfterRunError>;
  readonly events: Stream.Stream<OrchestrationV2DomainEvent, SettleAfterRunError>;
  /** Emits whenever command watches change. */
  readonly watchChanges: Stream.Stream<void, SettleAfterRunError>;
  readonly settle: (
    threadId: ThreadId,
    snapshotAt: DateTime.Utc | null,
  ) => Effect.Effect<void, SettleAfterRunError>;
  /** Waits between deciding to settle and checking once more. */
  readonly settleDelay: Effect.Effect<void>;
}

export class SettleAfterRunService extends Context.Service<
  SettleAfterRunService,
  {
    /** Records a request for a thread the caller may manage. */
    readonly request: (input: {
      readonly threadId: ThreadId;
      readonly requestedByThreadId: ThreadId | null;
    }) => Effect.Effect<SettleAfterRunResult, SettleAfterRunError>;
    readonly cancel: (
      threadId: ThreadId,
    ) => Effect.Effect<SettleAfterRunResult, SettleAfterRunError>;
    readonly list: () => Effect.Effect<ReadonlyArray<SettleAfterRunRequest>>;
    /** Decides one thread now and acts on it: drops, keeps, or settles. */
    readonly evaluate: (threadId: ThreadId) => Effect.Effect<SettleAfterRunDecision>;
    /** Follows thread events and watch changes, and rechecks waiting requests every minute. */
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/settleAfterRun/SettleAfterRunService") {}

const logFailure =
  (message: string, fields: Record<string, unknown>) =>
  <E>(cause: Cause.Cause<E>): Effect.Effect<void> =>
    Cause.hasInterruptsOnly(cause)
      ? Effect.interrupt
      : Effect.logWarning(message, { ...fields, cause });

/** Events that make a user action cancel the request, whatever the thread looks like later. */
const CANCELLING_EVENTS: ReadonlySet<OrchestrationV2DomainEvent["type"]> = new Set([
  "thread.pinned",
  "thread.snoozed",
  "thread.unsettled",
]);

/** Events on any thread that can free another thread's request: a child or nested thread ending. */
function canFreeOtherThread(event: OrchestrationV2DomainEvent): boolean {
  switch (event.type) {
    case "run.updated":
      return !ACTIVE_RUN_STATUSES.has(event.payload.status) && event.payload.status !== "queued";
    case "subagent.updated":
    case "thread.settled":
    case "thread.archived":
    case "thread.deleted":
    case "thread.sidebar-parent-set":
      return true;
    default:
      return false;
  }
}

/** Events on the requesting thread that can end its run or clear its pending work. */
function canChangeOwnThread(event: OrchestrationV2DomainEvent): boolean {
  switch (event.type) {
    case "turn-item.updated":
      return turnItemUpdateCanEndBackgroundWork(event.payload);
    // Assistant text streams; only a user message can cancel.
    case "message.updated":
      return event.payload.role === "user";
    case "run.updated":
    case "run.created":
    case "runtime-request.updated":
    case "provider-thread.updated":
    case "subagent.updated":
    case "thread.settled":
    case "thread.archived":
    case "thread.deleted":
      return true;
    default:
      return false;
  }
}

const failed = (message: string) => (cause: unknown) => new SettleAfterRunError({ message, cause });

export const makeWith = Effect.fn("SettleAfterRunService.makeWith")(function* (
  deps: SettleAfterRunDependencies,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const lock = yield* Semaphore.make(1);
  const fibers = yield* FiberSet.make();
  const requests = new Map<ThreadId, SettleAfterRunRequest>();
  /** Server time of each thread's latest user visit, kept across requests. */
  const lastViewedAt = new Map<ThreadId, number>();
  const inFlight = new Set<ThreadId>();
  const dirty = new Set<ThreadId>();
  /** The file is behind the requests after a failed save; the next save or recheck retries. */
  let fileStale = false;

  const locked = <A, E, R>(body: Effect.Effect<A, E, R>) =>
    Semaphore.withPermits(lock, 1)(Effect.uninterruptible(body));

  const persist = Effect.suspend(() => encodeStateFile({ requests: [...requests.values()] })).pipe(
    Effect.flatMap((contents) =>
      writeFileStringAtomically({ filePath: deps.statePath, contents: `${contents}\n` }),
    ),
    Effect.provideService(FileSystem.FileSystem, fs),
    Effect.provideService(Path.Path, path),
    Effect.tap(() =>
      Effect.sync(() => {
        fileStale = false;
      }),
    ),
    Effect.tapCause((cause) =>
      Effect.sync(() => {
        fileStale = true;
      }).pipe(
        Effect.andThen(logFailure("settle-after-run requests could not be saved", {})(cause)),
      ),
    ),
    Effect.mapError(failed("The settle-after-run request could not be saved.")),
  );
  const persistOrLog = persist.pipe(Effect.ignore);

  const restored = yield* fs.readFileString(deps.statePath).pipe(
    Effect.flatMap(decodeStateFile),
    Effect.map((file) => file.requests),
    Effect.catchCause((cause) =>
      fs.exists(deps.statePath).pipe(
        Effect.orElseSucceed(() => true),
        Effect.flatMap((exists) =>
          exists
            ? Effect.logWarning("settle-after-run requests could not be read", { cause })
            : Effect.void,
        ),
        Effect.as([] as ReadonlyArray<SettleAfterRunRequest>),
      ),
    ),
  );
  for (const request of restored) requests.set(request.threadId, request);

  /** Removes a request under the lock, unless it was replaced by a newer one meanwhile. */
  const remove = (request: SettleAfterRunRequest, reason: string) =>
    Effect.gen(function* () {
      if (requests.get(request.threadId) !== request) return;
      requests.delete(request.threadId);
      yield* persistOrLog;
      yield* Effect.logDebug("settle-after-run request ended", {
        threadId: request.threadId,
        reason,
      });
    });
  const drop = (request: SettleAfterRunRequest, reason: string) => locked(remove(request, reason));

  const decide = Effect.fn("SettleAfterRunService.decide")(function* (
    request: SettleAfterRunRequest,
  ) {
    const thread = yield* deps.readThread(request.threadId);
    const own = decideForThread(request, thread);
    if (own.type !== "ready" || thread === null) return { decision: own, thread };
    const relations = decideForRelations(yield* deps.readRelations(request.threadId));
    if (relations.type !== "ready") return { decision: relations, thread };
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    return { decision: decideForViewer(lastViewedAt.get(request.threadId), nowMs), thread };
  });

  const evaluate = Effect.fn("SettleAfterRunService.evaluate")(
    function* (threadId: ThreadId) {
      const request = requests.get(threadId);
      if (request === undefined) return { type: "drop", reason: "no request" } as const;
      const first = (yield* decide(request)).decision;
      if (first.type === "drop") yield* drop(request, first.reason);
      if (first.type !== "ready") return first;
      yield* deps.settleDelay;
      // The last check and the settle hold the lock, so a cancel cannot pass between them.
      return yield* locked(
        Effect.gen(function* () {
          if (requests.get(threadId) !== request) {
            return { type: "drop", reason: "the request changed" } as const;
          }
          const { decision, thread } = yield* decide(request);
          if (decision.type === "drop") yield* remove(request, decision.reason);
          if (decision.type !== "ready" || thread === null) return decision;
          yield* deps.settle(threadId, thread.settleSnapshotAt);
          yield* remove(request, "settled");
          return decision;
        }),
      );
    },
    (effect, threadId) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          logFailure("settle-after-run check failed", { threadId })(cause).pipe(
            Effect.as({ type: "wait", reason: "a failed check" } as const),
          ),
        ),
      ),
  );

  /** Runs one check per thread at a time; a change during a check runs it once more. */
  const schedule = (threadId: ThreadId): Effect.Effect<void> =>
    Effect.suspend(() => {
      if (!requests.has(threadId)) return Effect.void;
      if (inFlight.has(threadId)) {
        dirty.add(threadId);
        return Effect.void;
      }
      inFlight.add(threadId);
      const loop: Effect.Effect<void> = Effect.suspend(() => {
        dirty.delete(threadId);
        return evaluate(threadId).pipe(
          Effect.andThen(Effect.suspend(() => (dirty.has(threadId) ? loop : Effect.void))),
        );
      });
      return FiberSet.run(
        fibers,
        loop.pipe(Effect.ensuring(Effect.sync(() => inFlight.delete(threadId)))),
      ).pipe(Effect.asVoid);
    });

  const scheduleAll = Effect.suspend(() =>
    Effect.forEach([...requests.keys()], schedule, { discard: true }),
  );

  const recheck = Effect.gen(function* () {
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    for (const [threadId, viewedAtMs] of lastViewedAt) {
      if (nowMs - viewedAtMs >= SETTLE_AFTER_RUN_VIEW_GRACE_MS) lastViewedAt.delete(threadId);
    }
    if (fileStale) yield* locked(persistOrLog);
    yield* scheduleAll;
  });

  const onEvent = (event: OrchestrationV2DomainEvent) =>
    Effect.gen(function* () {
      // Visits are kept for every thread, so a request made while the user reads it waits.
      if (event.type === "thread.visited") {
        lastViewedAt.set(event.threadId, DateTime.toEpochMillis(event.occurredAt));
        return;
      }
      const request = requests.get(event.threadId);
      if (request !== undefined) {
        if (
          CANCELLING_EVENTS.has(event.type) &&
          DateTime.toEpochMillis(event.occurredAt) > Date.parse(request.requestedAt)
        ) {
          yield* drop(request, event.type);
          return;
        }
        if (canChangeOwnThread(event)) yield* schedule(event.threadId);
      }
      if (requests.size > 0 && canFreeOtherThread(event)) {
        for (const threadId of requests.keys()) {
          if (threadId !== event.threadId) yield* schedule(threadId);
        }
      }
    });

  const request: SettleAfterRunService["Service"]["request"] = Effect.fn(
    "SettleAfterRunService.request",
  )(function* (input) {
    const thread = yield* deps.readThread(input.threadId);
    if (thread === null || thread.archived) {
      return yield* new SettleAfterRunError({ message: "The thread is archived or deleted." });
    }
    if (thread.settled) return { settleAfterRun: "settled" } as const;
    const requestedAt = DateTime.formatIso(yield* DateTime.now);
    const stored: SettleAfterRunRequest = {
      threadId: input.threadId,
      requestedAt,
      runId: thread.activeRunId,
      requestedByThreadId: input.requestedByThreadId,
    };
    // A request that could not be saved would not survive a restart: refuse it.
    yield* locked(
      Effect.gen(function* () {
        const previous = requests.get(input.threadId);
        requests.set(input.threadId, stored);
        yield* persist.pipe(
          Effect.tapError(() =>
            Effect.sync(() => {
              if (previous === undefined) requests.delete(input.threadId);
              else requests.set(input.threadId, previous);
            }),
          ),
        );
      }),
    );
    const own = decideForThread(stored, thread);
    yield* schedule(input.threadId);
    return {
      settleAfterRun: "pending",
      waitingFor: own.type === "wait" ? own.reason : "nothing",
    } as const;
  });

  // A cancel whose save fails stays cancelled here, and the file is saved again on the next
  // recheck, so the request cannot settle the thread after a restart once that save lands.
  const cancel: SettleAfterRunService["Service"]["cancel"] = (threadId) =>
    locked(
      Effect.gen(function* () {
        const existing = requests.get(threadId);
        if (existing === undefined) return { settleAfterRun: "none" } as const;
        requests.delete(threadId);
        yield* persist;
        return { settleAfterRun: "cancelled" } as const;
      }),
    );

  const list: SettleAfterRunService["Service"]["list"] = () =>
    locked(Effect.sync(() => [...requests.values()]));

  const start: SettleAfterRunService["Service"]["start"] = () =>
    Effect.gen(function* () {
      yield* deps.events.pipe(
        Stream.runForEach(onEvent),
        Effect.catchCause(logFailure("settle-after-run event stream stopped", {})),
        Effect.forkScoped,
      );
      yield* deps.watchChanges.pipe(
        Stream.runForEach(() => scheduleAll),
        Effect.catchCause(logFailure("settle-after-run watch changes stopped", {})),
        Effect.forkScoped,
      );
      // Restored requests are checked at once; the recheck covers a viewer's grace ending.
      yield* recheck.pipe(
        Effect.repeat(Schedule.spaced(RECHECK_INTERVAL)),
        Effect.asVoid,
        Effect.forkScoped,
      );
    });

  return SettleAfterRunService.of({
    request,
    cancel,
    list,
    evaluate: (threadId) => evaluate(threadId),
    start,
  });
});

const CHILD_ACTIVE_SUBAGENT_STATUSES = new Set(["pending", "running", "waiting"]);

export const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const watches = yield* CommandWatchService.CommandWatchService;
  const config = yield* ServerConfig.ServerConfig;
  const crypto = yield* Crypto.Crypto;
  const path = yield* Path.Path;
  return yield* makeWith({
    statePath: path.join(config.stateDir, STATE_FILE),
    readThread: (threadId) =>
      Effect.gen(function* () {
        const shell = yield* engine.getThreadShell(threadId);
        if (shell === null || shell.deletedAt !== null) return null;
        const records = yield* engine.getThreadRecords(threadId, ["runs", "runtimeRequests"]);
        // records.thread is the thread row thread.auto-settle compares its snapshot with.
        return {
          archived: shell.archivedAt !== null,
          settled: shell.settledOverride === "settled",
          // The shell's activeRunId leaves out a waiting run, which has not completed yet.
          activeRunId:
            records.runs
              .filter((run) => ACTIVE_RUN_STATUSES.has(run.status))
              .toSorted((left, right) => right.ordinal - left.ordinal)[0]?.id ?? null,
          pinnedAt: shell.pinnedAt ?? null,
          snoozedAt: shell.snoozedAt ?? null,
          unsettledAt: shell.unsettledAt ?? null,
          latestUserMessageAt: shell.latestUserMessageAt,
          runs: records.runs.map((run) => ({
            id: run.id,
            status: run.status,
            startedAt: run.startedAt,
          })),
          pendingRuntimeRequests: records.runtimeRequests.filter(
            (request) => request.status === "pending",
          ).length,
          pendingBackgroundTasks: shell.pendingBackgroundTasks?.length ?? 0,
          settleSnapshotAt: shell.settledOverride === null ? records.thread.updatedAt : null,
        } satisfies SettleAfterRunThread;
      }).pipe(Effect.mapError(failed("Could not read the thread."))),
    readRelations: (threadId) =>
      Effect.gen(function* () {
        const { subagents } = yield* engine.getThreadRecords(threadId, ["subagents"]);
        const childThreadIds = new Set<ThreadId>();
        let runningChildThreads = 0;
        for (const subagent of subagents) {
          if (CHILD_ACTIVE_SUBAGENT_STATUSES.has(subagent.status)) runningChildThreads += 1;
          else if (subagent.childThreadId !== null) childThreadIds.add(subagent.childThreadId);
        }
        // A child whose task finished can still run a follow-up turn of its own.
        for (const childThreadId of childThreadIds) {
          const child = yield* engine.getThreadShell(childThreadId);
          if (
            child !== null &&
            child.deletedAt === null &&
            child.archivedAt === null &&
            (child.activityRunStatus != null || child.status === "queued")
          ) {
            runningChildThreads += 1;
          }
        }
        const nested = yield* projections.getSidebarChildThreads(threadId);
        return {
          runningChildThreads,
          unsettledNestedThreads: nested.filter(
            (child) =>
              child.archivedAt === null &&
              child.deletedAt === null &&
              child.settledOverride !== "settled",
          ).length,
          commandWatches: (yield* watches.list(threadId)).length,
        } satisfies SettleAfterRunRelations;
      }).pipe(Effect.mapError(failed("Could not read the thread's children."))),
    events: engine.streamDomainEvents.pipe(Stream.mapError(failed("Thread events stopped."))),
    watchChanges: watches.subscribe().pipe(Stream.map(() => undefined)),
    settle: (threadId, snapshotAt) =>
      Effect.gen(function* () {
        const uuid = yield* crypto.randomUUIDv4;
        const commandId = CommandId.make(`server:settle-after-run:${threadId}:${uuid}`);
        // Both end in thread.settle. Auto-settle first refuses, under the thread lock, if the
        // thread changed since it was read, so a pin or message just before cannot be lost.
        yield* engine.dispatch(
          snapshotAt === null
            ? { type: "thread.settle", commandId, threadId }
            : { type: "thread.auto-settle", commandId, threadId, snapshotAt },
        );
      }).pipe(Effect.mapError(failed("Could not settle the thread."))),
    settleDelay: Effect.sleep(SETTLE_AFTER_RUN_DELAY_MS),
  });
});

export const layer = Layer.effect(SettleAfterRunService, make);
