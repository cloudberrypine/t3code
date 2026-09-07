import { DiffHunksRenderer, hydratePartialDiff, parseDiffFromFile } from "@pierre/diffs";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  createDiffContextController,
  DIFF_CONTEXT_LINES,
  getDiffContextActions,
} from "./diffContext";
import { getRenderablePatch } from "./diffRendering";

function fixture() {
  const lines = Array.from({ length: 200 }, (_, index) => `line ${index + 1}\n`);
  const changed = [...lines];
  changed[50] = "first change\n";
  changed[119] = "second change\n";
  const oldFile = { name: "example.txt", contents: lines.join("") };
  const newFile = { name: "example.txt", contents: changed.join("") };
  return { oldFile, newFile, file: parseDiffFromFile(oldFile, newFile, { context: 3 }) };
}

function partialFixture() {
  const parsed = getRenderablePatch(
    [
      "diff --git a/example.txt b/example.txt",
      "--- a/example.txt",
      "+++ b/example.txt",
      "@@ -48,7 +48,7 @@",
      " line 48",
      " line 49",
      " line 50",
      "-line 51",
      "+first change",
      " line 52",
      " line 53",
      " line 54",
      "@@ -117,7 +117,7 @@",
      " line 117",
      " line 118",
      " line 119",
      "-line 120",
      "+second change",
      " line 121",
      " line 122",
      " line 123",
      "",
    ].join("\n"),
  );
  if (parsed?.kind !== "files" || !parsed.files[0]) throw new Error("Expected parsed fixture");
  return { ...fixture(), file: parsed.files[0] };
}

describe.each(["unified", "split"] as const)("%s diff context", (diffStyle) => {
  it("consumes the same gap from either neighboring change, twenty lines at a time", async () => {
    const { file } = fixture();
    const renderer = new DiffHunksRenderer({
      diffStyle,
      expansionLineCount: DIFF_CONTEXT_LINES,
      collapsedContextThreshold: 0,
    });
    await renderer.asyncRender(file);
    const gap = () => renderer.renderDiff(file)?.hunkData.find((hunk) => hunk.hunkIndex === 1);
    expect(gap()?.lines).toBe(62);

    const [below, above] = getDiffContextActions(false, false, 62);
    expect(below?.label).toBe("Show 20 lines below");
    expect(above?.label).toBe("Show 20 lines above");
    renderer.expandHunk(1, below!.direction);
    expect(gap()?.lines).toBe(42);
    renderer.expandHunk(1, above!.direction);
    expect(gap()?.lines).toBe(22);
    renderer.expandHunk(1, below!.direction);
    expect(gap()?.lines).toBe(2);
    expect(getDiffContextActions(false, false, 2).map((action) => action.label)).toEqual([
      "Show 2 lines below",
      "Show 2 lines above",
    ]);
    renderer.expandHunk(1, above!.direction);
    expect(gap()).toBeUndefined();
    renderer.cleanUp();
  });

  it("expands toward the start and end of a file without changing the other gaps", async () => {
    const { file } = fixture();
    const renderer = new DiffHunksRenderer({
      diffStyle,
      expansionLineCount: DIFF_CONTEXT_LINES,
      collapsedContextThreshold: 0,
    });
    await renderer.asyncRender(file);
    const counts = () => [
      ...new Map(
        renderer.renderDiff(file)?.hunkData.map((hunk) => [hunk.hunkIndex, hunk.lines]),
      ).values(),
    ];
    expect(counts()).toEqual([47, 62, 77]);
    const [above] = getDiffContextActions(true, false, 47);
    renderer.expandHunk(0, above!.direction);
    expect(counts()).toEqual([27, 62, 77]);
    const [below] = getDiffContextActions(false, true, 77);
    renderer.expandHunk(2, below!.direction);
    expect(counts()).toEqual([27, 62, 57]);
    renderer.cleanUp();
  });

  it("resolves a partial patch's full trailing count without revealing extra rows", async () => {
    const { oldFile, newFile, file } = partialFixture();
    const renderer = new DiffHunksRenderer({
      diffStyle,
      expansionLineCount: DIFF_CONTEXT_LINES,
      collapsedContextThreshold: 0,
    });
    const controller = createDiffContextController(async () => ({ oldFile, newFile }));
    const hydrated = hydratePartialDiff("clone", file, await controller.loadDiffFiles!(file));
    renderer.expandHunk(0, "down", 0);
    const result = await renderer.asyncRender(hydrated);
    expect(result?.hunkData.every((hunk) => hunk.lineCountKnown)).toBe(true);
    expect(result?.hunkData.find((hunk) => hunk.hunkIndex === 2)?.lines).toBe(77);
    renderer.cleanUp();
  });
});

