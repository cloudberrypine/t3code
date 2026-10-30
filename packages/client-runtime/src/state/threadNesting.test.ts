import { describe, expect, it } from "vite-plus/test";

import {
  listSidebarParentCandidates,
  mostUrgentThreadGroupStatus,
  nestThreads,
  threadDescendants,
  sidebarEnvironmentSections,
  orderSidebarEnvironments,
  moveSidebarEnvironment,
  threadAttentionStatus,
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

  it("bypasses hidden ancestors and keeps descendants attached to the nearest visible one", () => {
    const root = thread("root");
    const hidden = thread("hidden", { parent: "root" });
    const leaf = thread("leaf", { parent: "hidden" });
    const tree = nestThreads([[root, leaf]], [root, hidden, leaf]);
    expect(ids(tree.childrenByParent.get(root))).toEqual(["leaf"]);
  });

  it("does not nest across projects or environments", () => {
    const parent = thread("c2");
    const otherProject = thread("a", { parent: "c2", projectId: "elsewhere" });
    const otherEnvironment = thread("b", { parent: "c2", environmentId: "remote" });
    const nesting = nestThreads([[parent, otherProject, otherEnvironment]]);

    expect(nesting.sections.map(ids)).toEqual([["c2", "a", "b"]]);
  });

  it("keeps chains recursive and cycles visible", () => {
    const root = thread("root");
    const middle = thread("middle", { parent: "root" });
    const leaf = thread("leaf", { parent: "middle" });
    const chain = nestThreads([[root, middle, leaf]]);
    expect(chain.sections.map(ids)).toEqual([["root"]]);
    expect(ids(chain.childrenByParent.get(root))).toEqual(["middle"]);
    expect(ids(chain.childrenByParent.get(middle))).toEqual(["leaf"]);
    expect(ids(threadDescendants(root, chain.childrenByParent))).toEqual(["middle", "leaf"]);

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

    expect(ids(listSidebarParentCandidates(threads, self))).toEqual(["varzea", "c2", "nested"]);
  });

  it("offers valid parents for a whole subtree", () => {
    const parent = thread("c2");
    expect(
      listSidebarParentCandidates([parent, thread("owl", { parent: "c2" }), thread("b1")], parent),
    ).toEqual([thread("b1")]);
  });
});

describe("mostUrgentThreadGroupStatus", () => {
  it("shows what most needs the user", () => {
    expect(mostUrgentThreadGroupStatus([null, "done", "working"])).toBe("working");
    expect(mostUrgentThreadGroupStatus(["working", "attention", "failed"])).toBe("attention");
    expect(mostUrgentThreadGroupStatus([null, null])).toBeNull();
  });
});

describe("computer sections", () => {
  it("keeps pins ahead of active rows inside each computer, preserving local order", () => {
    const m1Pin = thread("lead1", { environmentId: "M1" });
    const m5Pin = thread("lead5", { environmentId: "M5" });
    const m1Active = thread("active1", { environmentId: "M1" });
    const m5Active = thread("active5", { environmentId: "M5" });
    const sections = sidebarEnvironmentSections(
      ["M1", "M5"],
      [
        [m5Pin, m1Pin],
        [m1Active, m5Active],
      ],
    );
    expect(
      sections?.map((computer) => [computer.environmentId, computer.sections.map(ids)]),
    ).toEqual([
      ["M1", [["lead1"], ["active1"]]],
      ["M5", [["lead5"], ["active5"]]],
    ]);
  });
  it("leaves the existing layout alone for one known computer", () => {
    expect(
      sidebarEnvironmentSections(["M5"], [[thread("lead", { environmentId: "M5" })]]),
    ).toBeNull();
    expect(sidebarEnvironmentSections([], [])).toBeNull();
  });
  it("keeps cached computers grouped even before the environment catalog is available", () => {
    const rows = [
      thread("lead5", { environmentId: "M5" }),
      thread("lead1", { environmentId: "M1" }),
    ];
    for (const environments of [[], ["M5"]]) {
      expect(
        sidebarEnvironmentSections(environments, [rows])?.map((section) => [
          section.environmentId,
          section.sections.map(ids),
        ]),
      ).toEqual([
        ["M5", [["lead5"]]],
        ["M1", [["lead1"]]],
      ]);
    }
  });
  it("ranks flags with attention above failures and work", () => {
    const state = {
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      runtime: { status: "failed" },
      attention: { reason: "Please test" },
    };
    expect(threadAttentionStatus(state)).toBe("attention");
  });
  it("defaults to primary and preserves saved client order with new computers last", () => {
    expect(orderSidebarEnvironments(["M1", "M5"], [], "M5")).toEqual(["M5", "M1"]);
    const saved = moveSidebarEnvironment(["M1", "M5"], "M5", -1);
    expect(orderSidebarEnvironments(["M1", "M5", "new"], saved, "M1")).toEqual(["M5", "M1", "new"]);
  });
});
