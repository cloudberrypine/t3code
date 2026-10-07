import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  type OrchestrationV2ThreadProjection,
  ProviderSessionId,
  ProviderThreadId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { resolveMessageDispatchIntent } from "../orchestration-v2/CommandPolicy.ts";
import type { CommandWatchOutput } from "./CommandWatchProcess.ts";
import { commandWatchWake, type CommandWatchThreadState, makeWith } from "./CommandWatchService.ts";
import { COMMAND_WATCH_FLOOD_LIMIT } from "./commandWatchMessages.ts";

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeStoredLabels = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({ watches: Schema.Array(Schema.Struct({ label: Schema.String })) }),
  ),
);

const threadA = ThreadId.make("command-watch-thread-a");
const threadB = ThreadId.make("command-watch-thread-b");
const active: CommandWatchThreadState = { removed: false, settled: false };
const settled: CommandWatchThreadState = { removed: false, settled: true };

interface FakeRun {
  readonly command: string;
  readonly output: Queue.Queue<CommandWatchOutput>;
  /** One signal each time the service asks for the next output, so every earlier one was handled. */
  readonly pulls: Queue.Queue<void>;
  /** Completes when the service stops the command. */
  readonly stopped: Deferred.Deferred<void>;
}

/** The service with fake threads, processes and wakes; the state file lives in a temp dir. */
const harness = Effect.fn("commandWatchHarness")(function* (options?: {
  readonly stateFile?: unknown;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-command-watch-" });
  const statePath = path.join(dir, "command-watches.json");
  if (options?.stateFile !== undefined) {
    yield* fs.writeFileString(statePath, yield* encodeJson(options.stateFile));
  }
  const threads = new Map<ThreadId, CommandWatchThreadState>([
    [threadA, active],
    [threadB, active],
  ]);
  const runs = yield* Queue.unbounded<FakeRun>();
  const wakes = yield* Queue.unbounded<{ readonly threadId: ThreadId; readonly text: string }>();
  const windows = yield* Queue.unbounded<void>();
  const changes = yield* PubSub.unbounded<{
    readonly threadId: ThreadId;
    readonly state: CommandWatchThreadState;
  }>();
  /** Runs once while the next read is in flight, after the state it returns was read. */
  let duringNextRead: Effect.Effect<void> | undefined;
  const service = yield* makeWith({
    statePath,
    readThread: (threadId) =>
      Effect.gen(function* () {
        const state = threads.get(threadId) ?? { removed: true, settled: false };
        const during = duringNextRead;
        duringNextRead = undefined;
        if (during !== undefined) yield* during;
        return state;
      }),
    threadChanges: Stream.fromPubSub(changes),
    wake: (threadId, text) => Queue.offer(wakes, { threadId, text }).pipe(Effect.asVoid),
    runProcess: ({ command }) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const output = yield* Queue.unbounded<CommandWatchOutput>();
          const pulls = yield* Queue.unbounded<void>();
          const stopped = yield* Deferred.make<void>();
          yield* Queue.offer(runs, { command, output, pulls, stopped });
          return Stream.fromEffectRepeat(
            Queue.offer(pulls, undefined).pipe(Effect.andThen(Queue.take(output))),
          ).pipe(Stream.ensuring(Deferred.succeed(stopped, undefined)));
        }),
      ),
    // A batch closes when the test releases it, so what counts as "together" is explicit.
    batchWindow: Queue.take(windows),
  });
  const setThread = (threadId: ThreadId, state: CommandWatchThreadState) =>
    Effect.gen(function* () {
      threads.set(threadId, state);
      yield* PubSub.publish(changes, { threadId, state });
    });
  /** The next run, once the service is ready for its first output. */
  const nextRun = Queue.take(runs).pipe(Effect.tap((run) => Queue.take(run.pulls)));
  /** Prints a line and waits until the service has taken it in. */
  const line = (run: FakeRun, text: string) =>
    Queue.offer(run.output, { type: "line", text }).pipe(Effect.andThen(Queue.take(run.pulls)));
  const closeWindow = Queue.offer(windows, undefined);
  const storedLabels = fs.readFileString(statePath).pipe(
    Effect.flatMap(decodeStoredLabels),
    Effect.map((file) => file.watches.map((watch) => watch.label)),
  );
  return {
    service,
    duringNextRead: (effect: Effect.Effect<void>) => {
      duringNextRead = effect;
    },
    runs,
    nextRun,
    wakes,
    setThread,
    line,
    closeWindow,
    storedLabels,
    cwd: dir,
  };
});

const start = (
  h: Effect.Success<ReturnType<typeof harness>>,
  label = "flags",
  threadId = threadA,
) => h.service.watch({ threadId, label, command: `watch-${label}`, cwd: h.cwd });

