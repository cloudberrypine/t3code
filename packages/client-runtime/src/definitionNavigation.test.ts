import { parseAngelScriptApi } from "@t3tools/shared/angelscript";
import { expect, it, vi } from "vite-plus/test";

import { resolveDefinitions, supportsDefinitionNavigation } from "./definitionNavigation.ts";

function reader(files: Record<string, string>) {
  return {
    read: vi.fn(async (relativePath: string) => {
      const contents = files[relativePath];
      return contents === undefined
        ? null
        : { relativePath, contents, byteLength: contents.length, truncated: false };
    }),
    search: vi.fn(async (query: string) => ({
      matches: Object.entries(files).flatMap(([path, contents]) =>
        contents
          .split("\n")
          .flatMap((lineContent, i) =>
            new RegExp(query).test(lineContent)
              ? [{ path, lineNumber: i + 1, lineContent, matchRanges: [] }]
              : [],
          ),
      ),
      truncated: false,
    })),
    findFiles: vi.fn(async (name: string) => ({
      entries: Object.keys(files)
        .filter((path) => path.split("/").at(-1) === name)
        .map((path) => ({ path, kind: "file" as const })),
      truncated: false,
    })),
  };
}

it("resolves C++ through the environment reads and lists equal-ranked overloads", async () => {
  const files = {
    "src/math.cpp":
      "int scale(int value) { return value; }\nfloat scale(float value) { return value; }",
    "src/main.cpp": "void run() { int value = scale(2); }",
  };
  const source = { path: "src/main.cpp", contents: files["src/main.cpp"] };
  expect(
    await resolveDefinitions({
      source,
      offset: source.contents.indexOf("scale"),
      api: null,
      ...reader(files),
    }),
  ).toEqual([
    { path: "src/math.cpp", line: 1 },
    { path: "src/math.cpp", line: 2 },
  ]);
  expect(
    await resolveDefinitions({
      source,
      offset: source.contents.indexOf("value"),
      api: null,
      ...reader(files),
    }),
  ).toEqual([{ path: "src/main.cpp", line: 1 }]);
});

it("falls back from the C++ bridge to AngelScript declarations", async () => {
  const apiSource = "void print(int value);\nvoid print(string value);";
  const api = parseAngelScriptApi(apiSource);
  api.source = { path: "scripts/ScriptingAPI.as", contents: apiSource };
  const source = { path: "scripts/main.as", contents: "void main() {\n  print(1);\n}" };
  expect(supportsDefinitionNavigation(source, api)).toBe(true);
  expect(supportsDefinitionNavigation({ path: "README.md", contents: "# Hi" }, api)).toBe(false);
  const definitions = await resolveDefinitions({
    source,
    offset: source.contents.indexOf("print"),
    api,
    ...reader({}),
  });
  expect(definitions).toEqual([
    { path: "scripts/ScriptingAPI.as", line: 1 },
    { path: "scripts/ScriptingAPI.as", line: 2 },
  ]);
  expect(
    await resolveDefinitions({
      source,
      offset: source.contents.indexOf("main"),
      api,
      ...reader({}),
    }),
  ).toEqual([{ path: "scripts/main.as", line: 1 }]);
});
