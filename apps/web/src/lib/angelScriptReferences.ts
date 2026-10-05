import type { FileContents } from "@pierre/diffs";
import { isAngelScriptPath, type AngelScriptApi } from "@t3tools/shared/angelscript";
import { createAngelScriptNavigation } from "@t3tools/shared/angelscriptNavigation";
import { textRange } from "~/components/diffs/diffSearch";

const HIGHLIGHT = "as-reference";

/** Paint only visible rows, and retain occurrence offsets when the viewer virtualizes them. */
export function createAngelScriptReferenceHighlights(api: AngelScriptApi | null = null) {
  const mounted = new Map<HTMLElement, FileContents>();
  const documents = new Set<Document>();
  const painted = new Map<HTMLElement, Range[]>();
  let active: { name: string; contents: string; offset: number } | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let matches: Array<{ start: number; end: number; line: number }> = [];
  let cached:
    | {
        contents: string;
        name: string;
        navigation: ReturnType<typeof createAngelScriptNavigation>;
        lines: number[];
      }
    | undefined;

  function clearNode(node: HTMLElement) {
    if (typeof CSS !== "undefined") {
      const highlight = CSS.highlights?.get(HIGHLIGHT);
      for (const range of painted.get(node) ?? []) highlight?.delete(range);
      if (highlight?.size === 0) CSS.highlights.delete(HIGHLIGHT);
    }
    painted.delete(node);
  }
  function clear() {
    clearTimeout(timer);
    timer = undefined;
    active = undefined;
    matches = [];
    for (const node of painted.keys()) clearNode(node);
  }
  function paint(node: HTMLElement) {
    clearNode(node);
    const file = mounted.get(node);
    if (
      !active ||
      !file ||
      file.name !== active.name ||
      file.contents !== active.contents ||
      !cached ||
      typeof CSS === "undefined" ||
      !CSS.highlights ||
      typeof Highlight === "undefined"
    )
      return;
    const ranges: Range[] = [];
    const root = node.shadowRoot ?? node;
    const byLine = new Map<number, typeof matches>();
    for (const match of matches) {
      const line = byLine.get(match.line) ?? [];
      line.push(match);
      byLine.set(match.line, line);
    }
    for (const row of root.querySelectorAll<HTMLElement>("[data-code] [data-line]")) {
      const line = Number(row.dataset.line);
      const start = cached.lines[line - 1];
      if (start === undefined) continue;
      for (const match of byLine.get(line) ?? []) {
        const range = textRange(row, match.start - start, match.end - start);
        if (range) ranges.push(range);
      }
    }
    if (!ranges.length) return;
    let highlight = CSS.highlights.get(HIGHLIGHT);
    if (!highlight) {
      highlight = new Highlight();
      CSS.highlights.set(HIGHLIGHT, highlight);
    }
    for (const range of ranges) highlight.add(range);
    painted.set(node, ranges);
  }
  function caret(file: FileContents, offset: number) {
    if (
      !isAngelScriptPath(file.name) ||
      file.contents.length > 2_000_000 ||
      typeof CSS === "undefined" ||
      !CSS.highlights
    ) {
      clear();
      return;
    }
    // At the end of a name the caret still belongs to that identifier.
    while (offset > 0 && /[A-Za-z0-9_]/.test(file.contents[offset - 1]!)) offset--;
    if (active?.name === file.name && active.contents === file.contents && active.offset === offset)
      return;
    clear();
    active = { name: file.name, contents: file.contents, offset };
    const target = active;
    // Coalesce caret movement while an arrow key is held down.
    timer = setTimeout(() => {
      timer = undefined;
      if (active !== target) return;
      if (cached?.name !== target.name || cached.contents !== target.contents) {
        const lines = [0];
        for (let i = 0; i < target.contents.length; i++)
          if (target.contents[i] === "\n") lines.push(i + 1);
        cached = {
          name: target.name,
          contents: target.contents,
          lines,
          navigation: createAngelScriptNavigation([
            { path: target.name, contents: target.contents },
            ...(api?.source && api.source.path !== target.name ? [api.source] : []),
          ]),
        };
      }
      matches = cached.navigation.references(target.name, target.offset);
      for (const node of mounted.keys()) paint(node);
    }, 100);
  }
  function selectionChanged() {
    for (const [node, file] of mounted) {
      const selection = node.ownerDocument.getSelection();
      if (!selection?.isCollapsed) continue;
      const range = selection.getComposedRanges?.({
        shadowRoots: node.shadowRoot ? [node.shadowRoot] : [],
      })[0];
      const anchor = range?.startContainer ?? selection.anchorNode;
      const offset = range?.startOffset ?? selection.anchorOffset;
      const element = anchor instanceof HTMLElement ? anchor : anchor?.parentElement;
      const row = element?.closest<HTMLElement>("[data-line]");
      if (
        !anchor ||
        !row ||
        !row.closest("[data-code]") ||
        row.getRootNode() !== (node.shadowRoot ?? node)
      )
        continue;
      const line = Number(row.dataset.line);
      if (!Number.isInteger(line) || line < 1) continue;
      const prefix = node.ownerDocument.createRange();
      prefix.selectNodeContents(row);
      prefix.setEnd(anchor, offset);
      let start = 0;
      for (let current = 1; current < line; current++) {
        const end = file.contents.indexOf("\n", start);
        if (end < 0) {
          clear();
          return;
        }
        start = end + 1;
      }
      caret(file, start + prefix.toString().length);
      return;
    }
    clear();
  }
  function releaseDocuments() {
    for (const document of documents) {
      if ([...mounted.keys()].some((node) => node.ownerDocument === document)) continue;
      document.removeEventListener("selectionchange", selectionChanged);
      documents.delete(document);
    }
  }
  return {
    attach(node: HTMLElement, file?: FileContents) {
      const old = mounted.get(node);
      if (!file || !isAngelScriptPath(file.name)) {
        clearNode(node);
        mounted.delete(node);
        releaseDocuments();
        if (old?.name === active?.name) clear();
        return;
      }
      if (old && (old.name !== file.name || old.contents !== file.contents)) clear();
      mounted.set(node, { ...file });
      if (!documents.has(node.ownerDocument)) {
        documents.add(node.ownerDocument);
        node.ownerDocument.addEventListener("selectionchange", selectionChanged);
      }
      paint(node);
    },
    clear,
    dispose() {
      clear();
      mounted.clear();
      releaseDocuments();
      cached = undefined;
    },
  };
}
