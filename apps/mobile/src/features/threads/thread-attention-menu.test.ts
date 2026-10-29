import { describe, expect, it, vi } from "vite-plus/test";
import {
  buildThreadAttentionHeaderItems,
  buildThreadAttentionMenuItems,
  handleThreadAttentionMenuAction,
} from "./thread-attention-menu";

describe("thread attention menus", () => {
  it("has no flag items for an unflagged thread", () => {
    expect(buildThreadAttentionMenuItems(null)).toEqual([]);
    expect(buildThreadAttentionHeaderItems(undefined, vi.fn())).toEqual([]);
  });

  it("shows the reason as an inline section with an enabled clear action", () => {
    expect(buildThreadAttentionMenuItems({ reason: "Choose a nest location" })).toEqual([
      {
        id: "thread-flag-reason",
        title: "Choose a nest location",
        displayInline: true,
        subactions: [{ id: "clear-thread-flag", title: "Clear flag", image: "flag.slash" }],
      },
    ]);
  });

  it("clears only on the clear action, leaving the reason informational", () => {
    const clear = vi.fn();
    expect(handleThreadAttentionMenuAction("thread-flag-reason", clear)).toBe(true);
    expect(handleThreadAttentionMenuAction("pin", clear)).toBe(false);
    expect(clear).not.toHaveBeenCalled();
    expect(handleThreadAttentionMenuAction("clear-thread-flag", clear)).toBe(true);
    expect(clear).toHaveBeenCalledOnce();
  });

  it("offers the same reason and clear behavior in the header", () => {
    const clear = vi.fn();
    const items = buildThreadAttentionHeaderItems({ reason: "Needs a decision" }, clear);
    expect(items[0]).toMatchObject({ title: "Needs a decision", inline: true });
    const section = items[0];
    if (section && "items" in section) {
      const clearItem = section.items[0];
      if (clearItem && "onPress" in clearItem) clearItem.onPress();
    }
    expect(clear).toHaveBeenCalledOnce();
  });
});
