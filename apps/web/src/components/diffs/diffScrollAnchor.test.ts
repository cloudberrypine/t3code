import { describe, expect, it, vi } from "vite-plus/test";
import { findAnchoredDiffItem } from "./diffScrollAnchor";

describe("findAnchoredDiffItem", () => {
  const items = [{ id: "first" }, { id: "second" }, { id: "third" }];

  it("follows the pinned header across file boundaries in both directions", () => {
    const tops = new Map([
      ["first", 0],
      ["second", 1000],
      ["third", 2000],
    ]);
    const current = (scrollTop: number) =>
      findAnchoredDiffItem(items, scrollTop, (id) => tops.get(id))?.id;
    expect([0, 999, 1000, 1999, 2000, 2900, 1000, 999].map(current)).toEqual([
      "first",
      "first",
      "second",
      "second",
      "third",
      "third",
      "second",
      "first",
    ]);
  });

  it("uses updated layout positions when a preceding file collapses or expands", () => {
    const tops = new Map([
      ["first", 20],
      ["second", 1000],
      ["third", 2000],
    ]);
    const current = () => findAnchoredDiffItem(items, 100, (id) => tops.get(id))?.id;
    expect(current()).toBe("first");
    tops.set("second", 52);
    tops.set("third", 1052);
    expect(current()).toBe("second");
    tops.set("second", 1000);
    expect(current()).toBe("first");
  });

  it("selects the first file before its header and handles an empty diff", () => {
    expect(findAnchoredDiffItem(items, 0, () => 20)).toBe(items[0]);
    expect(findAnchoredDiffItem([], 0, () => undefined)).toBeUndefined();
  });

  it("handles a jump through thousands of files without scanning every file", () => {
    const many = Array.from({ length: 25600 }, (_, index) => ({ id: String(index) }));
    const getTop = vi.fn((id: string) => Number(id) * 1000);
    expect(findAnchoredDiffItem(many, 20000999, getTop)?.id).toBe("20000");
    expect(getTop.mock.calls.length).toBeLessThanOrEqual(15);
  });
});
