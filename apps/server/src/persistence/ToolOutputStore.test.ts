import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "./Layers/Sqlite.ts";
import {
  TOOL_OUTPUT_INLINE_CHARS,
  TOOL_OUTPUT_PREVIEW_HEAD_CHARS,
  TOOL_OUTPUT_PREVIEW_TAIL_CHARS,
  backfillToolOutputs,
  externalizePayloadJson,
  restorePayloadJson,
} from "./ToolOutputStore.ts";

// Outputs with multi-byte text and a surrogate pair across the preview cuts.
const bigCommandOutput = (seed: string) =>
  `${"é".repeat(TOOL_OUTPUT_PREVIEW_HEAD_CHARS - 1)}😀${seed} ${"line of output\n".repeat(900)}😀${"ü".repeat(TOOL_OUTPUT_PREVIEW_TAIL_CHARS - 1)}`;

const commandPayload = (id: string, output: string | undefined) =>
  JSON.stringify({
    id,
    threadId: "thread-1",
    type: "command_execution",
    status: "completed",
    input: "ls",
    ...(output === undefined ? {} : { output }),
    exitCode: 0,
  });

const dynamicPayload = (id: string, output: unknown) =>
  JSON.stringify({
    id,
    threadId: "thread-1",
    type: "dynamic_tool",
    status: "completed",
    toolName: "mcp__t3__read",
    input: { q: 1 },
    output,
  });

describe("tool output payload rewriting", () => {
  it("restores command output byte for byte", () => {
    const original = commandPayload("item-1", bigCommandOutput("a"));
    const stored = externalizePayloadJson(original);
    assert.isDefined(stored);
    assert.isBelow(stored!.payload.length, 2 * TOOL_OUTPUT_INLINE_CHARS);
    // Neither preview cut leaves half of a surrogate pair.
    assert.notMatch(stored!.payload, /\\ud83d|\\ude00/u);
    assert.strictEqual(restorePayloadJson(stored!.payload, stored!.stored.json), original);
  });

  it("restores dynamic tool output byte for byte and keeps its compact form", () => {
    const original = dynamicPayload("item-2", {
      content: [{ type: "text", text: "x".repeat(20_000) }],
      isError: true,
    });
    const stored = externalizePayloadJson(original);
    assert.isDefined(stored);
    const record = JSON.parse(stored!.payload);
    assert.deepStrictEqual(record.output, { isError: true });
    assert.strictEqual(record.outputRef.bytes, Buffer.byteLength(stored!.stored.json));
    assert.strictEqual(restorePayloadJson(stored!.payload, stored!.stored.json), original);
  });

  it("leaves small, stored and non-canonical payloads alone", () => {
    assert.isUndefined(externalizePayloadJson(commandPayload("small", "ok")));
    assert.isUndefined(
      externalizePayloadJson(commandPayload("edge", "x".repeat(TOOL_OUTPUT_INLINE_CHARS))),
    );
    const stored = externalizePayloadJson(commandPayload("big", bigCommandOutput("b")));
    assert.isUndefined(externalizePayloadJson(stored!.payload));
    const spaced = commandPayload("spaced", bigCommandOutput("c")).replace('{"id"', '{ "id"');
    assert.isUndefined(externalizePayloadJson(spaced));
  });
});

const insertRows = (rows: ReadonlyArray<{ id: string; payload: string; type: string }>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    let ordinal = 0;
    for (const row of rows) {
      ordinal += 1;
      yield* sql`
        INSERT INTO orchestration_v2_projection_turn_items (
          turn_item_id, thread_id, ordinal, type, status, updated_at, payload_json
        ) VALUES (${row.id}, 'thread-1', ${ordinal}, ${row.type}, 'completed', '2026-11-03', ${row.payload})
      `;
      yield* sql`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
          actor_kind, payload_json, metadata_json, application_event_version
        ) VALUES (${`event-${row.id}`}, 'thread', 'thread-1', ${ordinal}, 'turn-item.updated',
          '2026-11-03', 'provider', ${row.payload}, '{}', 2)
      `;
    }
  });

const readPayloads = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const items = yield* sql<{ id: string; payload_json: string }>`
    SELECT turn_item_id AS id, payload_json FROM orchestration_v2_projection_turn_items
    ORDER BY ordinal
  `;
  const events = yield* sql<{ id: string; payload_json: string }>`
    SELECT event_id AS id, payload_json FROM orchestration_events
    WHERE event_type = 'turn-item.updated' ORDER BY sequence
  `;
  return [...items, ...events];
});

