import { describe, expect, it } from "vite-plus/test";
import {
  orderSidebarEnvironments,
  sidebarEnvironmentSections,
} from "@t3tools/client-runtime/state/thread-nesting";
import { sidebarVisibleOrder } from "./Sidebar.order";

describe("sidebar shortcut display order", () => {
  const row = (id: string, environmentId = "M1") => ({ id, environmentId });
  const pinned = [row("m1-pin"), row("m5-pin", "M5")];
  const active = [row("parent"), row("m5-active", "M5")];
  const computers = sidebarEnvironmentSections(
    orderSidebarEnvironments(["M1", "M5"], ["M5", "M1"], "M1"),
    [pinned, active, [row("working")]],
  );
  const child = row("child");
  const grandchild = row("grandchild");
  const children = (item: ReturnType<typeof row>) =>
    item.id === "parent" ? [child] : item.id === "child" ? [grandchild] : [];
  it("numbers the rendered rows with user-ordered computers, pins, and nested trees", () => {
    expect(
      sidebarVisibleOrder({
        computers,
        collapsed: [],
        singleSections: [],
        children,
        shelves: [[row("snoozed")], [row("settled")]],
      }).map((r) => r.id),
    ).toEqual([
      "m5-pin",
      "m5-active",
      "m1-pin",
      "parent",
      "child",
      "grandchild",
      "working",
      "snoozed",
      "settled",
    ]);
  });
  it("skips folded computers and collapsed subtrees and preserves visible shelf exceptions", () => {
    expect(
      sidebarVisibleOrder({
        computers,
        collapsed: ["M5"],
        singleSections: [],
        children: () => [],
        shelves: [[], [row("open-settled")]],
      }).map((r) => r.id),
    ).toEqual(["m1-pin", "parent", "working", "open-settled"]);
  });
  it("retains the one-computer order and visible shelf paging", () => {
    expect(
      sidebarVisibleOrder({
        computers: null,
        collapsed: ["M1"],
        singleSections: [pinned, active],
        children: () => [],
        shelves: [[], []],
      }),
    ).toEqual([...pinned, ...active]);
  });
});
