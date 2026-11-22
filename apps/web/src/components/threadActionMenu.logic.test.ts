import { describe, expect, it } from "vite-plus/test";

import { buildThreadActionMenuItems, type ThreadActionMenuState } from "./threadActionMenu.logic";

const baseState: ThreadActionMenuState = {
  canOperate: true,
  branch: null,
  projectFilter: null,
  isPinned: false,
  isSettled: false,
  autoSettleEnabled: true,
  isSnoozed: false,
  canSnoozeNow: true,
  isRegeneratingTitle: false,
  isRunning: false,
  supports: {
    settlement: true,
    autoSettleOptOut: true,
    snooze: true,
    pinning: true,
    titleRegeneration: true,
  },
  snoozePresets: [
    { id: "hour", label: "In 1 hour", whenLabel: "3:00 PM", snoozedUntil: "2026-08-07T15:00:00Z" },
  ],
};

describe("buildThreadActionMenuItems", () => {
  it.each([false, true])(
    "disables both lifecycle directions without permission (reversed: %s)",
    (reversed) => {
      const items = buildThreadActionMenuItems({
        ...baseState,
        canOperate: false,
        isPinned: reversed,
        isSettled: reversed,
        isSnoozed: reversed,
      });
      const expected = reversed
        ? [
            "unpin",
            "unsettle",
            "unsnooze",
            "rename",
            "regenerate-title",
            "auto-settle",
            "archive",
            "delete",
          ]
        : [
            "pin",
            "settle",
            "snooze",
            "rename",
            "regenerate-title",
            "auto-settle",
            "archive",
            "delete",
          ];
      expect(items.filter((item) => item.disabled).map((item) => item.id)).toEqual(expected);
      expect(
        items.find((item) => item.id === "snooze")?.children?.every((child) => child.disabled) ??
          true,
      ).toBe(true);
    },
  );

  it("disables archive and turning into a project while the thread is running", () => {
    const items = buildThreadActionMenuItems({
      ...baseState,
      isRunning: true,
      canTurnIntoProject: true,
    });
    expect(items.find((item) => item.id === "archive")?.disabled).toBe(true);
    expect(items.find((item) => item.id === "turn-into-project")?.disabled).toBe(true);
  });

  it("disables only rename where no inline title editor exists", () => {
    const items = buildThreadActionMenuItems({ ...baseState, canRename: false });
    expect(items.filter((item) => item.disabled).map((item) => item.id)).toEqual(["rename"]);
  });
});

// Local: showing a thread under another one in the sidebar.
describe("buildThreadActionMenuItems nesting", () => {
  const allIds = (state: ThreadActionMenuState) =>
    buildThreadActionMenuItems(state).flatMap((item) => [
      item.id,
      ...(item.children?.map((child) => child.id) ?? []),
    ]);
  const ids = (state: ThreadActionMenuState) =>
    buildThreadActionMenuItems(state).map((item) => item.id);

  it("offers parents only where the server stores nesting", () => {
    expect(allIds(baseState).some((id) => id.startsWith("nest"))).toBe(false);
    const candidates = [{ id: "c2", title: "Tree Lifecycle (C2)" }];
    expect(allIds({ ...baseState, nesting: { isNested: false, candidates } })).toEqual(
      expect.arrayContaining(["nest", "nest:c2"]),
    );
    expect(ids({ ...baseState, nesting: { isNested: false, candidates } })).not.toContain("unnest");
  });

  it("lets a nested thread leave its group even with nowhere else to go", () => {
    const items = ids({ ...baseState, nesting: { isNested: true, candidates: [] } });
    expect(items).toContain("unnest");
    expect(items).not.toContain("nest");
  });
});
