// @effect-diagnostics nodeBuiltinImport:off - disk space and worktree checks run before services exist.
/**
 * Deletes settled threads from the state database and gives the space back.
 *
 * It runs once per request, at server startup, before the server serves
 * anything: the installer writes `thread-purge-request.json` after it has quit
 * T3 Code and backed up the database. Threads kept: not settled, pinned, with
 * an active or queued run or pending effects, bound to a scheduled task or a
 * command watch, listed in `thread-purge-keep.json`, and every ancestor of a
 * kept thread (subagent lineage, sidebar nesting and subagent rows).
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlClientService from "effect/unstable/sql/SqlClient";

export const THREAD_PURGE_REQUEST_FILE = "thread-purge-request.json";
export const THREAD_PURGE_KEEP_FILE = "thread-purge-keep.json";
export const THREAD_PURGE_RESULT_FILE = "thread-purge-last.json";
export const THREAD_PURGE_PLAN_FILE = "thread-purge-plan.json";
const COMMAND_WATCHES_FILE = "command-watches.json";

/** Set by the server, so CLI processes that open the database never purge. */
export class StartupThreadPurge extends Context.Reference<boolean>("t3/startupThreadPurge", {
  defaultValue: () => false,
}) {}

const ACTIVE_RUN_STATUSES = ["queued", "preparing", "starting", "running", "waiting"] as const;

// Tables keyed by thread_id that the generic sweep must not touch: provider
// sessions are shared through bindings, and scheduled tasks are never deleted.
const SPECIAL_THREAD_TABLES = new Set([
  "orchestration_v2_projection_provider_sessions",
  "scheduled_tasks",
]);

export type ThreadKeepReason =
  | "not-settled"
  | "pinned"
  | "keep-list"
  | "command-watch"
  | "active-run"
  | "pending-effect"
  | "scheduled-task"
  | "worktree-work"
  | "kept-descendant";

export interface ThreadPurgeCandidate {
  readonly threadId: string;
  readonly title: string;
  readonly settledAt: string | null;
  readonly worktreePath: string | null;
}

export interface ThreadPurgeSelection {
  readonly purge: ReadonlyArray<ThreadPurgeCandidate>;
  readonly kept: number;
  readonly keptSettled: number;
  /** The first reason each kept thread matched. */
  readonly keptByReason: Readonly<Partial<Record<ThreadKeepReason, number>>>;
}

/** Whether a worktree holds work that exists nowhere else; see worktreeHasUnlandedWork. */
export type WorktreeCheck = (worktreePath: string) => boolean;

interface ThreadRow {
  readonly thread_id: string;
  readonly payload_json: string;
}

