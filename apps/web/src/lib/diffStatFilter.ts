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
