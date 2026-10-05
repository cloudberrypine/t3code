import { expect, it } from "vite-plus/test";
import { parseAngelScriptApi } from "@t3tools/shared/angelscript";
import {
  createApiStore,
  resolveAngelScriptNavigation,
  type ScriptingApiReader,
} from "./angelscript.js";

it("deduplicates concurrent reads, refreshes revisions and drops symbols when an API disappears", async () => {
  let revision = "1";
  let present = true;
  let reads = 0;
  const reader: ScriptingApiReader = {
    discover: async () => ({
      truncated: false,
      entries: present ? [{ kind: "file", path: "generated/ScriptingAPI.as", revision }] : [],
    }),
    read: async (relativePath) => {
      reads++;
      return {
        relativePath,
        contents: `class Version${revision} {}`,
        byteLength: 20,
        truncated: false,
      };
    },
  };
  const store = createApiStore();
  await Promise.all([store.refresh(reader), store.refresh(reader)]);
  expect(reads).toBe(1);
  expect(store.snapshot()?.source?.path).toBe("generated/ScriptingAPI.as");
  await store.refresh(reader);
  expect(reads).toBe(1);
  revision = "2";
  await store.refresh(reader);
  expect([...store.snapshot()!.types]).toEqual(["Version2"]);
  const otherWorktree = createApiStore();
  expect(otherWorktree.snapshot()).toBeNull();
  present = false;
  await store.refresh(reader);
  expect([...store.snapshot()!.types]).toEqual([]);
  expect(store.snapshot()?.source).toBeUndefined();
});

it("navigates to includes and qualified symbols using the supplied environment reader", async () => {
  const calls: string[] = [];
  const read: ScriptingApiReader["read"] = async (path) => {
    calls.push(path);
    return {
      relativePath: path,
      contents: "namespace Bee {\n class Object {}\n}",
      byteLength: 40,
      truncated: false,
    };
  };
  expect(
    await resolveAngelScriptNavigation({
      source: { path: "scripts/main.as", contents: '#include "Bee.as"' },
      offset: 11,
      api: null,
      read,
    }),
  ).toEqual({ path: "scripts/Bee.as", line: 1 });
  expect(
    await resolveAngelScriptNavigation({
      source: { path: "scripts/main.as", contents: "Bee::Object obj;" },
      offset: 5,
      api: null,
      read,
    }),
  ).toEqual({ path: "scripts/Bee.as", line: 2 });
  expect(calls).toEqual(["scripts/Bee.as", "scripts/Bee.as"]);
});

it("does not navigate into missing or truncated files, or substitute files for unresolved symbols", async () => {
  const source = { path: "scripts/main.as", contents: "Bee::Missing obj;" };
  const file = {
    relativePath: "scripts/Bee.as",
    contents: "namespace Bee {}",
    byteLength: 20,
    truncated: false,
  };
  for (const result of [null, file, { ...file, truncated: true }]) {
    expect(
      await resolveAngelScriptNavigation({
        source,
        offset: 5,
        api: null,
        read: async () => result,
      }),
    ).toBeNull();
  }
});

it("follows members of qualified types defined in a referenced behavior script", async () => {
  const source = {
    path: "scripts/main.as",
    contents:
      '#include "AntNest.as"\nvoid run(Context@ c) {\n AntNest::Object@ obj = c.getObject<AntNest::Object>();\n obj.antCount++;\n}',
  };
  const apiText = "class Context { T@ getObject<T>(); }";
  const api = {
    ...parseAngelScriptApi(apiText),
    source: { path: "scripts/ScriptingAPI.as", contents: apiText },
  };
  expect(
    await resolveAngelScriptNavigation({
      source,
      api,
      offset: source.contents.lastIndexOf("antCount"),
      read: async (path) =>
        path === "scripts/AntNest.as"
          ? {
              relativePath: path,
              contents: "namespace AntNest {\n class Object {\n int antCount;\n }\n}",
              byteLength: 65,
              truncated: false,
            }
          : null,
    }),
  ).toEqual({ path: "scripts/AntNest.as", line: 3 });
});

