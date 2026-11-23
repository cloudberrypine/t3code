import { describe, expect, it } from "vite-plus/test";

import { resolveHighlightLanguage } from "../../lib/highlightLanguage";

describe("local highlight languages", () => {
  it("map C and C++ sources and headers like desktop, with C++ for extensions Pierre lacks", () => {
    expect(
      Object.fromEntries(
        ["h", "hpp", "hh", "hxx", "inl", "ipp", "c", "cc", "cxx", "cpp", "mm"].map((extension) => [
          extension,
          resolveHighlightLanguage({ path: `src/engine/World.${extension}` }),
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
    expect(resolveHighlightLanguage({ path: "README.md" })).toBe("markdown");
  });

  it("tokenizes AngelScript with the C++ lexer", () => {
    expect(resolveHighlightLanguage({ path: "assets/scripts/Monkey.as" })).toBe("cpp");
    expect(resolveHighlightLanguage({ language: "angelscript" })).toBe("cpp");
  });

  it("tokenizes the behaviour language as plain text, never with the C++ lexer", () => {
    for (const path of ["prototype/sloth.beh", "prototype/engine.pzb", "Sloth.BEH"])
      expect(resolveHighlightLanguage({ path })).toBe("text");
    for (const language of ["beh", "pzb", "behaviour"])
      expect(resolveHighlightLanguage({ language })).toBe("text");
  });
});
