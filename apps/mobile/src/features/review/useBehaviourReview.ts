import { createBehaviourRevisionSemantics, isBehaviourPath } from "@t3tools/shared/behaviour";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { prepareBehaviourReview, type BehaviourRevision } from "./behaviourReview";
import type { NativeReviewDiffData } from "./nativeReviewDiffAdapter";

type RevisionLoader = (
  path: string,
) => Promise<{ oldContents: string; newContents: string } | null>;

const NO_REVISIONS: ReadonlyMap<string, BehaviourRevision> = new Map();

/**
 * Behaviour-language colours and wait rows for a review diff, reading each visible behaviour
 * file's complete revisions once they load, as the AngelScript path does. Revisions belong to
 * the loader (the review section) that read them.
 */
export function useBehaviourReview(input: {
  readonly data: NativeReviewDiffData;
  readonly canHighlight: boolean;
  readonly collapsedFileIds: ReadonlyArray<string>;
  readonly loadScriptRevision?: RevisionLoader | undefined;
}) {
  const { canHighlight, collapsedFileIds, data, loadScriptRevision } = input;
  const [loaded, setLoaded] = useState<{
    readonly loader: RevisionLoader | undefined;
    readonly values: ReadonlyMap<string, BehaviourRevision>;
  }>({ loader: undefined, values: NO_REVISIONS });
  const revisions = loaded.loader === loadScriptRevision ? loaded.values : NO_REVISIONS;
  const requested = useRef<{ loader: RevisionLoader | undefined; paths: Set<string> }>({
    loader: undefined,
    paths: new Set(),
  });
  const visible = useRef<{ start: number; end: number } | null>(null);
  const loadRevisions = useCallback(
    (start: number, end: number) => {
      const loader = loadScriptRevision;
      if (!loader || !canHighlight) return;
      if (requested.current.loader !== loader) requested.current = { loader, paths: new Set() };
      const { paths } = requested.current;
      const ids = new Set(data.rows.slice(Math.max(0, start), end + 1).map((row) => row.fileId));
      for (const file of data.files) {
        if (
          !ids.has(file.id) ||
          collapsedFileIds.includes(file.id) ||
          !isBehaviourPath(file.path) ||
          paths.has(file.path)
        )
          continue;
        paths.add(file.path);
        void loader(file.path)
          .then((contents) => {
            // A revision an earlier section's loader read is dropped.
            if (!contents || requested.current.loader !== loader) return;
            const revision = createBehaviourRevisionSemantics(contents);
            setLoaded((current) => ({
              loader,
              values: new Map(current.loader === loader ? current.values : NO_REVISIONS).set(
                file.path,
                revision,
              ),
            }));
          })
          .catch(() => {
            /* Hunk-only colours stand when a revision is unavailable. */
          });
      }
    },
    [loadScriptRevision, canHighlight, data, collapsedFileIds],
  );
  // Effect on purpose: a loader or rows that arrive after the native view reported its visible
  // range still fetch that range's revisions, with no new range event to start them.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- fetches the visible behaviour files' revisions over the network when the loader or rows change
  useEffect(() => {
    if (visible.current) loadRevisions(visible.current.start, visible.current.end);
  }, [loadRevisions]);
  const prepared = useMemo(() => prepareBehaviourReview(data, revisions), [data, revisions]);
  const updateVisibleRange = useCallback(
    (start: number, end: number) => {
      visible.current = { start, end };
      loadRevisions(start, end);
    },
    [loadRevisions],
  );
  return { ...prepared, updateVisibleRange };
}
