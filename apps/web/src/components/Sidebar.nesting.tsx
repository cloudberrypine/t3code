import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  listSidebarParentCandidates,
  mostUrgentThreadGroupStatus,
  nestThreads,
  threadDescendants,
  type ThreadGroupStatus,
} from "@t3tools/client-runtime/state/thread-nesting";
import { ThreadId } from "@t3tools/contracts";
import { ChevronRightIcon } from "lucide-react";
import * as Schema from "effect/Schema";
import { useCallback, useMemo } from "react";

import { useLocalStorage } from "../hooks/useLocalStorage";
import { readEnvironmentSupportsSidebarNesting, readThreadShells } from "../state/entities";
import type { ThreadActionMenuState } from "./threadActionMenu.logic";
import { cn } from "~/lib/utils";
import {
  hasUnseenCompletion,
  resolveSidebarThreadStatus,
  resolveThreadLastVisitedAt,
} from "./Sidebar.logic";

// Threads shown under another thread (see client-runtime's threadNesting.ts).
// Children render inside their parent's row, so they move with it while the
// parent is dragged, and they are not sortable items of their own: the pinned
// and active order stays a list of top-level rows.

const COLLAPSED_THREAD_GROUPS_KEY = "t3code:sidebar:collapsed-thread-groups";
const CollapsedThreadGroups = Schema.Array(Schema.String);

const keyOf = (thread: EnvironmentThreadShell) =>
  scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));

export interface SidebarThreadGroup {
  /** The children rendered under the parent: all of them unless collapsed. */
  readonly children: readonly EnvironmentThreadShell[];
  readonly count: number;
  readonly collapsed: boolean;
  /** The most urgent child state, shown on the parent while collapsed. */
  readonly status: ThreadGroupStatus | null;
}

function childGroupStatus(child: EnvironmentThreadShell): ThreadGroupStatus | null {
  if (child.attention) return "attention";
  const status = resolveSidebarThreadStatus(child);
  if (status === "approval" || status === "input") return "attention";
  if (status === "failed" || status === "limited") return "failed";
  if (status === "working" || status === "waiting") return "working";
  return hasUnseenCompletion({
    ...child,
    lastVisitedAt: resolveThreadLastVisitedAt(child.lastVisitedAt, undefined),
  })
    ? "done"
    : null;
}

/**
 * Split the grouping sections into top-level rows and the groups under them.
 * A collapsed group still shows the open thread, the same exception the
 * collapsed shelves make.
 */
export function useSidebarThreadNesting(input: {
  readonly pinned: readonly EnvironmentThreadShell[];
  readonly active: readonly EnvironmentThreadShell[];
  readonly working: readonly EnvironmentThreadShell[];
  readonly allThreads: readonly EnvironmentThreadShell[];
  readonly routeThreadKey: string | null;
}) {
  const [collapsedKeys, setCollapsedKeys] = useLocalStorage(
    COLLAPSED_THREAD_GROUPS_KEY,
    [] as readonly string[],
    CollapsedThreadGroups,
  );
  const { pinned, active, working, routeThreadKey, allThreads } = input;
  const nesting = useMemo(() => {
    const { sections, childrenByParent } = nestThreads([pinned, active, working], allThreads);
    const collapsed = new Set(collapsedKeys);
    const groups = new Map<string, SidebarThreadGroup>();
    for (const [parent, children] of childrenByParent) {
      const parentKey = keyOf(parent);
      const isCollapsed = collapsed.has(parentKey);
      const descendants = threadDescendants(parent, childrenByParent);
      groups.set(parentKey, {
        children: isCollapsed
          ? children.filter(
              (child) =>
                keyOf(child) === routeThreadKey ||
                threadDescendants(child, childrenByParent).some(
                  (descendant) => keyOf(descendant) === routeThreadKey,
                ),
            )
          : children,
        count: descendants.length,
        collapsed: isCollapsed,
        status: isCollapsed ? mostUrgentThreadGroupStatus(descendants.map(childGroupStatus)) : null,
      });
    }
    return {
      pinned: sections[0] ?? pinned,
      active: sections[1] ?? active,
      working: sections[2] ?? working,
      groups,
    };
  }, [active, allThreads, collapsedKeys, pinned, routeThreadKey, working]);
  const toggleGroup = useCallback(
    (parentKey: string) =>
      setCollapsedKeys((keys) =>
        keys.includes(parentKey) ? keys.filter((key) => key !== parentKey) : [...keys, parentKey],
      ),
    [setCollapsedKeys],
  );
  return { ...nesting, toggleGroup };
}