interface ThreadFacts {
  readonly title: string;
  readonly settled: boolean;
  readonly settledAt: string | null;
  readonly pinned: boolean;
  readonly worktreePath: string | null;
  readonly parents: ReadonlyArray<string>;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function threadFacts(payloadJson: string): ThreadFacts {
  let payload: Record<string, unknown> = {};
  let readable = false;
  try {
    const value: unknown = JSON.parse(payloadJson);
    if (typeof value === "object" && value !== null) {
      payload = value as Record<string, unknown>;
      readable = true;
    }
  } catch {
    // An unreadable thread is never treated as settled.
  }
  const lineage = payload.lineage as { readonly parentThreadId?: unknown } | undefined;
  const parents = [lineage?.parentThreadId, payload.sidebarParentThreadId].flatMap(
    (id) => nonEmptyString(id) ?? [],
  );
  const settledAt = nonEmptyString(payload.settledAt);
  return {
    title: nonEmptyString(payload.title) ?? "",
    settled:
      readable &&
      payload.settledOverride !== "unsettled" &&
      (payload.settledOverride === "settled" || settledAt !== null),
    settledAt,
    pinned: nonEmptyString(payload.pinnedAt) !== null,
    worktreePath: nonEmptyString(payload.worktreePath),
    parents,
  };
}

function git(cwd: string, args: ReadonlyArray<string>) {
  return NodeChildProcess.spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    timeout: 30_000,
    stdio: ["ignore", "pipe", "pipe"],
    // Status must not write index refreshes into someone's worktree.
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
}

/**
 * True when the worktree has uncommitted changes (untracked files included) or
 * commits not on origin/main, or when that cannot be told: a worktree that
 * exists but fails to answer is treated as holding work. A missing worktree
 * holds none.
 */
export const worktreeHasUnlandedWork: WorktreeCheck = (worktreePath) => {
  if (!NodeFS.existsSync(worktreePath)) return false;
  const status = git(worktreePath, ["status", "--porcelain", "--untracked-files=normal"]);
  if (status.status !== 0 || status.stdout.trim() !== "") return true;
  const ahead = git(worktreePath, ["rev-list", "--count", "HEAD", "--not", "origin/main"]);
  return ahead.status !== 0 || ahead.stdout.trim() !== "0";
};

const tableExists = (sql: SqlClient.SqlClient, name: string) =>
  sql<{ readonly present: number }>`
    SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ${name}) AS present
  `.pipe(Effect.map((rows) => rows[0]?.present === 1));

/**
 * The settled threads to purge; everything else, and every ancestor of it,
 * stays. Reads only, so it can plan against a live database.
 */
export const selectThreadsToPurge = (
  sql: SqlClient.SqlClient,
  options: {
    readonly keepThreadIds: ReadonlyArray<string>;
    readonly worktreeHasWork?: WorktreeCheck;
  },
) =>
  Effect.gen(function* () {
    const worktreeHasWork = options.worktreeHasWork ?? worktreeHasUnlandedWork;
    const threads = yield* sql<ThreadRow>`
      SELECT thread_id, payload_json FROM orchestration_v2_projection_threads
    `;
    const facts = new Map(threads.map((row) => [row.thread_id, threadFacts(row.payload_json)]));
    const parentsOf = new Map<string, Set<string>>();
    const addParent = (child: string, parent: string) => {
      if (child === parent) return;
      const parents = parentsOf.get(child) ?? new Set<string>();
      parents.add(parent);
      parentsOf.set(child, parents);
    };
    for (const [threadId, thread] of facts) {
      for (const parent of thread.parents) addParent(threadId, parent);
    }
    for (const row of yield* sql<{ readonly thread_id: string; readonly child_thread_id: string }>`
      SELECT DISTINCT thread_id, child_thread_id FROM orchestration_v2_projection_subagents
      WHERE child_thread_id IS NOT NULL
    `) {
      addParent(row.child_thread_id, row.thread_id);
    }

    const keep = new Map<string, ThreadKeepReason>();
    const keepThread = (threadId: string | null, reason: ThreadKeepReason) => {
      if (threadId !== null && !keep.has(threadId)) keep.set(threadId, reason);
    };
    for (const [threadId, thread] of facts) {
      if (!thread.settled) keepThread(threadId, "not-settled");
      else if (thread.pinned) keepThread(threadId, "pinned");
    }
    for (const threadId of options.keepThreadIds) keepThread(threadId, "keep-list");
    const keepRows = (
      rows: ReadonlyArray<{ readonly thread_id: string | null }>,
      reason: ThreadKeepReason,
    ) => {
      for (const row of rows) keepThread(row.thread_id, reason);
    };
    keepRows(
      yield* sql<{ readonly thread_id: string }>`
        SELECT DISTINCT thread_id FROM orchestration_v2_projection_runs
        WHERE status IN ${sql.in(ACTIVE_RUN_STATUSES)}
      `,
      "active-run",
    );
    // Finished effects stay in the outbox; only unfinished ones are work.
    keepRows(
      yield* sql<{ readonly thread_id: string }>`
        SELECT DISTINCT thread_id FROM orchestration_v2_effect_outbox
        WHERE status IN ('pending', 'running')
      `,
      "pending-effect",
    );
    if (yield* tableExists(sql, "scheduled_tasks")) {
      keepRows(
        yield* sql<{ readonly thread_id: string | null }>`
          SELECT DISTINCT thread_id FROM scheduled_tasks
        `,
        "scheduled-task",
      );
    }
    // A worktree is checked once, however many threads share it.
    const worktreeWork = new Map<string, boolean>();
    for (const [threadId, thread] of facts) {
      if (keep.has(threadId) || thread.worktreePath === null) continue;
      let hasWork = worktreeWork.get(thread.worktreePath);
      if (hasWork === undefined) {
        hasWork = worktreeHasWork(thread.worktreePath);
        worktreeWork.set(thread.worktreePath, hasWork);
      }
      if (hasWork) keepThread(threadId, "worktree-work");
    }
    // Keep the ancestors of every kept thread, so its tree stays reachable.
    const pending = [...keep.keys()];
    while (pending.length > 0) {
      const threadId = pending.pop()!;
      for (const parent of parentsOf.get(threadId) ?? []) {
        if (!keep.has(parent)) {
          keep.set(parent, "kept-descendant");
          pending.push(parent);
        }
      }
    }
    const purge = [...facts]
      .filter(([threadId]) => !keep.has(threadId))
      .map(([threadId, thread]) => ({
        threadId,
        title: thread.title,
        settledAt: thread.settledAt,
        worktreePath: thread.worktreePath,
      }))
      .toSorted((left, right) => left.threadId.localeCompare(right.threadId));
    const keptByReason: Partial<Record<ThreadKeepReason, number>> = {};
    let keptSettled = 0;
    for (const [threadId, thread] of facts) {
      const reason = keep.get(threadId);
      if (reason === undefined) continue;
      keptByReason[reason] = (keptByReason[reason] ?? 0) + 1;
      if (thread.settled) keptSettled += 1;
    }
    return {
      purge,
      kept: facts.size - purge.length,
      keptSettled,
      keptByReason,
    } satisfies ThreadPurgeSelection;
  });

/** Every table keyed by thread_id, found from the schema so new tables are covered. */
const threadTables = (sql: SqlClient.SqlClient) =>
  sql<{ readonly name: string }>`
    SELECT m.name FROM sqlite_master m, pragma_table_info(m.name) c
    WHERE m.type = 'table' AND c.name = 'thread_id'
    ORDER BY m.name
  `.pipe(
    Effect.map((rows) =>
      rows.map((row) => row.name).filter((name) => !SPECIAL_THREAD_TABLES.has(name)),
    ),
  );

const PURGE_CHUNK = 200;

/** Deletes every row of the given threads, in one transaction. */
export const purgeThreadChunk = (
  sql: SqlClient.SqlClient,
  threadIds: ReadonlyArray<string>,
  tables: ReadonlyArray<string>,
) =>
  sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`CREATE TEMP TABLE IF NOT EXISTS thread_purge_ids (thread_id TEXT PRIMARY KEY)`;
      yield* sql`DELETE FROM thread_purge_ids`;
      for (const threadId of threadIds) {
        yield* sql`INSERT OR IGNORE INTO thread_purge_ids (thread_id) VALUES (${threadId})`;
      }
      for (const table of tables) {
        yield* sql.unsafe(
          `DELETE FROM "${table}" WHERE thread_id IN (SELECT thread_id FROM thread_purge_ids)`,
        );
      }
      // Transfers belong to the thread that receives them; one a purged thread
      // sent stays in the receiving thread's history.
      yield* sql`
        DELETE FROM orchestration_v2_projection_context_transfers
        WHERE target_thread_id IN (SELECT thread_id FROM thread_purge_ids)
      `;
      // The event log, V2 and imported V1 events alike, and V1 command receipts.
      yield* sql`
        DELETE FROM orchestration_events
        WHERE aggregate_kind = 'thread' AND stream_id IN (SELECT thread_id FROM thread_purge_ids)
      `;
      yield* sql`
        DELETE FROM orchestration_command_receipts
        WHERE aggregate_kind = 'thread' AND aggregate_id IN (SELECT thread_id FROM thread_purge_ids)
      `;
      yield* sql`DELETE FROM thread_purge_ids`;
    }),
  );

