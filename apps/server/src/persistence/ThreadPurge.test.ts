// @effect-diagnostics nodeBuiltinImport:off - the tests build real git worktrees and state files.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import {
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnItemId,
  type ModelSelection,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { SqlitePersistenceMemory } from "./Layers/Sqlite.ts";
import {
  THREAD_PURGE_KEEP_FILE,
  THREAD_PURGE_PLAN_FILE,
  THREAD_PURGE_REQUEST_FILE,
  THREAD_PURGE_RESULT_FILE,
  StartupThreadPurge,
  purgeThreads,
  readKeepThreadIds,
  runRequestedThreadPurge,
  selectThreadsToPurge,
  startupThreadPurgeLayer,
  worktreeHasUnlandedWork,
} from "./ThreadPurge.ts";

const stores = Layer.mergeAll(
  SqlitePersistenceMemory,
  EventStore.layer.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
  ProjectionStore.layer.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

const providerInstanceId = ProviderInstanceId.make("codex");
const modelSelection = {
  instanceId: providerInstanceId,
  model: "gpt-5.4",
} satisfies ModelSelection;
const SETTLED = "2026-11-01T10:00:00.000Z";

interface ThreadSpec {
  readonly id: string;
  readonly settled?: boolean;
  readonly pinned?: boolean;
  readonly parent?: string;
  readonly sidebarParent?: string;
  readonly worktreePath?: string;
  readonly settledOverride?: "settled" | "active";
  readonly forkedFrom?: string;
}

function makeThread(spec: ThreadSpec, now: DateTime.Utc): OrchestrationV2AppThread {
  const id = ThreadId.make(spec.id);
  return {
    createdBy: "user",
    creationSource: "web",
    id,
    projectId: ProjectId.make("project:purge"),
    title: `Thread ${spec.id}`,
    providerInstanceId,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: spec.worktreePath ?? null,
    activeProviderThreadId: null,
    lineage: {
      parentThreadId: spec.parent === undefined ? null : ThreadId.make(spec.parent),
      relationshipToParent: spec.parent === undefined ? null : "subagent",
      rootThreadId: ThreadId.make(spec.parent ?? spec.id),
    },
    ...(spec.sidebarParent === undefined
      ? {}
      : { sidebarParentThreadId: ThreadId.make(spec.sidebarParent) }),
    forkedFrom:
      spec.forkedFrom === undefined
        ? null
        : {
            type: "run",
            threadId: ThreadId.make(spec.forkedFrom),
            runId: `run:${spec.forkedFrom}`,
          },
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: spec.settledOverride ?? null,
    settledAt: spec.settled === false ? null : DateTime.makeUnsafe(SETTLED),
    pinnedAt: spec.pinned === true ? now : null,
    lastVisitedAt: null,
    deletedAt: null,
  } as OrchestrationV2AppThread;
}

/** One thread with events, a projection, a bulky tool output and rows in other tables. */
const seedThread = (spec: ThreadSpec, output = `${spec.id}\n`.repeat(2_000)) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const eventStore = yield* EventStore.EventStoreV2;
    const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
    const now = yield* DateTime.now;
    const threadId = ThreadId.make(spec.id);
    const events: Array<OrchestrationV2DomainEvent> = [
      {
        id: EventId.make(`event:${spec.id}:created`),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: makeThread(spec, now),
      },
      {
        id: EventId.make(`event:${spec.id}:item`),
        type: "turn-item.updated",
        threadId,
        occurredAt: now,
        payload: {
          id: TurnItemId.make(`item:${spec.id}`),
          threadId,
          runId: null,
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 1,
          status: "completed",
          title: null,
          startedAt: now,
          completedAt: now,
          updatedAt: now,
          type: "command_execution",
          input: "ls",
          output,
          exitCode: 0,
        },
      },
    ];
    for (const stored of yield* eventStore.append({ events })) {
      yield* projectionStore.apply(stored.event);
    }
    yield* sql`
      INSERT INTO orchestration_v2_projection_runs
        (run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
      VALUES (${`run:${spec.id}`}, ${spec.id}, 1, 'codex', 'completed', '2026-11-01', '{}')
    `;
    yield* sql`
      INSERT INTO orchestration_v2_effect_outbox
        (effect_id, command_id, thread_id, effect_type, payload_json, status, available_at,
         created_at, updated_at)
      VALUES (${`effect:${spec.id}`}, 'command', ${spec.id}, 'provider.turn.start', '{}',
        'succeeded', '2026-11-01', '2026-11-01', '2026-11-01')
    `;
    yield* sql`
      INSERT INTO orchestration_v2_projection_provider_sessions
        (provider_session_id, thread_id, provider, status, updated_at, payload_json)
      VALUES (${`session:${spec.id}`}, ${spec.id}, 'codex', 'stopped', '2026-11-01', '{}')
    `;
    yield* sql`
      INSERT INTO projection_threads (thread_id, project_id, title, created_at, updated_at)
      VALUES (${spec.id}, 'project:purge', 'V1 copy', '2026-11-01', '2026-11-01')
    `;
    yield* sql`
      INSERT INTO projection_thread_messages
        (message_id, thread_id, role, text, is_streaming, created_at, updated_at)
      VALUES (${`v1-message:${spec.id}`}, ${spec.id}, 'user', 'hello', 0, '2026-11-01', '2026-11-01')
    `;
    yield* sql`
      INSERT INTO orchestration_events
        (event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at, actor_kind,
         payload_json, metadata_json, application_event_version)
      VALUES (${`v1-event:${spec.id}`}, 'thread', ${spec.id}, 1000, 'thread.activity-appended',
        '2026-11-01', 'server', '{}', '{}', 1)
    `;
  });

