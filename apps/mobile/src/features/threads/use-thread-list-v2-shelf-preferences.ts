import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/unstable/reactivity";
import { useCallback, useMemo, useRef } from "react";

import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";

/**
 * Shared persisted shelf state for the compact Home list and iPad sidebar.
 * Refs advance before persistence starts so consecutive presses always toggle
 * the latest value, even if React has not rendered the optimistic patch yet.
 */
export function useThreadListV2ShelfPreferences() {
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const loaded = AsyncResult.isSuccess(preferencesResult);
  const snoozedShelfExpanded =
    loaded && preferencesResult.value.threadListSnoozedShelfExpanded === true;
  const settledShelfExpanded =
    loaded && preferencesResult.value.threadListSettledShelfExpanded === true;
  // Working section beta: off until the preference loads and is enabled.
  const workingShelfEnabled = loaded && preferencesResult.value.workingShelfEnabled === true;
  const workingShelfExpanded =
    loaded && preferencesResult.value.threadListWorkingShelfExpanded === true;
  const snoozedShelfExpandedRef = useRef(snoozedShelfExpanded);
  const settledShelfExpandedRef = useRef(settledShelfExpanded);
  const workingShelfExpandedRef = useRef(workingShelfExpanded);
  const collapsedThreadGroups = loaded ? preferencesResult.value.collapsedThreadGroups : undefined;
  const collapsedThreadGroupKeys = useMemo(
    () => new Set(collapsedThreadGroups ?? []),
    [collapsedThreadGroups],
  );
  const collapsedThreadGroupKeysRef = useRef(collapsedThreadGroupKeys);
  collapsedThreadGroupKeysRef.current = collapsedThreadGroupKeys;
  snoozedShelfExpandedRef.current = snoozedShelfExpanded;
  settledShelfExpandedRef.current = settledShelfExpanded;
  workingShelfExpandedRef.current = workingShelfExpanded;

  const toggleSnoozedShelf = useCallback(() => {
    if (!loaded) return;
    const expanded = !snoozedShelfExpandedRef.current;
    snoozedShelfExpandedRef.current = expanded;
    savePreferences({ threadListSnoozedShelfExpanded: expanded });
  }, [loaded, savePreferences]);
  const toggleSettledShelf = useCallback(() => {
    if (!loaded) return;
    const expanded = !settledShelfExpandedRef.current;
    settledShelfExpandedRef.current = expanded;
    savePreferences({ threadListSettledShelfExpanded: expanded });
  }, [loaded, savePreferences]);
  const toggleWorkingShelf = useCallback(() => {
    if (!loaded) return;
    const expanded = !workingShelfExpandedRef.current;
    workingShelfExpandedRef.current = expanded;
    savePreferences({ threadListWorkingShelfExpanded: expanded });
  }, [loaded, savePreferences]);
  // Nested threads under a parent row (see threadNesting.ts); keyed by
  // `environmentId:threadId`, expanded unless listed.
  const toggleThreadGroup = useCallback(
    (parentKey: string) => {
      if (!loaded) return;
      const keys = new Set(collapsedThreadGroupKeysRef.current);
      if (!keys.delete(parentKey)) keys.add(parentKey);
      collapsedThreadGroupKeysRef.current = keys;
      savePreferences({ collapsedThreadGroups: [...keys] });
    },
    [loaded, savePreferences],
  );

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