/** Provider sessions no remaining thread owns or binds. */
const pruneProviderSessions = (sql: SqlClient.SqlClient) =>
  sql`
    DELETE FROM orchestration_v2_projection_provider_sessions
    WHERE COALESCE(thread_id, '') NOT IN (SELECT thread_id FROM orchestration_v2_projection_threads)
      AND provider_session_id NOT IN (
        SELECT provider_session_id FROM orchestration_v2_projection_provider_session_bindings
      )
  `;

/** Stored tool outputs no remaining turn item or event references. */
export const pruneToolOutputs = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    if (!(yield* tableExists(sql, "tool_outputs"))) return 0;
    const rows = yield* sql<{ readonly removed: number }>`
      DELETE FROM tool_outputs WHERE output_id NOT IN (
        SELECT json_extract(payload_json, '$.outputRef.id')
        FROM orchestration_v2_projection_turn_items
        WHERE type IN ('command_execution', 'dynamic_tool')
          AND json_extract(payload_json, '$.outputRef.id') IS NOT NULL
        UNION
        SELECT json_extract(payload_json, '$.outputRef.id')
        FROM orchestration_events
        WHERE event_type = 'turn-item.updated'
          AND json_extract(payload_json, '$.outputRef.id') IS NOT NULL
      )
      RETURNING 1 AS removed
    `;
    return rows.length;
  });

export interface ThreadPurgeResult {
  readonly purgedThreads: number;
  readonly prunedToolOutputs: number;
  readonly purgeSeconds: number;
}

