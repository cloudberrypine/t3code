import { ComposerContextId } from "@t3tools/contracts";
import { serializeLegacyContextMessage } from "@t3tools/shared/composerContextLegacySend";
import { formatComposerContextReference } from "@t3tools/shared/composerContextReferences";
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
 * The comment as the composer's review-comment block, built from desktop's file-comment fields
 * by the shared legacy serializer; the draft upgrades it to the same context record desktop sends.
 */
export function formatFileReviewCommentContext(target: ReviewCommentTarget, comment: string) {
  const fields = fileReviewCommentFields({
    filePath: target.filePath,
    startLine: target.startIndex + 1,
    endLine: target.endIndex + 1,
    text: comment,
    contents: target.lines.map((line) => line.content).join("\n"),
  });
  const reference = {
    kind: "review-comment" as const,
    contextId: ComposerContextId.make("review-comment-file"),
    label: "comment",
  };
  return serializeLegacyContextMessage({
    text: formatComposerContextReference(reference),
    records: [{ version: 1, ...reference, ...fields }],
  });
}
