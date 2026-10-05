import { afterEach, expect, it, vi } from "vite-plus/test";
import { parseAngelScriptApi } from "@t3tools/shared/angelscript";
import { getRenderablePatch } from "./diffRendering";
import { createAngelScriptPainter } from "./angelScriptRendering";

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

function fixture() {
  vi.stubGlobal("CSS", { highlights: new Map() });
  vi.stubGlobal("Highlight", Set);
  const oldFile = {
    name: "Otter.as",
    contents:
      "behavior Otter {\nstate Main {\n void run() {\n  Rest();\n } }\nstate Rest { void run() {} }\n}\n",
  };
  const newFile = { name: oldFile.name, contents: oldFile.contents.replaceAll("Rest", "Dive") };
  const patch = getRenderablePatch(
    "diff --git a/Otter.as b/Otter.as\n--- a/Otter.as\n+++ b/Otter.as\n@@ -4 +4 @@\n-  Rest();\n+  Dive();\n",
  );
  if (patch?.kind !== "files" || !patch.files[0]) throw new Error("Invalid fixture");
  const rows = [true, false].map((deleted) => ({
    dataset: { line: "4", lineType: deleted ? "change-deletion" : "change-addition" },
    attributes: new Set<string>(),
    closest: () => (deleted ? {} : null),
    setAttribute(name: string) {
      this.attributes.add(name);
    },
    removeAttribute(name: string) {
      this.attributes.delete(name);
    },
  }));
  const node = {
    shadowRoot: {
      querySelector: () => rows[0],
      querySelectorAll: (selector: string) =>
        selector === "[data-angelscript-await]"
          ? rows.filter((row) => row.attributes.has("data-angelscript-await"))
          : rows,
    },
  } as unknown as HTMLElement;
  return { node, rows, diff: patch.files[0], oldFile, newFile };
}

it("loads a visible partial script once and paints suspension points from each full revision", async () => {
  const f = fixture();
  const request = deferred<{ oldFile: typeof f.oldFile; newFile: typeof f.newFile }>();
  const load = vi.fn(() => request.promise);
  const painter = createAngelScriptPainter(parseAngelScriptApi(""), load);
  painter.paint(f.node, f.diff);
  painter.paint(f.node, f.diff);
  expect(load).toHaveBeenCalledOnce();
  expect(f.rows.map((row) => row.attributes.has("data-angelscript-await"))).toEqual([false, false]);
  request.resolve(f);
  await request.promise;
  expect(f.rows.map((row) => row.attributes.has("data-angelscript-await"))).toEqual([true, true]);
  expect(CSS.highlights.get("as-await")?.size).toBe(2);
  painter.dispose();
  expect(CSS.highlights.has("as-await")).toBe(false);
});

it.each(["unmount", "dispose"])("does not paint a late revision after %s", async (kind) => {
  const f = fixture();
  const request = deferred<{ oldFile: typeof f.oldFile; newFile: typeof f.newFile }>();
  const painter = createAngelScriptPainter(parseAngelScriptApi(""), () => request.promise);
  painter.paint(f.node, f.diff);
  if (kind === "unmount") painter.paint(f.node, f.diff, "unmount");
  else painter.dispose();
  request.resolve(f);
  await request.promise;
  expect(f.rows.every((row) => !row.attributes.has("data-angelscript-await"))).toBe(true);
  expect(CSS.highlights.has("as-await")).toBe(false);
  painter.dispose();
});

it("can repaint after effect cleanup replay without accepting the retired request", async () => {
  const f = fixture();
  type Files = { oldFile: typeof f.oldFile; newFile: typeof f.newFile };
  const first = deferred<Files>();
  const second = deferred<Files>();
  const load = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const painter = createAngelScriptPainter(parseAngelScriptApi(""), load);
  painter.paint(f.node, f.diff);
  painter.dispose();
  painter.paint(f.node, f.diff);
  first.resolve(f);
  await first.promise;
  expect(f.rows.every((row) => !row.attributes.has("data-angelscript-await"))).toBe(true);
  second.resolve(f);
  await second.promise;
  expect(f.rows.every((row) => row.attributes.has("data-angelscript-await"))).toBe(true);
  painter.dispose();
});
