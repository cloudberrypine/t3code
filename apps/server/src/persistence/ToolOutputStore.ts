// @effect-diagnostics nodeBuiltinImport:off - hashing needs node:crypto.
/**
 * Bulky tool output is stored once in `tool_outputs`, as JSON keyed by its
 * SHA-256. Turn item rows and turn-item events keep a preview in `output` and
 * an `outputRef`, so the event log and the projection share one copy and
 * thread reads skip the full text. Reads that show or forward the output
 * (detail reads, handoff history, agent thread reads) restore it.
 *
 * Content is never dropped: rows are only rewritten to a preview after their
 * full text is stored, and only when restoring reproduces the row exactly.
 */
import * as NodeCrypto from "node:crypto";

import type { OrchestrationV2ToolOutputRef, OrchestrationV2TurnItem } from "@t3tools/contracts";
import { compactDynamicToolOutput, toolOutputIndicatesFailure } from "@t3tools/shared/toolOutput";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

/** Output up to this many UTF-16 code units stays inline in the item. */
export const TOOL_OUTPUT_INLINE_CHARS = 4_096;
export const TOOL_OUTPUT_PREVIEW_HEAD_CHARS = 1_024;
export const TOOL_OUTPUT_PREVIEW_TAIL_CHARS = 512;
/** Clients judge inline command output by this prefix (see WireProjection). */
export const TOOL_OUTPUT_FAILURE_SCAN_CHARS = 32_768;
const RESTORE_CHUNK = 500;

export const ensureToolOutputSchema = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    // Not a numbered migration: fork migration ids would collide with upstream's.
    yield* sql`
      CREATE TABLE IF NOT EXISTS tool_outputs (
        output_id TEXT PRIMARY KEY,
        output_json TEXT NOT NULL
      )
    `;
    yield* sql`
      CREATE TABLE IF NOT EXISTS tool_output_backfill (
        source TEXT PRIMARY KEY,
        last_cursor INTEGER NOT NULL,
        completed_at TEXT
      )
    `;
  });

/** An output as stored: its JSON, which keeps NULs and lone surrogates intact. */
interface StoredToolOutput {
  readonly id: string;
  readonly json: string;
}

interface ToolOutputPlan<P> extends StoredToolOutput {
  readonly preview: P;
  readonly ref: OrchestrationV2ToolOutputRef;
}

function storedOutput(json: string): StoredToolOutput {
  return { id: NodeCrypto.createHash("sha256").update(json, "utf8").digest("hex"), json };
}

/** Head and tail of the output, cut on code point boundaries. */
function commandPreview(text: string): string {
  let head = text.slice(0, TOOL_OUTPUT_PREVIEW_HEAD_CHARS);
  if (/[\uD800-\uDBFF]$/u.test(head)) head = head.slice(0, -1);
  let tail = text.slice(-TOOL_OUTPUT_PREVIEW_TAIL_CHARS);
  if (/^[\uDC00-\uDFFF]/u.test(tail)) tail = tail.slice(1);
  const omitted = text.length - head.length - tail.length;
  return `${head}\n… ${omitted} more characters, full output stored separately …\n${tail}`;
}

function planCommandOutput(text: string): ToolOutputPlan<string> | undefined {
  if (text.length <= TOOL_OUTPUT_INLINE_CHARS) return undefined;
  const stored = storedOutput(JSON.stringify(text));
  const indicatesFailure = toolOutputIndicatesFailure(
    text.slice(0, TOOL_OUTPUT_FAILURE_SCAN_CHARS),
  );
  return {
    ...stored,
    preview: commandPreview(text),
    ref: {
      id: stored.id,
      bytes: Buffer.byteLength(stored.json, "utf8"),
      ...(indicatesFailure ? { indicatesFailure: true } : {}),
    },
  };
}

function planDynamicOutput(value: unknown): ToolOutputPlan<unknown> | undefined {
  if (value === undefined) return undefined;
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch {
    return undefined;
  }
  if (json === undefined || json.length <= TOOL_OUTPUT_INLINE_CHARS) return undefined;
  const stored = storedOutput(json);
  // The compact form is all the timeline derives from a dynamic tool's output.
  return {
    ...stored,
    preview: compactDynamicToolOutput(value) ?? {},
    ref: { id: stored.id, bytes: Buffer.byteLength(json, "utf8") },
  };
}

