import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as CommandWatchService from "../../../commandWatch/CommandWatchService.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import { readCaller, readMutationCaller, unavailable } from "../../threadAccess.ts";
import { CommandWatchesToolkit } from "./tools.ts";

/** Starting or stopping a watch runs commands as the server, so it needs a full-access/default caller, like t3_thread_launch. */
const readWatchingCaller = Effect.fn("mcp.commandWatches.readCaller")(function* () {
  const context = yield* readMutationCaller();
  if (context.caller.runtimeMode !== "full-access" || context.caller.interactionMode !== "default")
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message: "Command watches require a live full-access/default thread.",
    });
  return context;
});

const invalid = (error: { readonly message: string }) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message: error.message });

export const CommandWatchesToolkitHandlersLive = CommandWatchesToolkit.toLayer({
  watch_command: (input) =>
    Effect.gen(function* () {
      const { caller } = yield* readWatchingCaller();
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
  unwatch_command: (input) =>
    Effect.gen(function* () {
      const { caller } = yield* readWatchingCaller();
      const watches = yield* CommandWatchService.CommandWatchService;
      return yield* watches.unwatch({ threadId: caller.id, label: input.label });
    }),
  list_command_watches: () =>
    Effect.gen(function* () {
      const { caller } = yield* readCaller();
      const watches = yield* CommandWatchService.CommandWatchService;
      return { watches: yield* watches.list(caller.id) };
    }),
});
