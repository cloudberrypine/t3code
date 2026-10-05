import type { FileDiffMetadata } from "@pierre/diffs";

/** Reopen just enough context when history returns to a previously expanded row. */
export function diffJumpExpansion(
  file: FileDiffMetadata,
  line: number,
  side: "additions" | "deletions",
) {
  const prefix = side === "deletions" ? "deletion" : "addition";
  let previousEnd = 0;
  for (const [index, hunk] of file.hunks.entries()) {
    const start = hunk[`${prefix}Start`];
    const end = start + hunk[`${prefix}Count`] - 1;
    if (line >= start && line <= end) return null;
    if (line < start)
      return index > 0 && line - previousEnd <= start - line
        ? { index, direction: "up" as const, count: line - previousEnd }
        : { index, direction: "down" as const, count: start - line };
    previousEnd = end;
  }
  return { index: file.hunks.length, direction: "up" as const, count: line - previousEnd };
}
