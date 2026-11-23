import type { CodeViewHandle } from "@pierre/diffs/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import "~/index.css";

import { act, render } from "../../test/render";

let appearance: "light" | "dark" = "light";
vi.mock(import("~/hooks/useTheme"), async (original) => ({
  ...(await original()),
  useRenderedAppearance: (() => appearance) as never,
}));
// The pool starts its workers before showing any code, which can outlast a cold CI browser.
vi.mock(import("~/components/DiffWorkerPoolProvider"), () => ({
  DiffWorkerPoolProvider: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));

import ReadOnlySourcePreview from "~/components/files/ReadOnlySourcePreview";
import { StyledDiffCodeView } from "~/components/diffs/StyledDiffCodeView";
import { createBehaviourPainter } from "./behaviourRendering";
import { buildFileDiffEntries, getRenderablePatch } from "./diffRendering";
import { getSyntaxHighlighterPromise } from "./syntaxHighlighting";

// The Sloth's DungInHollow, in the C-like syntax.
const DUNG_IN_HOLLOW = `state DungInHollow(entity tree) {
  wait_for(p.dig_duration);
  if (!SlothDung::has_dung()) fail EmptyStomach;
  perform(DungAtTree, .at = self.position);   // 100 bp
  await Cover(tree);
}
`;

function rowsOf(container: HTMLElement) {
  const root = container.querySelector("diffs-container")?.shadowRoot;
  return [...(root?.querySelectorAll<HTMLElement>("[data-code] [data-line]") ?? [])];
}

describe("behaviour language rendering", () => {
  it.each(["light", "dark"] as const)(
    "paints a .beh file preview's tokens and its waiting rows in %s",
    async (theme) => {
      appearance = theme;
      await getSyntaxHighlighterPromise("text");
      const painter = createBehaviourPainter();
      await using screen = await render(
        <div className="flex h-[400px] w-[900px] flex-col">
          <ReadOnlySourcePreview
            name="behaviours/drafts/sloth_full.beh"
            text={DUNG_IN_HOLLOW}
            wordWrap={false}
            onPostRender={(node, instance, phase) => painter.paint(node, instance.file, phase)}
          />
        </div>,
        { router: false },
      );
      // Six lines and the empty one after the final newline.
      await vi.waitFor(() => expect(rowsOf(screen.container).length).toBe(7));
      const rows = rowsOf(screen.container);
      expect(rows.map((row) => row.getAttribute("data-beh-line"))).toEqual([
        null,
        "wait",
        null,
        null,
        "wait",
        null,
        null,
      ]);
      const waiting = getComputedStyle(rows[1]!);
      expect(waiting.backgroundImage).toContain("gradient");
      expect(waiting.boxShadow).toContain("inset");
      expect(getComputedStyle(rows[0]!).backgroundImage).toBe("none");
      expect(CSS.highlights.get("beh-wait")?.size).toBe(2);
      expect(CSS.highlights.get("beh-state")?.size).toBe(2);
      painter.dispose();
    },
  );

  it("marks a waiting row in a diff through the shared diff viewer", async () => {
    appearance = "dark";
    const parsed = getRenderablePatch(
      [
        "diff --git a/sloth.beh b/sloth.beh",
        "--- a/sloth.beh",
        "+++ b/sloth.beh",
        "@@ -1,3 +1,3 @@",
        " state Dig() {",
        "-  wait_for(p.dig_duration);",
        "+  await after(p.dig_duration);",
        " }",
        "",
      ].join("\n"),
    );
    if (parsed?.kind !== "files") throw new Error("Expected file diffs");
    const entries = buildFileDiffEntries(parsed.files);
    let viewer: CodeViewHandle<undefined, undefined> | null = null;
    await using screen = await render(
      <StyledDiffCodeView
        viewerRef={(value) => {
          viewer = value;
        }}
        className="h-[400px] w-[800px]"
        items={entries.map(({ fileDiff, fileKey, fileVersion }) => ({
          type: "diff",
          id: fileKey,
          fileDiff,
          version: fileVersion,
        }))}
        options={{ theme: "pierre-dark", diffStyle: "unified" }}
      />,
      { router: false },
    );
    await act(async () => viewer?.getInstance()?.render(true));
    await vi.waitFor(() => {
      const marked = rowsOf(screen.container).filter(
        (row) => row.getAttribute("data-beh-line") === "wait",
      );
      expect(marked.map((row) => row.textContent?.trim())).toEqual([
        "wait_for(p.dig_duration);",
        "await after(p.dig_duration);",
      ]);
    });
  });
});
