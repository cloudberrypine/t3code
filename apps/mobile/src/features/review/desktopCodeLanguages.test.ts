import { describe, expect, it } from "vite-plus/test";

import { desktopCodeLanguage } from "./desktopCodeLanguages";
import { highlightSourceFile } from "./shikiReviewHighlighter";

describe("desktop code languages", () => {
  it("map C and C++ sources and headers like desktop, with C++ for extensions it lacks", () => {
    expect(
      Object.fromEntries(
        ["h", "hpp", "hh", "hxx", "inl", "ipp", "c", "cc", "cxx", "cpp", "mm"].map((extension) => [
          extension,
          desktopCodeLanguage(`src/engine/World.${extension}`),
        ]),
      ),
    ).toEqual({
      h: "objective-cpp",
      hpp: "cpp",
      hh: "cpp",
      hxx: "cpp",
      inl: "cpp",
      ipp: "cpp",
      c: "c",
      cc: "cpp",
      cxx: "cpp",
      cpp: "cpp",
      mm: "objective-cpp",
    });
    expect(desktopCodeLanguage("README.md")).toBe("markdown");
  });

  it("highlights .h headers with C++ grammar (Objective-C++, as desktop does)", async () => {
    const contents = "#include <vector>\nnamespace Process {\nstruct World { int count = 0; };\n}";
    const header = await highlightSourceFile({
      path: "src/engine/World.h",
      contents,
      theme: "dark",
    });
    const colors = new Set(header.flat().map((token) => token.color));
    expect(colors.size).toBeGreaterThan(3);
    const color = (text: string) =>
      header.flat().find((token) => token.content.trim() === text)?.color;
    expect(color("struct")).toBe(color("namespace"));
    expect(color("0")).not.toBe(color("struct"));
  });

  it("highlights .inl like .cpp", async () => {
    const contents = "inline int twice(int value) { return value * 2; }";
    const [inline, cpp] = await Promise.all([
      highlightSourceFile({ path: "src/engine/World.inl", contents, theme: "dark" }),
      highlightSourceFile({ path: "src/engine/World.cpp", contents, theme: "dark" }),
    ]);
    expect(inline).toEqual(cpp);
  });
});
