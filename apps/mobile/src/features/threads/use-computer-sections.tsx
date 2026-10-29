import { SymbolView } from "../../components/AppSymbol";
import { useAtomValue, useAtomSet } from "@effect/atom-react";
import { AsyncResult } from "effect/unstable/reactivity";
import { useCallback, useMemo } from "react";
import { Pressable, View } from "react-native";
import {
  orderSidebarEnvironments,
  moveSidebarEnvironment,
} from "@t3tools/client-runtime/state/thread-nesting";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { useWorkspaceEnvironments } from "../../state/workspace";
import { AppText as Text } from "../../components/AppText";
import { ControlPillMenu } from "../../components/ControlPillMenu";
import type { ThreadListV2ComputerItem } from "./threadListV2";

const EMPTY: readonly string[] = [];
export function useComputerSections() {
  const all = useWorkspaceEnvironments();
  const environments = useMemo(
    () => all.filter((e) => e.isEnabled && e.connectionState === "connected"),
    [all],
  );
  const result = useAtomValue(mobilePreferencesAtom);
  const save = useAtomSet(updateMobilePreferencesAtom);
  const loaded = AsyncResult.isSuccess(result);
  const order = loaded ? (result.value.computerSectionOrder ?? EMPTY) : EMPTY;
  const collapsed = loaded ? (result.value.collapsedComputerSections ?? EMPTY) : EMPTY;
  // Mobile has no local server; the first paired environment is its primary.
  const primary = environments[0]?.environmentId ?? null;
  const toggle = useCallback(
    (id: string) => {
      if (loaded)
        save({
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
        save({
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
    <ControlPillMenu
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
    </ControlPillMenu>
  );
}
