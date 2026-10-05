import { useAngelScript, type AngelScriptWorkspace } from "../../lib/useAngelScript";
import { prepareAngelScriptReview } from "./angelScriptReview";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createAngelScriptRevisionSemantics, isAngelScriptPath } from "@t3tools/shared/angelscript";
import type { NativeSyntheticEvent } from "react-native";

import { createNativeReviewDiffTheme, type NativeReviewDiffData } from "./nativeReviewDiffAdapter";
import { useAppearanceCodeSurface } from "../settings/appearance/useAppearanceCodeSurface";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { useNativeReviewDiffHighlighting } from "./useNativeReviewDiffHighlighting";
import { buildNativeReviewTokensResetKey } from "./reviewDiffBridgeKeys";
import { useUniwindTheme } from "../../lib/useUniwindTheme";

export { buildNativeReviewTokensResetKey } from "./reviewDiffBridgeKeys";

export function useNativeReviewDiffBridge(input: {
  readonly threadKey: string | null;
  readonly workspace?: AngelScriptWorkspace;
  readonly sectionId: string | null;
  readonly diff: string | null | undefined;
  readonly data: NativeReviewDiffData;
  readonly collapsedFileIds: ReadonlyArray<string>;
  readonly viewedFileIds: ReadonlyArray<string>;
  readonly selectedRowIds: ReadonlyArray<string>;
  readonly canHighlight: boolean;
  readonly loadScriptRevision?: (
    path: string,
  ) => Promise<{ oldContents: string; newContents: string } | null>;
}) {
  const {
    canHighlight,
    collapsedFileIds,
    data: rawData,
    diff,
    sectionId,
    selectedRowIds,
    threadKey,
    viewedFileIds,
  } = input;
  const { nativeReviewDiffStyle } = useAppearanceCodeSurface();
  const { themeAppearance: scheme, themeId } = useAppearancePreferences();
  const appTheme = useUniwindTheme();
  const api = useAngelScript(
    rawData.files.some((file) => /\.as$/i.test(file.path)) ? input.workspace : undefined,
  );
  const loadScriptRevision = input.loadScriptRevision;
  const revisions = useMemo(
    () => ({
      requested: new Set<string>(),
      values: new Map<string, ReturnType<typeof createAngelScriptRevisionSemantics>>(),
    }),
    [loadScriptRevision, api],
  );
  const activeRevisions = useRef<typeof revisions | null>(revisions);
  useEffect(() => {
    activeRevisions.current = revisions;
    return () => {
      activeRevisions.current = null;
    };
  }, [revisions]);
  const [revisionVersion, setRevisionVersion] = useState(0);
  const visible = useRef<{ start: number; end: number } | null>(null);
  const loadVisibleScripts = useCallback(
    (start: number, end: number) => {
      if (!api || !loadScriptRevision || !canHighlight) return;
      const ids = new Set(rawData.rows.slice(Math.max(0, start), end + 1).map((row) => row.fileId));
      for (const file of rawData.files) {
        if (
          !ids.has(file.id) ||
          collapsedFileIds.includes(file.id) ||
          !isAngelScriptPath(file.path) ||
          revisions.requested.has(file.path)
        )
          continue;
        revisions.requested.add(file.path);
        void loadScriptRevision(file.path)
          .then((contents) => {
            if (!contents || activeRevisions.current !== revisions) return;
            revisions.values.set(file.path, createAngelScriptRevisionSemantics(contents, api));
            setRevisionVersion((version) => version + 1);
          })
          .catch(() => {
            /* Preserve hunk highlighting when a revision is unavailable. */
          });
      }
    },
    [api, loadScriptRevision, canHighlight, rawData, collapsedFileIds, revisions],
  );
  useEffect(() => {
    if (visible.current) loadVisibleScripts(visible.current.start, visible.current.end);
  }, [loadVisibleScripts]);
  const { data, semantics } = useMemo(
    () => prepareAngelScriptReview(rawData, api, scheme, revisions.values),
    [rawData, api, scheme, revisions, revisionVersion],
  );
  const [collapsedCommentIds, setCollapsedCommentIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );

  const theme = useMemo(
    () => createNativeReviewDiffTheme(scheme, themeId, appTheme),
    [appTheme, scheme, themeId],
  );
  const rowsJson = useMemo(() => JSON.stringify(data.rows), [data.rows]);
  const collapsedFileIdsJson = useMemo(() => JSON.stringify(collapsedFileIds), [collapsedFileIds]);
  const viewedFileIdsJson = useMemo(() => JSON.stringify(viewedFileIds), [viewedFileIds]);
  const selectedRowIdsJson = useMemo(() => JSON.stringify(selectedRowIds), [selectedRowIds]);
  const collapsedCommentIdsJson = useMemo(
    () => JSON.stringify(Array.from(collapsedCommentIds)),
    [collapsedCommentIds],
  );
  const themeJson = useMemo(() => JSON.stringify(theme), [theme]);
  const styleJson = useMemo(() => JSON.stringify(nativeReviewDiffStyle), [nativeReviewDiffStyle]);
  const tokensResetKey = useMemo(
    () =>
      buildNativeReviewTokensResetKey({
        threadKey,
        sectionId,
        scheme,
        diff,
        fileCount: data.files.length,
        rowCount: data.rows.length,
      }),
    [data.files.length, data.rows.length, diff, scheme, sectionId, threadKey],
  );
  const { tokensPatchJson, updateVisibleRange } = useNativeReviewDiffHighlighting({
    files: data.files,
    rows: data.rows,
    semantics,
    scheme,
    resetKey: tokensResetKey,
    enabled: canHighlight,
  });

  const onDebug = useCallback(
    (event: NativeSyntheticEvent<Record<string, unknown>>) => {
      const payload = event.nativeEvent;
      const message = payload.message;
      if (
        (message === "draw-metrics" || message === "visible-range") &&
        typeof payload.firstRowIndex === "number" &&
        typeof payload.lastRowIndex === "number"
      ) {
        updateVisibleRange({
          firstRowIndex: payload.firstRowIndex,
          lastRowIndex: payload.lastRowIndex,
        });
        visible.current = { start: payload.firstRowIndex, end: payload.lastRowIndex };
        loadVisibleScripts(payload.firstRowIndex, payload.lastRowIndex);
      }
    },
    [updateVisibleRange, loadVisibleScripts],
  );

  const onToggleComment = useCallback(
    (event: NativeSyntheticEvent<{ readonly commentId?: string }>) => {
      const { commentId } = event.nativeEvent;
      if (!commentId) {
        return;
      }

      setCollapsedCommentIds((current) => {
        const next = new Set(current);
        if (next.has(commentId)) {
          next.delete(commentId);
        } else {
          next.add(commentId);
        }
        return next;
      });
    },
    [],
  );

  return {
    themeId,
    theme,
    rowsJson,
    collapsedFileIdsJson,
    collapsedCommentIdsJson,
    viewedFileIdsJson,
    selectedRowIdsJson,
    themeJson,
    styleJson,
    tokensPatchJson,
    tokensResetKey,
    onDebug,
    onToggleComment,
  };
}
