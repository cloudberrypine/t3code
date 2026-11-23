import { behaviourColors, createBehaviourRevisionSemantics } from "@t3tools/shared/behaviour";
import { describe, expect, it } from "vite-plus/test";

import {
  colorBehaviourReviewRow,
  prepareBehaviourReview,
  withBehaviourWaitRows,
} from "./behaviourReview";
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
    "gives %s's wait rows the wait background and colours their tokens",
    (path) => {
      const data = diff(path, contextRows(DUNG_IN_HOLLOW));
      const result = prepareBehaviourReview(data, "dark");
      expect(result.data.files[0]!.language).toBe("text");
      const background = behaviourColors.dark.waitBackground;
      expect(result.data.rows.map((row) => row.awaitBackground ?? null)).toEqual([
        null,
        background,
        null,
        null,
        null,
        background,
        background,
        null,
      ]);
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

  it("reads a context row's wait from the new side only", () => {
    // The old file opens `await any {` above the row; the new file no longer does.
    const data = diff("a.beh", [
      {
        kind: "line",
        id: "gone",
        fileId: "script",
        content: "  await any {",
        change: "delete",
        oldLineNumber: 1,
      },
      {
        kind: "line",
        id: "row",
        fileId: "script",
        content: "    log(x);",
        change: "context",
        oldLineNumber: 2,
        newLineNumber: 1,
      },
    ]);
    const background = behaviourColors.dark.waitBackground;
    expect(
      prepareBehaviourReview(data, "dark").data.rows.map((row) => row.awaitBackground ?? null),
    ).toEqual([background, null]);
  });

  it("marks a comment excerpt's waiting rows on each side", () => {
    const rows: NativeReviewDiffRow[] = [
      { kind: "line", id: "a", content: "  wait_for(1t);", change: "delete", oldLineNumber: 2 },
      { kind: "line", id: "b", content: "  foo();", change: "add", newLineNumber: 2 },
      { kind: "line", id: "c", content: "  await Rest();", change: "context", newLineNumber: 3 },
    ];
    const background = behaviourColors.light.waitBackground;
    expect(
      withBehaviourWaitRows(rows, "sloth.beh", "light").map((row) => row.awaitBackground ?? null),
    ).toEqual([background, null, background]);
    expect(withBehaviourWaitRows(rows, "Sloth.as", "light")).toBe(rows);
  });

  it("leaves other files alone", () => {
    const data = diff("Sloth.as", contextRows(DUNG_IN_HOLLOW));
    const result = prepareBehaviourReview(data, "light");
    expect(result.data).toBe(data);
    expect(result.semantics.size).toBe(0);
  });

  it("marks a hunk inside an await any block from its complete revisions", () => {
    const oldLines = [
      "state Rest() {",
      "  await any {",
      "    after(p.rest_duration);",
      "    event(Alarm);",
      "  }",
      "}",
    ];
    const newLines = oldLines.map((line) => line.replace("rest_duration", "nap_duration"));
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
    // Alone, the changed line reads as a plain statement.
    expect(
      prepareBehaviourReview(data, "light").data.rows.map((row) => row.awaitBackground ?? null),
    ).toEqual([null, null]);

    const revisions = new Map([
      [
        "Sloth.beh",
        createBehaviourRevisionSemantics({
          oldContents: oldLines.join("\n"),
          newContents: newLines.join("\n"),
        }),
      ],
    ]);
    const result = prepareBehaviourReview(data, "light", revisions);
    const background = behaviourColors.light.waitBackground;
    expect(result.data.rows.map((row) => [row.change, row.awaitBackground])).toEqual([
      ["delete", background],
      ["add", background],
    ]);
    expect(
      result.semantics
        .get("new")
        ?.map((token) => [newLines[2]!.slice(token.start, token.end), token.kind]),
    ).toContainEqual(["nap_duration", "param"]);
  });

  it("falls back to the hunk when a revision does not match the row", () => {
    const data = diff("Sloth.beh", contextRows(DUNG_IN_HOLLOW.slice(0, 2)));
    const revisions = new Map([
      [
        "Sloth.beh",
        createBehaviourRevisionSemantics({ oldContents: "other", newContents: "other" }),
      ],
    ]);
    const result = prepareBehaviourReview(data, "light", revisions);
    expect(result.data.rows[1]!.awaitBackground).toBe(behaviourColors.light.waitBackground);
  });
});
