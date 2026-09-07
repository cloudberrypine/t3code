import type { FileDiffMetadata } from "@pierre/diffs";
import { describe, expect, it } from "vite-plus/test";

import {
  buildDiffFileTreeUpdates,
  collectDirectoryPaths,
  diffFileTreeEntries,
  reviewDiffFileTreeEntries,
} from "./diffFileTree.logic";

function file(type: FileDiffMetadata["type"], name: string, prevName = name): FileDiffMetadata {
  return { type, name: `b/${name}`, prevName: `a/${prevName}` } as FileDiffMetadata;
}

describe("diffFileTreeEntries", () => {
  it("maps each change type to its git status under the file's current path", () => {
    expect(
      diffFileTreeEntries([
        file("new", "src/a.ts"),
        file("deleted", "src/b.ts"),
        file("rename-pure", "src/c.ts", "src/old-c.ts"),
        file("rename-changed", "src/d.ts", "src/old-d.ts"),
        file("change", "README.md"),
      ]),
    ).toEqual([
      { path: "src/a.ts", status: "added" },
      { path: "src/b.ts", status: "deleted" },
      { path: "src/c.ts", status: "renamed" },
      { path: "src/d.ts", status: "renamed" },
      { path: "README.md", status: "modified" },
    ]);
  });
});

describe("reviewDiffFileTreeEntries", () => {
  it("lists manifest files even when their patches were omitted", () => {
    expect(
      reviewDiffFileTreeEntries([
        {
          changeType: "rename-changed",
          oldPath: "src/old.ts",
          newPath: "src/new.ts",
          additions: 2,
          deletions: 1,
          patchIncluded: false,
          isUntracked: false,
        },
        {
          changeType: "new",
          oldPath: "notes.txt",
          newPath: "notes.txt",
          additions: 4,
          deletions: 0,
          patchIncluded: true,
          isUntracked: true,
        },
      ]),
    ).toEqual([
      { path: "src/new.ts", status: "renamed", loadState: "unloaded" },
      { path: "notes.txt", status: "added", loadState: "loaded" },
    ]);
  });

  it("identifies files that are loading, loaded on demand, or ready to retry", () => {
    const files = [
      {
        changeType: "change" as const,
        oldPath: "loaded.ts",
        newPath: "loaded.ts",
        additions: 1,
        deletions: 1,
        patchIncluded: false,
        isUntracked: false,
      },
      {
        changeType: "change" as const,
        oldPath: "loading.ts",
        newPath: "loading.ts",
        additions: 1,
        deletions: 1,
        patchIncluded: false,
        isUntracked: false,
      },
      {
        changeType: "change" as const,
        oldPath: "failed.ts",
        newPath: "failed.ts",
        additions: 1,
        deletions: 1,
        patchIncluded: false,
        isUntracked: false,
      },
    ];

    expect(
      reviewDiffFileTreeEntries(
        files,
        new Set(["loaded.ts"]),
        new Set(["loading.ts"]),
        "failed.ts",
      ).map((entry) => [entry.path, entry.loadState]),
    ).toEqual([
      ["loaded.ts", "loaded"],
      ["loading.ts", "loading"],
      ["failed.ts", "error"],
    ]);
  });
});

describe("collectDirectoryPaths", () => {
  it("lists every ancestor once, parents first, with Pierre's trailing slash", () => {
    expect(collectDirectoryPaths(["apps/web/src/a.ts", "apps/web/b.ts", "README.md"])).toEqual([
      "apps/",
      "apps/web/",
      "apps/web/src/",
    ]);
  });
});

describe("buildDiffFileTreeUpdates", () => {
  it("adds a new file's directories before the file", () => {
    expect(buildDiffFileTreeUpdates(["README.md"], ["README.md", "src/lib/a.ts"])).toEqual([
      { type: "add", path: "src/" },
      { type: "add", path: "src/lib/" },
      { type: "add", path: "src/lib/a.ts" },
    ]);
  });

  it("removes files before their now-empty directories, deepest first", () => {
    expect(buildDiffFileTreeUpdates(["src/lib/a.ts", "src/b.ts"], ["src/b.ts"])).toEqual([
      { type: "remove", path: "src/lib/a.ts" },
      { type: "remove", path: "src/lib/", recursive: true },
    ]);
  });

  it("keeps a directory that still holds a file", () => {
    expect(buildDiffFileTreeUpdates(["src/a.ts", "src/b.ts"], ["src/b.ts"])).toEqual([
      { type: "remove", path: "src/a.ts" },
    ]);
  });

  it("produces nothing when the paths are unchanged", () => {
    expect(buildDiffFileTreeUpdates(["src/a.ts"], ["src/a.ts"])).toEqual([]);
  });
});
