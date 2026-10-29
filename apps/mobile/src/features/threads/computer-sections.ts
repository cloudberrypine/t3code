import {
  orderSidebarEnvironments,
  sidebarEnvironmentSections,
} from "@t3tools/client-runtime/state/thread-nesting";
import type { ThreadListV2ListItem } from "./threadListV2";

export function groupMobileComputerSections(input: {
  readonly items: readonly ThreadListV2ListItem[];
  readonly environments: readonly {
    readonly environmentId: string;
    readonly environmentLabel: string;
  }[];
  readonly primary: string | null;
  readonly order: readonly string[];
  readonly collapsed: readonly string[];
  readonly disabled: boolean;
}): ThreadListV2ListItem[] {
  const end = input.items.findIndex(
    (item) => item.type === "v2-snoozed-shelf" || item.type === "v2-settled-shelf",
  );
  const head = end < 0 ? input.items : input.items.slice(0, end);
  const rows = head.flatMap((entry) =>
    entry.type === "v2-thread"
      ? [{ ...entry, environmentId: entry.item.thread.environmentId }]
      : [],
  );
  const sections = sidebarEnvironmentSections(
    orderSidebarEnvironments(
      input.environments.map((e) => e.environmentId),
      input.order,
      input.primary,
    ),
    [rows],
  );
  if (sections === null) return [...input.items];
  return [
    ...sections.flatMap((section, index): ThreadListV2ListItem[] => {
      const expanded = !input.collapsed.includes(section.environmentId);
      return [
        {
          type: "v2-computer",
          key: `computer:${section.environmentId}`,
          environmentId: section.environmentId,
          label:
            input.environments.find((e) => e.environmentId === section.environmentId)
              ?.environmentLabel ?? section.environmentId,
          expanded,
          disabled: input.disabled,
          canMoveUp: index > 0,
          canMoveDown: index < sections.length - 1,
        },
        ...(expanded ? section.sections.flat() : []),
      ];
    }),
    ...head.filter((entry) => entry.type === "v2-pending"),
    ...(end < 0 ? [] : input.items.slice(end)),
  ];
}
