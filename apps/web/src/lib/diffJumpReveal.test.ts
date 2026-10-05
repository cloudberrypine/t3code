import { DiffHunksRenderer, parseDiffFromFile } from "@pierre/diffs";
import { expect, it } from "vite-plus/test";
import { diffJumpExpansion } from "./diffJumpReveal";

it.each(["unified", "split"] as const)(
  "restores expanded context on either side in %s view",
  async (diffStyle) => {
    const contents = Array.from({ length: 120 }, (_, i) => `line ${i + 1}\n`).join("");
    const file = parseDiffFromFile(
      { name: "a.cpp", contents },
      {
        name: "a.cpp",
        contents: contents
          .replace("line 30\n", "changed 30\n")
          .replace("line 70\n", "changed 70\n"),
      },
      { context: 3 },
    );
    for (const side of ["additions", "deletions"] as const) {
      expect(diffJumpExpansion(file, 30, side)).toBeNull();
      for (const line of [24, 37, 65, 80]) {
        const expansion = diffJumpExpansion(file, line, side)!;
        expect(expansion.count).toBeGreaterThan(0);
        const renderer = new DiffHunksRenderer({ diffStyle, collapsedContextThreshold: 0 });
        await renderer.asyncRender(file);
        const before =
          renderer.renderDiff(file)?.hunkData.find((h) => h.hunkIndex === expansion.index)?.lines ??
          0;
        renderer.expandHunk(expansion.index, expansion.direction, expansion.count);
        const after =
          renderer.renderDiff(file)?.hunkData.find((h) => h.hunkIndex === expansion.index)?.lines ??
          0;
        expect(after).toBe(Math.max(0, before - expansion.count));
        renderer.cleanUp();
      }
    }
  },
);
