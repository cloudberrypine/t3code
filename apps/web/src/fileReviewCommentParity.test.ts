import { fileReviewCommentFields } from "@t3tools/shared/fileReviewComment";
import { describe, expect, it } from "vite-plus/test";

import { buildFileReviewComment } from "./reviewCommentContext";

// Mobile builds file comments with the shared fields; they must match what desktop sends.
describe("file review comments", () => {
  it.each([
    ["src/game/Behavior.as", 2, 2],
    ["src/engine/World.cpp", 4, 2],
    ["data/mesh.json", 1, 3],
    [".env", 1, 1],
    ["Makefile", 2, 9],
  ])("match desktop for %s lines %i-%i", (filePath, startLine, endLine) => {
    const input = {
      filePath,
      startLine,
      endLine,
      text: "  Why is this here?  ",
      contents: "one\ntwo\n  three\nfour",
    };
    expect(buildFileReviewComment({ id: "comment", ...input })).toEqual({
      id: "comment",
      ...fileReviewCommentFields(input),
    });
  });
});
