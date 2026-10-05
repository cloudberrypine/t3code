import { it, expect } from "@effect/vitest";
import { EnvironmentId, WS_METHODS, type ProjectFileChange } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";
import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import type { RpcSession } from "../rpc/session.ts";
import { createProjectEnvironmentAtoms } from "./projectCommands.ts";

it.effect(
  "refreshes an open file from disk events and reconnects, shares cached reads, and releases subscriptions",
  () =>
    Effect.gen(function* () {
      const environmentId = EnvironmentId.make("file-test");
      const notifications = yield* Queue.unbounded<ProjectFileChange>();
      const stopped = yield* Queue.unbounded<void>();
      let contents = "before";
      const client = {
        [WS_METHODS.projectsReadFile]: () =>
          Effect.sync(() => ({
            relativePath: "Actor.as",
            contents,
            byteLength: contents.length,
            truncated: false,
          })),
        [WS_METHODS.projectsWatchFile]: () =>
          Stream.fromQueue(notifications).pipe(Stream.ensuring(Queue.offer(stopped, undefined))),
      };
      const session = { client } as unknown as RpcSession;
      const sessions = yield* SubscriptionRef.make(Option.some(session));
      const supervisor = EnvironmentSupervisor.of({
        target: new PrimaryConnectionTarget({
          environmentId,
          label: "test",
          httpBaseUrl: "http://localhost",
          wsBaseUrl: "ws://localhost",
        }),
        state: yield* SubscriptionRef.make<SupervisorConnectionState>({
          ...AVAILABLE_CONNECTION_STATE,
          phase: "connected",
          desired: true,
        }),
        session: sessions,
        prepared: yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(Option.none()),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      });
      const environment = EnvironmentRegistry.of({
        run: (_id, effect) => Effect.provideService(effect, EnvironmentSupervisor, supervisor),
        followStream: (_id, stream) =>
          Stream.provideService(stream, EnvironmentSupervisor, supervisor),
      } as EnvironmentRegistry["Service"]);
      const runtime = Atom.runtime(
        Layer.succeed(EnvironmentRegistry, environment).pipe(
          Layer.provideMerge(
            Layer.succeed(
              Crypto.Crypto,
              Crypto.make({
                randomBytes: (size) => new Uint8Array(size),
                digest: (_algorithm, data) => Effect.succeed(data),
              }),
            ),
          ),
        ),
      );
      const files = createProjectEnvironmentAtoms(runtime, { projectAtom: () => Atom.make(null) });
      const registry = AtomRegistry.make();
      yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
      const target = { environmentId, input: { cwd: "/repo", relativePath: "Actor.as" } };
      const query = files.liveFile(target);
      const results = yield* Queue.unbounded<string>();
      const unmount = registry.subscribe(
        query,
        (result) => {
          if (AsyncResult.isSuccess(result) && !result.waiting)
            Queue.offerUnsafe(results, result.value.contents);
        },
        { immediate: true },
      );
      const waitForContents = (expected: string) =>
        Stream.fromQueue(results).pipe(
          Stream.filter((value) => value === expected),
          Stream.take(1),
          Stream.runDrain,
        );
      yield* waitForContents("before");
      contents = "external edit";
      yield* Queue.offer(notifications, { revision: 1 });
      yield* waitForContents("external edit");
      const cached = registry.get(files.readFile(target));
      expect(AsyncResult.isSuccess(cached) && cached.value.contents).toBe("external edit");
      // A new connection starts at revision zero; it must still refresh cached data.
      yield* SubscriptionRef.set(sessions, Option.none());
      yield* Queue.take(stopped);
      contents = "changed while disconnected";
      yield* SubscriptionRef.set(sessions, Option.some({ ...session }));
      yield* Queue.offer(notifications, { revision: 0 });
      yield* waitForContents("changed while disconnected");
      unmount();
      // The subscription finalizer is the receipt; no sleeps or polling.
      yield* Queue.take(stopped);
    }),
);
