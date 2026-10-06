import { describe, expect, it } from "vite-plus/test";
import pierreDark from "@pierre/theme/pierre-dark";
import pierreLight from "@pierre/theme/pierre-light";

import { getNativeReviewDiffHighlighter } from "../diffs/nativeReviewDiffHighlighter";
import { DESKTOP_CODE_THEME_NAMES } from "./desktopCodeThemes";
import { highlightSourceFile } from "./shikiReviewHighlighter";

function palette(theme: typeof pierreDark) {
  return new Set(
    [
      theme.colors["editor.foreground"],
      ...theme.tokenColors.map((rule) => rule.settings.foreground),
    ].flatMap((color) => (color ? [color.toLowerCase()] : [])),
  );
}

async function highlight(
  path: string,
  contents: string,
  theme: "light" | "dark",
  language?: string,
) {
  const lines = await highlightSourceFile({
    path,
    contents,
    theme,
    ...(language ? { language } : {}),
  });
  const colors = new Set(
    lines.flat().flatMap((token) => (token.color ? [token.color.toLowerCase()] : [])),
  );
  return { lines, colors };
}

describe("desktop code themes", () => {
  it("colors every token from desktop's Pierre theme in both appearances", async () => {
    for (const [scheme, theme] of [
      ["dark", pierreDark],
      ["light", pierreLight],
    ] as const) {
      const { colors } = await highlight("src/example.ts", 'const value = "text"; // note', scheme);
      expect(colors.size).toBeGreaterThan(2);
      for (const color of colors) expect(palette(theme)).toContain(color);
    }
  });

  it.each([
    ["AngelScript", "scripts/behavior.as", "void main() { int count = 1; }", "angelscript"],
    ["C++", "src/main.cpp", "#include <vector>\nint main() { return 0; }", undefined],
    ["JSON", "data/mesh.json", '{"name": "cube", "count": 2}', undefined],
  ])("tokenizes %s with its grammar", async (_name, path, contents, language) => {
    const { colors } = await highlight(path, contents, "dark", language);
    expect(colors.size).toBeGreaterThan(1);
    for (const color of colors) expect(palette(pierreDark)).toContain(color);
  });

  it("highlights C++ review diffs with the desktop theme once the grammar loads", async () => {
    const highlighter = await getNativeReviewDiffHighlighter("javascript");
    const lines = await highlighter.tokenize("int main() { return 0; }", {
      lang: "cpp",
      theme: DESKTOP_CODE_THEME_NAMES.dark,
    });
    const colors = new Set(
      lines.flat().flatMap((token) => (token.color ? [token.color.toLowerCase()] : [])),
    );
    expect(colors.size).toBeGreaterThan(1);
    for (const color of colors) expect(palette(pierreDark)).toContain(color);
  });
});
