import { sidebarParentError } from "./threadNesting.ts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { followsSidebarParent, type SidebarParkState } from "./threadNesting.ts";

const at = (iso: string) => DateTime.makeUnsafe(iso);
const now = at("2026-10-08T12:00:00.000Z");
const live: SidebarParkState = { settledOverride: null, settledAt: null };
const settledAt = at("2026-10-08T11:00:00.000Z");
const settled: SidebarParkState = { settledOverride: "settled", settledAt };
const snoozed: SidebarParkState = {
  ...live,
  snoozedUntil: at("2026-10-09T09:00:00.000Z"),
  snoozedAt: at("2026-10-08T11:30:00.000Z"),
};

describe("followsSidebarParent", () => {
  it("parks live children with the parent", () => {
    expect(followsSidebarParent(live, live, "settle", now)).toBe(true);
    expect(followsSidebarParent(live, live, "snooze", now)).toBe(true);
  });

  it("leaves a child parked on its own alone, both ways", () => {
    const ownSettle = { ...settled, settledAt: at("2026-10-07T08:00:00.000Z") };
    const ownSnooze = { ...snoozed, snoozedAt: at("2026-10-08T10:00:00.000Z") };
    expect(followsSidebarParent(ownSettle, live, "snooze", now)).toBe(false);
    expect(followsSidebarParent(ownSnooze, live, "settle", now)).toBe(false);
    expect(followsSidebarParent(ownSettle, settled, "unsettle", now)).toBe(false);
    expect(followsSidebarParent(ownSnooze, snoozed, "unsnooze", now)).toBe(false);
  });

  it("brings back children that carry the parent's stamp", () => {
    expect(followsSidebarParent(settled, settled, "unsettle", now)).toBe(true);
    expect(followsSidebarParent(snoozed, snoozed, "unsnooze", now)).toBe(true);
    // A new snooze time moves the children that went with the old one.
    expect(followsSidebarParent(snoozed, snoozed, "snooze", now)).toBe(true);
  });

  it("does not bring back a child whose snooze already ended", () => {
    const later = at("2026-10-10T00:00:00.000Z");
    expect(followsSidebarParent(snoozed, snoozed, "unsnooze", later)).toBe(false);
  });
});

describe("sidebar tree moves", () => {
  const chain = Array.from({ length: 9 }, (_, i) => ({
    id: String(i),
    projectId: "p",
    sidebarParentThreadId: i === 0 ? null : String(i - 1),
  }));
  it("allows eight links but refuses depth overflow including a moved subtree", () => {
    expect(sidebarParentError(chain, "8", "7")).toBeNull();
    expect(sidebarParentError([...chain, { id: "extra", projectId: "p" }], "extra", "8")).toContain(
      "8 levels",
    );
    expect(sidebarParentError([...chain, { id: "extra", projectId: "p" }], "0", "extra")).toContain(
      "8 levels",
    );
  });
  it("rejects self, descendants, missing and cross-project parents", () => {
    expect(sidebarParentError(chain, "0", "0")).toContain("cycle");
    expect(sidebarParentError(chain, "0", "8")).toContain("cycle");
    expect(sidebarParentError(chain, "0", "missing")).toContain("same project");
    expect(sidebarParentError([...chain, { id: "other", projectId: "q" }], "0", "other")).toContain(
      "same project",
    );
  });
});
