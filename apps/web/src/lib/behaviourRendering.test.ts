import { afterEach, expect, it, vi } from "vite-plus/test";
import { getRenderablePatch } from "./diffRendering";
import { BEHAVIOUR_CSS, createBehaviourPainter } from "./behaviourRendering";

vi.mock("~/components/diffs/diffSearch", () => ({
  textRange: (_row: unknown, start: number, end: number) => ({ start, end }),
}));
afterEach(() => vi.unstubAllGlobals());

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

interface FakeRow {
  dataset: { line: string; lineType?: string };
  attributes: Map<string, string>;
  closest: () => object | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
}

function row(line: number, deleted = false): FakeRow {
  return {
    dataset: { line: String(line), lineType: deleted ? "change-deletion" : "change-addition" },
    attributes: new Map(),
    closest: () => (deleted ? {} : null),
    setAttribute(name, value) {
      this.attributes.set(name, value);
    },
    removeAttribute(name) {
      this.attributes.delete(name);
    },
  };
}

function nodeWith(rows: FakeRow[]) {
  return {
    shadowRoot: {
      querySelector: () => rows[0] ?? null,
      querySelectorAll: (selector: string) =>
        selector === "[data-beh-line]" ? rows.filter((entry) => entry.attributes.size) : rows,
    },
  } as unknown as HTMLElement;
}

function stubHighlights() {
  vi.stubGlobal("CSS", { highlights: new Map() });
  vi.stubGlobal("Highlight", Set);
}

// The Sloth's DungInHollow, in the C-like syntax.
const DUNG_IN_HOLLOW = `state DungInHollow(entity tree) {
  wait_for(p.dig_duration);
  if (!SlothDung::has_dung()) fail EmptyStomach;
  perform(DungAtTree, .at = self.position);
  wait_for(p.cover_duration);
}
`;

it("paints a file's tokens and marks its waiting rows", () => {
  stubHighlights();
  const rows = [1, 2, 3, 4, 5, 6].map((line) => row(line));
  const node = nodeWith(rows);
  const painter = createBehaviourPainter();
  painter.paint(node, { name: "behaviours/drafts/sloth_full.beh", contents: DUNG_IN_HOLLOW });
  expect(rows.map((entry) => entry.attributes.get("data-beh-line") ?? null)).toEqual([
    null,
    "wait",
    null,
    null,
    "wait",
    null,
  ]);
  expect(CSS.highlights.get("beh-wait")?.size).toBe(2);
  expect(CSS.highlights.get("beh-state")?.size).toBe(1);
  expect(CSS.highlights.get("beh-param")?.size).toBe(4);
  // Another file in the same node clears the marks and the ranges.
  painter.paint(node, { name: "Sloth.as", contents: DUNG_IN_HOLLOW });
  expect(rows.every((entry) => entry.attributes.size === 0)).toBe(true);
  expect(CSS.highlights.get("beh-wait")?.size).toBe(0);
  painter.dispose();
  expect(CSS.highlights.has("beh-wait")).toBe(false);
});

it("reads a partial diff from its full revisions once they load", async () => {
  stubHighlights();
  const oldContents = "state A() {\n  await any {\n    until(t);\n    after(1s);\n  }\n}\n";
  const newContents = oldContents.replace("until(t)", "until(later)");
  const patch = getRenderablePatch(
    "diff --git a/a.beh b/a.beh\n--- a/a.beh\n+++ b/a.beh\n@@ -3 +3 @@\n-    until(t);\n+    until(later);\n",
  );
  if (patch?.kind !== "files" || !patch.files[0]) throw new Error("Invalid fixture");
  const diff = patch.files[0];
  const rows = [row(3, true), row(3)];
  const node = nodeWith(rows);
  const request = deferred<{
    oldFile: { name: string; contents: string };
    newFile: { name: string; contents: string };
  }>();
  const load = vi.fn(() => request.promise);
  const painter = createBehaviourPainter(load);
  painter.paint(node, diff);
  painter.paint(node, diff);
  expect(load).toHaveBeenCalledOnce();
  // The hunk alone does not show that the condition is inside `await any`.
  expect(rows.map((entry) => entry.attributes.get("data-beh-line") ?? null)).toEqual([null, null]);
  request.resolve({
    oldFile: { name: "a.beh", contents: oldContents },
    newFile: { name: "a.beh", contents: newContents },
  });
  await request.promise;
  expect(rows.map((entry) => entry.attributes.get("data-beh-line"))).toEqual(["wait", "wait"]);
  painter.dispose();
});

it("does not paint a late revision after unmount", async () => {
  stubHighlights();
  const patch = getRenderablePatch(
    "diff --git a/a.beh b/a.beh\n--- a/a.beh\n+++ b/a.beh\n@@ -1 +1 @@\n-  after(1s);\n+  after(2s);\n",
  );
  if (patch?.kind !== "files" || !patch.files[0]) throw new Error("Invalid fixture");
  const rows = [row(1, true), row(1)];
  const node = nodeWith(rows);
  const request = deferred<{
    oldFile: { name: string; contents: string };
    newFile: { name: string; contents: string };
  }>();
  const painter = createBehaviourPainter(() => request.promise);
  painter.paint(node, patch.files[0]);
  painter.paint(node, patch.files[0], "unmount");
  request.resolve({
    oldFile: { name: "a.beh", contents: "await any {\n  after(1s);\n}\n" },
    newFile: { name: "a.beh", contents: "await any {\n  after(2s);\n}\n" },
  });
  await request.promise;
  expect(rows.every((entry) => entry.attributes.size === 0)).toBe(true);
  painter.dispose();
});

it("styles waiting rows with a gutter stripe only, no tint and no background on the word", () => {
  expect(BEHAVIOUR_CSS).toContain('[data-beh-line="wait"]');
  expect(BEHAVIOUR_CSS).not.toContain("background-image");
  expect(BEHAVIOUR_CSS).toMatch(/box-shadow: inset 3px 0 0 light-dark\(/);
  expect(BEHAVIOUR_CSS).not.toMatch(/::highlight\(beh-wait\) \{[^}]*background-color/);
  expect(BEHAVIOUR_CSS).toContain("::highlight(beh-state)");
});
