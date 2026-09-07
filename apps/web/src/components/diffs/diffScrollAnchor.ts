/** The last header at or above the viewport owns the sticky header, even on large scroll jumps. */
export function findAnchoredDiffItem<T extends { id: string }>(
  items: readonly T[],
  scrollTop: number,
  getTop: (id: string) => number | undefined,
): T | undefined {
  let low = 0;
  let high = items.length - 1;
  let anchored = items[0];
  while (low <= high) {
    const middle = (low + high) >>> 1;
    const item = items[middle]!;
    const top = getTop(item.id);
    if (top !== undefined && top <= scrollTop) {
      anchored = item;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return anchored;
}
