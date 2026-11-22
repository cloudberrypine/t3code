import { SymbolView } from "../../components/ui/AppSymbol";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { useCallback, useMemo } from "react";
import { Pressable, View } from "react-native";
import {
  orderSidebarEnvironments,
  moveSidebarEnvironment,
} from "@t3tools/client-runtime/state/thread-nesting";
import { mobilePreferencesAtom, saveMobilePreferences } from "../../state/preferences";
import { useAtomCommand } from "../../state/use-atom-command";
import { workspaceConnections } from "../../state/workspace";
import { AppText as Text } from "../../components/ui/AppText";
import { Menu } from "../../components/ui/Menu";
import type { ThreadListV2ComputerItem } from "./threadListV2";

const EMPTY: readonly string[] = [];
export function useComputerSections() {
  const environments = useAtomValue(workspaceConnections.sidebarEnvironmentsAtom);
  const result = useAtomValue(mobilePreferencesAtom);
  const save = useAtomCommand(saveMobilePreferences);
  const loaded = AsyncResult.isSuccess(result);
  const order = loaded ? (result.value.computerSectionOrder ?? EMPTY) : EMPTY;
  const collapsed = loaded ? (result.value.collapsedComputerSections ?? EMPTY) : EMPTY;
  // Mobile has no local server; the first paired environment is its primary.
  const primary = environments[0]?.environmentId ?? null;
  const toggle = useCallback(
    (id: string) => {
      if (loaded)
        void save({
          transform: (current) => ({
            collapsedComputerSections: (current.collapsedComputerSections ?? []).includes(id)
              ? current.collapsedComputerSections?.filter((key) => key !== id)
              : [...(current.collapsedComputerSections ?? []), id],
          }),
        });
    },
    [loaded, save],
  );
  const move = useCallback(
    (id: string, direction: -1 | 1) => {
      if (loaded)
        void save({
          transform: (current) => ({
            computerSectionOrder: moveSidebarEnvironment(
              orderSidebarEnvironments(
                environments.map((e) => e.environmentId),
                current.computerSectionOrder ?? [],
                primary,
              ),
              id,
              direction,
            ),
          }),
        });
    },
    [loaded, save, environments, primary],
  );
  return useMemo(
    () => ({ environments, primary, order, collapsed, disabled: !loaded, toggle, move }),
    [environments, primary, order, collapsed, loaded, toggle, move],
  );
}

export function ComputerSectionHeader({
  item,
  controls,
}: {
  readonly item: ThreadListV2ComputerItem;
  readonly controls: ReturnType<typeof useComputerSections>;
}) {
  return (
    <Menu
      shouldOpenOnLongPress
      actions={[
        { id: "up", title: "Move up", attributes: { disabled: !item.canMoveUp || item.disabled } },
        {
          id: "down",
          title: "Move down",
          attributes: { disabled: !item.canMoveDown || item.disabled },
        },
      ]}
      onPressAction={({ nativeEvent }) =>
        controls.move(item.environmentId, nativeEvent.event === "up" ? -1 : 1)
      }
    >
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: item.expanded, disabled: item.disabled }}
        disabled={item.disabled}
        onPress={() => controls.toggle(item.environmentId)}
      >
        <View className="w-full flex-row items-center gap-2 border-y border-separator bg-subtle-strong px-3 py-2">
          <SymbolView
            name={item.expanded ? "chevron.down" : "chevron.right"}
            size={16}
            tintColorClassName="accent-foreground"
          />
          <Text numberOfLines={1} className="flex-1 text-xs font-t3-medium text-foreground-muted">
            {item.label}
          </Text>
        </View>
      </Pressable>
    </Menu>
  );
}