/** Deletes the planned threads, then what only they referenced. */
export const purgeThreads = (sql: SqlClient.SqlClient, threadIds: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const started = yield* Clock.currentTimeMillis;
    const tables = yield* threadTables(sql);
    for (let start = 0; start < threadIds.length; start += PURGE_CHUNK) {
      yield* purgeThreadChunk(sql, threadIds.slice(start, start + PURGE_CHUNK), tables);
    }
    yield* pruneProviderSessions(sql);
    const prunedToolOutputs = yield* pruneToolOutputs(sql);
    // Planner statistics taken before the purge describe tables many times larger.
    yield* sql.unsafe("PRAGMA optimize = 0x10002");
    return {
      purgedThreads: threadIds.length,
      prunedToolOutputs,
      purgeSeconds: ((yield* Clock.currentTimeMillis) - started) / 1000,
    } satisfies ThreadPurgeResult;
  });

export interface VacuumResult {
  readonly vacuumed: boolean;
  readonly reason?: string;
  readonly bytesBefore: number;
  readonly bytesAfter: number;
  readonly vacuumSeconds: number;
}

function freeBytes(directory: string): number {
  const stats = NodeFS.statfsSync(directory);
  return stats.bavail * stats.bsize;
}

function fileBytes(path: string): number {
  return NodeFS.existsSync(path) ? NodeFS.statSync(path).size : 0;
}

/** Space VACUUM needs beyond the data it keeps: a temporary copy and the WAL it rewrites. */
export const VACUUM_MARGIN_BYTES = 1024 ** 3;

/**
 * Rebuilds the file without its free pages. VACUUM writes a temporary copy and
 * then the whole database through the WAL, so it needs about twice the kept
 * data free; without that it is skipped.
 */
export const vacuumIfRoom = (sql: SqlClient.SqlClient, dbPath: string) =>
  Effect.gen(function* () {
    const bytesBefore = fileBytes(dbPath);
    const pages = yield* sql<{ readonly page_size: number; readonly used: number }>`
      SELECT
        (SELECT page_size FROM pragma_page_size) AS page_size,
        (SELECT page_count FROM pragma_page_count) - (SELECT freelist_count FROM pragma_freelist_count)
          AS used
    `;
    const usedBytes = (pages[0]?.used ?? 0) * (pages[0]?.page_size ?? 0);
    const needed = 2 * usedBytes + VACUUM_MARGIN_BYTES;
    const available = freeBytes(NodePath.dirname(dbPath));
    if (available < needed) {
      const reason = `needs ${needed} free bytes for ${usedBytes} bytes of data, has ${available}`;
      yield* Effect.logWarning(`Skipping VACUUM: ${reason}`);
      return { vacuumed: false, reason, bytesBefore, bytesAfter: bytesBefore, vacuumSeconds: 0 };
    }
    const started = yield* Clock.currentTimeMillis;
    yield* sql.unsafe("VACUUM");
    yield* sql.unsafe("PRAGMA wal_checkpoint(TRUNCATE)");
    return {
      vacuumed: true,
      bytesBefore,
      bytesAfter: fileBytes(dbPath),
      vacuumSeconds: ((yield* Clock.currentTimeMillis) - started) / 1000,
    } satisfies VacuumResult;
  });

