import { sidebarParentError } from "@t3tools/contracts";
/**
 * Threads shown under another thread in thread lists (`sidebarParentThreadId`).
 * Presentational tree: a thread nests under its parent
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
  allThreads: readonly T[] = sections.flat(),
): ThreadNesting<T> {
  const byKey = new Map<string, T>();
  for (const section of sections) {
    for (const thread of section) byKey.set(threadKey(thread.environmentId, thread.id), thread);
  }
  const allByKey = new Map(
    allThreads.map((thread) => [threadKey(thread.environmentId, thread.id), thread]),
  );
  const childrenByParent = new Map<T, T[]>();
  const nested = new Set<T>();
  for (const thread of byKey.values()) {
    const seen = new Set<T>([thread]);
    let ancestor = parentIn(thread, allByKey);
    let parent: T | undefined;
    while (ancestor !== undefined && !seen.has(ancestor)) {
      seen.add(ancestor);
      parent ??= byKey.get(threadKey(ancestor.environmentId, ancestor.id));
      ancestor = parentIn(ancestor, allByKey);
    }
    if (ancestor !== undefined || parent === undefined) continue;
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
 * threads of the same project that accept the entire subtree.
 */
export function listSidebarParentCandidates<T extends ParentCandidateThread>(
  threads: ReadonlyArray<T>,
  thread: NestableThread,
  limit = Number.POSITIVE_INFINITY,
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
  return live
    .filter(
      (candidate) =>
        candidate.id !== thread.id &&
        candidate.id !== thread.sidebarParentThreadId &&
        candidate.settledOverride !== "settled" &&
        sidebarParentError([...byKey.values()], thread.id, candidate.id) === null,
    )
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
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

/** All descendants in display order, also used for collapsed counts and urgency. */
export function threadDescendants<T>(parent: T, children: ReadonlyMap<T, readonly T[]>): T[] {
  const result: T[] = [];
  const visit = (node: T) => {
    for (const child of children.get(node) ?? []) {
      result.push(child);
      visit(child);
    }
  };
  visit(parent);
  return result;
}

export interface AttentionThread {
  readonly attention?: { readonly reason: string } | null;
  readonly hasPendingApprovals: boolean;
  readonly hasPendingUserInput: boolean;
  readonly runtime: { readonly status: string } | null;
}

export function threadAttentionStatus(thread: AttentionThread): ThreadGroupStatus | null {
  if (thread.attention || thread.hasPendingApprovals || thread.hasPendingUserInput)
    return "attention";
  if (thread.runtime?.status === "failed" || thread.runtime?.status === "interrupted")
    return "failed";
  if (
    thread.runtime &&
    ["preparing", "queued", "starting", "running", "waiting", "idle"].includes(
      thread.runtime.status,
    )
  )
    return "working";
  return null;
}

/** Preserve each section's existing order, with pins first within each computer. */
export function sidebarEnvironmentSections<T extends { readonly environmentId: string }>(
  environmentIds: readonly string[],
  sections: readonly (readonly T[])[],
): ReadonlyArray<{
  readonly environmentId: string;
  readonly sections: readonly (readonly T[])[];
}> | null {
  if (environmentIds.length < 2) return null;
  // Keep cached rows from temporarily disconnected computers reachable too.
  const ids = new Set([
    ...environmentIds,
    ...sections.flat().map((thread) => thread.environmentId),
  ]);
  return [...ids].map((environmentId) => ({
    environmentId,
    sections: sections.map((section) =>
      section.filter((thread) => thread.environmentId === environmentId),
    ),
  }));
}

/** Saved order wins; unseen environments append. Initially the primary comes first. */
export function orderSidebarEnvironments(
  ids: readonly string[],
  saved: readonly string[],
  primary: string | null,
): string[] {
  const preferred = saved.length > 0 ? saved : primary === null ? [] : [primary];
  return [...new Set([...preferred.filter((id) => ids.includes(id)), ...ids])];
}

export function moveSidebarEnvironment(
  ids: readonly string[],
  id: string,
  direction: -1 | 1,
): string[] {
  const result = [...ids];
  const index = result.indexOf(id);
  const next = index + direction;
  if (index >= 0 && next >= 0 && next < result.length) {
    [result[index], result[next]] = [result[next]!, result[index]!];
  }
  return result;
}