/**
 * The item as stored: a bulky output becomes a preview plus a reference, and
 * `stored` carries the full output to save. Items that already carry a reference
 * keep it; their `output` is that reference's preview.
 */
export function externalizeToolOutput(item: OrchestrationV2TurnItem): {
  readonly item: OrchestrationV2TurnItem;
  readonly stored?: StoredToolOutput;
} {
  switch (item.type) {
    case "command_execution": {
      if (item.outputRef !== undefined || item.output === undefined) return { item };
      const plan = planCommandOutput(item.output);
      return plan === undefined
        ? { item }
        : { item: { ...item, output: plan.preview, outputRef: plan.ref }, stored: plan };
    }
    case "dynamic_tool": {
      if (item.outputRef !== undefined) return { item };
      const plan = planDynamicOutput(item.output);
      return plan === undefined
        ? { item }
        : { item: { ...item, output: plan.preview, outputRef: plan.ref }, stored: plan };
    }
    default:
      return { item };
  }
}

const saveToolOutput = (sql: SqlClient.SqlClient, stored: StoredToolOutput) =>
  sql`
    INSERT INTO tool_outputs (output_id, output_json)
    VALUES (${stored.id}, ${stored.json})
    ON CONFLICT(output_id) DO NOTHING
  `;

/** Saves a bulky output and returns the item to persist in its place. */
export const storeToolOutput = (sql: SqlClient.SqlClient, item: OrchestrationV2TurnItem) => {
  const { item: storedItem, stored } = externalizeToolOutput(item);
  return stored === undefined
    ? Effect.succeed(storedItem)
    : saveToolOutput(sql, stored).pipe(Effect.as(storedItem));
};

function withOutput(item: OrchestrationV2TurnItem, json: string): OrchestrationV2TurnItem {
  const output: unknown = JSON.parse(json);
  switch (item.type) {
    case "command_execution": {
      if (typeof output !== "string") return item;
      const { outputRef: _ref, ...rest } = item;
      return { ...rest, output };
    }
    case "dynamic_tool": {
      const { outputRef: _ref, ...rest } = item;
      return { ...rest, output };
    }
    default:
      return item;
  }
}

function outputRefOf(item: OrchestrationV2TurnItem): OrchestrationV2ToolOutputRef | undefined {
  return item.type === "command_execution" || item.type === "dynamic_tool"
    ? item.outputRef
    : undefined;
}

/**
 * Restores the full output of items that reference one. An item whose output
 * is missing (a database copied without the table) keeps its preview.
 */
export const restoreToolOutputs = <T extends OrchestrationV2TurnItem>(
  sql: SqlClient.SqlClient,
  items: ReadonlyArray<T>,
) =>
  Effect.gen(function* () {
    const ids = [...new Set(items.flatMap((item) => outputRefOf(item)?.id ?? []))];
    if (ids.length === 0) return items;
    const outputs = new Map<string, string>();
    for (let start = 0; start < ids.length; start += RESTORE_CHUNK) {
      const rows = yield* sql<{ readonly output_id: string; readonly output_json: string }>`
        SELECT output_id, output_json FROM tool_outputs
        WHERE output_id IN ${sql.in(ids.slice(start, start + RESTORE_CHUNK))}
      `;
      for (const row of rows) outputs.set(row.output_id, row.output_json);
    }
    return items.map((item) => {
      const id = outputRefOf(item)?.id;
      const json = id === undefined ? undefined : outputs.get(id);
      // withOutput keeps the item's variant, so the element type is unchanged.
      return json === undefined ? item : (withOutput(item, json) as T);
    });
  });

// ---------------------------------------------------------------------------
// Backfill of rows written before the store existed.

/**
 * The stored form of one turn item JSON payload, or undefined to leave the row
 * as it is. Rows are rewritten only when restoring the output reproduces the
 * original JSON byte for byte.
 */
