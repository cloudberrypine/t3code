import { describe, expect, it } from "vite-plus/test";

import {
  listSidebarParentCandidates,
  mostUrgentThreadGroupStatus,
  nestThreads,
} from "./threadNesting.ts";

const thread = (
  id: string,
  options: {
    readonly parent?: string | null;
    readonly createdAt?: string;
    readonly projectId?: string;
    readonly environmentId?: string;
    readonly settled?: boolean;
    readonly updatedAt?: string;
  } = {},
) => ({
  environmentId: options.environmentId ?? "env",
  id,
  projectId: options.projectId ?? "project",
  sidebarParentThreadId: options.parent ?? null,
  createdAt: options.createdAt ?? "2026-10-08T09:00:00.000Z",
  updatedAt: options.updatedAt ?? "2026-10-08T09:00:00.000Z",
  title: id,
  archivedAt: null,
  settledOverride: options.settled ? ("settled" as const) : null,
  lineage: { relationshipToParent: null },
});

const ids = (threads: ReadonlyArray<{ readonly id: string }> | undefined) =>
  threads?.map((entry) => entry.id);

describe("nestThreads", () => {
  it("moves children under their parent across sections, oldest first", () => {
    const parent = thread("c2");
    const owl = thread("owl", { parent: "c2", createdAt: "2026-10-08T09:30:18.000Z" });
    const beetle = thread("beetle", { parent: "c2", createdAt: "2026-10-08T09:30:32.000Z" });
    const other = thread("other");
    const nesting = nestThreads([[parent], [beetle, other], [owl]]);

    expect(nesting.sections.map(ids)).toEqual([["c2"], ["other"], []]);
    expect(ids(nesting.childrenByParent.get(parent))).toEqual(["owl", "beetle"]);
  });

  it("keeps a child on its own when its parent is not in a grouping section", () => {
    const child = thread("paca", { parent: "varzea" });
    const nesting = nestThreads([[child]]);

    expect(nesting.sections.map(ids)).toEqual([["paca"]]);
    expect(nesting.childrenByParent.size).toBe(0);
  });

  it("does not nest across projects or environments", () => {
    const parent = thread("c2");
    const otherProject = thread("a", { parent: "c2", projectId: "elsewhere" });
    const otherEnvironment = thread("b", { parent: "c2", environmentId: "remote" });
    const nesting = nestThreads([[parent, otherProject, otherEnvironment]]);

    expect(nesting.sections.map(ids)).toEqual([["c2", "a", "b"]]);
  });

  it("stays one level deep: chains stop at the first level and cycles show flat", () => {
    const root = thread("root");
    const middle = thread("middle", { parent: "root" });
    const leaf = thread("leaf", { parent: "middle" });
    const chain = nestThreads([[root, middle, leaf]]);
    expect(chain.sections.map(ids)).toEqual([["root", "leaf"]]);
    expect(ids(chain.childrenByParent.get(root))).toEqual(["middle"]);

    const cycle = nestThreads([[thread("a", { parent: "b" }), thread("b", { parent: "a" })]]);
    expect(cycle.sections.map(ids)).toEqual([["a", "b"]]);
  });
});

describe("listSidebarParentCandidates", () => {
  it("offers unsettled top-level threads of the same project, newest first", () => {
    const self = thread("paca", { parent: "orchestrator" });
    const threads = [
      self,
      thread("orchestrator", { updatedAt: "2026-10-08T10:00:00.000Z" }),
      thread("varzea", { updatedAt: "2026-10-08T11:00:00.000Z" }),
      thread("c2", { updatedAt: "2026-10-08T09:00:00.000Z" }),
      thread("done", { settled: true }),
      thread("nested", { parent: "c2" }),
      thread("elsewhere", { projectId: "other" }),
    ];

    expect(ids(listSidebarParentCandidates(threads, self))).toEqual(["varzea", "c2"]);
  });

  it("offers nothing to a thread that already holds children", () => {
    const parent = thread("c2");
    expect(
      listSidebarParentCandidates([parent, thread("owl", { parent: "c2" }), thread("b1")], parent),
    ).toEqual([]);
  });
});

describe("mostUrgentThreadGroupStatus", () => {
  it("shows what most needs the user", () => {
    expect(mostUrgentThreadGroupStatus([null, "done", "working"])).toBe("working");
    expect(mostUrgentThreadGroupStatus(["working", "attention", "failed"])).toBe("attention");
    expect(mostUrgentThreadGroupStatus([null, null])).toBeNull();
  });
});
