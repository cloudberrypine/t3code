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
        const stderr: Array<string> = [];
        const stderrFiber = yield* handle.stderr.pipe(
          Stream.decodeText(),
          Stream.splitLines,
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
          yield* Fiber.join(stderrFiber);
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
          handle.stdout.pipe(
            Stream.decodeText(),
            Stream.splitLines,
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
