import type { CodeViewItem, SelectionSide } from "@pierre/diffs";

export interface DiffSearchMatch {
  id: string;
  side: SelectionSide;
  line: number;
  start: number;
  end: number;
}

export interface DiffSearchOptions {
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
}

export const DIFF_SEARCH_LIMIT = 10_000;

/** Search patch hunks, counting shared context once and preserving actual file line numbers. */
export function searchDiffItems<T>(
  items: readonly CodeViewItem<T>[],
  query: string,
  options: DiffSearchOptions,
) {
  const matches: DiffSearchMatch[] = [];
  if (!query) return { matches, error: null, truncated: false };
  let pattern: RegExp;
  try {
    const source = options.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    pattern = new RegExp(
      options.wholeWord ? `\\b(?:${source})\\b` : source,
      options.caseSensitive ? "g" : "gi",
    );
  } catch {
    return { matches, error: "Invalid regular expression", truncated: false };
  }
  function searchLine(id: string, side: SelectionSide, line: number, text: string) {
    pattern.lastIndex = 0;
    for (const match of text.replace(/\r?\n$/, "").matchAll(pattern)) {
      if (match[0].length === 0) continue;
      matches.push({ id, side, line, start: match.index, end: match.index + match[0].length });
      if (matches.length === DIFF_SEARCH_LIMIT) return;
    }
  }
  for (const item of items) {
    if (item.type === "file") {
      const lines = item.file.contents.split("\n");
      for (let index = 0; index < lines.length; index++) {
        searchLine(item.id, "additions", index + 1, lines[index]!);
        if (matches.length === DIFF_SEARCH_LIMIT) return { matches, error: null, truncated: true };
      }
      continue;
    }
    const diff = item.fileDiff;
    for (const hunk of diff.hunks) {
      for (const block of hunk.hunkContent) {
        const sides =
          block.type === "context"
            ? (["additions"] as const)
            : (["deletions", "additions"] as const);
        for (const side of sides) {
          const addition = side === "additions";
          const count = block.type === "context" ? block.lines : block[side];
          const startIndex = addition ? block.additionLineIndex : block.deletionLineIndex;
          const lineStart = addition ? hunk.additionStart : hunk.deletionStart;
          const hunkIndex = addition ? hunk.additionLineIndex : hunk.deletionLineIndex;
          const lines = addition ? diff.additionLines : diff.deletionLines;
          for (let offset = 0; offset < count; offset++) {
            searchLine(
              item.id,
              side,
              lineStart + startIndex - hunkIndex + offset,
              lines[startIndex + offset] ?? "",
            );
            if (matches.length === DIFF_SEARCH_LIMIT)
              return { matches, error: null, truncated: true };
          }
        }
      }
    }
  }
  return { matches, error: null, truncated: false };
}

/** Map a rendered row back to a search result in unified or split layout. */
export function diffSearchRowLine(row: HTMLElement): { side: SelectionSide; line: number } {
  const deletion =
    row.closest("[data-deletions]") !== null || row.dataset.lineType === "change-deletion";
  return {
    side: deletion && !row.dataset.altLine ? "deletions" : "additions",
    line: Number(deletion && row.dataset.altLine ? row.dataset.altLine : row.dataset.line),
  };
}

export function textRange(row: HTMLElement, start: number, end: number): Range | null {
  const walker = row.ownerDocument.createTreeWalker(row, NodeFilter.SHOW_TEXT);
  const range = row.ownerDocument.createRange();
  let position = 0;
  let started = false;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const length = node.textContent?.length ?? 0;
    if (!started && start < position + length) {
      range.setStart(node, start - position);
      started = true;
    }
    if (started && end <= position + length) {
      range.setEnd(node, end - position);
      return range;
    }
    position += length;
  }
  return null;
}
