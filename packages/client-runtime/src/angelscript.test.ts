import { expect, it } from "vite-plus/test";
import { createApiStore, type ScriptingApiReader } from "./angelscript";

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
