import { behaviourColors } from "@t3tools/shared/behaviour";
import { expect, it, vi } from "vite-plus/test";

import { highlightBehaviourCode } from "./behaviourHighlighting";

// Behaviour code never reaches the native lexer: it tokenizes as plain text.
vi.mock("react-native-nitro-modules", () => ({
  NitroModules: {
    hasHybridObject: () => false,
    createHybridObject: () => {
      throw new Error("no native highlighter in tests");
    },
  },
}));

it("colours a behaviour snippet over plain-text tokens, '//' starting a comment", () => {
  const code = "state Dig() {\n  wait_for(p.dig_duration);  // yields\n  fail NoDung;\n}";
  const lines = highlightBehaviourCode(code, "light");
  expect(lines.map((line) => line.map((token) => token.content).join(""))).toEqual(
    code.split("\n"),
  );
  const colorOf = (line: number, content: string) =>
    lines[line]!.find((token) => token.content === content)?.color;
  expect(colorOf(0, "state")).toBe(behaviourColors.light.keyword);
  expect(colorOf(0, "Dig")).toBe(behaviourColors.light.state);
  expect(colorOf(1, "wait_for")).toBe(behaviourColors.light.wait);
  expect(colorOf(1, "// yields")).toBe(behaviourColors.light.comment);
  expect(colorOf(2, "fail")).toBe(behaviourColors.light.control);
  expect(colorOf(2, "NoDung")).toBe(behaviourColors.light.constant);
});

it("gives a fence's wait word its own background and leaves the line untinted", () => {
  const lines = highlightBehaviourCode("state A() {\n  await after(2s);\n}", "dark");
  const palette = behaviourColors.dark;
  expect(lines.flat().filter((token) => token.background !== undefined)).toEqual([
    expect.objectContaining({ content: "await", background: palette.waitKeywordBackground }),
  ]);
});
