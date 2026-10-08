import type { FileDiffMetadata } from "@pierre/diffs";
import { useMemo, useState } from "react";
import { getDiffLineStat, resolveFileDiffPath } from "~/lib/diffRendering";

// Local fork: a large diff shows one file at a time, picked from the file tree, instead of one
// long scroll through every file. Smaller diffs keep upstream's view.
const LARGE_DIFF_FILE_COUNT = 20;
const LARGE_DIFF_CHANGED_LINES = 2_000;

/** A diff the server sends file by file (its patch passed the server's size cap) is always large. */
export function isLargeDiff(files: ReadonlyArray<FileDiffMetadata>, loadsPerFile: boolean) {
  if (loadsPerFile || files.length > LARGE_DIFF_FILE_COUNT) return true;
  const { additions, deletions } = getDiffLineStat(files);
  return additions + deletions > LARGE_DIFF_CHANGED_LINES;
}

/** The picked file while it is still in the diff, otherwise the first file. */
export function shownDiffFilePath(paths: ReadonlyArray<string>, picked: string | null) {
  return picked !== null && paths.includes(picked) ? picked : (paths[0] ?? null);
}

/** The one file a large diff shows, or null when the diff shows every file. */
export function useSingleFileDiff({
  files,
  loadsPerFile,
  selectedFilePath,
  selectedFileRevealRequestId,
}: {
  files: ReadonlyArray<FileDiffMetadata>;
  loadsPerFile: boolean;
  selectedFilePath: string | null;
  selectedFileRevealRequestId: unknown;
}) {
  const [picked, setPicked] = useState(selectedFilePath);
  // A file selected outside the diff panel, for example from the chat, replaces the pick.
  const [selection, setSelection] = useState({ selectedFilePath, selectedFileRevealRequestId });
  if (
    selection.selectedFilePath !== selectedFilePath ||
    selection.selectedFileRevealRequestId !== selectedFileRevealRequestId
  ) {
    setSelection({ selectedFilePath, selectedFileRevealRequestId });
    if (selectedFilePath) setPicked(selectedFilePath);
  }
  const shownPath = useMemo(
    () =>
      isLargeDiff(files, loadsPerFile)
        ? shownDiffFilePath(files.map(resolveFileDiffPath), picked)
        : null,
    [files, loadsPerFile, picked],
  );
  return { shownPath, pick: setPicked };
}
