/**
 * Fork: command watches (`watch_command`). The server runs a long-lived
 * command for a thread and wakes the thread's agent with each line it prints.
 */
import * as Schema from "effect/Schema";

import { IsoDateTime, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const COMMAND_WATCH_LABEL_MAX_LENGTH = 40;

export const CommandWatchLabel = TrimmedNonEmptyString.check(
  Schema.isMaxLength(COMMAND_WATCH_LABEL_MAX_LENGTH),
);
export type CommandWatchLabel = typeof CommandWatchLabel.Type;

/** A thread's watch, named by its label; one thread has at most one watch per label. */
export const CommandWatch = Schema.Struct({
  threadId: ThreadId,
  label: CommandWatchLabel,
  command: TrimmedNonEmptyString,
  cwd: TrimmedNonEmptyString,
  /** When the watch was started; kept across T3 Code restarts. */
  startedAt: IsoDateTime,
  /** A settled thread's watches are paused: the command is stopped until the thread is active. */
  status: Schema.Literals(["running", "paused"]),
  /** When the running command started; null while paused. */
  runningSince: Schema.NullOr(IsoDateTime),
});
export type CommandWatch = typeof CommandWatch.Type;

export const CommandWatchListInput = Schema.Struct({});
export type CommandWatchListInput = typeof CommandWatchListInput.Type;

export const CommandWatchListResult = Schema.Struct({
  watches: Schema.Array(CommandWatch),
});
export type CommandWatchListResult = typeof CommandWatchListResult.Type;

export const CommandWatchStopInput = Schema.Struct({
  threadId: ThreadId,
  label: CommandWatchLabel,
});
export type CommandWatchStopInput = typeof CommandWatchStopInput.Type;

export const CommandWatchStopResult = Schema.Struct({
  /** False when no such watch was running. */
  stopped: Schema.Boolean,
});
export type CommandWatchStopResult = typeof CommandWatchStopResult.Type;

export class CommandWatchError extends Schema.TaggedError<CommandWatchError>()(
  "CommandWatchError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}
