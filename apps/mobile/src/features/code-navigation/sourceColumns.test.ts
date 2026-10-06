import { describe, expect, it } from "vite-plus/test";

import {
  expandedColumnToOffset,
  lineNavigationTargets,
  offsetToExpandedColumn,
  splitTokensAtRanges,
} from "./sourceColumns";

describe("source columns", () => {
  it("maps native canvas columns through expanded tabs and back", () => {
    const line = "\t\tfoo(bar);";
    expect(expandedColumnToOffset(line, 0)).toBe(0);
    expect(expandedColumnToOffset(line, 3)).toBe(0);
    expect(expandedColumnToOffset(line, 4)).toBe(1);
    expect(expandedColumnToOffset(line, 8)).toBe(2);
    expect(expandedColumnToOffset(line, 13)).toBe(7);
    expect(expandedColumnToOffset(line, 200)).toBe(line.length);
    expect(offsetToExpandedColumn(line, 2)).toBe(8);
    expect(offsetToExpandedColumn(line, 6)).toBe(12);
  });

  it("lists followable symbols per line, as offsets into that line", () => {
    const contents = "void run() {\n  // helper\n  helper(1);\n}";
    const targets = lineNavigationTargets("scripts/main.as", contents);
    // Keywords such as `void` have nothing to follow.
    expect(targets.get(0)).toEqual([{ start: 5, end: 8 }]);
    expect(targets.has(1)).toBe(false);
    expect(targets.get(2)).toEqual([{ start: 2, end: 8 }]);
  });

  it("splits tokens at symbol boundaries without losing text or styles", () => {
    const tokens = [
      { content: "  helper(", color: "#111" },
      { content: "count", color: "#222" },
      { content: ");", color: "#111" },
      { content: "", color: null },
    ];
    const segments = splitTokensAtRanges(tokens, [
      { start: 2, end: 8 },
      { start: 9, end: 14 },
    ]);
    expect(segments.map(({ token }) => token.content).join("")).toBe("  helper(count);");
    expect(
      segments.map(({ token, range }) => [token.content, token.color, range?.start ?? null]),
    ).toEqual([
      ["  ", "#111", null],
      ["helper", "#111", 2],
      ["(", "#111", null],
      ["count", "#222", 9],
      [");", "#111", null],
      ["", null, null],
    ]);
  });

  it("gives nested symbols to the narrowest range", () => {
    const segments = splitTokensAtRanges(
      [{ content: "Bee::Run" }],
      [
        { start: 0, end: 8 },
        { start: 5, end: 8 },
      ],
    );
    expect(segments.map(({ token, range }) => [token.content, range])).toEqual([
      ["Bee::", { start: 0, end: 8 }],
      ["Run", { start: 5, end: 8 }],
    ]);
  });
});