const threadIdsIn = (rows: ReadonlyArray<{ readonly threadId: string }>) =>
  rows.map((row) => row.threadId).toSorted();

const noWorktreeWork = () => false;

/** Rows anywhere that still belong to one of the threads. */
const rowsOfThreads = (threadIds: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const tables = yield* sql<{ readonly name: string }>`
      SELECT m.name FROM sqlite_master m, pragma_table_info(m.name) c
      WHERE m.type = 'table' AND c.name = 'thread_id'
    `;
    const found: Array<string> = [];
    for (const { name } of tables) {
      const rows = yield* sql.unsafe<{ readonly count: number }>(
        `SELECT COUNT(*) AS count FROM "${name}" WHERE thread_id IN (${threadIds.map(() => "?").join(",")})`,
        threadIds,
      );
      if ((rows[0]?.count ?? 0) > 0) found.push(name);
    }
    const events = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count FROM orchestration_events
      WHERE aggregate_kind = 'thread' AND stream_id IN ${sql.in(threadIds)}
    `;
    if ((events[0]?.count ?? 0) > 0) found.push("orchestration_events");
    return found;
  });

const writeJsonFile = (path: string, value: unknown) =>
  NodeFS.writeFileSync(path, JSON.stringify(value));
const freshRequest = (fields: Record<string, unknown> = {}) => ({
  requestedAt: DateTime.formatIso(DateTime.nowUnsafe()),
  ...fields,
});

function stateDirWith(files: Record<string, unknown>) {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "thread-purge-"));
  for (const [name, value] of Object.entries(files)) {
    NodeFS.writeFileSync(NodePath.join(dir, name), JSON.stringify(value));
  }
  return dir;
}

describe("settled thread purge selection", () => {
  it.effect("keeps unsettled, pinned, listed, busy and scheduled threads and their ancestors", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      for (const spec of [
        { id: "settled" },
        { id: "unsettled", settled: false },
        { id: "pinned", pinned: true },
        { id: "lead" },
        { id: "parent-of-active" },
        { id: "active-child", settled: false, parent: "parent-of-active" },
        { id: "grandparent" },
        { id: "nested-parent", parent: "grandparent" },
        { id: "nested-child", settled: false, sidebarParent: "nested-parent" },
        { id: "subagent-parent" },
        { id: "subagent-child", settled: false },
        { id: "settled-child-of-unsettled", parent: "unsettled" },
        { id: "running" },
        { id: "pending-effect" },
        { id: "scheduled" },
      ] satisfies ReadonlyArray<ThreadSpec>) {
        yield* seedThread(spec);
      }
      yield* sql`
        INSERT INTO orchestration_v2_projection_subagents
          (subagent_id, thread_id, parent_node_id, provider, child_thread_id, origin, status,
           updated_at, payload_json)
        VALUES ('subagent:1', 'subagent-parent', 'node:1', 'codex', 'subagent-child', 'app_owned',
          'completed', '2026-11-01', '{}')
      `;
      yield* sql`UPDATE orchestration_v2_projection_runs SET status = 'running'
        WHERE thread_id = 'running'`;
      yield* sql`UPDATE orchestration_v2_effect_outbox SET status = 'pending'
        WHERE thread_id = 'pending-effect'`;
      yield* sql`
        INSERT INTO scheduled_tasks
          (task_id, title, prompt, enabled, schedule_json, project_id, thread_id,
           workspace_strategy_json, model_selection_json, runtime_mode, interaction_mode,
           created_by, creation_source, created_at, updated_at, last_run_status, run_count)
        VALUES ('task:1', 'Nightly', 'go', 1, '{}', 'project:purge', 'scheduled', '{}', '{}',
          'full-access', 'default', 'user', 'web', '2026-11-01', '2026-11-01', 'never', 0)
      `;

      const selection = yield* selectThreadsToPurge(sql, {
        keepThreadIds: ["lead"],
        worktreeHasWork: noWorktreeWork,
      });
      assert.deepStrictEqual(threadIdsIn(selection.purge), [
        "settled",
        "settled-child-of-unsettled",
      ]);
      assert.deepStrictEqual(selection.keptByReason, {
        "not-settled": 4,
        pinned: 1,
        "keep-list": 1,
        "active-run": 1,
        "pending-effect": 1,
        "scheduled-task": 1,
        "kept-descendant": 4,
      });
    }).pipe(Effect.provide(stores)),
  );

  it.effect("keeps settled threads whose worktree holds work", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "thread-purge-git-"));
      const run = (cwd: string, ...args: Array<string>) =>
        NodeChildProcess.execFileSync("git", args, { cwd, stdio: "pipe" });
      const origin = NodePath.join(root, "origin.git");
      run(root, "init", "--bare", "--initial-branch=main", origin);
      const clone = (name: string) => {
        const path = NodePath.join(root, name);
        run(root, "clone", "--quiet", origin, path);
        run(
          path,
          "-c",
          "user.name=t",
          "-c",
          "user.email=t@t",
          "commit",
          "--allow-empty",
          "-m",
          "x",
        );
        return path;
      };
      const landed = clone("landed");
      run(landed, "push", "--quiet", "origin", "HEAD:main");
      const dirty = clone("dirty");
      run(dirty, "reset", "--quiet", "--hard", "origin/main");
      NodeFS.writeFileSync(NodePath.join(dirty, "notes.txt"), "in progress");
      const unpushed = clone("unpushed");
      run(unpushed, "fetch", "--quiet");
      run(unpushed, "rebase", "--quiet", "origin/main");
      run(
        unpushed,
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@t",
        "commit",
        "--allow-empty",
        "-m",
        "y",
      );

      assert.isFalse(worktreeHasUnlandedWork(landed));
      assert.isTrue(worktreeHasUnlandedWork(dirty));
      assert.isTrue(worktreeHasUnlandedWork(unpushed));
      assert.isFalse(worktreeHasUnlandedWork(NodePath.join(root, "removed")));
      // A directory that is not a repository cannot vouch for itself.
      assert.isTrue(worktreeHasUnlandedWork(root));

      for (const [id, worktreePath] of [
        ["on-landed", landed],
        ["on-dirty", dirty],
        ["on-unpushed", unpushed],
        ["on-removed", NodePath.join(root, "removed")],
      ] as const) {
        yield* seedThread({ id, worktreePath });
      }
      const selection = yield* selectThreadsToPurge(sql, { keepThreadIds: [] });
      assert.deepStrictEqual(threadIdsIn(selection.purge), ["on-landed", "on-removed"]);
      assert.deepStrictEqual(selection.keptByReason, { "worktree-work": 2 });
      NodeFS.rmSync(root, { recursive: true, force: true });
    }).pipe(Effect.provide(stores)),
  );

  it.effect("keeps reopened threads, fork sources and pending transfer sources", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      for (const spec of [
        // Reopened: "active" with a stale settledAt.
        { id: "reopened", settledOverride: "active" },
        { id: "source" },
        { id: "fork", forkedFrom: "source" },
        { id: "fork-kept", forkedFrom: "source-of-kept-fork", pinned: true },
        { id: "source-of-kept-fork" },
        { id: "parent", settled: false },
        { id: "merging-fork" },
      ] satisfies ReadonlyArray<ThreadSpec>) {
        yield* seedThread(spec);
      }
      yield* sql`
        INSERT INTO orchestration_v2_projection_context_transfers
          (context_transfer_id, source_thread_id, target_thread_id, type, status, updated_at,
           payload_json)
        VALUES ('merge', 'merging-fork', 'parent', 'merge_back', 'pending', '2026-11-01', '{}')
      `;
      const selection = yield* selectThreadsToPurge(sql, {
        keepThreadIds: [],
        worktreeHasWork: noWorktreeWork,
      });
      assert.deepStrictEqual(threadIdsIn(selection.purge), ["fork", "source"]);
      assert.include(selection.keptByReason, {
        "not-settled": 2,
        "pending-transfer-source": 1,
        "kept-descendant": 1,
      });

      // A plan reviewed before "fork" existed approves only "source": the fork
      // created since stays, and so does the source it reads.
      const approved = yield* selectThreadsToPurge(sql, {
        keepThreadIds: [],
        worktreeHasWork: noWorktreeWork,
        approvedThreadIds: new Set(["source"]),
      });
      assert.deepStrictEqual(threadIdsIn(approved.purge), []);
    }).pipe(Effect.provide(stores)),
  );

  it("reads the keep file and command watches", () => {
    const dir = stateDirWith({
      [THREAD_PURGE_KEEP_FILE]: { keepThreadIds: ["lead-1", "lead-2"] },
      "command-watches.json": { watches: [{ threadId: "watching", label: "x" }] },
    });
    assert.deepStrictEqual(readKeepThreadIds(dir), ["lead-1", "lead-2", "watching"]);
    assert.isUndefined(readKeepThreadIds(NodePath.join(dir, "missing")));
    NodeFS.rmSync(dir, { recursive: true, force: true });
  });
});

describe("settled thread purge", () => {
  // Live clock: requests carry wall-clock times.
  it.live("dry run plans without deleting; purge removes every row of purged threads", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      // "kept" shares its tool output with "gone-shared", so that stored copy stays.
      const shared = "shared output\n".repeat(1_000);
      yield* seedThread({ id: "kept", settled: false }, shared);
      yield* seedThread({ id: "gone-shared" }, shared);
      yield* seedThread({ id: "gone" });
      yield* sql`
        INSERT INTO orchestration_v2_projection_context_transfers
          (context_transfer_id, source_thread_id, target_thread_id, type, status, updated_at,
           payload_json)
        VALUES ('to-kept', 'gone', 'kept', 'subagent_result', 'delivered', '2026-11-01', '{}'),
               ('to-gone', 'kept', 'gone', 'fork', 'delivered', '2026-11-01', '{}')
      `;
      const stateDir = stateDirWith({ [THREAD_PURGE_KEEP_FILE]: { keepThreadIds: [] } });
      const dbPath = NodePath.join(stateDir, "statev2.sqlite");
      const requestPath = NodePath.join(stateDir, THREAD_PURGE_REQUEST_FILE);
      const readState = (name: string) =>
        JSON.parse(NodeFS.readFileSync(NodePath.join(stateDir, name), "utf8"));
      const countRows = sql<{ readonly count: number }>`
        SELECT (SELECT COUNT(*) FROM orchestration_events)
          + (SELECT COUNT(*) FROM orchestration_v2_projection_turn_items)
          + (SELECT COUNT(*) FROM tool_outputs) AS count
      `;

      // Dry run is the default.
      writeJsonFile(requestPath, freshRequest());
      const before = yield* countRows;
      yield* runRequestedThreadPurge(sql, dbPath, { worktreeHasWork: noWorktreeWork });
      assert.deepStrictEqual(yield* countRows, before);
      assert.deepStrictEqual(threadIdsIn(readState(THREAD_PURGE_PLAN_FILE).purge), [
        "gone",
        "gone-shared",
      ]);
      assert.include(readState(THREAD_PURGE_RESULT_FILE), { outcome: "dry-run", wouldPurge: 2 });
      assert.isFalse(NodeFS.existsSync(requestPath));

      // A purge needs a named backup; without one the request is set aside.
      writeJsonFile(requestPath, freshRequest({ mode: "purge" }));
      yield* runRequestedThreadPurge(sql, dbPath, { worktreeHasWork: noWorktreeWork });
      assert.deepStrictEqual(yield* countRows, before);
      assert.isFalse(NodeFS.existsSync(requestPath));
      assert.isTrue(NodeFS.existsSync(`${requestPath}.rejected`));
      assert.include(readState(THREAD_PURGE_RESULT_FILE), { outcome: "rejected" });

      // Limited to a reviewed plan that lists only "gone".
      const approvedPlan = NodePath.join(stateDir, "approved.json");
      writeJsonFile(approvedPlan, { purge: [{ threadId: "gone" }] });
      writeJsonFile(
        requestPath,
        freshRequest({ mode: "purge", backup: "test", vacuum: false, approvedPlan }),
      );
      yield* runRequestedThreadPurge(sql, dbPath, { worktreeHasWork: noWorktreeWork });
      assert.deepStrictEqual(yield* rowsOfThreads(["gone"]), []);
      assert.include(readState(THREAD_PURGE_RESULT_FILE), {
        outcome: "purge",
        wouldPurge: 1,
        notInApprovedPlan: 1,
      });

      // Unrestricted purge of the rest.
      writeJsonFile(requestPath, freshRequest({ mode: "purge", backup: "test", vacuum: false }));
      yield* runRequestedThreadPurge(sql, dbPath, { worktreeHasWork: noWorktreeWork });
      assert.deepStrictEqual(yield* rowsOfThreads(["gone", "gone-shared"]), []);

      // The kept thread is whole: its rows, the transfers it sent and received,
      // and its stored output.
      assert.includeMembers(yield* rowsOfThreads(["kept"]), [
        "orchestration_events",
        "orchestration_v2_projection_threads",
        "orchestration_v2_projection_turn_items",
        "projection_threads",
      ]);
      const transfers = yield* sql<{ readonly id: string }>`
        SELECT context_transfer_id AS id FROM orchestration_v2_projection_context_transfers
      `;
      assert.deepStrictEqual(transfers.map((row) => row.id).toSorted(), ["to-gone", "to-kept"]);
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const item = yield* projectionStore.getTurnItem({
        threadId: ThreadId.make("kept"),
        itemId: TurnItemId.make("item:kept"),
      });
      assert.strictEqual(item?.type === "command_execution" ? item.output : undefined, shared);
      const outputs = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM tool_outputs
      `;
      assert.strictEqual(outputs[0]?.count, 1);
      const sessions = yield* sql<{ readonly id: string }>`
        SELECT provider_session_id AS id FROM orchestration_v2_projection_provider_sessions
      `;
      assert.deepStrictEqual(
        sessions.map((row) => row.id),
        ["session:kept"],
      );
      NodeFS.rmSync(stateDir, { recursive: true, force: true });
    }).pipe(Effect.provide(stores)),
  );

  // Live clock: requests carry wall-clock times.
  it.live("sets aside requests it must not run, without failing", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedThread({ id: "settled" });
      const keep = { [THREAD_PURGE_KEEP_FILE]: { keepThreadIds: [] } };
      for (const [files, suffix] of [
        // No keep file.
        [
          { [THREAD_PURGE_REQUEST_FILE]: freshRequest({ mode: "purge", backup: "test" }) },
          "rejected",
        ],
        // Stale: written for an earlier restart.
        [
          {
            ...keep,
            [THREAD_PURGE_REQUEST_FILE]: {
              requestedAt: "2026-01-01T00:00:00.000Z",
              mode: "purge",
              backup: "test",
            },
          },
          "rejected",
        ],
        // A reviewed plan that is not there.
        [
          {
            ...keep,
            [THREAD_PURGE_REQUEST_FILE]: freshRequest({
              mode: "purge",
              backup: "test",
              approvedPlan: "/missing/plan.json",
            }),
          },
          "rejected",
        ],
      ] as const) {
        const stateDir = stateDirWith(files);
        const requestPath = NodePath.join(stateDir, THREAD_PURGE_REQUEST_FILE);
        yield* runRequestedThreadPurge(sql, NodePath.join(stateDir, "statev2.sqlite"), {
          worktreeHasWork: noWorktreeWork,
        });
        assert.isFalse(NodeFS.existsSync(requestPath));
        assert.isTrue(NodeFS.existsSync(`${requestPath}.${suffix}`));
        NodeFS.rmSync(stateDir, { recursive: true, force: true });
      }
      // Malformed JSON is set aside too.
      const stateDir = stateDirWith(keep);
      const requestPath = NodePath.join(stateDir, THREAD_PURGE_REQUEST_FILE);
      NodeFS.writeFileSync(requestPath, "{ not json");
      yield* runRequestedThreadPurge(sql, NodePath.join(stateDir, "statev2.sqlite"));
      assert.isTrue(NodeFS.existsSync(`${requestPath}.rejected`));
      assert.includeMembers(yield* rowsOfThreads(["settled"]), ["orchestration_events"]);
      NodeFS.rmSync(stateDir, { recursive: true, force: true });
    }).pipe(Effect.provide(stores)),
  );

  // Live clock: requests carry wall-clock times.
  it.live("runs only in the server process", () =>
    Effect.gen(function* () {
      yield* seedThread({ id: "settled" });
      const stateDir = stateDirWith({
        [THREAD_PURGE_KEEP_FILE]: { keepThreadIds: [] },
        [THREAD_PURGE_REQUEST_FILE]: freshRequest(),
      });
      const requestPath = NodePath.join(stateDir, THREAD_PURGE_REQUEST_FILE);
      const layer = startupThreadPurgeLayer(NodePath.join(stateDir, "statev2.sqlite"));
      // CLI processes leave the reference at its default.
      yield* Effect.provide(Effect.void, layer);
      assert.isTrue(NodeFS.existsSync(requestPath));
      yield* Effect.provide(
        Effect.void,
        layer.pipe(Layer.provide(Layer.succeed(StartupThreadPurge, true))),
      );
      assert.isFalse(NodeFS.existsSync(requestPath));
      assert.isTrue(NodeFS.existsSync(NodePath.join(stateDir, THREAD_PURGE_PLAN_FILE)));
      NodeFS.rmSync(stateDir, { recursive: true, force: true });
    }).pipe(Effect.provide(stores)),
  );

  it.effect("skips a planned thread that another process woke before the purge", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedThread({ id: "woken" });
      yield* seedThread({ id: "settled" });
      // Unsettled after planning, before its chunk runs.
      yield* sql`
        UPDATE orchestration_v2_projection_threads
        SET payload_json = json_set(payload_json, '$.settledOverride', 'active')
        WHERE thread_id = 'woken'
      `;
      const result = yield* purgeThreads(sql, ["woken", "settled"]);
      assert.include(result, { purgedThreads: 1, skippedAsBusy: 1 });
      assert.includeMembers(yield* rowsOfThreads(["woken"]), ["orchestration_events"]);
      assert.deepStrictEqual(yield* rowsOfThreads(["settled"]), []);
    }).pipe(Effect.provide(stores)),
  );
});