it.layer(NodeServices.layer)("CommandWatchService", (it) => {
  it.effect("combines lines that arrive together into one labelled wake", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      yield* start(h);
      const run = yield* h.nextRun;
      yield* h.line(run, "flag: one.json");
      yield* h.line(run, "flag: two.json");
      yield* h.closeWindow;
      const wake = yield* Queue.take(h.wakes);
      assert.equal(wake.threadId, threadA);
      assert.equal(wake.text, "[watch flags] flag: one.json\n[watch flags] flag: two.json");

      yield* h.line(run, "main: moved");
      yield* h.closeWindow;
      assert.equal((yield* Queue.take(h.wakes)).text, "[watch flags] main: moved");
    }).pipe(Effect.scoped),
  );

  it.effect("reports an exit once with its code and stderr, and does not restart", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      yield* start(h);
      const run = yield* h.nextRun;
      yield* Queue.offer(run.output, {
        type: "exit",
        code: 2,
        reason: null,
        stderr: ["fatal: not a git repository"],
      });
      const wake = yield* Queue.take(h.wakes);
      assert.include(wake.text, "exited with code 2");
      assert.include(wake.text, "fatal: not a git repository");
      yield* Deferred.await(run.stopped);
      assert.deepEqual(yield* h.service.list(), []);
      assert.deepEqual(yield* h.storedLabels, []);
      assert.equal(yield* Queue.size(h.runs), 0);
    }).pipe(Effect.scoped),
  );

  it.effect("stops a command that floods and tells the thread", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      yield* start(h);
      const run = yield* h.nextRun;
      for (let index = 0; index < COMMAND_WATCH_FLOOD_LIMIT; index++) {
        yield* h.line(run, `line ${index}`);
      }
      // One line too many: the service stops reading and stops the command.
      yield* Queue.offer(run.output, { type: "line", text: "one too many" });
      yield* Deferred.await(run.stopped);
      yield* h.closeWindow;
      // The first line opened a batch; the flood ends it without listing the lines.
      const wake = yield* Queue.take(h.wakes);
      assert.include(wake.text, `more than ${COMMAND_WATCH_FLOOD_LIMIT} lines in a minute`);
      assert.notInclude(wake.text, "line 0");
      assert.deepEqual(yield* h.service.list(), []);
    }).pipe(Effect.scoped),
  );

  it.effect("unwatch stops the command and forgets the watch", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      yield* start(h, "flags");
      yield* start(h, "main");
      const flags = yield* h.nextRun;
      assert.deepEqual(yield* h.storedLabels, ["flags", "main"]);

      assert.deepEqual(yield* h.service.unwatch({ threadId: threadA, label: "flags" }), {
        stopped: true,
      });
      yield* Deferred.await(flags.stopped);
      assert.deepEqual(yield* h.storedLabels, ["main"]);
      assert.deepEqual(yield* h.service.unwatch({ threadId: threadA, label: "flags" }), {
        stopped: false,
      });
    }).pipe(Effect.scoped),
  );

  it.effect("watching the same command again is a no-op; a new command replaces it", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      yield* start(h);
      const first = yield* h.nextRun;
      assert.isTrue((yield* start(h)).alreadyWatching);
      assert.equal(yield* Queue.size(h.runs), 0);

      const replaced = yield* h.service.watch({
        threadId: threadA,
        label: "flags",
        command: "other",
        cwd: h.cwd,
      });
      assert.isFalse(replaced.alreadyWatching);
      yield* Deferred.await(first.stopped);
      assert.equal((yield* h.nextRun).command, "other");
    }).pipe(Effect.scoped),
  );

  it.effect("archiving the thread stops its watches", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      yield* h.service.start();
      yield* start(h);
      const run = yield* h.nextRun;
      yield* h.setThread(threadA, { removed: true, settled: false });
      yield* Deferred.await(run.stopped);
      assert.deepEqual(yield* h.service.list(), []);
      assert.deepEqual(yield* h.storedLabels, []);
    }).pipe(Effect.scoped),
  );

  it.effect("settling pauses a watch and activity resumes it with one line", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      yield* h.service.start();
      yield* start(h);
      const run = yield* h.nextRun;

      yield* h.setThread(threadA, settled);
      yield* Deferred.await(run.stopped);
      const [paused] = yield* h.service.list();
      assert.equal(paused?.status, "paused");
      assert.equal(paused?.runningSince, null);
      assert.deepEqual(yield* h.storedLabels, ["flags"]);

      yield* h.setThread(threadA, active);
      const resumed = yield* h.nextRun;
      assert.equal(resumed.command, "watch-flags");
      assert.equal(
        (yield* Queue.take(h.wakes)).text,
        "The thread is active again; watch flags resumed.",
      );
      assert.equal((yield* h.service.list())[0]?.status, "running");
    }).pipe(Effect.scoped),
  );

  it.effect("never wakes a thread that settled before its output was delivered", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      yield* start(h);
      const run = yield* h.nextRun;
      yield* h.line(run, "flag: late.json");
      // Settled while the line waited; no change event reached the watch (it was not started).
      yield* h.setThread(threadA, settled);
      yield* h.closeWindow;
      yield* Deferred.await(run.stopped);
      assert.equal((yield* h.service.list())[0]?.status, "paused");
      assert.equal(yield* Queue.size(h.wakes), 0);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "an exit while the thread is settled ends the watch; the thread hears when active",
    () =>
      Effect.gen(function* () {
        const h = yield* harness();
        yield* start(h);
        const run = yield* h.nextRun;
        // Settled with no change event reaching the watch (it was not started).
        yield* h.setThread(threadA, settled);
        yield* Queue.offer(run.output, { type: "exit", code: 0, reason: null, stderr: [] });
        yield* Deferred.await(run.stopped);
        assert.deepEqual(yield* h.service.list(), []);
        assert.deepEqual(yield* h.storedLabels, []);
        assert.equal(yield* Queue.size(h.wakes), 0);

        yield* h.service.start();
        yield* h.setThread(threadA, active);
        assert.include((yield* Queue.take(h.wakes)).text, "exited with code 0");
        assert.equal(yield* Queue.size(h.runs), 0);
      }).pipe(Effect.scoped),
  );

  it.effect("a thread that settles while a watch starts pauses it", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      yield* h.service.start();
      // The watch read the thread as active; it settles before the watch is registered.
      h.duringNextRead(
        Effect.gen(function* () {
          yield* h.setThread(threadA, settled);
          for (let index = 0; index < 20; index++) yield* Effect.yieldNow;
        }),
      );
      yield* start(h);
      const run = yield* Queue.take(h.runs);
      yield* Deferred.await(run.stopped);
      assert.equal((yield* h.service.list())[0]?.status, "paused");
      assert.equal(yield* Queue.size(h.wakes), 0);
    }).pipe(Effect.scoped),
  );

  it.effect("restores persisted watches on start and wakes each thread once", () =>
    Effect.gen(function* () {
      const watch = (threadId: ThreadId, label: string) => ({
        threadId,
        label,
        command: `watch-${label}`,
        cwd: "/tmp",
        startedAt: "2026-10-07T08:00:00.000Z",
      });
      const h = yield* harness({
        stateFile: {
          watches: [
            watch(threadA, "flags"),
            watch(threadA, "main"),
            watch(threadB, "quiet"),
            watch(ThreadId.make("archived-thread"), "gone"),
          ],
        },
      });
      yield* h.setThread(threadB, settled);
      yield* h.service.start();

      const wake = yield* Queue.take(h.wakes);
      assert.equal(wake.threadId, threadA);
      assert.equal(
        wake.text,
        "T3 Code restarted; watch flags restarted.\nT3 Code restarted; watch main restarted.",
      );
      const commands = [(yield* h.nextRun).command, (yield* h.nextRun).command];
      assert.deepEqual(commands.toSorted(), ["watch-flags", "watch-main"]);

      const watches = yield* h.service.list();
      assert.deepEqual(
        watches.map((entry) => [entry.label, entry.status, entry.startedAt]),
        [
          ["flags", "running", "2026-10-07T08:00:00.000Z"],
          ["main", "running", "2026-10-07T08:00:00.000Z"],
          ["quiet", "paused", "2026-10-07T08:00:00.000Z"],
        ],
      );
      // The archived thread's watch is dropped; the settled thread is not woken.
      assert.deepEqual(yield* h.storedLabels, ["flags", "main", "quiet"]);
      assert.equal(yield* Queue.size(h.wakes), 0);
    }).pipe(Effect.scoped),
  );

  it.effect("rejects a working directory that does not exist", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      const error = yield* h.service
        .watch({ threadId: threadA, label: "flags", command: "x", cwd: `${h.cwd}/missing` })
        .pipe(Effect.flip);
      assert.include(error.message, "does not exist");
    }).pipe(Effect.scoped),
  );
});

it("wakes steer an active run and otherwise start a turn", () => {
  const wake = commandWatchWake({ threadId: threadA, uuid: "u", text: "[watch flags] x" });
  assert.equal(wake.deliveryIntent, "auto");
  const providerThreadId = ProviderThreadId.make("command-watch-provider-thread");
  const providerSessionId = ProviderSessionId.make("command-watch-provider-session");
  const runId = RunId.make("command-watch-run");
  const idle = { runs: [], providerThreads: [], providerSessions: [] };
  const running = {
    runs: [{ id: runId, status: "running", providerThreadId }],
    providerThreads: [{ id: providerThreadId, providerSessionId }],
    providerSessions: [{ id: providerSessionId, capabilities: CodexProviderCapabilitiesV2 }],
  };
  assert.deepEqual(
    resolveMessageDispatchIntent(
      idle as unknown as OrchestrationV2ThreadProjection,
      wake.dispatchMode,
      wake.deliveryIntent,
    ),
    { type: "start_immediately" },
  );
  assert.deepEqual(
    resolveMessageDispatchIntent(
      running as unknown as OrchestrationV2ThreadProjection,
      wake.dispatchMode,
      wake.deliveryIntent,
    ),
    { type: "steer_active", targetRunId: runId },
  );
});
