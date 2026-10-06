import { upgradeLegacyContextMessage } from "@t3tools/shared/composerContextLegacy";
import { fileReviewCommentFields } from "@t3tools/shared/fileReviewComment";
import { describe, expect, it } from "vite-plus/test";

import { formatReviewCommentContext } from "../review/reviewCommentSelection";
import { fileLineCommentTarget } from "./fileLineComment";

const lines = ["void main() {", "  int count = 1;", "  print(count);", "}"];

describe("file line comments", () => {
  it("reach the draft as the review-comment record desktop sends for that line", () => {
    const target = fileLineCommentTarget("scripts/Behavior.as", lines, 1);
    const upgraded = upgradeLegacyContextMessage(
      formatReviewCommentContext(target, " Why start at one? "),
    );
    expect(upgraded.records).toHaveLength(1);
    const { contextId: _contextId, ...record } = upgraded.records[0]!;
    expect(record).toEqual({
      version: 1,
      kind: "review-comment",
      label: "Behavior.as L2",
      ...fileReviewCommentFields({
        filePath: "scripts/Behavior.as",
        startLine: 2,
        endLine: 2,
        text: "Why start at one?",
        contents: lines.join("\n"),
      }),
    });
    expect(record).toMatchObject({
      sectionId: "file:scripts/Behavior.as",
      sectionTitle: "File comment",
      rangeLabel: "L2",
      startIndex: 1,
      diff: "  int count = 1;",
      fenceLanguage: "as",
    });
    expect(upgraded.text).toMatch(/^\[Behavior\.as L2\]\(t3-context:\/\/v1\/review-comment\//);
  });

  it("keeps diff comments in their diff format", () => {
    const target = { ...fileLineCommentTarget("src/a.ts", lines, 0) };
    delete (target as { source?: string }).source;
    expect(formatReviewCommentContext(target, "note")).toContain("```diff");
  });
});
