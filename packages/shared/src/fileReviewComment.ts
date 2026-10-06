/**
 * A comment on lines of a source file (not a diff), as desktop's Files panel builds it with
 * `buildFileReviewComment` (apps/web/src/reviewCommentContext.ts). Mobile builds the same
 * fields, so the agent receives an identical review-comment context from either client.
 */
export interface FileReviewCommentFields {
  readonly sectionId: string;
  readonly sectionTitle: string;
  readonly filePath: string;
  /** Zero-based first and last line. */
  readonly startIndex: number;
  readonly endIndex: number;
  readonly rangeLabel: string;
  readonly text: string;
  /** The selected source lines (not a diff). */
  readonly diff: string;
  readonly fenceLanguage: string;
}

export function fileReviewCommentFields(input: {
  readonly filePath: string;
  /** One-based, in either order. */
  readonly startLine: number;
  readonly endLine: number;
  readonly text: string;
  readonly contents: string;
}): FileReviewCommentFields {
  const startLine = Math.max(1, Math.min(input.startLine, input.endLine));
  const endLine = Math.max(startLine, Math.max(input.startLine, input.endLine));
  return {
    sectionId: `file:${input.filePath}`,
    sectionTitle: "File comment",
    filePath: input.filePath,
    startIndex: startLine - 1,
    endIndex: endLine - 1,
    rangeLabel: startLine === endLine ? `L${startLine}` : `L${startLine} to L${endLine}`,
    text: input.text.trim(),
    diff: input.contents
      .split("\n")
      .slice(startLine - 1, endLine)
      .join("\n"),
    fenceLanguage: fileReviewCommentFenceLanguage(input.filePath),
  };
}

export function fileReviewCommentFenceLanguage(filePath: string): string {
  const normalizedPath = filePath.replaceAll("\\", "/");
  const fileName = normalizedPath.slice(normalizedPath.lastIndexOf("/") + 1).toLowerCase();
  const extensionIndex = fileName.lastIndexOf(".");
  if (extensionIndex > 0 && extensionIndex < fileName.length - 1) {
    return fileName.slice(extensionIndex + 1);
  }
  if (fileName.startsWith(".") && fileName.length > 1) {
    return fileName.slice(1);
  }
  return "text";
}
