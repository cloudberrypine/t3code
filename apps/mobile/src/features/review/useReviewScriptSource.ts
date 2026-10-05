import { useMemo } from "react";
import { checkpointFileRevision } from "@t3tools/client-runtime/checkpoint-file-revision";
import { deriveThreadCheckpointSummaries } from "@t3tools/client-runtime/state/thread-checkpoints";
import type { EnvironmentId } from "@t3tools/contracts";
import { useSelectedThreadProjection } from "../../state/use-thread-detail";
import { useSelectedThreadWorktree } from "../../state/use-selected-thread-worktree";
import { useAtomCommand } from "../../state/use-atom-command";
import { reviewEnvironment } from "../../state/review";
import {
  getReviewSectionIdForCheckpoint,
  type ReviewSectionItem,
  type ReviewRenderableFile,
} from "./reviewModel";

/** Keep revision-aware AngelScript coloring separate from the upstream review layout. */
export function useReviewScriptSource(
  environmentId: EnvironmentId | undefined,
  section: ReviewSectionItem | null,
  files: readonly ReviewRenderableFile[],
) {
  const selectedThread = useSelectedThreadProjection();
  const { selectedThreadCwd: cwd } = useSelectedThreadWorktree();
  const read = useAtomCommand(reviewEnvironment.diffFileContents);
  const projection = selectedThread?.projection;
  const loadScriptRevision = useMemo(() => {
    if (!environmentId || !cwd) return undefined;
    const run =
      section?.kind === "turn" && projection
        ? deriveThreadCheckpointSummaries(projection).find(
            (checkpoint) => getReviewSectionIdForCheckpoint(checkpoint) === section.id,
          )
        : null;
    const revision =
      run && projection ? checkpointFileRevision(projection.checkpoints, run.runId) : null;
    const source = section?.source;
    if (!source && !revision) return undefined;
    return async (path: string) => {
      const file = files.find((file) => file.path === path);
      if (!file) return null;
      const result = await read({
        environmentId,
        input: {
          cwd,
          sourceKind: source?.kind ?? "branch-range",
          baseRef: source ? source.baseRef : revision!.baseRef,
          headRef: source ? source.headRef : revision!.headRef,
          ...(revision ? { baseRefMode: revision.baseRefMode } : {}),
          changeType: file.changeType,
          oldPath: file.previousPath ?? file.path,
          newPath: file.path,
        },
      });
      return result._tag === "Success" ? result.value : null;
    };
  }, [environmentId, cwd, section, files, projection, read]);
  return {
    ...(environmentId && cwd ? { workspace: { environmentId, cwd, revision: section?.diff } } : {}),
    ...(loadScriptRevision ? { loadScriptRevision } : {}),
  };
}
