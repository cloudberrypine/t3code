/** Fork: command watch tools (`watch_command`). */
import {
  CommandWatch,
  CommandWatchLabel,
  OrchestratorMcpFailure,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as CommandWatchService from "../../../commandWatch/CommandWatchService.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const commandWatchTool = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ProjectService.ProjectService,
    CommandWatchService.CommandWatchService,
    Path.Path,
  ],
};

const label = CommandWatchLabel.annotate({
  description:
    "A short name for the watch, unique in this thread, for example flags. Each line the command prints reaches you as `[watch <label>] <line>`.",
});

const WatchCommandTool = Tool.make("watch_command", {
  ...commandWatchTool,
  description:
    "Have T3 Code run a long-lived watch command for this thread, with no time limit, and wake you with what it prints. Use it instead of your harness's time-limited monitors or background shells for anything that should keep watching. The command runs in your login shell and should print one stdout line per event. Lines arriving within about 1.5 seconds reach you as one message; it steers your active turn or starts a new one. When the command exits you are told its exit code and last stderr lines, and it is not restarted. More than 60 lines in a minute stops it. The watch survives T3 Code restarts: the command is restarted and you are told once. It pauses while the thread is settled and resumes, telling you once, when the thread is active again. Archiving or deleting the thread stops it. Calling again with the same label and command is a no-op; a different command replaces the watch. Requires a full-access/default caller.",
  parameters: Schema.Struct({
    command: TrimmedNonEmptyString.annotate({ description: "The shell command to run." }),
    label,
    cwd: Schema.optional(
      TrimmedNonEmptyString.annotate({
        description:
          "Working directory, absolute or relative to this thread's workspace. Defaults to this thread's workspace.",
      }),
    ),
  }),
  success: Schema.Struct({
    watch: CommandWatch,
    alreadyWatching: Schema.Boolean.annotate({
      description: "True when this exact watch was already running and nothing changed.",
    }),
  }),
})
  .annotate(Tool.Title, "Watch a command")
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, true);

const UnwatchCommandTool = Tool.make("unwatch_command", {
  ...commandWatchTool,
  description: "Stop one of this thread's command watches and its command.",
  parameters: Schema.Struct({ label }),
  success: Schema.Struct({
    stopped: Schema.Boolean.annotate({
      description: "False when this thread had no watch with that label.",
    }),
  }),
})
  .annotate(Tool.Title, "Stop watching a command")
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true);

const ListCommandWatchesTool = Tool.make("list_command_watches", {
  ...commandWatchTool,
  description:
    "List this thread's command watches: label, command, working directory, and whether each is running or paused.",
  success: Schema.Struct({ watches: Schema.Array(CommandWatch) }),
})
  .annotate(Tool.Title, "List command watches")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

export const CommandWatchesToolkit = Toolkit.make(
  WatchCommandTool,
  UnwatchCommandTool,
  ListCommandWatchesTool,
);
