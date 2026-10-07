/**
 * Fork: command watches (`watch_command`). The server runs a thread's long-lived command and
 * wakes the thread with what it prints, so agents need no time-limited monitor of their own.
 *
 * Watches are kept in `<state dir>/command-watches.json` rather than in the thread projection:
 * they are process supervision, not conversation history, and a separate file keeps upstream's
 * orchestrator and migrations untouched. `migrate-dev-db` copies only the database, so a dev
 * server never runs the user's watch commands.
 */
import {
  CommandId,
  CommandWatch,
  CommandWatchError,
  type CommandWatchListResult,
  type CommandWatchStopInput,
  type CommandWatchStopResult,
  MessageId,
  type OrchestrationV2Command,
  type OrchestrationV2DomainEvent,
  type ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { writeFileStringAtomically } from "../atomicWrite.ts";
import * as ServerConfig from "../config.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as CommandWatchProcess from "./CommandWatchProcess.ts";
import {
  COMMAND_WATCH_FLOOD_LIMIT,
  exitLines,
  floodLines,
  outputLines,
  restartedLine,
  resumedLine,
} from "./commandWatchMessages.ts";

/** Lines arriving this close together wake the thread once. */
export const COMMAND_WATCH_BATCH_WINDOW_MS = 1_500;
const FLOOD_WINDOW_MS = 60_000;
const STATE_FILE = "command-watches.json";

const StoredWatch = CommandWatch.mapFields(({ threadId, label, command, cwd, startedAt }) => ({
  threadId,
  label,
  command,
  cwd,
  startedAt,
}));
type StoredWatch = typeof StoredWatch.Type;
const StateFile = Schema.Struct({ watches: Schema.Array(StoredWatch) });
const decodeStateFile = Schema.decodeUnknownEffect(Schema.fromJsonString(StateFile));
const encodeStateFile = Schema.encodeEffect(Schema.fromJsonString(StateFile));

/** What a watch needs to know about its thread. Missing, archived and deleted are `removed`. */
export interface CommandWatchThreadState {
  readonly removed: boolean;
  readonly settled: boolean;
}

/** The orchestrator and process seams, so the watch logic can be tested on its own. */
export interface CommandWatchDependencies {
  readonly statePath: string;
  readonly readThread: (
    threadId: ThreadId,
  ) => Effect.Effect<CommandWatchThreadState, CommandWatchError>;
  /** Live archive, delete, settle and unsettle changes. */
  readonly threadChanges: Stream.Stream<
    { readonly threadId: ThreadId; readonly state: CommandWatchThreadState },
    CommandWatchError
  >;
  /** Delivers a message: it steers an active run, or starts a turn. */
  readonly wake: (threadId: ThreadId, text: string) => Effect.Effect<void, CommandWatchError>;
  readonly runProcess: CommandWatchProcess.CommandWatchProcess["Service"]["run"];
  /** Waits while lines that follow a first one gather into the same wake. */
  readonly batchWindow: Effect.Effect<void>;
}

export interface CommandWatchInput {
  readonly threadId: ThreadId;
  readonly label: string;
  readonly command: string;
  readonly cwd: string;
}

export class CommandWatchService extends Context.Service<
  CommandWatchService,
  {
    /** Starts a watch. The same label, command and directory again is a no-op; a new command under a label replaces the old one. */
    readonly watch: (
      input: CommandWatchInput,
    ) => Effect.Effect<
      { readonly watch: CommandWatch; readonly alreadyWatching: boolean },
      CommandWatchError
    >;
    readonly unwatch: (input: CommandWatchStopInput) => Effect.Effect<CommandWatchStopResult>;
    readonly list: (threadId?: ThreadId) => Effect.Effect<ReadonlyArray<CommandWatch>>;
    /** Emits every watch on subscribe and again after every change. */
    readonly subscribe: () => Stream.Stream<CommandWatchListResult>;
    /** Restores the persisted watches (waking each thread once) and follows thread changes. */
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/commandWatch/CommandWatchService") {}

interface Entry {
  readonly stored: StoredWatch;
  /** Tells a watch's runs apart, so a stopped run cannot change its replacement. */
  readonly generation: number;
  readonly status: "running" | "paused";
  readonly runningSince: string | null;
}

type QueuedOutput = CommandWatchProcess.CommandWatchOutput | { readonly type: "flood" };

const keyOf = (threadId: ThreadId, label: string) => `${threadId}\n${label}`;

const toWatch = (entry: Entry): CommandWatch => ({
  ...entry.stored,
  status: entry.status,
  runningSince: entry.runningSince,
});

const logFailure =
  (message: string, fields: Record<string, unknown>) =>
  <E>(cause: Cause.Cause<E>): Effect.Effect<void> =>
    Cause.hasInterruptsOnly(cause)
      ? Effect.interrupt
      : Effect.logWarning(message, { ...fields, cause });

export const makeWith = Effect.fn("CommandWatchService.makeWith")(function* (
  deps: CommandWatchDependencies,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const fibers = yield* FiberMap.make<string>();
  const lock = yield* Semaphore.make(1);
  const changes = yield* PubSub.sliding<void>(1);
  const entries = new Map<string, Entry>();
  /** Exit and flood reports of watches that ended while their thread was settled. */
  const heldReports = new Map<ThreadId, Array<string>>();
  let generation = 0;

  const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  // Waiting for the lock stays interruptible; the work under it is not.
  const locked = <A, E, R>(body: Effect.Effect<A, E, R>) =>
    Semaphore.withPermits(lock, 1)(Effect.uninterruptible(body));
  const notify = PubSub.publish(changes, undefined).pipe(Effect.asVoid);
  const sameRun = (entry: Entry) =>
    entries.get(keyOf(entry.stored.threadId, entry.stored.label))?.generation === entry.generation;

  const persist = Effect.suspend(() =>
    encodeStateFile({ watches: [...entries.values()].map((entry) => entry.stored) }),
  ).pipe(
    Effect.flatMap((contents) =>
      writeFileStringAtomically({ filePath: deps.statePath, contents: `${contents}\n` }),
    ),
    Effect.provideService(FileSystem.FileSystem, fs),
    Effect.provideService(Path.Path, path),
    Effect.catchCause(logFailure("command watches could not be saved", {})),
  );

  const running = (stored: StoredWatch) =>
    Effect.map(now, (runningSince): Entry => ({
      stored,
      generation: ++generation,
      status: "running",
      runningSince,
    }));
  const paused = (stored: StoredWatch): Entry => ({
    stored,
    generation: ++generation,
    status: "paused",
    runningSince: null,
  });

  const readThreadOrActive = (threadId: ThreadId) =>
    deps.readThread(threadId).pipe(
      Effect.tapCause(logFailure("command watch could not read its thread", { threadId })),
      Effect.orElseSucceed((): CommandWatchThreadState => ({ removed: false, settled: false })),
    );

  const wake = (threadId: ThreadId, lines: ReadonlyArray<string>) =>
    deps
      .wake(threadId, lines.join("\n"))
      .pipe(Effect.catchCause(logFailure("command watch could not wake its thread", { threadId })));

  /**
   * Ends a run's watch, unless it was stopped or replaced meanwhile. A report to hold is told
   * when the thread is active again.
   */
  const finish = (entry: Entry, holdReport?: ReadonlyArray<string>) =>
    locked(
      Effect.gen(function* () {
        if (!sameRun(entry)) return;
        entries.delete(keyOf(entry.stored.threadId, entry.stored.label));
        if (holdReport !== undefined) {
          const { threadId } = entry.stored;
          heldReports.set(threadId, [...(heldReports.get(threadId) ?? []), ...holdReport]);
        }
        yield* persist;
        yield* notify;
      }),
    );

  const pause = (entry: Entry) =>
    locked(
      Effect.gen(function* () {
        if (!sameRun(entry)) return;
        entries.set(keyOf(entry.stored.threadId, entry.stored.label), paused(entry.stored));
        yield* notify;
      }),
    );

  /**
   * Wakes the thread with a run's news. A watch never un-settles its thread: when the thread
   * settled or went away before the news arrived, the run pauses or ends instead, and the run
   * stops. Returns whether it keeps running.
   */
  const deliver = (entry: Entry, lines: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const thread = yield* readThreadOrActive(entry.stored.threadId);
      if (thread.removed) {
        yield* finish(entry);
        return false;
      }
      if (thread.settled) {
        yield* pause(entry);
        return false;
      }
      yield* wake(entry.stored.threadId, lines);
      return true;
    });

  /**
   * Tells the thread a run ended, and ends the watch: an exited or flooding command is never
   * started again. A settled thread hears when it is active again.
   */
  const deliverEnd = (entry: Entry, lines: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const thread = yield* readThreadOrActive(entry.stored.threadId);
      if (thread.removed) return yield* finish(entry);
      if (thread.settled) return yield* finish(entry, lines);
      yield* wake(entry.stored.threadId, lines);
      yield* finish(entry);
    });

  /** One run of a watch's command, until it exits, floods, pauses or is stopped. */
  const runOnce = (entry: Entry) =>
    Effect.gen(function* () {
      const { label, command, cwd } = entry.stored;
      const queue = yield* Queue.unbounded<QueuedOutput>();
      const recent: Array<number> = [];
      yield* deps.runProcess({ command, cwd }).pipe(
        Stream.runForEachWhile((output) =>
          Effect.gen(function* () {
            if (output.type === "line") {
              const at = yield* Clock.currentTimeMillis;
              recent.push(at);
              while (recent[0]! <= at - FLOOD_WINDOW_MS) recent.shift();
              if (recent.length > COMMAND_WATCH_FLOOD_LIMIT) {
                yield* Queue.offer(queue, { type: "flood" });
                return false;
              }
            }
            yield* Queue.offer(queue, output);
            return true;
          }),
        ),
        Effect.forkScoped,
      );

      while (true) {
        const first = yield* Queue.take(queue);
        const batch = [first];
        if (first.type === "line") {
          yield* deps.batchWindow;
          batch.push(...(yield* Queue.clear(queue)));
        }
        const endAt = batch.findIndex((output) => output.type !== "line");
        const lines = (endAt === -1 ? batch : batch.slice(0, endAt)).flatMap((output) =>
          output.type === "line" ? [output.text] : [],
        );
        const end = endAt === -1 ? undefined : batch[endAt];
        if (end === undefined || end.type === "line") {
          if (!(yield* deliver(entry, outputLines(label, lines)))) return;
          continue;
        }
        const report =
          end.type === "flood"
            ? floodLines(label)
            : [...outputLines(label, lines), ...exitLines(label, end)];
        yield* deliverEnd(entry, report);
        return;
      }
    }).pipe(
      Effect.scoped,
      Effect.catchCause(
        logFailure("command watch failed", {
          threadId: entry.stored.threadId,
          label: entry.stored.label,
        }),
      ),
    );

  // Runs start under the lock's uninterruptible region; the run itself must stay stoppable.
  const startRun = (entry: Entry) =>
    FiberMap.run(
      fibers,
      keyOf(entry.stored.threadId, entry.stored.label),
      Effect.interruptible(runOnce(entry)),
    );

  const watch: CommandWatchService["Service"]["watch"] = (input) =>
    Effect.gen(function* () {
      const isDirectory = yield* fs.stat(input.cwd).pipe(
        Effect.map((info) => info.type === "Directory"),
        Effect.orElseSucceed(() => false),
      );
      if (!isDirectory) {
        return yield* new CommandWatchError({
          message: `The working directory ${input.cwd} does not exist.`,
        });
      }
      // Read under the lock, so a settle or archive cannot pass between the read and the start.
      return yield* locked(
        Effect.gen(function* () {
          const thread = yield* deps.readThread(input.threadId);
          if (thread.removed) {
            return yield* new CommandWatchError({ message: "The thread is archived or deleted." });
          }
          const key = keyOf(input.threadId, input.label);
          const existing = entries.get(key);
          if (existing?.stored.command === input.command && existing.stored.cwd === input.cwd) {
            return { watch: toWatch(existing), alreadyWatching: true };
          }
          const stored: StoredWatch = { ...input, startedAt: yield* now };
          const entry = thread.settled ? paused(stored) : yield* running(stored);
          yield* FiberMap.remove(fibers, key);
          entries.set(key, entry);
          if (entry.status === "running") yield* startRun(entry);
          yield* persist;
          yield* notify;
          return { watch: toWatch(entry), alreadyWatching: false };
        }),
      );
    });

  const unwatch: CommandWatchService["Service"]["unwatch"] = (input) =>
    locked(
      Effect.gen(function* () {
        const key = keyOf(input.threadId, input.label);
        if (!entries.has(key)) return { stopped: false };
        entries.delete(key);
        yield* persist;
        yield* notify;
        yield* FiberMap.remove(fibers, key);
        return { stopped: true };
      }),
    );

  const list: CommandWatchService["Service"]["list"] = (threadId) =>
    Effect.sync(() =>
      [...entries.values()]
        .filter((entry) => threadId === undefined || entry.stored.threadId === threadId)
        .map(toWatch),
    );

  const subscribe: CommandWatchService["Service"]["subscribe"] = () =>
    Stream.unwrap(
      Effect.gen(function* () {
        // Subscribe before the snapshot so a change between the two is not lost.
        const subscription = yield* PubSub.subscribe(changes);
        const snapshot = list().pipe(Effect.map((watches) => ({ watches })));
        return Stream.concat(
          Stream.fromEffect(snapshot),
          Stream.fromSubscription(subscription).pipe(Stream.mapEffect(() => snapshot)),
        );
      }),
    );

  /**
   * Archive and delete end a thread's watches; settling pauses them; activity resumes them, and
   * tells the thread what ended while it was settled.
   */
  const onThreadChange = (threadId: ThreadId, state: CommandWatchThreadState) =>
    Effect.gen(function* () {
      const { held, resumed } = yield* locked(
        Effect.gen(function* () {
          const held = state.settled ? [] : (heldReports.get(threadId) ?? []);
          if (!state.settled || state.removed) heldReports.delete(threadId);
          const own = [...entries.entries()].filter(
            ([, entry]) => entry.stored.threadId === threadId,
          );
          const labels: Array<string> = [];
          const stop: Array<string> = [];
          for (const [key, entry] of own) {
            if (state.removed) {
              entries.delete(key);
              stop.push(key);
            } else if (state.settled) {
              if (entry.status === "paused") continue;
              entries.set(key, paused(entry.stored));
              stop.push(key);
            } else if (entry.status === "paused") {
              const next = yield* running(entry.stored);
              entries.set(key, next);
              yield* startRun(next);
              labels.push(entry.stored.label);
            }
          }
          // The change is recorded before the commands stop.
          if (state.removed && own.length > 0) yield* persist;
          if (own.length > 0) yield* notify;
          for (const key of stop) yield* FiberMap.remove(fibers, key);
          return { held: state.removed ? [] : held, resumed: labels };
        }),
      );
      const news = [...held, ...resumed.map(resumedLine)];
      if (news.length > 0) yield* wake(threadId, news);
    });

  const start: CommandWatchService["Service"]["start"] = () =>
    Effect.gen(function* () {
      yield* deps.threadChanges.pipe(
        Stream.runForEach(({ threadId, state }) => onThreadChange(threadId, state)),
        Effect.catchCause(logFailure("command watch thread changes stopped", {})),
        Effect.forkScoped,
      );
      const restored = yield* fs.readFileString(deps.statePath).pipe(
        Effect.flatMap(decodeStateFile),
        Effect.map((file) => file.watches),
        Effect.catchCause((cause) =>
          fs.exists(deps.statePath).pipe(
            Effect.orElseSucceed(() => true),
            Effect.flatMap((exists) =>
              exists
                ? Effect.logWarning("command watches could not be read", { cause })
                : Effect.void,
            ),
            Effect.as([] as ReadonlyArray<StoredWatch>),
          ),
        ),
      );
      const restarted = new Map<ThreadId, Array<Entry>>();
      yield* locked(
        Effect.gen(function* () {
          let dropped = false;
          for (const stored of restored) {
            const key = keyOf(stored.threadId, stored.label);
            if (entries.has(key)) continue;
            const thread = yield* readThreadOrActive(stored.threadId);
            if (thread.removed) {
              dropped = true;
              continue;
            }
            const entry = thread.settled ? paused(stored) : yield* running(stored);
            entries.set(key, entry);
            if (entry.status === "running") {
              restarted.set(stored.threadId, [...(restarted.get(stored.threadId) ?? []), entry]);
            }
          }
          if (dropped) yield* persist;
          yield* notify;
        }),
      );
      // Each thread hears once, before its commands print anything, so the agent can take over.
      for (const [threadId, own] of restarted) {
        yield* wake(
          threadId,
          own.map((entry) => restartedLine(entry.stored.label)),
        );
        for (const entry of own) if (sameRun(entry)) yield* startRun(entry);
      }
    });

  return CommandWatchService.of({ watch, unwatch, list, subscribe, start });
});

