import { hydratePartialDiff, parseDiffFromFile, type CodeViewItem } from "@pierre/diffs";
import { describe, expect, it } from "vite-plus/test";

import { getRenderablePatch } from "~/lib/diffRendering";
import { DIFF_SEARCH_LIMIT, searchDiffItems } from "./diffSearch";

const options = { caseSensitive: false, wholeWord: false, regex: false };

describe("diff text search", () => {
  it("finds both sides of collapsed files and counts shared context once", () => {
    const fileDiff = parseDiffFromFile(
      { name: "file.ts", contents: "shared needle\nold needle\nlast\n" },
      { name: "file.ts", contents: "shared needle\nnew needle needle\nlast\n" },
    );
    const items: CodeViewItem[] = [{ id: "file", type: "diff", fileDiff, collapsed: true }];
    expect(searchDiffItems(items, "needle", options).matches).toEqual([
      { id: "file", side: "additions", line: 1, start: 7, end: 13 },
      { id: "file", side: "deletions", line: 2, start: 4, end: 10 },
      { id: "file", side: "additions", line: 2, start: 4, end: 10 },
      { id: "file", side: "additions", line: 2, start: 11, end: 17 },
    ]);
  });

  it("uses original line numbers across partial hunks and keeps results stable after hydration", () => {
    const before = Array.from({ length: 120 }, (_, index) => `line ${index + 1}\n`);
    const after = [...before];
    after[49] = "new needle\n";
    after[99] = "second needle\n";
    const parsed = getRenderablePatch(
      [
        "diff --git a/file.txt b/file.txt",
        "--- a/file.txt",
        "+++ b/file.txt",
        "@@ -50 +50 @@",
        "-line 50",
        "+new needle",
        "@@ -100 +100 @@",
        "-line 100",
        "+second needle",
        "",
      ].join("\n"),
    );
    if (parsed?.kind !== "files") throw new Error("Expected parsed patch");
    const fileDiff = parsed.files[0]!;
    const items: CodeViewItem[] = [{ id: "file", type: "diff", fileDiff }];
    const matches = searchDiffItems(items, "needle", options).matches;
    expect(matches.map((match) => match.line)).toEqual([50, 100]);
    hydratePartialDiff("merge", fileDiff, {
      oldFile: { name: "file.txt", contents: before.join("") },
      newFile: { name: "file.txt", contents: after.join("") },
    });
    expect(searchDiffItems(items, "needle", options).matches).toEqual(matches);
  });

  const files: CodeViewItem[] = [
    {
      id: "first",
      type: "file",
      file: { name: "first.txt", contents: "Needle needles needle. a+b\n" },
    },
    { id: "second", type: "file", file: { name: "second.txt", contents: "needle\n" } },
  ];
  it("supports case, whole word, regex, literal punctuation, and multiple files", () => {
    expect(searchDiffItems(files, "needle", options).matches).toHaveLength(4);
    expect(
      searchDiffItems(files, "needle", { ...options, caseSensitive: true, wholeWord: true })
        .matches,
    ).toHaveLength(2);
    expect(searchDiffItems(files, "a+b", options).matches).toHaveLength(1);
    expect(searchDiffItems(files, "needle[s.]", { ...options, regex: true }).matches).toHaveLength(
      2,
    );
    expect(searchDiffItems(files, "needle", options).matches.at(-1)?.id).toBe("second");
  });
  it("handles clearing, no results, invalid regex, and zero-width regex without looping", () => {
    expect(searchDiffItems(files, "", options).matches).toEqual([]);
    expect(searchDiffItems(files, "missing", options).matches).toEqual([]);
    expect(searchDiffItems(files, "[", { ...options, regex: true }).error).toBe(
      "Invalid regular expression",
    );
    expect(searchDiffItems(files, "(?=needle)", { ...options, regex: true }).matches).toEqual([]);
  });
  it("bounds highlight work for very large results", () => {
    const result = searchDiffItems(
      [
        {
          id: "large",
          type: "file",
          file: { name: "large", contents: "x ".repeat(DIFF_SEARCH_LIMIT + 1) },
        },
      ],
      "x",
      options,
    );
    expect(result.matches).toHaveLength(DIFF_SEARCH_LIMIT);
    expect(result.truncated).toBe(true);
  });
});
