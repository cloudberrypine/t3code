/** Map a revision location into current text, refusing deleted or ambiguous lines. */
export function revisionLine(
  contents: string,
  currentContents: string,
  line: number,
): number | null {
  if (contents === currentContents) return line;
  const original = contents.split("\n");
  const current = currentContents.split("\n");
  const text = original[line - 1]?.trim();
  if (!text) return null;
  let best: number | null = null;
  let bestScore = -1;
  for (let index = 0; index < current.length; index++) {
    if (current[index]!.trim() !== text) continue;
    let score = 0;
    for (let delta = -3; delta <= 3; delta++) {
      const neighbor = original[line - 1 + delta]?.trim();
      if (delta !== 0 && neighbor && neighbor === current[index + delta]?.trim())
        score += 4 - Math.abs(delta);
    }
    if (score > bestScore) {
      bestScore = score;
      best = index + 1;
    } else if (score === bestScore) best = null;
  }
  return best;
}