// Every row, with stored outputs put back, as it was before the backfill.
const restoredPayloads = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* readPayloads;
  const texts = new Map(
    (yield* sql<{ output_id: string; output_json: string }>`
      SELECT output_id, output_json FROM tool_outputs
    `).map((row) => [row.output_id, row.output_json]),
  );
  return rows.map((row) => {
    const id = JSON.parse(row.payload_json).outputRef?.id;
    return id === undefined
      ? row.payload_json
      : restorePayloadJson(row.payload_json, texts.get(id)!);
  });
});

const fixtureRows = [
  { id: "a", type: "command_execution", payload: commandPayload("a", bigCommandOutput("a")) },
  { id: "b", type: "command_execution", payload: commandPayload("b", "short") },
  { id: "c", type: "dynamic_tool", payload: dynamicPayload("c", { text: "y".repeat(9_000) }) },
  { id: "d", type: "command_execution", payload: commandPayload("d", bigCommandOutput("a")) },
  { id: "e", type: "user_message", payload: JSON.stringify({ id: "e", text: "z".repeat(9_000) }) },
  { id: "f", type: "command_execution", payload: commandPayload("f", bigCommandOutput("f")) },
  // NULs and a lone surrogate, which raw SQLite text would cut or replace.
  {
    id: "g",
    type: "command_execution",
    payload: commandPayload("g", `${"\u0000".repeat(5_000)}\ud800${"k".repeat(5_000)}`),
  },
];

describe("tool output backfill", () => {
  it.effect("moves bulky output, preserves content and is idempotent", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* insertRows(fixtureRows);
      const before = (yield* readPayloads).map((row) => row.payload_json);

      const first = yield* backfillToolOutputs(sql, { pause: 0 });
      assert.isTrue(first.complete);
      // a, c, d, f and g in both the projection and the event log.
      assert.strictEqual(first.rewritten, 10);
      const after = yield* readPayloads;
      // Previews are a few kilobytes (escaped control characters take six bytes each).
      for (const row of after.filter((row) => row.payload_json.includes('"outputRef"'))) {
        assert.isBelow(row.payload_json.length, 2 * TOOL_OUTPUT_INLINE_CHARS, row.id);
      }
      // Identical outputs share one stored copy.
      const stored = yield* sql<{ count: number }>`SELECT COUNT(*) AS count FROM tool_outputs`;
      assert.strictEqual(stored[0]?.count, 4);
      assert.deepStrictEqual(yield* restoredPayloads, before);

      yield* sql`DELETE FROM tool_output_backfill`;
      const second = yield* backfillToolOutputs(sql, { pause: 0 });
      assert.strictEqual(second.rewritten, 0);
      assert.deepStrictEqual(
        (yield* readPayloads).map((row) => row.payload_json),
        after.map((row) => row.payload_json),
      );
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  it.effect("resumes from its recorded progress", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* insertRows(fixtureRows);
      const before = (yield* readPayloads).map((row) => row.payload_json);

      const partial = yield* backfillToolOutputs(sql, { batchRows: 1, pause: 0, maxBatches: 3 });
      assert.isFalse(partial.complete);
      assert.strictEqual(partial.rewritten, 3);
      const progress = yield* sql<{ source: string; last_cursor: number; completed_at: null }>`
        SELECT source, last_cursor, completed_at FROM tool_output_backfill
      `;
      assert.deepStrictEqual(progress, [
        { source: "turn_items", last_cursor: 4, completed_at: null },
      ]);

      // Rows written since are already stored and are skipped.
      let rest = 0;
      while (true) {
        const next = yield* backfillToolOutputs(sql, { batchRows: 1, pause: 0, maxBatches: 2 });
        rest += next.rewritten;
        if (next.complete) break;
      }
      assert.strictEqual(rest, 7);
      assert.deepStrictEqual(yield* restoredPayloads, before);
      const done = yield* sql<{ completed: number }>`
        SELECT COUNT(*) AS completed FROM tool_output_backfill WHERE completed_at IS NOT NULL
      `;
      assert.strictEqual(done[0]?.completed, 2);
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );
});