function readJson(path: string): Record<string, unknown> | undefined {
  if (!NodeFS.existsSync(path)) return undefined;
  const value: unknown = JSON.parse(NodeFS.readFileSync(path, "utf8"));
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} is not a JSON object`);
  }
  return value as Record<string, unknown>;
}

function writeJson(path: string, value: unknown): void {
  NodeFS.writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function stringList(value: unknown): Array<string> {
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
}

/** The keep list: the keep file's ids plus every thread with a command watch. */
export function readKeepThreadIds(
  stateDir: string,
  keepFile = NodePath.join(stateDir, THREAD_PURGE_KEEP_FILE),
): ReadonlyArray<string> | undefined {
  const keep = readJson(keepFile);
  if (keep === undefined) return undefined;
  const watches = readJson(NodePath.join(stateDir, COMMAND_WATCHES_FILE));
  const watchThreadIds = Array.isArray(watches?.watches)
    ? watches.watches.flatMap((watch: unknown) =>
        typeof watch === "object" && watch !== null && "threadId" in watch
          ? stringList([(watch as { readonly threadId: unknown }).threadId])
          : [],
      )
    : [];
  return [...stringList(keep.keepThreadIds), ...watchThreadIds];
}

/**
 * Runs a pending request. `"mode": "dry-run"` (the default) only writes the
 * plan. `"mode": "purge"` writes the same plan, then deletes, and needs the
 * request to name the database backup taken before it. `"approvedPlan"` (a
 * plan file from an earlier dry run) limits the purge to the threads it lists. Both need the keep
 * file. The request is removed once handled; an interrupted purge leaves it,
 * so the purge runs again at the next start.
 */
export const runRequestedThreadPurge = (
  sql: SqlClient.SqlClient,
  dbPath: string,
  options: { readonly worktreeHasWork?: WorktreeCheck } = {},
) =>
  Effect.gen(function* () {
    const stateDir = NodePath.dirname(dbPath);
    const requestPath = NodePath.join(stateDir, THREAD_PURGE_REQUEST_FILE);
    const request = readJson(requestPath);
    if (request === undefined) return;
    const mode = request.mode === "purge" ? "purge" : "dry-run";
    const keepThreadIds = readKeepThreadIds(stateDir);
    if (keepThreadIds === undefined) {
      yield* Effect.logWarning(`Thread purge skipped: ${THREAD_PURGE_KEEP_FILE} is missing`);
      return;
    }
    if (mode === "purge" && (typeof request.backup !== "string" || request.backup.trim() === "")) {
      yield* Effect.logWarning(`Thread purge skipped: ${requestPath} names no database backup`);
      return;
    }
    const selected = yield* selectThreadsToPurge(sql, {
      keepThreadIds,
      ...(options.worktreeHasWork === undefined
        ? {}
        : { worktreeHasWork: options.worktreeHasWork }),
    });
    // A purge limited to a reviewed plan removes only threads that plan listed
    // and that still qualify now; threads settled since stay.
    const approved =
      typeof request.approvedPlan === "string" ? readJson(request.approvedPlan) : undefined;
    if (typeof request.approvedPlan === "string" && approved === undefined) {
      yield* Effect.logWarning(`Thread purge skipped: ${request.approvedPlan} is missing`);
      return;
    }
    const approvedIds =
      approved === undefined
        ? undefined
        : new Set(
            (Array.isArray(approved.purge) ? approved.purge : []).flatMap((entry: unknown) =>
              typeof entry === "object" && entry !== null && "threadId" in entry
                ? stringList([(entry as { readonly threadId: unknown }).threadId])
                : [],
            ),
          );
    const selection =
      approvedIds === undefined
        ? selected
        : {
            ...selected,
            purge: selected.purge.filter((candidate) => approvedIds.has(candidate.threadId)),
          };
    const plannedAt = DateTime.formatIso(yield* DateTime.now);
    writeJson(NodePath.join(stateDir, THREAD_PURGE_PLAN_FILE), { plannedAt, mode, ...selection });
    yield* Effect.log(
      mode === "purge" ? "Purging settled threads" : "Thread purge dry run: would purge",
      {
        threads: selection.purge.length,
        kept: selection.kept,
        keptSettled: selection.keptSettled,
        keptByReason: selection.keptByReason,
        plan: THREAD_PURGE_PLAN_FILE,
      },
    );
    let purge: ThreadPurgeResult | undefined;
    let vacuum: VacuumResult | undefined;
    if (mode === "purge") {
      purge = yield* purgeThreads(
        sql,
        selection.purge.map((candidate) => candidate.threadId),
      );
      yield* Effect.log("Purged settled threads", purge);
      if (request.vacuum !== false) {
        vacuum = yield* vacuumIfRoom(sql, dbPath).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("VACUUM failed; the purge stands", { cause }).pipe(
              Effect.as({
                vacuumed: false,
                reason: "VACUUM failed",
                bytesBefore: fileBytes(dbPath),
                bytesAfter: fileBytes(dbPath),
                vacuumSeconds: 0,
              } satisfies VacuumResult),
            ),
          ),
        );
        yield* Effect.log("Thread purge VACUUM", vacuum);
      }
    }
    writeJson(NodePath.join(stateDir, THREAD_PURGE_RESULT_FILE), {
      request,
      mode,
      completedAt: DateTime.formatIso(yield* DateTime.now),
      wouldPurge: selection.purge.length,
      notInApprovedPlan: selected.purge.length - selection.purge.length,
      kept: selection.kept,
      keptSettled: selection.keptSettled,
      keptByReason: selection.keptByReason,
      ...(purge === undefined ? {} : { purge }),
      ...(vacuum === undefined ? {} : { vacuum }),
    });
    NodeFS.rmSync(requestPath, { force: true });
  });

/** Runs a requested purge in the server process, before anything else uses the database. */
export const startupThreadPurgeLayer = (dbPath: string) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      if (!(yield* StartupThreadPurge)) return;
      const sql = yield* SqlClientService.SqlClient;
      yield* runRequestedThreadPurge(sql, dbPath);
    }),
  );
