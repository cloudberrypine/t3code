import { afterEach, expect, it, vi } from "vite-plus/test";
import { createAngelScriptReferenceHighlights } from "./angelScriptReferences";

vi.mock("~/components/diffs/diffSearch", () => ({
  textRange: (row: { dataset: { line: string } }, start: number, end: number) => ({
    line: Number(row.dataset.line),
    start,
    end,
  }),
}));
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("highlights visible references, repaints virtualized rows, and clears stale ranges on edits and disposal", () => {
  vi.useFakeTimers();
  vi.stubGlobal("CSS", { highlights: new Map() });
  vi.stubGlobal("Highlight", Set);
  const file = {
    name: "main.as",
    contents: "int value;\nvoid run() { value++; }\nvoid other() { value++; }",
  };
  let lines = [1, 2];
  let caretOffset = 0;
  let selectedLine = 1;
  let selection: object | null = null;
  const document = Object.assign(new EventTarget(), {
    getSelection: () => selection,
    createRange: () => ({
      selectNodeContents: () => {},
      setEnd: (_node: unknown, offset: number) => {
        caretOffset = offset;
      },
      toString: () => file.contents.split("\n")[selectedLine - 1]!.slice(0, caretOffset),
    }),
  });
  const root = {
    querySelectorAll: () => lines.map((line) => ({ dataset: { line: String(line) } })),
  };
  class ElementStub {
    get dataset() {
      return { line: String(selectedLine) };
    }
    closest() {
      return this;
    }
    getRootNode() {
      return root;
    }
  }
  vi.stubGlobal("HTMLElement", ElementStub);
  const row = new ElementStub();
  const text = { parentElement: row };
  const node = { shadowRoot: root, ownerDocument: document } as unknown as HTMLElement;
  function moveCaret(offset: number, composed = true) {
    const before = file.contents.slice(0, offset);
    selectedLine = before.split("\n").length;
    const column = offset - before.lastIndexOf("\n") - 1;
    selection = {
      isCollapsed: true,
      anchorNode: composed ? node : text,
      anchorOffset: column,
      ...(composed
        ? { getComposedRanges: () => [{ startContainer: text, startOffset: column }] }
        : {}),
    };
    document.dispatchEvent(new Event("selectionchange"));
  }
  const references = createAngelScriptReferenceHighlights();
  references.attach(node, file);
  moveCaret(file.contents.indexOf("value"));
  vi.advanceTimersByTime(100);
  expect([...CSS.highlights.get("as-reference")!]).toEqual([
    { line: 1, start: 4, end: 9 },
    { line: 2, start: 13, end: 18 },
  ]);
  const unchanged = CSS.highlights.get("as-reference");
  // Keyboard movement within the identifier, including its end, retains the ranges.
  moveCaret(file.contents.indexOf("value") + 5);
  expect(CSS.highlights.get("as-reference")).toBe(unchanged);
  // Moving to another occurrence via the non-shadow selection fallback works too.
  moveCaret(file.contents.lastIndexOf("value") + 2, false);
  vi.advanceTimersByTime(100);
  expect(CSS.highlights.get("as-reference")?.size).toBe(2);
  moveCaret(file.contents.indexOf("run") + 1);
  vi.advanceTimersByTime(100);
  expect(CSS.highlights.has("as-reference")).toBe(false);
  moveCaret(file.contents.indexOf("value"));
  vi.advanceTimersByTime(100);
  selection = { isCollapsed: false };
  document.dispatchEvent(new Event("selectionchange"));
  expect(CSS.highlights.has("as-reference")).toBe(false);
  moveCaret(file.contents.indexOf("value"));
  vi.advanceTimersByTime(100);
  lines = [3];
  references.attach(node, file);
  expect([...CSS.highlights.get("as-reference")!]).toEqual([{ line: 3, start: 15, end: 20 }]);
  file.contents = file.contents.replaceAll("value", "next");
  references.attach(node, file);
  expect(CSS.highlights.has("as-reference")).toBe(false);
  moveCaret(file.contents.indexOf("next"));
  references.clear();
  vi.runAllTimers();
  expect(CSS.highlights.has("as-reference")).toBe(false);
  moveCaret(file.contents.indexOf("next"));
  vi.advanceTimersByTime(100);
  expect(CSS.highlights.get("as-reference")?.size).toBe(1);
  references.attach(node);
  moveCaret(file.contents.indexOf("next"));
  vi.runAllTimers();
  expect(CSS.highlights.has("as-reference")).toBe(false);
  references.attach(node, file);
  moveCaret(file.contents.indexOf("next"));
  vi.advanceTimersByTime(100);
  references.dispose();
  moveCaret(file.contents.indexOf("next"));
  vi.runAllTimers();
  expect(CSS.highlights.has("as-reference")).toBe(false);
});
