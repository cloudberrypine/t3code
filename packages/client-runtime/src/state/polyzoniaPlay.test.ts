import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";

import type { PlayServerState } from "../polyzoniaPlay.ts";
import { followPlayServer, type PlayServerCheck } from "./polyzoniaPlay.ts";

const SERVING: PlayServerCheck = { _tag: "Serving", repository: "/Users/me/polyzonia" };

/**
 * Follows a play server whose connection the test drives and whose answers it
 * scripts (the last answer repeats). Returns what was emitted so far.
 */
const harness = Effect.fn(function* (answers: ReadonlyArray<PlayServerCheck>) {
  const connected = yield* SubscriptionRef.make(false);
  const remaining = yield* Ref.make(answers);
  const checks = yield* Ref.make(0);
  const states = yield* Ref.make<ReadonlyArray<PlayServerState>>([]);
  const check = Ref.update(checks, (count) => count + 1).pipe(
    Effect.andThen(
      Ref.modify(remaining, (left) => [left[0]!, left.length > 1 ? left.slice(1) : left]),
    ),
  );
  const fiber = yield* followPlayServer({
    connected: SubscriptionRef.changes(connected),
    check,
    retryEvery: "15 seconds",
  }).pipe(
    Stream.runForEach((state) => Ref.update(states, (all) => [...all, state])),
    Effect.forkChild,
  );
  const settle = Effect.yieldNow.pipe(Effect.repeat({ times: 20 }));
  return {
    setConnected: (value: boolean) =>
      SubscriptionRef.set(connected, value).pipe(Effect.andThen(settle)),
    advance: (seconds: number) =>
      TestClock.adjust(`${seconds} seconds`).pipe(Effect.andThen(settle)),
    states: Ref.get(states),
    checks: Ref.get(checks),
    stop: Fiber.interrupt(fiber),
  };
});

describe("followPlayServer", () => {
  it.effect("says nothing until the client connects, then reports the answer", () =>
    Effect.gen(function* () {
      const play = yield* harness([SERVING]);
      yield* play.advance(1);
      expect(yield* play.checks).toBe(0);
      expect(yield* play.states).toEqual([]);

      yield* play.setConnected(true);
      expect(yield* play.states).toEqual([
        { status: "serving", repository: "/Users/me/polyzonia" },
      ]);
      yield* play.stop;
    }),
  );

  it.effect("checks again on every reconnect", () =>
    Effect.gen(function* () {
      const play = yield* harness([{ _tag: "Absent" }, SERVING]);
      yield* play.setConnected(true);
      expect(yield* play.states).toEqual([{ status: "absent" }]);

      // A disconnect keeps the last answer; the reconnect asks again.
      yield* play.setConnected(false);
      expect(yield* play.checks).toBe(1);
      yield* play.setConnected(true);
      expect(yield* play.checks).toBe(2);
      expect(yield* play.states).toEqual([
        { status: "absent" },
        { status: "serving", repository: "/Users/me/polyzonia" },
      ]);
      yield* play.stop;
    }),
  );

  it.effect("asks an unreachable play server again until it answers", () =>
    Effect.gen(function* () {
      const play = yield* harness([{ _tag: "Unreachable" }, { _tag: "Unreachable" }, SERVING]);
      yield* play.setConnected(true);
      expect(yield* play.states).toEqual([{ status: "absent" }]);

      yield* play.advance(15);
      expect(yield* play.checks).toBe(2);
      yield* play.advance(15);
      expect(yield* play.states).toEqual([
        { status: "absent" },
        { status: "serving", repository: "/Users/me/polyzonia" },
      ]);

      // Answered: no more checks while connected.
      yield* play.advance(60);
      expect(yield* play.checks).toBe(3);
      yield* play.stop;
    }),
  );

  it.effect("stops asking while disconnected", () =>
    Effect.gen(function* () {
      const play = yield* harness([{ _tag: "Unreachable" }]);
      yield* play.setConnected(true);
      yield* play.setConnected(false);
      yield* play.advance(60);
      expect(yield* play.checks).toBe(1);
      yield* play.stop;
    }),
  );
});
