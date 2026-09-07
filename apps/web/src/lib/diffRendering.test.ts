import { describe, expect, it } from "vite-plus/test";
import {
  buildFileDiffContentVersion,
  buildFileDiffIdentityKey,
  buildFileDiffRenderKey,
  buildPatchCacheKey,
  buildReviewDiffPlaceholder,
  getDiffLineStat,
  getRenderablePatch,
  stripDiffTruncationMarker,
} from "./diffRendering";

describe("buildReviewDiffPlaceholder", () => {
  it("creates a stable header-only partial diff for an unloaded manifest file", () => {
    const placeholder = buildReviewDiffPlaceholder(
      {
        changeType: "rename-changed",
        oldPath: "src/old.ts",
        newPath: "src/new.ts",
        additions: 4,
        deletions: 2,
        patchIncluded: false,
        isUntracked: false,
      },
      "review-scope",
    );

    expect(placeholder).toMatchObject({
      name: "b/src/new.ts",
      prevName: "a/src/old.ts",
      type: "rename-changed",
      hunks: [],
      isPartial: true,
      splitLineCount: 0,
      unifiedLineCount: 0,
    });
    expect(buildFileDiffIdentityKey(placeholder)).toBe("src/old.ts\0src/new.ts");
  });
});

describe("stripDiffTruncationMarker", () => {
  it("removes server metadata without changing a complete patch", () => {
    const patch = "diff --git a/a.ts b/a.ts\n+value";

    expect(stripDiffTruncationMarker(`${patch}\n\n[truncated]\n`)).toBe(patch);
    expect(stripDiffTruncationMarker(patch)).toBe(patch);
  });
});

describe("buildPatchCacheKey", () => {
  it("normalizes outer whitespace before hashing", () => {
    const patch = "diff --git a/a.ts b/a.ts\n+console.log('hello')";

    expect(buildPatchCacheKey(`\n${patch}\n`)).toBe(buildPatchCacheKey(patch));
  });

  it("changes when diff content changes", () => {
    const before = "diff --git a/a.ts b/a.ts\n+console.log('hello')";
    const after = "diff --git a/a.ts b/a.ts\n+console.log('hello world')";

    expect(buildPatchCacheKey(before)).not.toBe(buildPatchCacheKey(after));
  });

  it("distinguishes trailing whitespace in the final source line", () => {
    const patch = "diff --git a/a.ts b/a.ts\n+value";
    expect(buildPatchCacheKey(`${patch}  \n`)).not.toBe(buildPatchCacheKey(`${patch}\n`));
  });

  it("changes when cache scope changes", () => {
    const patch = "diff --git a/a.ts b/a.ts\n+console.log('hello')";

    expect(buildPatchCacheKey(patch, "diff-panel:light")).not.toBe(
      buildPatchCacheKey(patch, "diff-panel:dark"),
    );
  });
});

describe("getRenderablePatch", () => {
  it.each(["", "\n"])("preserves source whitespace with patch terminator %j", (terminator) => {
    const patch =
      "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-before\n+after  ";
    const parsed = getRenderablePatch(stripDiffTruncationMarker(patch + terminator));
    if (parsed?.kind !== "files") throw new Error("Expected parsed patch");
    expect(parsed.files[0]?.additionLines).toEqual(["after  \n"]);
  });

  it("respects an explicit missing-file-newline marker", () => {
    const parsed = getRenderablePatch(
      "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-before\n+after\n\\ No newline at end of file",
    );
    if (parsed?.kind !== "files") throw new Error("Expected parsed patch");
    expect(parsed.files[0]?.additionLines).toEqual(["after"]);
  });

  it("compacts partial hunk render offsets for virtualized review diffs", () => {
    const patch = [
      "diff --git a/example.ts b/example.ts",
      "index 1111111..2222222 100644",
      "--- a/example.ts",
      "+++ b/example.ts",
      "@@ -48,4 +48,4 @@",
      " context",
      "-before",
      "+after",
      " context",
      " context",
      "@@ -80,3 +80,4 @@",
      " context",
      "+added",
      " context",
      " context",
    ].join("\n");

    const parsed = getRenderablePatch(patch, "review", {
      compactPartialHunkOffsets: true,
    });
    expect(parsed?.kind).toBe("files");
    if (parsed?.kind !== "files") return;

    const file = parsed.files[0];
    expect(file?.hunks[0]?.collapsedBefore).toBe(47);
    expect(file?.hunks[0]?.unifiedLineStart).toBe(0);
    expect(file?.hunks[1]?.collapsedBefore).toBeGreaterThan(0);
    expect(file?.hunks[1]?.unifiedLineStart).toBe(file?.hunks[0]?.unifiedLineCount);
    expect(file?.unifiedLineCount).toBe(
      file?.hunks.reduce((total, hunk) => total + hunk.unifiedLineCount, 0),
    );
  });

  it("retains source-file offsets for checkpoint diffs", () => {
    const patch = [
      "diff --git a/example.ts b/example.ts",
      "--- a/example.ts",
      "+++ b/example.ts",
      "@@ -48,1 +48,1 @@",
      "-before",
      "+after",
    ].join("\n");

    const parsed = getRenderablePatch(patch, "checkpoint");
    expect(parsed?.kind).toBe("files");
    if (parsed?.kind !== "files") return;
    expect(parsed.files[0]?.hunks[0]?.unifiedLineStart).toBe(47);
  });
});

