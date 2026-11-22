import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as CommandWatchService from "../../../commandWatch/CommandWatchService.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { readCaller, unavailable } from "../../threadAccess.ts";
import { CommandWatchesToolkit } from "./tools.ts";

const callerThread = Effect.fn("mcp.commandWatches.callerThread")(function* () {
  const context = yield* readCaller();
  if (context.caller === undefined)
    return yield* new OrchestratorMcpFailure({
      code: "target_required",
      message: "Command watches belong to a T3 thread; this MCP client is not running inside one.",
    });
  return context.caller;
});

/** Starting or stopping a watch runs commands as the server, so it needs a full-access/default caller, like t3_thread_launch. */
const watchingCaller = Effect.fn("mcp.commandWatches.watchingCaller")(function* () {
  const caller = yield* callerThread();
  if (caller.runtimeMode !== "full-access" || caller.interactionMode !== "default")
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message: "Command watches require a live full-access/default thread.",
    });
  return caller;
});

const invalid = (error: { readonly message: string }) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message: error.message });

export const layer = McpToolAccess.toLayer(CommandWatchesToolkit, {
  watch_command: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const caller = yield* watchingCaller();
      const projects = yield* ProjectService.ProjectService;
      const workspace =
        caller.worktreePath ??
        (yield* projects.getShell(caller.projectId).pipe(
          Effect.map((project) => Option.getOrNull(project)?.workspaceRoot ?? null),
          Effect.mapError(unavailable),
        ));
      if (workspace === null)
        return yield* new OrchestratorMcpFailure({
          code: "thread_not_found",
          message: "This thread's project was not found.",
        });
      const path = yield* Path.Path;
      const cwd = input.cwd === undefined ? workspace : path.resolve(workspace, input.cwd);
      const watches = yield* CommandWatchService.CommandWatchService;
      return yield* watches
        .watch({ threadId: caller.id, label: input.label, command: input.command, cwd })
        .pipe(Effect.mapError(invalid));
    }),
  ),
  unwatch_command: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const caller = yield* watchingCaller();
      const watches = yield* CommandWatchService.CommandWatchService;
      return yield* watches.unwatch({ threadId: caller.id, label: input.label });
    }),
  ),
  list_command_watches: McpToolAccess.readsAsCaller(() =>
    Effect.gen(function* () {
      const caller = yield* callerThread();
      const watches = yield* CommandWatchService.CommandWatchService;
      return { watches: yield* watches.list(caller.id) };
    }),
  ),
});
