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

  it("starts with the disabled reason and clear action", () => {
    expect(buildThreadAttentionMenuItems({ reason: "Choose a nest location" })).toEqual([
      {
        id: "thread-flag-reason",
        title: "⚑ Choose a nest location",
        attributes: { disabled: true },
      },
      { id: "clear-thread-flag", title: "Clear flag", image: "flag.slash" },
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
    expect(items[0]).toMatchObject({ title: "⚑ Needs a decision", disabled: true });
    for (const item of items) {
      if ("onPress" in item) item.onPress();
    }
    expect(clear).toHaveBeenCalledOnce();
  });
});
