import ignore from "ignore";

/** Include a secondary total only when filtering changes the additions or deletions. */
export function getDiffStatTotals(
  files: ReadonlyArray<{ path: string; additions: number; deletions: number }>,
  patterns?: string,
) {
  const matcher = patterns === undefined ? undefined : ignore({ ignorecase: false }).add(patterns);
  const full = { additions: 0, deletions: 0 };
  const filtered = matcher ? { additions: 0, deletions: 0 } : undefined;
  for (const file of files) {
    full.additions += file.additions;
    full.deletions += file.deletions;
    if (filtered && !(ignore.isPathValid(file.path) && matcher?.ignores(file.path))) {
      filtered.additions += file.additions;
      filtered.deletions += file.deletions;
    }
  }
  return {
    full,
    filtered:
      filtered && (filtered.additions !== full.additions || filtered.deletions !== full.deletions)
        ? filtered
        : undefined,
  };
}

/**
 * The filtered share of totals that may cover more files than the client lists (a truncated
 * turn). Only listed files can be matched, so unlisted ones always count.
 */
export function getFilteredDiffStat(
  totals: { additions: number; deletions: number },
  files: ReadonlyArray<{ path: string; additions: number; deletions: number }>,
  patterns?: string,
) {
  const { full, filtered } = getDiffStatTotals(files, patterns);
  if (!filtered) return undefined;
  return {
    additions: totals.additions - (full.additions - filtered.additions),
    deletions: totals.deletions - (full.deletions - filtered.deletions),
  };
}
