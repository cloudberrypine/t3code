import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Stream from "effect/Stream";

import * as CommandWatchProcess from "./CommandWatchProcess.ts";

it.layer(NodeServices.layer)("CommandWatchProcess", (it) => {
  it.effect("emits stdout lines, then the exit code with the last stderr lines", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-command-watch-process-" });
      const processes = yield* CommandWatchProcess.make;
      const outputs = yield* processes
        .run({ command: "printf 'one\\ntwo\\n'; echo oops >&2; pwd; exit 3", cwd })
        .pipe(Stream.runCollect);
      const lines = outputs.flatMap((output) => (output.type === "line" ? [output.text] : []));
      assert.deepEqual(lines.slice(0, 2), ["one", "two"]);
      assert.isTrue(lines[2]?.endsWith(cwd.split("/").at(-1)!));
      assert.deepEqual(outputs.at(-1), { type: "exit", code: 3, reason: null, stderr: ["oops"] });
    }).pipe(Effect.scoped),
  );

  it.effect("stopping the stream stops the command's whole process group", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-command-watch-process-" });
      const processes = yield* CommandWatchProcess.make;
      // The background sleep is a grandchild; it must go with the shell.
      const [first] = yield* processes
        .run({ command: "sleep 30 & echo $!; wait", cwd })
        .pipe(Stream.take(1), Stream.runCollect);
      assert.equal(first?.type, "line");
      const pid = Number(first?.type === "line" ? first.text : NaN);
      const alive = Effect.sync(() => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      });
      assert.isFalse(yield* alive);
    }).pipe(Effect.scoped),
  );

  it.effect("breaks output without line breaks into bounded lines", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-command-watch-process-" });
      const processes = yield* CommandWatchProcess.make;
      const outputs = yield* processes
        .run({ command: "head -c 100000 /dev/zero | tr '\\0' x; printf '\\nend\\n'", cwd })
        .pipe(Stream.runCollect);
      const lines = outputs.flatMap((output) => (output.type === "line" ? [output.text] : []));
      assert.isTrue(lines.every((line) => line.length <= CommandWatchProcess.MAX_LINE_LENGTH));
      assert.equal(lines.slice(0, -1).join("").length, 100000);
      assert.equal(lines.at(-1), "end");
    }).pipe(Effect.scoped),
  );

  it.effect("reports a working directory it cannot start in", () =>
    Effect.gen(function* () {
      const processes = yield* CommandWatchProcess.make;
      const outputs = yield* processes
        .run({ command: "echo hi", cwd: "/definitely/not/here" })
        .pipe(Stream.runCollect);
      assert.equal(outputs.length, 1);
      const [exit] = outputs;
      assert.equal(exit?.type, "exit");
      assert.isTrue(exit?.type === "exit" && exit.code === null && exit.reason !== null);
    }),
  );
});

// Live, outside the layer above: the wait for output after the exit runs on the real clock.
it.live("ends when the command exits, stopping what it left running", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-command-watch-process-" });
    const processes = yield* CommandWatchProcess.make;
    // The shell exits at once; the sleep, not a job of its own (a login shell hangs up on
    // those), still holds stdout and stderr.
    const startedAt = yield* Clock.currentTimeMillis;
    const outputs = yield* processes
      .run({ command: "(sleep 30 & echo $!)", cwd })
      .pipe(Stream.runCollect);
    assert.isBelow((yield* Clock.currentTimeMillis) - startedAt, 10_000);
    const [first] = outputs;
    assert.equal(first?.type, "line");
    assert.deepEqual(outputs.at(-1), { type: "exit", code: 0, reason: null, stderr: [] });
    const pid = Number(first?.type === "line" ? first.text : NaN);
    const alive = () => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    // The signal takes a moment to land.
    for (let tries = 0; tries < 20 && alive(); tries++) yield* Effect.sleep("50 millis");
    assert.isFalse(alive());
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
