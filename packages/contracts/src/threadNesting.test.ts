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
