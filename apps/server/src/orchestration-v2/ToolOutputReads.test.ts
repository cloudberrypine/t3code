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
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as EventStore from "./EventStore.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import {
  projectDomainEventForWire,
  projectThreadProjectionForWire,
  projectTurnItemForDetail,
  projectTurnItemForWire,
} from "./WireProjection.ts";

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
const threadId = ThreadId.make("thread:tool-output-reads");
// Only the middle of each output carries this, so a preview never shows it.
const MIDDLE = "FULL_OUTPUT_ONLY_MARKER";
const commandOutput = `${"head\n".repeat(1_000)}${MIDDLE}\nexit code: 2\n${"tail\n".repeat(1_000)}`;
const dynamicOutput = {
  threadId: "thread:created-by-tool",
  log: `${"a".repeat(6_000)}${MIDDLE}${"b".repeat(6_000)}`,
};

function makeThread(now: DateTime.Utc): OrchestrationV2AppThread {
  return {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId: ProjectId.make("project:tool-output-reads"),
    title: "Tool output reads",
    providerInstanceId,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
}

function toolItems(now: DateTime.Utc) {
  const base = {
    threadId,
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    status: "completed" as const,
    title: null,
    startedAt: now,
    completedAt: now,
    updatedAt: now,
  };
  const command: OrchestrationV2TurnItem = {
    ...base,
    id: TurnItemId.make("item:command"),
    ordinal: 1,
    type: "command_execution",
    input: "vp test run",
    output: commandOutput,
    exitCode: 0,
  };
  const dynamic: OrchestrationV2TurnItem = {
    ...base,
    id: TurnItemId.make("item:dynamic"),
    ordinal: 2,
    type: "dynamic_tool",
    toolName: "mcp__t3__thread_read",
    input: { threadId: "x" },
    output: dynamicOutput,
  };
  return { command, dynamic };
}

const seed = Effect.gen(function* () {
  const eventStore = yield* EventStore.EventStoreV2;
  const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
  const now = yield* DateTime.now;
  const { command, dynamic } = toolItems(now);
  const events: Array<OrchestrationV2DomainEvent> = [
    {
      id: EventId.make("event:thread"),
      type: "thread.created",
      threadId,
      occurredAt: now,
      payload: makeThread(now),
    },
    ...[command, dynamic, command].map((payload, index): OrchestrationV2DomainEvent => ({
      id: EventId.make(`event:item:${index}`),
      type: "turn-item.updated",
      threadId,
      occurredAt: now,
      payload,
    })),
  ];
  // As the event sink does: append, then project what was committed.
  const stored = yield* eventStore.append({ events });
  for (const event of stored) yield* projectionStore.apply(event.event);
  return { stored, command, dynamic };
});

const containsFullOutput = (value: unknown) => JSON.stringify(value).includes(MIDDLE);

describe("stored tool output", () => {
  it.effect("keeps one copy and previews in rows, events and window reads", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const eventStore = yield* EventStore.EventStoreV2;
      const { stored, command, dynamic } = yield* seed;

      // Subscribers still get the events as decided.
      assert.isTrue(containsFullOutput(stored.map((event) => event.event)));

      const rows = yield* sql<{ payload_json: string }>`
        SELECT payload_json FROM orchestration_v2_projection_turn_items
        UNION ALL
        SELECT payload_json FROM orchestration_events WHERE event_type = 'turn-item.updated'
      `;
      assert.strictEqual(rows.length, 5);
      for (const row of rows) {
        assert.notInclude(row.payload_json, MIDDLE);
        assert.include(row.payload_json, '"outputRef"');
      }
      const outputs = yield* sql<{ count: number }>`SELECT COUNT(*) AS count FROM tool_outputs`;
      assert.strictEqual(outputs[0]?.count, 2);

      const snapshot = yield* projectionStore.getThreadSnapshot(threadId);
      const window = yield* projectionStore.getThreadSnapshotWindow(threadId, { rowLimit: 50 });
      const shell = yield* projectionStore.getThreadShell(threadId);
      const shells = yield* projectionStore.getShellSnapshot();
      const projection = yield* projectionStore.getThreadProjection(threadId);
      for (const read of [snapshot, window, shell, shells, projection]) {
        assert.isFalse(containsFullOutput(read));
      }
      const windowCommand = window.projection.turnItems.find((item) => item.id === command.id);
      assert.strictEqual(windowCommand?.type, "command_execution");
      assert.isDefined(windowCommand?.type === "command_execution" && windowCommand.outputRef);

      // Clients get the same items they got when rows held the full output.
      const wire = projectThreadProjectionForWire(window.projection);
      assert.deepStrictEqual(wire.turnItems, [
        projectTurnItemForWire(command),
        projectTurnItemForWire(dynamic),
      ]);
      assert.deepInclude(wire.turnItems[0], { outputOmitted: true, outputIndicatesFailure: true });
      assert.deepInclude(wire.turnItems[1], {
        outputOmitted: true,
        output: { threadId: "thread:created-by-tool" },
      });

      const persisted = yield* Stream.runCollect(eventStore.read({ threadId }));
      const wireEvents = Array.from(persisted, (event) => projectDomainEventForWire(event.event));
      assert.isFalse(containsFullOutput(wireEvents));
      assert.notInclude(JSON.stringify(wireEvents), "outputRef");
    }).pipe(Effect.provide(stores)),
  );

  it.effect("restores the full output for detail, record and timeline reads", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const { command, dynamic } = yield* seed;

      const detail = yield* projectionStore.getTurnItem({ threadId, itemId: command.id });
      assert.deepStrictEqual(detail, command);
      assert.deepStrictEqual(
        yield* projectionStore.getTurnItem({ threadId, itemId: dynamic.id }),
        dynamic,
      );
      assert.deepStrictEqual(projectTurnItemForDetail(detail!), {
        ...command,
        output: commandOutput,
      });

      const records = yield* projectionStore.getThreadRecords(threadId, ["turnItems"]);
      assert.deepStrictEqual(records.turnItems, [command, dynamic]);
      assert.deepStrictEqual(yield* projectionStore.getTurnStartHistory(threadId), [command]);

      const page = yield* projectionStore.getTimelinePage(threadId, {
        view: "activity",
        limit: 10,
      });
      assert.deepStrictEqual(
        page.items.map((row) => row.item),
        [command, dynamic],
      );
    }).pipe(Effect.provide(stores)),
  );
});
