import { useAngelScript, type AngelScriptWorkspace } from "../../lib/useAngelScript";
import { prepareAngelScriptReview } from "./angelScriptReview";
import { useBehaviourReview } from "./useBehaviourReview";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createAngelScriptRevisionSemantics, isAngelScriptPath } from "@t3tools/shared/angelscript";
import type { NativeSyntheticEvent } from "react-native";

import { createNativeReviewDiffTheme, type NativeReviewDiffData } from "./nativeReviewDiffAdapter";
import { useAppearanceCodeSurface } from "../settings/appearance/useAppearanceCodeSurface";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { useNativeReviewDiffHighlighting } from "./useNativeReviewDiffHighlighting";
import { buildNativeReviewTokensResetKey } from "./reviewDiffBridgeKeys";
import { useUniwindTheme } from "../../lib/useUniwindTheme";

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
    // oxlint-disable-next-line react/memo-dependencies -- a new revision reader or scripting API starts a fresh revision cache
    [loadScriptRevision, api],
  );
  const activeRevisions = useRef<typeof revisions | null>(revisions);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tells in-flight revision reads which cache is current, so a replaced cache drops their results
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
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the revisions of the rows already on screen when the loader changes
  useEffect(() => {
    if (visible.current) loadVisibleScripts(visible.current.start, visible.current.end);
  }, [loadVisibleScripts]);
  const angelScript = useMemo(
    () => prepareAngelScriptReview(rawData, api, scheme, revisions.values),
    // oxlint-disable-next-line react/memo-dependencies -- revisionVersion recolours when a revision lands in the mutable cache
    [rawData, api, scheme, revisions, revisionVersion],
  );
  const { semantics } = angelScript;
  // Polyzonia's behaviour language (`.beh`, `.pzb`): its colours and wait rows over AngelScript's.
  const behaviour = useBehaviourReview({
    data: angelScript.data,
    canHighlight,
    collapsedFileIds,
    loadScriptRevision,
  });
  const { data } = behaviour;
  const [surfaceGeneration, setSurfaceGeneration] = useState(0);
  const hasMountedContentRef = useRef(false);
  const [collapsedCommentIds, setCollapsedCommentIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );

  const theme = useMemo(
    () => createNativeReviewDiffTheme(scheme, themeId, appTheme),
    [appTheme, scheme, themeId],
  );
  const collapsedFileIdsSet = useMemo(() => new Set(collapsedFileIds), [collapsedFileIds]);
  const rowsJson = useMemo(() => JSON.stringify(data.rows), [data.rows]);
  const collapsedFileIdsJson = useMemo(() => JSON.stringify(collapsedFileIds), [collapsedFileIds]);
  const viewedFileIdsJson = useMemo(() => JSON.stringify(viewedFileIds), [viewedFileIds]);
  const selectedRowIdsJson = useMemo(() => JSON.stringify(selectedRowIds), [selectedRowIds]);
  const collapsedCommentIdsJson = useMemo(
    () => JSON.stringify(Array.from(collapsedCommentIds)),
    [collapsedCommentIds],
  );
  const themeJson = useMemo(() => JSON.stringify(theme), [theme]);
  const styleJson = JSON.stringify(nativeReviewDiffStyle);
  const tokensResetKey = useMemo(
    () =>
      `${buildNativeReviewTokensResetKey({
        threadKey,
        sectionId,
        scheme,
        diff,
        fileCount: data.files.length,
        rowCount: data.rows.length,
      })}:${surfaceGeneration}`,
    [data.files.length, data.rows.length, diff, scheme, sectionId, surfaceGeneration, threadKey],
  );
  const { acknowledgeTokenPatch, rejectTokenPatch, tokensPatchJson, updateVisibleRange } =
    useNativeReviewDiffHighlighting({
      files: data.files,
      rows: data.rows,
      collapsedFileIds: collapsedFileIdsSet,
      semantics,
      behaviourSemantics: behaviour.semantics,
      scheme,
      resetKey: tokensResetKey,
      enabled: canHighlight,
    });

  const onDebug = (event: NativeSyntheticEvent<Record<string, unknown>>) => {
    const payload = event.nativeEvent;
    const message = payload.message;
    if (message === "surface-content-mounted") {
      // The initial content already has a fresh hook; replacements lose accepted tokens.
      if (hasMountedContentRef.current) setSurfaceGeneration((generation) => generation + 1);
      hasMountedContentRef.current = true;
    }
    if (message === "tokens-patch-delivered") acknowledgeTokenPatch(payload);
    if (message === "tokens-patch-failed") rejectTokenPatch(payload);
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
      behaviour.updateVisibleRange(payload.firstRowIndex, payload.lastRowIndex);
    }
  };

  const onToggleComment = (event: NativeSyntheticEvent<{ readonly commentId?: string }>) => {
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
  };

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
