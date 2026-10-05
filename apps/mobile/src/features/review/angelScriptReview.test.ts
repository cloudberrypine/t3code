import { expect, it } from "vite-plus/test";
import { parseAngelScriptApi } from "@t3tools/shared/angelscript";
import { prepareAngelScriptReview } from "./angelScriptReview";
import type { NativeReviewDiffData } from "./nativeReviewDiffAdapter";

it.each([
  { name: "component waits", old: "s.wait(1);", next: "s.wait(2);" },
  { name: "deadline waits", old: "WaitUntil(1);", next: "WaitUntil(2);" },
])("marks $name on both diff sides while preserving add/delete markers", ({ old, next }) => {
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
        content: old,
        change: "delete",
        oldLineNumber: 2,
      },
      {
        kind: "line",
        id: "new",
        fileId: "script",
        content: next,
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

it("uses implicit native getters and HSM calls in mobile diff highlighting", () => {
  const contents = [
    "behavior Otter {",
    "state Main { void run() { Dive(); w.Wait(); } }",
    "state Dive { void run() {} }",
    "}",
  ];
  const data: NativeReviewDiffData = {
    files: [
      {
        id: "script",
        path: "Otter.as",
        language: "diff",
        additions: 0,
        deletions: 0,
        loaded: true,
      },
    ],
    rows: contents.map((content, i) => ({
      kind: "line",
      id: String(i),
      fileId: "script",
      content,
      change: "context",
      oldLineNumber: i + 1,
      newLineNumber: i + 1,
    })),
    commentTargetsByRowId: new Map(),
    rowIdByCommentLineId: new Map(),
    additions: 0,
    deletions: 0,
  };
  const result = prepareAngelScriptReview(
    data,
    parseAngelScriptApi("World@ get_w(); class World { void Wait(); /** await */ }"),
    "dark",
  );
  expect(result.data.rows[1]?.awaitBackground).toBe("#343225");
  expect(
    result.semantics
      .get("1")
      ?.filter((t) => t.kind === "await")
      .map((t) => contents[1]!.slice(t.start, t.end)),
  ).toEqual(["Dive", "Wait"]);
});

it("highlights sparse native diff rows using their own complete revisions", async () => {
  const { createAngelScriptRevisionSemantics } = await import("@t3tools/shared/angelscript");
  const api = parseAngelScriptApi("");
  const oldContents =
    "namespace Otter {\nstate Main { void run() { Rest(); } }\nstate Rest { void run() {} }\n}";
  const newContents = oldContents.replaceAll("Rest", "Dive");
  const data: NativeReviewDiffData = {
    files: [
      {
        id: "script",
        path: "Otter.as",
        language: "diff",
        additions: 1,
        deletions: 1,
        loaded: true,
      },
    ],
    rows: [
      {
        kind: "line",
        id: "old",
        fileId: "script",
        content: oldContents.split("\n")[1]!,
        change: "delete",
        oldLineNumber: 2,
      },
      {
        kind: "line",
        id: "new",
        fileId: "script",
        content: newContents.split("\n")[1]!,
        change: "add",
        newLineNumber: 2,
      },
    ],
    commentTargetsByRowId: new Map(),
    rowIdByCommentLineId: new Map(),
    additions: 1,
    deletions: 1,
  };
  const revisions = new Map([
    ["Otter.as", createAngelScriptRevisionSemantics({ oldContents, newContents }, api)],
  ]);
  const result = prepareAngelScriptReview(data, api, "dark", revisions);
  expect(result.data.rows.map((row) => [row.change, row.awaitBackground])).toEqual([
    ["delete", "#343225"],
    ["add", "#343225"],
  ]);
  expect(
    result.semantics
      .get("old")
      ?.filter((t) => t.kind === "await")
      .map((t) => data.rows[0]!.content!.slice(t.start, t.end)),
  ).toEqual(["Rest"]);
  expect(
    result.semantics
      .get("new")
      ?.filter((t) => t.kind === "await")
      .map((t) => data.rows[1]!.content!.slice(t.start, t.end)),
  ).toEqual(["Dive"]);
});
