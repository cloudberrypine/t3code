import { describe, expect, it } from "vite-plus/test";
import { getDiffStatTotals } from "./diffStatFilter";

const files = Object.freeze([
  Object.freeze({ path: "src/app.ts", additions: 300, deletions: 200 }),
  Object.freeze({ path: "pnpm-lock.yaml", additions: 900, deletions: 600 }),
]);

describe("getDiffStatTotals", () => {
  it("excludes assets/meshes recursively only from the filtered total", () => {
    const changes = Object.freeze([
      Object.freeze({ path: "assets/meshes/otter.obj", additions: 100, deletions: 50 }),
      Object.freeze({ path: "assets/meshes/river/rocks/rock.obj", additions: 200, deletions: 100 }),
      Object.freeze({ path: "assets/textures/otter.txt", additions: 10, deletions: 5 }),
      Object.freeze({ path: "src/assets/meshes/example.ts", additions: 20, deletions: 10 }),
    ]);
    expect(getDiffStatTotals(changes, "assets/meshes/\n")).toEqual({
      full: { additions: 330, deletions: 165 },
      filtered: { additions: 30, deletions: 15 },
    });
    expect(changes.map((file) => file.path)).toEqual([
      "assets/meshes/otter.obj",
      "assets/meshes/river/rocks/rock.obj",
      "assets/textures/otter.txt",
      "src/assets/meshes/example.ts",
    ]);
  });

  it("retains the full total and file data while calculating a second total", () => {
    expect(getDiffStatTotals(files, "pnpm-lock.yaml")).toEqual({
      full: { additions: 1200, deletions: 800 },
      filtered: { additions: 300, deletions: 200 },
    });
    expect(files).toHaveLength(2);
    expect(files[1]).toEqual({ path: "pnpm-lock.yaml", additions: 900, deletions: 600 });
  });

  it("shows only the full total when the file is absent or removed", () => {
    expect(getDiffStatTotals(files).filtered).toBeUndefined();
    expect(getDiffStatTotals(files, "*").filtered).toEqual({ additions: 0, deletions: 0 });
    expect(getDiffStatTotals(files)).toEqual({
      full: { additions: 1200, deletions: 800 },
      filtered: undefined,
    });
  });

  it.each(["", "# No exclusions yet\n\n", "assets/meshes/", "*\n!*"])(
    "omits the second total when rules %j do not change the counts",
    (patterns) => {
      expect(getDiffStatTotals(files, patterns)).toEqual({
        full: { additions: 1200, deletions: 800 },
        filtered: undefined,
      });
    },
  );

  it("omits the second total when matched files have zero line changes", () => {
    expect(
      getDiffStatTotals(
        [...files, { path: "assets/meshes/otter.glb", additions: 0, deletions: 0 }],
        "assets/meshes/",
      ).filtered,
    ).toBeUndefined();
  });

  it.each([
    { additions: 1, deletions: 0 },
    { additions: 0, deletions: 1 },
  ])("shows the second total when only one count differs: %j", (stat) => {
    expect(
      getDiffStatTotals([{ path: "assets/meshes/otter.obj", ...stat }], "assets/meshes/"),
    ).toEqual({ full: stat, filtered: { additions: 0, deletions: 0 } });
  });

  it.each([
    ["generated/", ["generated/a.ts", "src/generated/b.ts"], ["generated.ts"]],
    ["/generated/", ["generated/a.ts"], ["src/generated/b.ts"]],
    ["**/*.snap\n!important.snap", ["test/a.snap", "other.snap"], ["important.snap", "app.ts"]],
    ["build/*\n!build/keep.ts", ["build/a.ts", "build/nested/b.ts"], ["build/keep.ts"]],
    ["# comment\r\n\r\n*.map\r\n", ["app.js.map"], ["src/app.ts"]],
    ["\\#file\n\\!file\nfile\\ ", ["#file", "!file", "file "], ["file", "normal"]],
    ["*.snap\n!keep.snap\nkeep.snap", ["keep.snap", "a.snap"], ["app.ts"]],
    ["removed.txt", ["removed.txt"], ["src/current.txt"]],
    ["/generated.txt", ["generated.txt"], ["Generated.txt", "src/generated.txt"]],
  ])("honors gitignore rules %j", (patterns, excluded, included) => {
    const entries = [...excluded, ...included].map((path) => ({
      path,
      additions: 2,
      deletions: 3,
    }));
    expect(getDiffStatTotals(entries, patterns)).toEqual({
      full: { additions: entries.length * 2, deletions: entries.length * 3 },
      filtered: { additions: included.length * 2, deletions: included.length * 3 },
    });
  });

  it("keeps unknown paths in totals without failing the diff view", () => {
    const entries = ["", "/outside.txt", "../outside.txt"].map((path) => ({
      path,
      additions: 1,
      deletions: 2,
    }));
    expect(getDiffStatTotals(entries, "*")).toEqual({
      full: { additions: 3, deletions: 6 },
      filtered: undefined,
    });
  });
});