it("does not use a fuzzy match or choose arbitrarily between multiple API files", async () => {
  let reads = 0;
  const store = createApiStore();
  await store.refresh({
    discover: async () => ({
      truncated: false,
      entries: [{ kind: "file", path: "NotScriptingAPI.as" }],
    }),
    read: async () => {
      reads++;
      return null;
    },
  });
  await store.refresh({
    discover: async () => ({
      truncated: false,
      entries: ["a", "b"].map((directory) => ({
        kind: "file",
        path: `${directory}/ScriptingAPI.as`,
      })),
    }),
    read: async () => {
      reads++;
      return null;
    },
  });
  expect(reads).toBe(0);
});

it("loads library tree definitions and filenames only from the caller's environment", async () => {
  const source = {
    path: "scripts/Otter.as",
    contents:
      '#include "Life.as"\n// State tree (generated; update with --check-script <file> --write-tree):\n//   Captured\n//   `-- AwaitRelease (Life.as)\nnamespace Otter {}',
  };
  const reads: string[] = [];
  const read: ScriptingApiReader["read"] = async (path) => {
    reads.push(path);
    return path === "scripts/Life.as"
      ? {
          relativePath: path,
          contents: "namespace Life {\n state Captured {}\n state AwaitRelease {}\n}",
          byteLength: 70,
          truncated: false,
        }
      : null;
  };
  for (const [offset, line] of [
    [source.contents.indexOf("Captured"), 2],
    [source.contents.indexOf("AwaitRelease"), 3],
    [source.contents.lastIndexOf("Life.as"), 1],
  ]) {
    expect(
      await resolveAngelScriptNavigation({ source, api: null, offset: offset!, read }),
    ).toEqual({ path: "scripts/Life.as", line });
  }
  expect(reads).toEqual(["scripts/Life.as", "scripts/Life.as", "scripts/Life.as"]);
});

it("follows implicit Object properties into types declared by an include", async () => {
  const source = {
    path: "scripts/Otter.as",
    contents: '#include "Data.as"\nnamespace Otter { state Main { void run() { o.target; } } }',
  };
  expect(
    await resolveAngelScriptNavigation({
      source,
      api: null,
      offset: source.contents.indexOf("target"),
      read: async (path) => ({
        relativePath: path,
        contents: "namespace Otter {\n class Object { uint64 target; }\n}",
        byteLength: 60,
        truncated: false,
      }),
    }),
  ).toEqual({ path: "scripts/Data.as", line: 2 });
});

it("finds species Object members through transitive lifecycle includes and terminates cycles", async () => {
  const source = {
    path: "scripts/Frog.as",
    contents: '#include "Clutch.as"\nnamespace Frog { void run() { o.prey; } }',
  };
  const contents: Record<string, string> = {
    "scripts/Clutch.as": '#include "Lifecycle.as"\nnamespace Clutch { class Object {} }',
    "scripts/Lifecycle.as":
      '#include "Frog.as"\nnamespace Frog {\n class Object { uint64 prey; }\n}',
  };
  const reads: string[] = [];
  const result = await resolveAngelScriptNavigation({
    source,
    api: null,
    offset: source.contents.indexOf("prey"),
    read: async (path) => {
      reads.push(path);
      return contents[path]
        ? {
            relativePath: path,
            contents: contents[path],
            truncated: false,
            byteLength: contents[path].length,
          }
        : null;
    },
  });
  expect(result).toEqual({ path: "scripts/Lifecycle.as", line: 3 });
  expect(reads).toEqual(["scripts/Clutch.as", "scripts/Lifecycle.as"]);
});

it("bounds dependency reads on an unending include graph", async () => {
  const source = {
    path: "scripts/Main.as",
    contents: '#include "1.as"\nnamespace Main { void run() { o.missing; } }',
  };
  let reads = 0;
  expect(
    await resolveAngelScriptNavigation({
      source,
      api: null,
      offset: source.contents.indexOf("missing"),
      read: async (path) => {
        reads++;
        const number = Number(path.split("/").at(-1)!.split(".")[0]);
        return {
          relativePath: path,
          contents: `#include "${number + 1}.as"`,
          byteLength: 30,
          truncated: false,
        };
      },
    }),
  ).toBeNull();
  expect(reads).toBeLessThanOrEqual(64);
});
