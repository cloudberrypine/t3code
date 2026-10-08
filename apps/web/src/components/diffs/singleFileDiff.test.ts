import type { FileDiffMetadata, Hunk } from "@pierre/diffs";
import { describe, expect, it } from "vite-plus/test";
import { isLargeDiff, shownDiffFilePath } from "./singleFileDiff";

function file(path: string, changedLines = 1): FileDiffMetadata {
  return {
    name: path,
    type: "change",
    hunks: [{ additionLines: changedLines, deletionLines: 0 } as Hunk],
    additionLines: [],
    deletionLines: [],
    splitLineCount: 0,
    unifiedLineCount: 0,
    isPartial: true,
  };
}

const files = (count: number, changedLines = 1) =>
  Array.from({ length: count }, (_, index) => file(`src/file${index}.ts`, changedLines));

describe("isLargeDiff", () => {
  it("keeps upstream's full view for a diff of up to 20 files and 2,000 changed lines", () => {
    expect(isLargeDiff(files(20, 100), false)).toBe(false);
  });

  it("shows one file at a time past 20 files or 2,000 changed lines", () => {
    expect(isLargeDiff(files(21), false)).toBe(true);
    expect(isLargeDiff([...files(19, 100), file("big.json", 101)], false)).toBe(true);
  });

  it("treats a diff the server sends file by file as large", () => {
    expect(isLargeDiff(files(2), true)).toBe(true);
  });
});

describe("shownDiffFilePath", () => {
  const paths = ["a.ts", "b.ts", "c.ts"];

  it("shows the picked file, and the first file until one is picked", () => {
    expect(shownDiffFilePath(paths, "b.ts")).toBe("b.ts");
    expect(shownDiffFilePath(paths, null)).toBe("a.ts");
  });

  it("falls back to the first file when the picked file left the diff", () => {
    expect(shownDiffFilePath(paths, "gone.ts")).toBe("a.ts");
    expect(shownDiffFilePath([], "gone.ts")).toBeNull();
  });
});
