const LEADING_FRONTMATTER =
  /^\uFEFF?---[ \t]*(?:\r\n|\r|\n)(?:[\s\S]*?(?:\r\n|\r|\n))?(?:---|\.\.\.)[ \t]*(?=\r\n|\r|\n|$)/;

/**
 * Blanks a leading YAML frontmatter block so rendered previews skip it instead
 * of showing a rule and a setext heading. Masked characters become spaces and
 * line breaks stay, so source offsets (task checkbox edits) stay valid.
 */
export function maskMarkdownFrontmatter(markdown: string): string {
  return markdown.replace(LEADING_FRONTMATTER, (block) => block.replace(/[^\r\n]/g, " "));
}

// Polyzonia: file previews show the block instead of hiding it (FileMarkdownPreview).
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