const settledOf = (thread: {
  readonly settledOverride: "settled" | "active" | null;
  readonly settledAt: unknown;
}) => thread.settledOverride === "settled" || thread.settledAt !== null;

function threadChangeOf(event: OrchestrationV2DomainEvent) {
  switch (event.type) {
    case "thread.deleted":
      return { threadId: event.threadId, state: { removed: true, settled: false } };
    case "thread.archived":
    case "thread.settled":
    case "thread.unsettled":
    // Pinning a settled thread makes it active again.
    case "thread.pinned":
      return {
        threadId: event.threadId,
        state: { removed: event.payload.archivedAt !== null, settled: settledOf(event.payload) },
      };
    default:
      return undefined;
  }
}

/**
 * A wake is an ordinary message, as t3_thread_send's "auto" mode sends: the server resolves it
 * under the thread lock to steer an active run, or to start a turn.
 */
export const commandWatchWake = (input: {
  readonly threadId: ThreadId;
  readonly uuid: string;
  readonly text: string;
}) =>
  ({
    type: "message.dispatch",
    commandId: CommandId.make(`server:command-watch:${input.threadId}:${input.uuid}`),
    threadId: input.threadId,
    messageId: MessageId.make(`message:command-watch:${input.uuid}`),
    text: input.text,
    attachments: [],
    dispatchMode: { type: "queue_after_active" },
    deliveryIntent: "auto",
    createdBy: "agent",
    creationSource: "server",
  }) satisfies OrchestrationV2Command;