/** The thread menu's grouping items for `thread`, read at menu-open time. */
export function readThreadNestingMenuState(
  thread: EnvironmentThreadShell,
): NonNullable<ThreadActionMenuState["nesting"]> | null {
  if (!readEnvironmentSupportsSidebarNesting(thread.environmentId)) return null;
  return {
    isNested: thread.sidebarParentThreadId !== null,
    candidates: listSidebarParentCandidates(readThreadShells(), thread),
  };
}

/** The parent a `nest:<threadId>` menu choice names, or null for other items. */
export function parseNestMenuChoice(id: string): ThreadId | null {
  return id.startsWith("nest:") ? ThreadId.make(id.slice("nest:".length)) : null;
}

/** Rows in display order: each top-level row followed by its shown children. */
export function flattenSidebarGroups(
  rows: readonly EnvironmentThreadShell[],
  groups: ReadonlyMap<string, SidebarThreadGroup>,
): EnvironmentThreadShell[] {
  if (groups.size === 0) return [...rows];
  return rows.flatMap((row) => [
    row,
    ...flattenSidebarGroups(groups.get(keyOf(row))?.children ?? [], groups),
  ]);
}

/** A row the lifted thread can be dropped onto, in list coordinates. */
export interface SidebarNestBand {
  readonly key: string;
  readonly top: number;
  readonly bottom: number;
}

/**
 * Measure the drop-onto bands at pickup, before rows shift around the gap:
 * the middle half of each eligible row's own surface (not its children).
 */
export function measureSidebarNestBands(
  list: HTMLElement,
  eligible: (key: string) => boolean,
): SidebarNestBand[] {
  const listTop = list.getBoundingClientRect().top;
  const bands: SidebarNestBand[] = [];
  for (const row of list.querySelectorAll<HTMLElement>("li[data-thread-item]")) {
    const key = row.dataset.threadItem;
    const surface = row.firstElementChild;
    if (key === undefined || surface === null || !eligible(key)) continue;
    const rect = surface.getBoundingClientRect();
    const quarter = rect.height / 4;
    bands.push({ key, top: rect.top - listTop + quarter, bottom: rect.bottom - listTop - quarter });
  }
  return bands;
}

/** The row a pointer at list-relative `y` would nest the lifted thread under. */
export function resolveSidebarNestTarget(
  bands: readonly SidebarNestBand[],
  y: number,
): string | null {
  return bands.find((band) => y >= band.top && y <= band.bottom)?.key ?? null;
}

const groupStatusClassName: Record<ThreadGroupStatus, string> = {
  attention: "bg-warning",
  failed: "bg-destructive",
  working: "bg-info",
  done: "bg-success",
};

/** Disclosure for a parent row; collapsed, it carries the child count and state. */
export function SidebarThreadGroupToggle(props: {
  readonly group: SidebarThreadGroup;
  readonly onToggle: () => void;
}) {
  const { group } = props;
  return (
    <button
      type="button"
      aria-expanded={!group.collapsed}
      aria-label={group.collapsed ? "Show nested threads" : "Hide nested threads"}
      // The row is a drag source and a button of its own.
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        props.onToggle();
      }}
      className="-ml-1 inline-flex h-5 shrink-0 cursor-pointer items-center gap-0.5 rounded-sm px-0.5 text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
    >
      <ChevronRightIcon
        aria-hidden
        className={cn("size-3.5 transition-transform", !group.collapsed && "rotate-90")}
      />
      {group.collapsed ? (
        <>
          <span className="text-xs tabular-nums">{group.count}</span>
          {group.status !== null ? (
            <span
              role="img"
              aria-label={`Nested thread ${group.status === "attention" ? "needs attention" : group.status}`}
              className={cn("size-1.5 rounded-full", groupStatusClassName[group.status])}
            />
          ) : null}
        </>
      ) : null}
    </button>
  );
}
