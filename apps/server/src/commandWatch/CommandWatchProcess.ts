import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { listLoginShellCandidates } from "@t3tools/shared/shell";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

/** Stderr lines kept for the exit report. */
export const STDERR_TAIL_LINES = 10;
/** Output with no line break for this long is cut into lines, so it cannot pile up unread. */
export const MAX_LINE_LENGTH = 4096;
/** How long output may go on after the command exits (something it left running holds it). */
const DRAIN_AFTER_EXIT = "1 second";

export type CommandWatchOutput =
  | { readonly type: "line"; readonly text: string }
  | {
      readonly type: "exit";
      /** Null when the process was killed by a signal or never started. */
      readonly code: number | null;
      /** Why there is no exit code: the signal, or the reason it could not start. */
      readonly reason: string | null;
      readonly stderr: ReadonlyArray<string>;
    };

/**
 * Runs a watch command in the user's login shell. The stream emits each stdout line and ends
 * with the command's exit; interrupting it stops the command's whole process group.
 */
export class CommandWatchProcess extends Context.Service<
  CommandWatchProcess,
  {
    readonly run: (input: {
      readonly command: string;
      readonly cwd: string;
    }) => Stream.Stream<CommandWatchOutput>;
  }
>()("t3/commandWatch/CommandWatchProcess") {}

const errorText = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

/** Decoded text as lines, a line at most MAX_LINE_LENGTH long. */
const toLines = <E, R>(bytes: Stream.Stream<Uint8Array, E, R>) =>
  bytes.pipe(
    Stream.decodeText(),
    Stream.mapAccum(
      () => 0,
      (sinceBreak: number, text: string) => {
        let pieces = "";
        let from = 0;
        let run = sinceBreak;
        for (let index = 0; index < text.length; index++) {
          const code = text.charCodeAt(index);
          if (code === 10 || code === 13) {
            run = 0;
          } else if (++run > MAX_LINE_LENGTH) {
            pieces += `${text.slice(from, index)}\n`;
            from = index;
            run = 1;
          }
        }
        return [run, [pieces + text.slice(from)]] as const;
      },
    ),
    Stream.splitLines,
  );

export const make = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const platform = yield* HostProcessPlatform;
  const environment = yield* HostProcessEnvironment;
  const shell = listLoginShellCandidates(platform, environment.SHELL)[0];

  const commandFor = (input: { readonly command: string; readonly cwd: string }) => {
    const options = {
      cwd: input.cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      forceKillAfter: "3 seconds",
    } as const;
    // A login shell gives the command the user's profile, as in a terminal.
    return shell === undefined
      ? ChildProcess.make(input.command, [], { ...options, shell: true })
      : ChildProcess.make(shell, ["-lc", input.command], options);
  };

  const run: CommandWatchProcess["Service"]["run"] = (input) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const handle = yield* spawner.spawn(commandFor(input));
        // The spawner stops the process group only when the command is still running or failed;
        // what a command that exited cleanly left running goes with the watch too.
        if (platform !== "win32") {
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              try {
                process.kill(-handle.pid, "SIGTERM");
              } catch {
                // The group is gone already.
              }
            }),
          );
        }
        const exited = Effect.exit(handle.exitCode).pipe(
          Effect.andThen(Effect.sleep(DRAIN_AFTER_EXIT)),
        );
        const stderr: Array<string> = [];
        const stderrFiber = yield* toLines(handle.stderr).pipe(
          Stream.runForEach((line) =>
            Effect.sync(() => {
              stderr.push(line);
              if (stderr.length > STDERR_TAIL_LINES) stderr.shift();
            }),
          ),
          Effect.ignore,
          Effect.forkScoped,
        );
        const exit = Effect.gen(function* () {
          const code = yield* Effect.exit(handle.exitCode);
          yield* Fiber.join(stderrFiber).pipe(Effect.raceFirst(exited));
          return Exit.isSuccess(code)
            ? { type: "exit" as const, code: Number(code.value), reason: null, stderr }
            : {
                type: "exit" as const,
                code: null,
                reason: errorText(Cause.squash(code.cause)),
                stderr,
              };
        });
        return Stream.concat(
          toLines(handle.stdout).pipe(
            Stream.interruptWhen(exited),
            Stream.map((text): CommandWatchOutput => ({ type: "line", text })),
            Stream.catch(() => Stream.empty),
          ),
          Stream.fromEffect(exit),
        );
      }).pipe(
        Effect.catch((cause) =>
          Effect.succeed(
            Stream.succeed<CommandWatchOutput>({
              type: "exit",
              code: null,
              reason: `it could not start: ${errorText(cause)}`,
              stderr: [],
            }),
          ),
        ),
      ),
    );

  return CommandWatchProcess.of({ run });
});

export const layer = Layer.effect(CommandWatchProcess, make);
