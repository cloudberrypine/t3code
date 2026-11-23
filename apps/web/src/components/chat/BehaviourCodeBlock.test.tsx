import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vite-plus/test";
import { behaviourColors } from "@t3tools/shared/behaviour";

import { BehaviourCodeBlock } from "./BehaviourCodeBlock";
import { extractFenceLanguage } from "./MarkdownCodeBlock.logic";

const CODE = `state HangStill(tick duration, bool take_nap) {
  tick rest_until = now + duration;
  if (take_nap) await after(p.settle_before_sleep);
  await until(rest_until);
}
`;

it("colours a beh fence and marks its waiting lines in both themes", () => {
  expect(extractFenceLanguage("language-beh")).toBe("beh");
  for (const [themeName, theme] of [
    ["t3-light", "light"],
    ["pierre-dark", "dark"],
  ] as const) {
    const html = renderToStaticMarkup(<BehaviourCodeBlock code={CODE} themeName={themeName} />);
    const palette = behaviourColors[theme];
    const lines = html.match(/<span class="line"[^>]*>/g) ?? [];
    expect(lines).toHaveLength(5);
    expect(lines.map((line) => line.includes('data-beh-line="wait"'))).toEqual([
      false,
      false,
      true,
      true,
      false,
    ]);
    expect(html).toContain(`color:${palette.wait}`);
    expect(html).toContain(`color:${palette.state}`);
    expect(html).toContain(`background-color:${palette.waitBackground}`);
    // The text survives as written, with a newline between lines and none after the last.
    expect(html.replace(/<[^>]+>/g, "")).toBe(
      CODE.trimEnd().replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"),
    );
  }
});
