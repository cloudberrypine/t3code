/** Split a leading YAML metadata block without changing source text or character offsets. */
export function splitMarkdownFrontMatter(text: string) {
  const opening = /^\uFEFF?---[\t ]*(?:\r\n|\n|\r)/.exec(text);
  if (opening) {
    const closing = /^(?:---|\.\.\.)[\t ]*(?:\r\n|\n|\r|$)/gm;
    closing.lastIndex = opening[0].length;
    const match = closing.exec(text);
    if (match) {
      const bodyOffset = match.index + match[0].length;
      return {
        frontMatter: text.slice(opening[0].length, match.index),
        body: text.slice(bodyOffset),
        bodyOffset,
      };
    }
  }
  return { frontMatter: null, body: text, bodyOffset: 0 };
}
