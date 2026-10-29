// @vitest-environment jsdom
// @effect-diagnostics nodeBuiltinImport:off - checks the actual theme stylesheet.
import { act } from "react";
import { createRoot } from "react-dom/client";
import * as NodeFS from "node:fs";
import { expect, it } from "vite-plus/test";
import { PolyWordmark } from "./PolyWordmark";

it("enlarges Poly around the original baseline without changing the row height", async () => {
  const host = document.createElement("div");
  const root = createRoot(host);
  try {
    await act(async () => root.render(<PolyWordmark aria-label="Poly" />));
    const box = host.querySelector("span")!;
    const svg = host.querySelector("svg")!;
    const width = Number.parseFloat(svg.style.width);
    const height = Number.parseFloat(svg.style.height);
    const top = Number.parseFloat(svg.style.top);
    const viewBox = svg.getAttribute("viewBox")!.split(" ").map(Number);
    expect(width / (viewBox[2]! / 150)).toBeCloseTo(1.125);
    expect(height / width).toBeCloseTo(viewBox[3]! / viewBox[2]!);
    expect(top + (170.22650718688965 / viewBox[3]!) * height).toBeCloseTo(0.71);
    expect(box.style.height).toBe("0.71em");
    expect(Number.parseFloat(box.style.marginRight)).toBeGreaterThan(0);
    expect(Number.parseFloat(box.style.marginRight)).toBeLessThan(0.05);
    expect(top + height).toBeGreaterThan(Number.parseFloat(box.style.height));
    expect(svg.classList.contains("overflow-visible")).toBe(true);
    expect(svg.classList.contains("text-foreground")).toBe(true);
  } finally {
    await act(async () => root.unmount());
  }
});

it("uses coral orange for Claude and retains the blue Codex theme colours", () => {
  const css = NodeFS.readFileSync("src/index.css", "utf8");
  expect(css).toContain("--color-usage-claude: light-dark(#b85e40, #d97757)");
  expect(css).toContain("--color-usage-codex: light-dark(#4f86bd, #79a5d2)");
  expect(css).not.toContain("--color-poly-wordmark");
});
