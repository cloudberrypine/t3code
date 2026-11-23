import { behaviourColors, createBehaviourRevisionSemantics } from "@t3tools/shared/behaviour";
import { describe, expect, it } from "vite-plus/test";

import { colorBehaviourReviewRow, prepareBehaviourReview } from "./behaviourReview";
import type { NativeReviewDiffData } from "./nativeReviewDiffAdapter";
import type { NativeReviewDiffRow } from "../diffs/nativeReviewDiffSurface";

// The Sloth's DungInHollow, in the C-like syntax.
const DUNG_IN_HOLLOW = [
  "state DungInHollow(entity tree) {",
  "  wait_for(p.dig_duration);",
  "  if (!SlothDung::has_dung()) fail EmptyStomach;",
  "  entity dung = Pooping::spawn(poop_preset());",
  "  perform(DungAtTree, .at = self.position);  // 100 bp",
  "  wait_for(p.cover_duration);",
  "  await Cover(dung);",
  "}",
];

function diff(path: string, rows: NativeReviewDiffRow[]): NativeReviewDiffData {
  return {
    files: [{ id: "script", path, language: "text", additions: 0, deletions: 0 }],
    rows,
    commentTargetsByRowId: new Map(),
    rowIdByCommentLineId: new Map(),
    additions: 0,
    deletions: 0,
  };
}

const contextRows = (lines: readonly string[]): NativeReviewDiffRow[] =>
  lines.map((content, i) => ({
    kind: "line",
    id: String(i),
    fileId: "script",
    content,
    change: "context",
    oldLineNumber: i + 1,
    newLineNumber: i + 1,
  }));

describe("prepareBehaviourReview", () => {
  it.each(["Sloth.beh", "Sloth.pzb"])(
    "colours %s's rows as plain text with no wait row tint",
    (path) => {
      const data = diff(path, contextRows(DUNG_IN_HOLLOW));
      const result = prepareBehaviourReview(data);
      expect(result.data.files[0]!.language).toBe("text");
      expect(result.data.rows.every((row) => row.awaitBackground === undefined)).toBe(true);
      const kinds = (id: string) =>
        result.semantics
          .get(id)
          ?.map((token) => [DUNG_IN_HOLLOW[Number(id)]!.slice(token.start, token.end), token.kind]);
      expect(kinds("1")).toContainEqual(["wait_for", "wait"]);
      expect(kinds("1")).toContainEqual(["dig_duration", "param"]);
      expect(kinds("0")).toContainEqual(["DungInHollow", "state"]);
      expect(kinds("4")).toContainEqual(["// 100 bp", "comment"]);
      expect(kinds("6")).toContainEqual(["Cover", "state"]);

      // The plain-text row token splits at the semantic tokens, keeping all its text.
      const line = DUNG_IN_HOLLOW[1]!;
      const colored = colorBehaviourReviewRow(
        "1",
        [{ content: line, color: null, fontStyle: null }],
        result.semantics,
        "dark",
      )!;
      expect(colored.map((token) => token.content).join("")).toBe(line);
      expect(colored.find((token) => token.content === "wait_for")).toEqual({
        content: "wait_for",
        color: behaviourColors.dark.wait,
        fontStyle: 2,
      });
      expect(colorBehaviourReviewRow("missing", [], result.semantics, "dark")).toBeNull();
    },
  );

  it("reads a context row's colours from the new side only", () => {
    // The old file opens a block comment above the row; the new file no longer does.
    const data = diff("a.beh", [
      {
        kind: "line",
        id: "gone",
        fileId: "script",
        content: "  /* old",
        change: "delete",
        oldLineNumber: 1,
      },
      {
        kind: "line",
        id: "row",
        fileId: "script",
        content: "  log(x);",
        change: "context",
        oldLineNumber: 2,
        newLineNumber: 1,
      },
    ]);
    const kinds = prepareBehaviourReview(data)
      .semantics.get("row")
      ?.map((token) => token.kind);
    expect(kinds).toEqual(["function"]);
  });

  it("leaves other files alone", () => {
    const data = diff("Sloth.as", contextRows(DUNG_IN_HOLLOW));
    const result = prepareBehaviourReview(data);
    expect(result.data).toBe(data);
    expect(result.semantics.size).toBe(0);
  });

  it("reads a hunk inside a block comment from its complete revisions", () => {
    const oldLines = ["state Rest() {", "  /* a", "     wait_for(x); */", "}"];
    const newLines = oldLines.map((line) => line.replace("(x)", "(y)"));
    const data = diff("Sloth.beh", [
      {
        kind: "line",
        id: "old",
        fileId: "script",
        content: oldLines[2]!,
        change: "delete",
        oldLineNumber: 3,
      },
      {
        kind: "line",
        id: "new",
        fileId: "script",
        content: newLines[2]!,
        change: "add",
        newLineNumber: 3,
      },
    ]);
    // Alone, the changed line reads as a wait.
    expect(prepareBehaviourReview(data).semantics.get("new")?.[0]?.kind).toBe("wait");

    const revisions = new Map([
      [
        "Sloth.beh",
        createBehaviourRevisionSemantics({
          oldContents: oldLines.join("\n"),
          newContents: newLines.join("\n"),
        }),
      ],
    ]);
    const result = prepareBehaviourReview(data, revisions);
    expect(result.semantics.get("old")?.map((token) => token.kind)).toEqual(["comment"]);
    expect(result.semantics.get("new")?.map((token) => token.kind)).toEqual(["comment"]);
  });

  it("falls back to the hunk when a revision does not match the row", () => {
    const data = diff("Sloth.beh", contextRows(DUNG_IN_HOLLOW.slice(0, 2)));
    const revisions = new Map([
      [
        "Sloth.beh",
        createBehaviourRevisionSemantics({ oldContents: "other", newContents: "other" }),
      ],
    ]);
    const result = prepareBehaviourReview(data, revisions);
    expect(result.semantics.get("1")?.[0]?.kind).toBe("wait");
  });
});