export function externalizePayloadJson(
  json: string,
): { readonly payload: string; readonly stored: StoredToolOutput } | undefined {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.outputRef !== undefined) return undefined;
  const plan =
    record.type === "command_execution" && typeof record.output === "string"
      ? planCommandOutput(record.output)
      : record.type === "dynamic_tool"
        ? planDynamicOutput(record.output)
        : undefined;
  if (plan === undefined || JSON.stringify(record) !== json) return undefined;
  const payload = JSON.stringify({ ...record, output: plan.preview, outputRef: plan.ref });
  return restorePayloadJson(payload, plan.json) === json
    ? { payload, stored: { id: plan.id, json: plan.json } }
    : undefined;
}

/** Inverse of externalizePayloadJson, given the stored output JSON. */
export function restorePayloadJson(payload: string, outputJson: string): string {
  const { outputRef: _ref, ...rest } = JSON.parse(payload) as Record<string, unknown>;
  return JSON.stringify({ ...rest, output: JSON.parse(outputJson) });
}

interface BackfillSource {
  readonly name: string;
  /** Candidates in (after, through], with their payload sizes, in cursor order. */
  readonly candidates: (
    sql: SqlClient.SqlClient,
    after: number,
    through: number,
    limit: number,
  ) => Effect.Effect<ReadonlyArray<{ readonly cursor: number; readonly bytes: number }>, SqlError>;
  readonly payload: (
    sql: SqlClient.SqlClient,
    cursor: number,
  ) => Effect.Effect<ReadonlyArray<{ readonly payload_json: string }>, SqlError>;
  readonly update: (
    sql: SqlClient.SqlClient,
    cursor: number,
    before: string,
    after: string,
  ) => Effect.Effect<unknown, SqlError>;
  readonly maxCursor: (
    sql: SqlClient.SqlClient,
  ) => Effect.Effect<ReadonlyArray<{ readonly max: number | null }>, SqlError>;
}

// Any output over the inline limit makes its payload larger than that in bytes,
// so the size filter never skips a candidate. The type columns come before the
// payload, so rows that are not candidates are skipped without reading it.
const BACKFILL_SOURCES: ReadonlyArray<BackfillSource> = [
  {
    name: "turn_items",
    candidates: (sql, after, through, limit) => sql`
      SELECT rowid AS cursor, octet_length(payload_json) AS bytes
      FROM orchestration_v2_projection_turn_items
      WHERE rowid > ${after} AND rowid <= ${through}
        AND type IN ('command_execution', 'dynamic_tool')
        AND octet_length(payload_json) > ${TOOL_OUTPUT_INLINE_CHARS}
      ORDER BY rowid
      LIMIT ${limit}
    `,
    payload: (sql, cursor) => sql`
      SELECT payload_json FROM orchestration_v2_projection_turn_items WHERE rowid = ${cursor}
    `,
    update: (sql, cursor, before, after) => sql`
      UPDATE orchestration_v2_projection_turn_items SET payload_json = ${after}
      WHERE rowid = ${cursor} AND payload_json = ${before}
    `,
    maxCursor: (sql) => sql`SELECT MAX(rowid) AS max FROM orchestration_v2_projection_turn_items`,
  },
  {
    name: "events",
    candidates: (sql, after, through, limit) => sql`
      SELECT sequence AS cursor, octet_length(payload_json) AS bytes
      FROM orchestration_events
      WHERE sequence > ${after} AND sequence <= ${through}
        AND event_type = 'turn-item.updated'
        AND octet_length(payload_json) > ${TOOL_OUTPUT_INLINE_CHARS}
      ORDER BY sequence
      LIMIT ${limit}
    `,
    payload: (sql, cursor) => sql`
      SELECT payload_json FROM orchestration_events WHERE sequence = ${cursor}
    `,
    update: (sql, cursor, before, after) => sql`
      UPDATE orchestration_events SET payload_json = ${after}
      WHERE sequence = ${cursor} AND payload_json = ${before}
    `,
    maxCursor: (sql) => sql`SELECT MAX(sequence) AS max FROM orchestration_events`,
  },
];

export interface ToolOutputBackfillOptions {
  /** Most candidate rows per transaction. */
  readonly batchRows?: number;
  /** Payload bytes after which a transaction stops taking rows (it takes at least one). */
  readonly batchBytes?: number;
  /** Cursor range one transaction scans. */
  readonly scanWindow?: number;
  /** Pause between transactions, so other work gets the database. */
  readonly pause?: Duration.Input;
  /** Stop after this many transactions (tests and measurement). */
  readonly maxBatches?: number;
}

