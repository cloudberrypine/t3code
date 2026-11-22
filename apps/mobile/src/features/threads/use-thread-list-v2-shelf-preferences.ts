import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { useMemo } from "react";

import { mobilePreferencesAtom, saveMobilePreferences } from "../../state/preferences";
import { useAtomCommand } from "../../state/use-atom-command";

export function useThreadListV2ShelfPreferences() {
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomCommand(saveMobilePreferences);
  const loaded = AsyncResult.isSuccess(preferencesResult);
  const snoozedShelfExpanded =
    loaded && preferencesResult.value.threadListSnoozedShelfExpanded === true;
  const settledShelfExpanded =
    loaded && preferencesResult.value.threadListSettledShelfExpanded === true;
  const workingShelfEnabled = loaded && preferencesResult.value.workingShelfEnabled !== false;
  const workingShelfExpanded =
    loaded && preferencesResult.value.threadListWorkingShelfExpanded === true;
  // Nested threads under a parent row (see threadNesting.ts); keyed by
  // `environmentId:threadId`, expanded unless listed.
  const collapsedThreadGroups = loaded ? preferencesResult.value.collapsedThreadGroups : undefined;
  const collapsedThreadGroupKeys = useMemo(
    () => new Set(collapsedThreadGroups ?? []),
    [collapsedThreadGroups],
  );

  // Transforms read optimistic state so same-frame presses toggle twice.
  const toggleSnoozedShelf = () => {
    if (!loaded) return;
    void savePreferences({
      transform: (current) => ({
        threadListSnoozedShelfExpanded: current.threadListSnoozedShelfExpanded !== true,
      }),
    });
  };
  const toggleSettledShelf = () => {
    if (!loaded) return;
    void savePreferences({
      transform: (current) => ({
        threadListSettledShelfExpanded: current.threadListSettledShelfExpanded !== true,
      }),
    });
  };
  const toggleWorkingShelf = () => {
    if (!loaded) return;
    void savePreferences({
      transform: (current) => ({
        threadListWorkingShelfExpanded: current.threadListWorkingShelfExpanded !== true,
      }),
    });
  };
  const toggleThreadGroup = (parentKey: string) => {
    if (!loaded) return;
    void savePreferences({
      transform: (current) => {
        const keys = new Set(current.collapsedThreadGroups ?? []);
        if (!keys.delete(parentKey)) keys.add(parentKey);
        return { collapsedThreadGroups: [...keys] };
      },
    });
  };

  return {
    loaded,
    settledShelfExpanded,
    snoozedShelfExpanded,
    workingShelfEnabled,
    workingShelfExpanded,
    toggleSettledShelf,
    toggleSnoozedShelf,
    toggleWorkingShelf,
    collapsedThreadGroupKeys,
    toggleThreadGroup,
  } as const;
}
