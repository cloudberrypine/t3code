import {
  followsSidebarParent,
  type EnvironmentId,
  type OrchestrationV2ShellSnapshot,
  type OrchestrationV2ThreadShell,
  type SidebarGroupAction,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { Atom } from "effect/reactivity";

import type { AtomCommand } from "./runtime.ts";

interface PendingThreadUpdate {
  readonly threadId: ThreadId;
  readonly apply: (thread: OrchestrationV2ThreadShell) => OrchestrationV2ThreadShell;
  sequence?: number;
}

// The server moves nested threads after their parent, one command each, so
// a follower's preview holds until its own shell catches up. A child the
// server refused (say, it started a turn meanwhile) drops after this long.
const FOLLOWER_PREVIEW_TIMEOUT_MS = 10_000;

const parkState = (thread: OrchestrationV2ThreadShell) =>
  `${thread.settledOverride === "settled"}:${
    thread.snoozedUntil == null ? null : DateTime.toEpochMillis(thread.snoozedUntil)
  }`;

export function createOptimisticThreadLifecycle(
  sourceSnapshotAtom: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<OrchestrationV2ShellSnapshot | null>,
) {
  const pendingAtom = Atom.family((_environmentId: EnvironmentId) =>
    Atom.make<ReadonlyArray<PendingThreadUpdate>>([]).pipe(Atom.keepAlive),
  );
  const snapshotAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => {
      const snapshot = get(sourceSnapshotAtom(environmentId));
      const pending = get(pendingAtom(environmentId));
      if (snapshot === null || pending.length === 0) return snapshot;
      const byThread = new Map<ThreadId, PendingThreadUpdate[]>();
      for (const update of pending) {
        if (update.sequence !== undefined && update.sequence <= snapshot.snapshotSequence) continue;
        const updates = byThread.get(update.threadId) ?? [];
        updates.push(update);
        byThread.set(update.threadId, updates);
      }
      if (byThread.size === 0) return snapshot;
      return {
        ...snapshot,
        threads: snapshot.threads.map((thread) =>
          (byThread.get(thread.id) ?? []).reduce(
            (current, update) => update.apply(current),
            thread,
          ),
        ),
      };
    }),
  );

  // Until the durable snapshot catches up, an older pending update can still replace what shows.
  const pendingThreadIdsAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make(
      (get): ReadonlySet<ThreadId> =>
        new Set(get(pendingAtom(environmentId)).map((update) => update.threadId)),
    ),
  );

  function wrap<Input extends { readonly threadId: ThreadId }, E>(
    command: AtomCommand<
      { readonly environmentId: EnvironmentId; readonly input: Input },
      { readonly sequence: number },
      E
    >,
    apply: (
      thread: OrchestrationV2ThreadShell,
      input: Input,
      now: DateTime.Utc,
      accepted: boolean,
    ) => OrchestrationV2ThreadShell,
    /** Threads nested under this one in the sidebar follow it (see threadNesting.ts). */
    follow?: SidebarGroupAction,
  ): typeof command {
    return {
      label: command.label,
      run: (registry, target) =>
        Effect.suspend(() => {
          const now = DateTime.nowUnsafe();
          const pending = pendingAtom(target.environmentId);
          const source = sourceSnapshotAtom(target.environmentId);
          const update: PendingThreadUpdate = {
            threadId: target.input.threadId,
            apply: (thread) => apply(thread, target.input, now, update.sequence !== undefined),
          };
          const followers =
            follow === undefined
              ? []
              : previewFollowers(
                  registry.get(snapshotAtom(target.environmentId)),
                  target.input.threadId,
                  follow,
                  (child) => apply(child, { ...target.input, threadId: child.id }, now, false),
                );
          const removeFollower = (follower: PendingThreadUpdate) =>
            registry.update(pending, (current) => current.filter((item) => item !== follower));
          let stopWatchingFollowers = () => {};
          if (followers.length > 0) {
            const waiting = new Set(followers);
            const watch = (snapshot: OrchestrationV2ShellSnapshot | null) => {
              for (const follower of waiting) {
                const canonical = snapshot?.threads.find(
                  (thread) => thread.id === follower.threadId,
                );
                if (canonical !== undefined && parkState(canonical) === follower.expected) {
                  waiting.delete(follower);
                  removeFollower(follower.update);
                }
              }
              if (waiting.size === 0) stopWatchingFollowers();
            };
            const unsubscribeFollowers = registry.subscribe(source, watch);
            // @effect-diagnostics-next-line globalTimersInEffect:off - the preview outlives the command.
            const timeout = setTimeout(() => stopWatchingFollowers(), FOLLOWER_PREVIEW_TIMEOUT_MS);
            stopWatchingFollowers = () => {
              clearTimeout(timeout);
              unsubscribeFollowers();
              for (const follower of followers) removeFollower(follower.update);
            };
          }
          const remove = () => {
            registry.update(pending, (current) => current.filter((item) => item !== update));
            stopWatchingFollowers();
          };
          // Stays applied after the reply until a snapshot at or past its sequence replaces it.
          const confirm = (sequence: number) => {
            update.sequence = sequence;
            registry.update(pending, (current) => [...current]);
            const reconcile = (snapshot: OrchestrationV2ShellSnapshot | null) => {
              if (snapshot === null || snapshot.snapshotSequence >= sequence) {
                registry.update(pending, (current) => current.filter((item) => item !== update));
                unsubscribe();
              }
            };
            const unsubscribe = registry.subscribe(source, reconcile);
            reconcile(registry.get(source));
          };
          registry.update(pending, (current) => [
            ...current,
            update,
            ...followers.map((follower) => follower.update),
          ]);
          return command
            .run(registry, target)
            .pipe(
              Effect.onExit((exit) =>
                Effect.sync(() => (Exit.isSuccess(exit) ? confirm(exit.value.sequence) : remove())),
              ),
            );
        }),
    };
  }

  /** Preview the parent's action on the nested threads the server will move with it. */
  function previewFollowers(
    snapshot: OrchestrationV2ShellSnapshot | null,
    parentThreadId: ThreadId,
    action: SidebarGroupAction,
    applyToChild: (child: OrchestrationV2ThreadShell) => OrchestrationV2ThreadShell,
  ) {
    const parent = snapshot?.threads.find((thread) => thread.id === parentThreadId);
    if (snapshot == null || parent === undefined) return [];
    const now = DateTime.nowUnsafe();
    const seen = new Set<ThreadId>([parentThreadId]);
    const visit = (
      parent: OrchestrationV2ThreadShell,
    ): Array<{ threadId: ThreadId; update: PendingThreadUpdate; expected: string }> =>
      snapshot.threads.flatMap((child) => {
        if (
          seen.has(child.id) ||
          child.sidebarParentThreadId !== parent.id ||
          child.archivedAt !== null ||
          child.projectId !== parent.projectId ||
          !followsSidebarParent(child, parent, action, now)
        )
          return [];
        seen.add(child.id);
        const predicted = applyToChild(child);
        if (predicted === child) return [];
        const update: PendingThreadUpdate = { threadId: child.id, apply: applyToChild };
        return [{ threadId: child.id, update, expected: parkState(predicted) }, ...visit(child)];
      });
    return visit(parent);
  }

  return { snapshotAtom, pendingThreadIdsAtom, wrap };
}
