import {
  followsSidebarParent,
  type EnvironmentId,
  type OrchestrationV2ShellSnapshot,
  type OrchestrationV2ThreadShell,
  type SidebarGroupAction,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { Atom } from "effect/unstable/reactivity";

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
      run: async (registry, target) => {
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
        if (followers.length > 0) {
          const waiting = new Set(followers);
          let stopWatching = () => {};
          const watch = (snapshot: OrchestrationV2ShellSnapshot | null) => {
            for (const follower of waiting) {
              const canonical = snapshot?.threads.find((thread) => thread.id === follower.threadId);
              if (canonical !== undefined && parkState(canonical) === follower.expected) {
                waiting.delete(follower);
                removeFollower(follower.update);
              }
            }
            if (waiting.size === 0) stopWatching();
          };
          const unsubscribeFollowers = registry.subscribe(source, watch);
          // @effect-diagnostics-next-line globalTimers:off - preview timing inside an atom command.
          const timeout = setTimeout(() => stopWatching(), FOLLOWER_PREVIEW_TIMEOUT_MS);
          stopWatching = () => {
            clearTimeout(timeout);
            unsubscribeFollowers();
            for (const follower of followers) removeFollower(follower.update);
          };
          followerCleanup.set(update, stopWatching);
        }
        const remove = () =>
          registry.update(pending, (current) => current.filter((item) => item !== update));
        registry.update(pending, (current) => [
          ...current,
          update,
          ...followers.map((follower) => follower.update),
        ]);
        let confirmed = false;
        try {
          const result = await command.run(registry, target);
          if (result._tag === "Success") {
            update.sequence = result.value.sequence;
            registry.update(pending, (current) => [...current]);
            const reconcile = (snapshot: OrchestrationV2ShellSnapshot | null) => {
              if (snapshot === null || snapshot.snapshotSequence >= result.value.sequence) {
                remove();
                unsubscribe();
              }
            };
            const unsubscribe = registry.subscribe(source, reconcile);
            reconcile(registry.get(source));
            confirmed = true;
          }
          return result;
        } finally {
          if (!confirmed) {
            remove();
            followerCleanup.get(update)?.();
          }
          followerCleanup.delete(update);
        }
      },
    };
  }

  const followerCleanup = new WeakMap<PendingThreadUpdate, () => void>();

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

  return { snapshotAtom, wrap };
}