it("deduplicates concurrent context requests for a file while isolating refreshed patches", async () => {
  const { oldFile, newFile, file } = fixture();
  const loader = vi.fn(async () => ({ oldFile, newFile }));
  const controller = createDiffContextController(loader);
  const first = controller.loadDiffFiles!(file);
  expect(controller.loadDiffFiles!(file)).toBe(first);
  await first;
  await controller.loadDiffFiles!(file);
  expect(loader).toHaveBeenCalledTimes(1);
  await controller.loadDiffFiles!({ ...file, cacheKey: "refreshed" });
  expect(loader).toHaveBeenCalledTimes(2);
});

describe.each(["unified", "split"] as const)("%s stale context", (diffStyle) => {
  it("rejects mismatched trailing lines without corrupting the diff being scrolled", async () => {
    const { oldFile, newFile, file } = partialFixture();
    const tail = Array.from({ length: 54 }, (_, index) => `extra ${index}\n`).join("");
    const files = {
      oldFile: { ...oldFile, contents: oldFile.contents + tail },
      newFile: {
        ...newFile,
        contents: newFile.contents + tail.replace("extra 52\nextra 53\n", ""),
      },
    };
    // The reported crash: the same patch leaves 129 new-side and 131 old-side trailing lines.
    const unsafe = hydratePartialDiff("clone", file, files);
    const lastHunk = unsafe.hunks.at(-1)!;
    expect(unsafe.additionLines.length - lastHunk.additionLineIndex - lastHunk.additionCount).toBe(
      129,
    );
    expect(unsafe.deletionLines.length - lastHunk.deletionLineIndex - lastHunk.deletionCount).toBe(
      131,
    );

    const before = structuredClone(file);
    const controller = createDiffContextController(async () => files);
    await expect(controller.loadDiffFiles!(file)).rejects.toThrow("no longer match the diff");
    expect(file).toEqual(before);
    const renderer = new DiffHunksRenderer({ diffStyle });
    try {
      expect(await renderer.asyncRender(file)).toBeDefined();
      renderer.expandHunk(1, "up", 20);
      expect(renderer.renderDiff(file)).toBeDefined();
    } finally {
      renderer.cleanUp();
    }
  });
});

it.each([
  ["before the first hunk", "line 10\n"],
  ["inside a hunk", "first change\n"],
  ["between hunks", "line 80\n"],
  ["after the last hunk", "line 150\n"],
])("rejects same-length edits %s", async (_where, line) => {
  const { oldFile, newFile, file } = partialFixture();
  const controller = createDiffContextController(async () => ({
    oldFile,
    newFile: { ...newFile, contents: newFile.contents.replace(line, "later edit\n") },
  }));
  await expect(controller.loadDiffFiles!(file)).rejects.toThrow("no longer match the diff");
  expect(file.isPartial).toBe(true);
});

it("allows a matching refresh after an earlier context request failed", async () => {
  const stale = partialFixture();
  const fresh = partialFixture();
  const loader = vi
    .fn()
    .mockResolvedValueOnce({
      oldFile: stale.oldFile,
      newFile: { ...stale.newFile, contents: "changed\n" },
    })
    .mockResolvedValueOnce({ oldFile: fresh.oldFile, newFile: fresh.newFile });
  const controller = createDiffContextController(loader);
  await expect(controller.loadDiffFiles!(stale.file)).rejects.toThrow("no longer match the diff");
  const loaded = await controller.loadDiffFiles!(fresh.file);
  expect(hydratePartialDiff("clone", fresh.file, loaded).isPartial).toBe(false);
  expect(loader).toHaveBeenCalledTimes(2);
});

it.each([
  { old: "a\nb\nc\nd\n", next: "a\nx\ny\nc\nd\n", hunk: "@@ -1,3 +1,4 @@\n a\n-b\n+x\n+y\n c\n" },
  { old: "a\nx\ny\nc\nd\n", next: "a\nb\nc\nd\n", hunk: "@@ -1,4 +1,3 @@\n a\n-x\n-y\n+b\n c\n" },
  { old: "", next: "new\n", hunk: "@@ -0,0 +1 @@\n+new\n" },
  { old: "old\n", next: "", hunk: "@@ -1 +0,0 @@\n-old\n" },
  { old: "before\r\n", next: "after\r\n", hunk: "@@ -1 +1 @@\n-before\r\n+after\r\n" },
  {
    old: "before",
    next: "after",
    hunk: "@@ -1 +1 @@\n-before\n\\ No newline at end of file\n+after\n\\ No newline at end of file\n",
  },
])(
  "accepts matching contents across line-count and newline changes: $hunk",
  async ({ old, next, hunk }) => {
    const parsed = getRenderablePatch(
      `diff --git a/example.txt b/example.txt\n--- a/example.txt\n+++ b/example.txt\n${hunk}`,
    );
    if (parsed?.kind !== "files" || !parsed.files[0]) throw new Error("Expected parsed patch");
    const file = parsed.files[0];
    const files = {
      oldFile: { name: "example.txt", contents: old },
      newFile: { name: "example.txt", contents: next },
    };
    const controller = createDiffContextController(async () => files);
    await expect(controller.loadDiffFiles!(file)).resolves.toBe(files);
  },
);
