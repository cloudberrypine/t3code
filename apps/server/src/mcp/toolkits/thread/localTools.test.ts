// Fork: the local thread tools (attention flags, settle after run, sidebar nesting) through the
// production registration. The orchestrator's handling of their commands is in runtimeLayer.test.ts
// and the settle-after-run rules in settleAfterRun/.
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { McpSchema, McpServer } from "effect/ai";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as PeerForwarding from "../../../peer/PeerForwarding.ts";
import * as PeerLinkRequests from "../../../peer/PeerLinkRequests.ts";
import * as PeerLinks from "../../../peer/PeerLinks.ts";
import * as ThreadSearch from "../../../orchestration-v2/ThreadSearch.ts";
import * as ScheduledTaskService from "../../../scheduledTasks/ScheduledTaskService.ts";
import * as SettleAfterRun from "../../../settleAfterRun/SettleAfterRunService.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccessTestkit from "../../McpToolAccess.testkit.ts";

const threadId = ThreadId.make("local-tools-thread");
const parentThreadId = ThreadId.make("local-tools-parent");
const scope: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("local-tools-environment"),
  requestNamespace: "local-tools-session",
  thread: {
    threadId,
    providerSessionId: "local-tools-session",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  issuedAt: 0,
  capabilities: new Set(["orchestration"]),
};
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "local-tools", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "local-tools", version: "1" },
  },
  getClient: Effect.die("unused"),
});

const harness = () => {
  const dispatched: Array<Record<string, unknown>> = [];
  const settleCalls: Array<unknown> = [];
  const layer = McpHttpServer.layerThreadToolkit.pipe(
    Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
    Layer.provide(Layer.mock(ThreadSearch.ThreadSearch)({})),
    Layer.provide(Layer.mock(ScheduledTaskService.ScheduledTaskService)({})),
    Layer.provide(Layer.mock(PeerForwarding.PeerForwarding)({})),
    Layer.provide(Layer.mock(PeerLinkRequests.PeerLinkRequests)({})),
    Layer.provide(Layer.mock(PeerLinks.PeerLinks)({})),
    Layer.provide(NodeCrypto.layer),
    Layer.provide(
      Layer.mock(SettleAfterRun.SettleAfterRunService)({
        request: (input) => {
          settleCalls.push(input);
          return Effect.succeed({ settleAfterRun: "pending", waitingFor: "the current run" });
        },
        cancel: (id) => {
          settleCalls.push({ cancel: id });
          return Effect.succeed({ settleAfterRun: "cancelled" });
        },
      }),
    ),
    Layer.provide(
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: (id) => Effect.succeed(McpToolAccessTestkit.liveThreadShell(id)),
        getProjectThreadRecords: ({ threadId: id }) =>
          Effect.succeed(
            McpToolAccessTestkit.idleThreadProjection(McpToolAccessTestkit.liveThreadShell(id)),
          ),
        dispatch: (command) => {
          dispatched.push(command as unknown as Record<string, unknown>);
          return Effect.succeed({ sequence: dispatched.length } as never);
        },
      }),
    ),
  );
  const call = (name: string, args: Record<string, unknown>) =>
    McpServer.McpServer.pipe(
      Effect.flatMap((server) => server.callTool({ name, arguments: args })),
      Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
      Effect.provideService(McpSchema.McpServerClient, client),
    );
  return { dispatched, settleCalls, layer, call };
};

const declaredFailure = (result: McpSchema.CallToolResult) => {
  const text = result.content[0];
  return result.isError === true && text?.type === "text" ? JSON.parse(text.text) : undefined;
};

it.effect("t3_thread_flag raises and clears the calling thread's flag", () => {
  const { dispatched, layer, call } = harness();
  return Effect.gen(function* () {
    const raised = yield* call("t3_thread_flag", { reason: "Please test" });
    expect(raised.structuredContent).toHaveProperty("sequence");
    yield* call("t3_thread_flag", { clear: true });
    const neither = yield* call("t3_thread_flag", {});
    expect(declaredFailure(neither)).toMatchObject({ code: "invalid_request" });
    const both = yield* call("t3_thread_flag", { reason: "x", clear: true });
    expect(declaredFailure(both)).toMatchObject({ code: "invalid_request" });
    expect(dispatched).toEqual([
      expect.objectContaining({ type: "thread.attention.raise", threadId, reason: "Please test" }),
      expect.objectContaining({ type: "thread.attention.clear", threadId }),
    ]);
  }).pipe(Effect.provide(layer));
});

it.effect("t3_thread_organize records and cancels a settle-after-run request", () => {
  const { dispatched, settleCalls, layer, call } = harness();
  return Effect.gen(function* () {
    const requested = yield* call("t3_thread_organize", { action: "settle_after_run" });
    expect(requested.structuredContent).toEqual({
      settleAfterRun: "pending",
      waitingFor: "the current run",
    });
    const cancelled = yield* call("t3_thread_organize", { action: "cancel_settle_after_run" });
    expect(cancelled.structuredContent).toEqual({ settleAfterRun: "cancelled" });
    expect(settleCalls).toEqual([
      { threadId, requestedByThreadId: threadId },
      { cancel: threadId },
    ]);
    expect(dispatched).toEqual([]);
  }).pipe(Effect.provide(layer));
});

it.effect("t3_thread_organize nests a thread under another and back", () => {
  const { dispatched, layer, call } = harness();
  return Effect.gen(function* () {
    const missing = yield* call("t3_thread_organize", { action: "nest" });
    expect(declaredFailure(missing)).toMatchObject({ code: "invalid_request" });
    yield* call("t3_thread_organize", { action: "nest", parentThreadId });
    yield* call("t3_thread_organize", { action: "unnest" });
    expect(dispatched).toEqual([
      expect.objectContaining({
        type: "thread.sidebar-parent.set",
        threadId,
        sidebarParentThreadId: parentThreadId,
      }),
      expect.objectContaining({
        type: "thread.sidebar-parent.set",
        threadId,
        sidebarParentThreadId: null,
      }),
    ]);
  }).pipe(Effect.provide(layer));
});