const failed = (message: string) => (cause: unknown) => new CommandWatchError({ message, cause });

export const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const config = yield* ServerConfig.ServerConfig;
  const processes = yield* CommandWatchProcess.CommandWatchProcess;
  const crypto = yield* Crypto.Crypto;
  const path = yield* Path.Path;
  return yield* makeWith({
    statePath: path.join(config.stateDir, STATE_FILE),
    readThread: (threadId) =>
      engine.getThreadShell(threadId).pipe(
        Effect.map((thread) => ({
          removed: thread === null || thread.archivedAt !== null || thread.deletedAt !== null,
          settled: thread !== null && settledOf(thread),
        })),
        Effect.mapError(failed("Could not read the thread.")),
      ),
    threadChanges: engine.streamDomainEvents.pipe(
      Stream.map(threadChangeOf),
      Stream.filter(Predicate.isNotUndefined),
      Stream.mapError(failed("Thread changes stopped.")),
    ),
    wake: (threadId, text) =>
      Effect.gen(function* () {
        const uuid = yield* crypto.randomUUIDv4;
        yield* engine.dispatch(commandWatchWake({ threadId, uuid, text }));
      }).pipe(Effect.mapError(failed("Could not wake the thread."))),
    runProcess: processes.run,
    batchWindow: Effect.sleep(COMMAND_WATCH_BATCH_WINDOW_MS),
  });
});

export const layer = Layer.effect(CommandWatchService, make).pipe(
  Layer.provide(CommandWatchProcess.layer),
);
