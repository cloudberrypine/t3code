import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  moveSidebarEnvironment,
  mostUrgentThreadGroupStatus,
  orderSidebarEnvironments,
  sidebarEnvironmentSections,
  threadAttentionStatus,
} from "@t3tools/client-runtime/state/thread-nesting";
import { useGT } from "gt-react";
import { ChevronRightIcon } from "lucide-react";
import * as Schema from "effect/Schema";
import type { ReactNode } from "react";

import { useLocalStorage } from "../hooks/useLocalStorage";
import { readLocalApi } from "../localApi";
import { useSidebarEnvironments } from "../state/environments";
import { cn } from "~/lib/utils";
import { hasUnseenCompletion, resolveThreadLastVisitedAt } from "./Sidebar.logic";

// Local (PolyCode): with more than one computer, the pinned, active and working
// rows are grouped by computer, in an order the user picks. The snoozed and
// settled shelves stay global. Boring mode's project folders replace this.

const EnvironmentIdList = Schema.Array(Schema.String);
const COLLAPSED_ENVIRONMENTS_KEY = "polycode:sidebar:collapsed-environments";
const ENVIRONMENT_ORDER_KEY = "polycode:sidebar:environment-order";

/** The sidebar sections that computer blocks hold, in their order. */
export const COMPUTER_SECTIONS = ["pinned", "active", "working"] as const;

export type SidebarComputerSections = ReadonlyArray<{
  readonly environmentId: string;
  readonly sections: readonly (readonly EnvironmentThreadShell[])[];
}>;

export function useSidebarComputerSections(input: {
  readonly enabled: boolean;
  readonly primaryEnvironmentId: string | null;
  readonly pinned: readonly EnvironmentThreadShell[];
  readonly active: readonly EnvironmentThreadShell[];
  readonly working: readonly EnvironmentThreadShell[];
}) {
  // Saved enabled environments, not live connections, so headers survive a reconnect.
  const sidebarEnvironments = useSidebarEnvironments();
  const [collapsedEnvironmentIds, setCollapsedEnvironmentIds] = useLocalStorage(
    COLLAPSED_ENVIRONMENTS_KEY,
    [] as readonly string[],
    EnvironmentIdList,
  );
  const [environmentOrder, setEnvironmentOrder] = useLocalStorage(
    ENVIRONMENT_ORDER_KEY,
    [] as readonly string[],
    EnvironmentIdList,
  );
  const computerSections: SidebarComputerSections | null = input.enabled
    ? sidebarEnvironmentSections(
        orderSidebarEnvironments(
          sidebarEnvironments.map((environment) => environment.environmentId),
          environmentOrder,
          input.primaryEnvironmentId,
        ),
        [input.pinned, input.active, input.working],
      )
    : null;
  return {
    computerSections,
    collapsedEnvironmentIds,
    toggleComputer: (environmentId: string) =>
      setCollapsedEnvironmentIds((current) =>
        current.includes(environmentId)
          ? current.filter((id) => id !== environmentId)
          : [...current, environmentId],
      ),
    moveComputer: (environmentId: string, direction: -1 | 1) =>
      setEnvironmentOrder(
        moveSidebarEnvironment(
          (computerSections ?? []).map((computer) => computer.environmentId),
          environmentId,
          direction,
        ),
      ),
  };
}

function computerRollUpStatus(threads: readonly EnvironmentThreadShell[]) {
  return mostUrgentThreadGroupStatus(
    threads.map(
      (thread) =>
        threadAttentionStatus(thread) ??
        (hasUnseenCompletion({
          ...thread,
          lastVisitedAt: resolveThreadLastVisitedAt(thread.lastVisitedAt, undefined),
        })
          ? "done"
          : null),
    ),
  );
}

/**
 * A computer's block: a light grey header that folds it (showing the thread count and
 * the most urgent state while folded) and moves it up or down from its context menu.
 */
export function SidebarComputerBlock(props: {
  readonly environmentId: string;
  readonly label: string;
  readonly collapsed: boolean;
  readonly isFirst: boolean;
  readonly isLast: boolean;
  /** Every thread of the computer, children included, for the folded roll-up. */
  readonly threads: readonly EnvironmentThreadShell[];
  readonly onToggle: (environmentId: string) => void;
  readonly onMove: (environmentId: string, direction: -1 | 1) => void;
  readonly children: ReactNode;
}) {
  const gt = useGT();
  const status = props.collapsed ? computerRollUpStatus(props.threads) : null;
  return (
    <li className="list-none">
      <button
        type="button"
        onContextMenu={(event) => {
          event.preventDefault();
          const api = readLocalApi();
          if (!api) return;
          void api.contextMenu
            .show(
              [
                { id: "up", label: gt("Move up"), disabled: props.isFirst },
                { id: "down", label: gt("Move down"), disabled: props.isLast },
              ],
              { x: event.clientX, y: event.clientY },
            )
            .then((choice) => {
              if (choice === "up" || choice === "down")
                props.onMove(props.environmentId, choice === "up" ? -1 : 1);
            })
            .catch(() => {});
        }}
        aria-expanded={!props.collapsed}
        onClick={() => props.onToggle(props.environmentId)}
        className="flex w-full cursor-pointer items-center gap-1.5 border-b border-border bg-muted/60 px-2 py-2 text-left text-xs font-medium text-muted-foreground hover:text-foreground"
      >
        <ChevronRightIcon
          aria-hidden
          className={cn("size-4 shrink-0", !props.collapsed && "rotate-90")}
        />
        <span className="min-w-0 flex-1 truncate">{props.label}</span>
        {props.collapsed ? (
          <>
            <span>{props.threads.length}</span>
            {status ? (
              <span
                aria-label={status}
                className={cn(
                  "size-1.5 rounded-full",
                  status === "attention"
                    ? "bg-warning"
                    : status === "failed"
                      ? "bg-destructive"
                      : "bg-info",
                )}
              />
            ) : null}
          </>
        ) : null}
      </button>
      {props.collapsed ? null : <ul className="flex flex-col gap-px">{props.children}</ul>}
    </li>
  );
}
