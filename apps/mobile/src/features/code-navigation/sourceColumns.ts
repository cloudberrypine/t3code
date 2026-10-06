import { navigationTargets } from "@t3tools/shared/angelscriptNavigation";

/** The native canvas draws each tab as four spaces (`buildNativeSourceRows`). */
const TAB_WIDTH = 4;

/** A column on the native canvas, back to an offset into the line's text. */
export function expandedColumnToOffset(line: string, column: number): number {
  let expanded = 0;
  for (let offset = 0; offset < line.length; offset++) {
    expanded += line[offset] === "\t" ? TAB_WIDTH : 1;
    if (column < expanded) return offset;
  }
  return line.length;
}

/** An offset into the line's text, as a column on the native canvas. */
export function offsetToExpandedColumn(line: string, offset: number): number {
  let column = 0;
  for (let index = 0; index < Math.min(offset, line.length); index++)
    column += line[index] === "\t" ? TAB_WIDTH : 1;
  return column;
}

export interface LineRange {
  readonly start: number;
  readonly end: number;
}

/** Followable symbols per zero-based line, as offsets into that line. */
export function lineNavigationTargets(
  path: string,
  contents: string,
): ReadonlyMap<number, ReadonlyArray<LineRange>> {
  const lineStarts = [0];
  for (let i = 0; i < contents.length; i++) if (contents[i] === "\n") lineStarts.push(i + 1);
  const lines = new Map<number, LineRange[]>();
  for (const target of navigationTargets({ path, contents })) {
    const index = target.line - 1;
    const lineStart = lineStarts[index] ?? 0;
    const ranges = lines.get(index) ?? [];
    ranges.push({ start: target.start - lineStart, end: target.end - lineStart });
    lines.set(index, ranges);
  }
  for (const ranges of lines.values()) ranges.sort((a, b) => a.start - b.start || b.end - a.end);
  return lines;
}

/**
 * Split highlighted tokens so each symbol range is whole segments, keeping all text and styles.
 * Each segment reports the symbol range it belongs to, if any.
 */
export function splitTokensAtRanges<T extends { readonly content: string }>(
  tokens: ReadonlyArray<T>,
  ranges: ReadonlyArray<LineRange>,
): Array<{ readonly token: T; readonly start: number; readonly range: LineRange | null }> {
  const boundaries = new Set<number>();
  for (const range of ranges) boundaries.add(range.start).add(range.end);
  // Like navigationTargetAt: the narrowest symbol wins where ranges nest.
  const rangeAt = (offset: number) => {
    let best: LineRange | null = null;
    for (const range of ranges)
      if (
        range.start <= offset &&
        offset < range.end &&
        (!best || range.end - range.start < best.end - best.start)
      )
        best = range;
    return best;
  };
  const segments: Array<{ token: T; start: number; range: LineRange | null }> = [];
  let offset = 0;
  for (const token of tokens) {
    const end = offset + token.content.length;
    if (end === offset) {
      segments.push({ token, start: offset, range: null });
      continue;
    }
    let cursor = offset;
    for (let point = offset + 1; point <= end; point++) {
      if (point !== end && !boundaries.has(point)) continue;
      segments.push({
        token:
          point - cursor === token.content.length
            ? token
            : {
                ...token,
                content: token.content.slice(cursor - offset, point - offset),
              },
        start: cursor,
        range: rangeAt(cursor),
      });
      cursor = point;
    }
    offset = end;
  }
  return segments;
}
