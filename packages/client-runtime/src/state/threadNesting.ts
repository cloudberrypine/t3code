/**
 * Threads shown under another thread in thread lists (`sidebarParentThreadId`).
 * Purely presentational and one level deep: a thread nests under its parent
 * when both are in a list section that can hold groups (pinned, inbox,
 * working). Settled, snoozed, archived, and hidden threads neither nest nor
 * parent, so a child shows on its own while it or its parent is parked.
 */

export interface NestableThread {
  readonly environmentId: string;
  readonly id: string;
  readonly projectId: string;
  readonly sidebarParentThreadId?: string | null | undefined;
  readonly createdAt: string;
}

export interface ThreadNesting<T> {
  /** The input sections, in order, without the nested children. */
  readonly sections: ReadonlyArray<ReadonlyArray<T>>;
  /** Children per parent, oldest first. Keyed by the parent object. */
  readonly childrenByParent: ReadonlyMap<T, ReadonlyArray<T>>;
}

const threadKey = (environmentId: string, threadId: string) => `${environmentId}\u0000${threadId}`;

function parentIn<T extends NestableThread>(
  thread: T,
  byKey: ReadonlyMap<string, T>,
): T | undefined {
  if (thread.sidebarParentThreadId == null) return undefined;
  const parent = byKey.get(threadKey(thread.environmentId, thread.sidebarParentThreadId));
  return parent === undefined || parent === thread || parent.projectId !== thread.projectId
    ? undefined
    : parent;
}

function compareCreated(left: NestableThread, right: NestableThread): number {
  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}

/**
 * Pull each child out of its section and list it under its parent. A parent
 * that is itself nested cannot hold children, so chains and cycles written by
 * racing clients fall back to the top level instead of disappearing.
 */
export function nestThreads<T extends NestableThread>(
  sections: ReadonlyArray<ReadonlyArray<T>>,
): ThreadNesting<T> {
  const byKey = new Map<string, T>();
  for (const section of sections) {
    for (const thread of section) byKey.set(threadKey(thread.environmentId, thread.id), thread);
  }
  const childrenByParent = new Map<T, T[]>();
  const nested = new Set<T>();
  for (const thread of byKey.values()) {
    const parent = parentIn(thread, byKey);
    if (parent === undefined || parentIn(parent, byKey) !== undefined) continue;
    nested.add(thread);
    const children = childrenByParent.get(parent);
    if (children) children.push(thread);
    else childrenByParent.set(parent, [thread]);
  }
  if (nested.size === 0) return { sections, childrenByParent };
  for (const children of childrenByParent.values()) children.sort(compareCreated);
  return {
    sections: sections.map((section) => section.filter((thread) => !nested.has(thread))),
    childrenByParent,
  };
}

export interface ParentCandidateThread extends NestableThread {
  readonly title: string;
  readonly archivedAt: string | null;
  readonly settledOverride: "settled" | "active" | null;
  readonly updatedAt: string;
  readonly lineage: { readonly relationshipToParent: string | null };
}

/**
 * Threads `thread` can be shown under, most recently updated first: unsettled
 * top-level threads of the same project. Empty when `thread` already holds
 * children, since groups are one level deep.
 */
export function listSidebarParentCandidates<T extends ParentCandidateThread>(
  threads: ReadonlyArray<T>,
  thread: NestableThread,
  limit = 20,
): T[] {
  const live = threads.filter(
    (candidate) =>
      candidate.archivedAt === null &&
      candidate.lineage.relationshipToParent !== "subagent" &&
      candidate.environmentId === thread.environmentId &&
      candidate.projectId === thread.projectId,
  );
  const byKey = new Map(
    live.map((candidate) => [threadKey(candidate.environmentId, candidate.id), candidate]),
  );
  if (live.some((candidate) => candidate.sidebarParentThreadId === thread.id)) return [];
  return live
    .filter(
      (candidate) =>
        candidate.id !== thread.id &&
        candidate.id !== thread.sidebarParentThreadId &&
        candidate.settledOverride !== "settled" &&
        parentIn(candidate, byKey) === undefined,
    )
    .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, limit);
}

/** A child state a collapsed parent row shows, most urgent first. */
export type ThreadGroupStatus = "attention" | "failed" | "working" | "done";

const groupStatusRank: Record<ThreadGroupStatus, number> = {
  attention: 4,
  failed: 3,
  working: 2,
  done: 1,
};

/** The state a collapsed parent shows: what most needs the user. */
export function mostUrgentThreadGroupStatus(
  statuses: Iterable<ThreadGroupStatus | null>,
): ThreadGroupStatus | null {
  let best: ThreadGroupStatus | null = null;
  for (const status of statuses) {
    if (status !== null && (best === null || groupStatusRank[status] > groupStatusRank[best])) {
      best = status;
    }
  }
  return best;
}