describe("diff file reconciliation", () => {
  it("keeps Pierre's render key stable when a partial diff hydrates", () => {
    const patch = [
      "diff --git a/example.ts b/example.ts",
      "--- a/example.ts",
      "+++ b/example.ts",
      "@@ -1 +1 @@",
      "-before",
      "+after",
    ].join("\n");
    const parsed = getRenderablePatch(patch, "hydrated-key");
    expect(parsed?.kind).toBe("files");
    if (parsed?.kind !== "files") return;

    const file = parsed.files[0];
    expect(file).toBeDefined();
    if (!file) return;
    const key = buildFileDiffRenderKey(file);
    file.cacheKey = `${file.cacheKey}:hydrated`;

    expect(buildFileDiffRenderKey(file)).toBe(key);
  });

  it("keeps identities stable and versions local to the changed file", () => {
    const patch = (secondLine: string) =>
      [
        "diff --git a/unchanged.ts b/unchanged.ts",
        "--- a/unchanged.ts",
        "+++ b/unchanged.ts",
        "@@ -1 +1 @@",
        "-before",
        "+after",
        "diff --git a/changed.ts b/changed.ts",
        "--- a/changed.ts",
        "+++ b/changed.ts",
        "@@ -1 +1 @@",
        "-old",
        `+${secondLine}`,
      ].join("\n");
    const before = getRenderablePatch(patch("new"), "before");
    const after = getRenderablePatch(patch("newer"), "after");
    expect(before?.kind).toBe("files");
    expect(after?.kind).toBe("files");
    if (before?.kind !== "files" || after?.kind !== "files") return;

    const [beforeUnchanged, beforeChanged] = before.files;
    const [afterUnchanged, afterChanged] = after.files;
    expect(beforeUnchanged).toBeDefined();
    expect(beforeChanged).toBeDefined();
    expect(afterUnchanged).toBeDefined();
    expect(afterChanged).toBeDefined();
    if (!beforeUnchanged || !beforeChanged || !afterUnchanged || !afterChanged) return;

    expect(buildFileDiffIdentityKey(afterUnchanged)).toBe(
      buildFileDiffIdentityKey(beforeUnchanged),
    );
    expect(buildFileDiffIdentityKey(afterChanged)).toBe(buildFileDiffIdentityKey(beforeChanged));
    expect(buildFileDiffContentVersion(afterUnchanged)).toBe(
      buildFileDiffContentVersion(beforeUnchanged),
    );
    expect(buildFileDiffContentVersion(afterChanged)).not.toBe(
      buildFileDiffContentVersion(beforeChanged),
    );
  });
});

describe("getDiffLineStat", () => {
  it("totals additions and deletions across every file and hunk", () => {
    const patch = [
      "diff --git a/example.ts b/example.ts",
      "--- a/example.ts",
      "+++ b/example.ts",
      "@@ -1,2 +1,3 @@",
      "-before",
      "+after",
      "+added",
      " context",
      "@@ -10,2 +11,1 @@",
      "-removed",
      " context",
      "diff --git a/README.md b/README.md",
      "--- a/README.md",
      "+++ b/README.md",
      "@@ -1 +1,2 @@",
      " title",
      "+description",
    ].join("\n");

    const parsed = getRenderablePatch(patch);
    expect(parsed?.kind).toBe("files");
    if (parsed?.kind !== "files") return;

    expect(getDiffLineStat(parsed.files)).toEqual({ additions: 3, deletions: 2 });
  });
});
