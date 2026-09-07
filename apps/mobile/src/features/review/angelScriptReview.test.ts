import { expect, it } from "vite-plus/test";
import { parseAngelScriptApi } from "@t3tools/shared/angelscript";
import { prepareAngelScriptReview } from "./angelScriptReview";
import type { NativeReviewDiffData } from "./nativeReviewDiffAdapter";

it("marks await rows on both diff sides while preserving add/delete markers", () => {
  const data: NativeReviewDiffData = {
    files: [
      { id: "script", path: "test.as", language: "diff", additions: 1, deletions: 1, loaded: true },
    ],
    rows: [
      {
        kind: "line",
        id: "declaration",
        fileId: "script",
        content: "Shot@ s;",
        change: "context",
        oldLineNumber: 1,
        newLineNumber: 1,
      },
      {
        kind: "line",
        id: "old",
        fileId: "script",
        content: "s.wait(1);",
        change: "delete",
        oldLineNumber: 2,
      },
      {
        kind: "line",
        id: "new",
        fileId: "script",
        content: "s.wait(2);",
        change: "add",
        newLineNumber: 2,
      },
    ],
    commentTargetsByRowId: new Map(),
    rowIdByCommentLineId: new Map(),
    additions: 1,
    deletions: 1,
  };
  const api = parseAngelScriptApi("class Shot { void wait(float); /** await */ }");
  const result = prepareAngelScriptReview(data, api, "dark");
  expect(result.data.files[0]!.language).toBe("angelscript");
  expect(result.data.rows.slice(1).map((row) => [row.change, row.awaitBackground])).toEqual([
    ["delete", "#343225"],
    ["add", "#343225"],
  ]);
  const withoutApi = prepareAngelScriptReview(data, null, "dark");
  expect(withoutApi.data.files[0]!.language).toBe("angelscript");
  expect(withoutApi.data.rows).toBe(data.rows);
  expect(withoutApi.semantics.size).toBe(0);
});