export interface ToolOutputBackfillResult {
  readonly batches: number;
  readonly rewritten: number;
  readonly complete: boolean;
}

/**
 * Moves bulky outputs of rows written before the store existed into
 * `tool_outputs`, in short transactions that each record their progress, so
 * the work resumes where it stopped after a restart. Rows written by this
 * build already hold references and are skipped.
 */
export const backfillToolOutputs = (
  sql: SqlClient.SqlClient,
  options: ToolOutputBackfillOptions = {},
) =>
  Effect.gen(function* () {
    const batchRows = options.batchRows ?? 32;
    const batchBytes = options.batchBytes ?? 2 * 1024 * 1024;
    const scanWindow = options.scanWindow ?? 5_000;
    const pause = options.pause ?? Duration.millis(25);
    let batches = 0;
    let rewritten = 0;
    for (const source of BACKFILL_SOURCES) {
      const state = yield* sql<{
        readonly last_cursor: number;
        readonly completed_at: string | null;
      }>`
        SELECT last_cursor, completed_at FROM tool_output_backfill WHERE source = ${source.name}
      `;
      if (state[0]?.completed_at != null) continue;
      while (true) {
        if (options.maxBatches !== undefined && batches >= options.maxBatches) {
          return { batches, rewritten, complete: false } satisfies ToolOutputBackfillResult;
        }
        const done = yield* sql.withTransaction(
          Effect.gen(function* () {
            const progress = yield* sql<{ readonly last_cursor: number }>`
              SELECT last_cursor FROM tool_output_backfill WHERE source = ${source.name}
            `;
            const after = progress[0]?.last_cursor ?? 0;
            const max = (yield* source.maxCursor(sql))[0]?.max ?? 0;
            const through = Math.min(max, after + scanWindow);
            const candidates = yield* source.candidates(sql, after, through, batchRows);
            let next = candidates.length === batchRows ? candidates.at(-1)!.cursor : through;
            let bytes = 0;
            for (const candidate of candidates) {
              if (bytes > 0 && bytes + candidate.bytes > batchBytes) {
                next = candidate.cursor - 1;
                break;
              }
              bytes += candidate.bytes;
              const row = (yield* source.payload(sql, candidate.cursor))[0];
              const rewrite =
                row === undefined ? undefined : externalizePayloadJson(row.payload_json);
              if (row === undefined || rewrite === undefined) continue;
              yield* saveToolOutput(sql, rewrite.stored);
              // Rewrite the row only once its full output reads back complete.
              const saved = yield* sql<{ readonly bytes: number }>`
                SELECT octet_length(output_json) AS bytes FROM tool_outputs
                WHERE output_id = ${rewrite.stored.id}
              `;
              if (saved[0]?.bytes !== Buffer.byteLength(rewrite.stored.json, "utf8")) continue;
              yield* source.update(sql, candidate.cursor, row.payload_json, rewrite.payload);
              rewritten += 1;
            }
            const complete = next >= max;
            const now = DateTime.formatIso(yield* DateTime.now);
            yield* sql`
              INSERT INTO tool_output_backfill (source, last_cursor, completed_at)
              VALUES (${source.name}, ${next}, ${complete ? now : null})
              ON CONFLICT(source) DO UPDATE SET
                last_cursor = excluded.last_cursor,
                completed_at = excluded.completed_at
            `;
            return complete;
          }),
        );
        batches += 1;
        if (done) break;
        yield* Effect.sleep(pause);
      }
    }
    return { batches, rewritten, complete: true } satisfies ToolOutputBackfillResult;
  });

/** The server's background backfill. A failed pass (a busy database) retries later. */
export const runToolOutputBackfill = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const result = yield* backfillToolOutputs(sql);
  if (result.rewritten > 0) {
    yield* Effect.log("Moved bulky tool output into the tool output store", result);
  }
}).pipe(
  Effect.retry({ times: 5, schedule: Schedule.spaced("1 minute") }),
  Effect.catchCause((cause) => Effect.logWarning("Tool output backfill stopped", { cause })),
);
