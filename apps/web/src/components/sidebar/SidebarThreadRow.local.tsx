import { useGT } from "gt-react";
import type { ReactNode } from "react";

import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

// Local (PolyCode) additions to the sidebar thread row: inline flags, the
// computer label on shelf rows, and children shown under their parent row
// (Sidebar.nesting.tsx).

/** The row's accessible title, which names the flag so it is not only a glyph. */
export function useThreadRowAccessibleTitle(thread: {
  readonly title: string;
  readonly attention?: { readonly reason: string } | null | undefined;
}): string {
  const gt = useGT();
  return thread.attention
    ? gt("{title}, Flag: {reason}", { title: thread.title, reason: thread.attention.reason })
    : thread.title;
}

/** ⚑ before the title, with the flag's reason on hover. */
export function ThreadFlagMark(props: {
  readonly attention?: { readonly reason: string } | null | undefined;
}) {
  const gt = useGT();
  if (!props.attention) return null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="img"
            aria-label={gt("Flag: {reason}", { reason: props.attention.reason })}
            className="shrink-0 text-warning"
          />
        }
      >
        {"⚑"}
      </TooltipTrigger>
      <TooltipPopup side="top">{props.attention.reason}</TooltipPopup>
    </Tooltip>
  );
}

/** The computer a shelf row belongs to, while the sidebar groups threads by computer. */
export function ThreadComputerLabel(props: { readonly label: string | null | undefined }) {
  if (!props.label) return null;
  return (
    <span className="mr-1 shrink-0 rounded bg-muted px-1 text-2xs text-muted-foreground">
      {props.label}
    </span>
  );
}

/** Children render inside their parent's row element, so they move with it. */
export function SidebarThreadChildRows(props: { readonly children: ReactNode }) {
  if (!props.children) return null;
  return (
    <ul
      role="presentation"
      className="mt-px ml-1.5 flex flex-col gap-px border-l border-sidebar-border pl-1"
      // Children are not drag sources: a press here must not lift the parent.
      onPointerDown={(event) => event.stopPropagation()}
    >
      {props.children}
    </ul>
  );
}
