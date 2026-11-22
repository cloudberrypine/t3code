import { fileReviewCommentFields } from "@t3tools/shared/fileReviewComment";

import type { ReviewRenderableLineRow } from "../review/reviewModel";
import type { ReviewCommentTarget } from "../review/reviewCommentSelection";

/** Comment target for one source line, opened by long-pressing its line number. */
export function fileLineCommentTarget(
  filePath: string,
  lines: ReadonlyArray<string>,
  lineIndex: number,
): ReviewCommentTarget {
  return {
    source: "file",
    sectionId: `file:${filePath}`,
    sectionTitle: "File comment",
    filePath,
    lines: lines.map((content, index): ReviewRenderableLineRow => ({
      kind: "line",
      id: `file-line:${index}`,
      change: "context",
      oldLineNumber: index + 1,
      newLineNumber: index + 1,
      content,
      additionTokenIndex: null,
      deletionTokenIndex: null,
      comparison: null,
    })),
    startIndex: lineIndex,
    endIndex: lineIndex,
  };
}

/**
 * The comment as the composer's review-comment block, built from desktop's file-comment fields;
 * the draft upgrades it (`upgradeLegacyContextMessage`) to the same context record desktop sends.
 */
export function formatFileReviewCommentContext(target: ReviewCommentTarget, comment: string) {
  const fields = fileReviewCommentFields({
    filePath: target.filePath,
    startLine: target.startIndex + 1,
    endLine: target.endIndex + 1,
    text: comment,
    contents: target.lines.map((line) => line.content).join("\n"),
  });
  const attributes = [
    `sectionId="${escapeAttribute(fields.sectionId)}"`,
    `sectionTitle="${escapeAttribute(fields.sectionTitle)}"`,
    `filePath="${escapeAttribute(fields.filePath)}"`,
    `rangeLabel="${escapeAttribute(fields.rangeLabel)}"`,
    `startIndex="${fields.startIndex}"`,
    `endIndex="${fields.endIndex}"`,
  ].join(" ");
  // The fence must be longer than any run of backticks inside the code so the body stays intact.
  const longestRun = Math.max(0, ...[...fields.diff.matchAll(/`+/g)].map((run) => run[0].length));
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  const body = fields.diff
    ? `${fields.text}\n\n${fence}${fields.fenceLanguage ?? "diff"}\n${fields.diff}\n${fence}`
    : fields.text;
  return `<review_comment ${attributes}>\n${body}\n</review_comment>`;
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
