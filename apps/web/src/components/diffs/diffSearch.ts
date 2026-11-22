/** The DOM range of characters start..end in a rendered code row (AngelScript decorations). */
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
