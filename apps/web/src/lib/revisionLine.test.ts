import { expect, it } from "vite-plus/test";
import { revisionLine } from "./revisionLine";

it("retains unchanged locations and follows a declaration shifted by inserted lines", () => {
  const old = "void helper() {}\n\nhelper();\n";
  expect(revisionLine(old, old, 1)).toBe(1);
  expect(revisionLine(old, "// new\n\n" + old, 1)).toBe(3);
  expect(revisionLine(old, "// new\n\n" + old, 3)).toBe(5);
});
it("uses neighboring context to distinguish repeated member names", () => {
  const old = "struct A {\n  int value;\n};\n\nstruct B {\n  int value;\n};\n";
  expect(revisionLine(old, "// new\n" + old, 6)).toBe(7);
});
it("refuses removed and ambiguous lines instead of guessing", () => {
  expect(revisionLine("void removed() {}", "void other() {}", 1)).toBeNull();
  expect(revisionLine("\nhelper();\n", "helper();\n\nhelper();\n", 2)).toBeNull();
  expect(revisionLine("\n", "\n\n", 1)).toBeNull();
});
