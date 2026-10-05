import type { FileContents } from "@pierre/diffs";
import {
  angelScriptStateTree,
  isAngelScriptPath,
  tokenizeAngelScript,
  type AngelScriptApi,
} from "@t3tools/shared/angelscript";
import { createAngelScriptReferenceHighlights } from "./angelScriptReferences";
import { textRange } from "~/components/diffs/diffSearch";

interface NavigationToken {
  start: number;
  end: number;
  offset: number;
}

export type NavigationSource =
  | FileContents
  | ((row: HTMLElement) => {
      file: FileContents;
      line: number;
      partial?: boolean;
    } | null);

/** Hit-test actual text rectangles, including wrapped lines and Pierre's shadow DOM. */
export function createAngelScriptClickNavigation(
  navigate: (file: FileContents, offset: number, isCurrent: () => boolean) => void,
  api: AngelScriptApi | null = null,
) {
  let requestId = 0;
  const references = createAngelScriptReferenceHighlights(api);
  const attached = new Map<
    HTMLElement,
    { file: NavigationSource; contents: string | undefined; dispose: () => void }
  >();
  const cache = new WeakMap<
    FileContents,
    { contents: string; partial: boolean; lines: Map<number, NavigationToken[]> }
  >();
  function linesFor(file: FileContents, partial = false) {
    const previous = cache.get(file);
    if (previous?.contents === file.contents && previous.partial === partial) return previous.lines;
    const lines = new Map<number, NavigationToken[]>();
    const offsets = [0];
    for (let i = 0; i < file.contents.length; i++)
      if (file.contents[i] === "\n") offsets.push(i + 1);
    const tokens = tokenizeAngelScript(file.contents);
    for (const token of tokens) {
      if (token.comment || !/^[A-Za-z_]\w*$/.test(token.text)) continue;
      const line = lines.get(token.line) ?? [];
      line.push({
        start: token.start - offsets[token.line - 1]!,
        end: token.end - offsets[token.line - 1]!,
        offset: token.start,
      });
      lines.set(token.line, line);
    }
    if (isAngelScriptPath(file.name)) {
      for (const entry of angelScriptStateTree(file.contents, partial)) {
        const line = lines.get(entry.line) ?? [];
        const start = offsets[entry.line - 1]!;
        line.push({ start: entry.start - start, end: entry.end - start, offset: entry.start });
        if (entry.file && entry.fileStart !== undefined) {
          line.push({
            start: entry.fileStart - start,
            end: entry.fileStart + entry.file.length - start,
            offset: entry.fileStart,
          });
        }
        lines.set(entry.line, line);
      }
    }
    for (const [index, start] of offsets.entries()) {
      const text = file.contents.slice(start, offsets[index + 1]);
      const include = /^\s*#\s*include\s+["'<]([^"'>]+)["'>]/.exec(text);
      if (!include) continue;
      const first = text.indexOf(include[1]!);
      if (
        tokens.some(
          (token) => token.comment && token.start <= start + first && start + first < token.end,
        )
      )
        continue;
      const line = lines.get(index + 1) ?? [];
      line.push({ start: first, end: first + include[1]!.length, offset: start + first });
      lines.set(index + 1, line);
    }
    cache.set(file, { contents: file.contents, partial, lines });
    return lines;
  }
  return {
    beginRequest() {
      const request = ++requestId;
      return () => request === requestId;
    },
    currentLine(path: string, fallback: number) {
      for (const [node, entry] of attached) {
        if (typeof entry.file === "function" || entry.file.name !== path) continue;
        const root = node.shadowRoot ?? node;
        const selection = node.ownerDocument.getSelection();
        const range = selection?.getComposedRanges?.({
          shadowRoots: node.shadowRoot ? [node.shadowRoot] : [],
        })[0];
        const anchor = range?.startContainer ?? selection?.anchorNode;
        const element = anchor instanceof HTMLElement ? anchor : anchor?.parentElement;
        const row = element?.closest<HTMLElement>("[data-line]");
        if (row?.getRootNode() === root) {
          const line = Number(row?.dataset.line);
          if (line > 0) return line;
        }
      }
      return fallback;
    },
    cancelPending() {
      requestId++;
    },
    attach(node: HTMLElement, file: NavigationSource | undefined, phase?: string) {
      references.attach(node, phase !== "unmount" && typeof file !== "function" ? file : undefined);
      const existing = attached.get(node);
      if (phase === "unmount" || !file) {
        requestId++;
        existing?.dispose();
        attached.delete(node);
        return;
      }
      const contents = typeof file === "function" ? undefined : file.contents;
      if (existing) {
        if (
          existing.contents !== contents ||
          (typeof file === "function" && existing.file !== file) ||
          (typeof file !== "function" &&
            typeof existing.file !== "function" &&
            existing.file.name !== file.name)
        )
          requestId++;
        existing.file = file;
        existing.contents = contents;
        return;
      }
      const root = node.shadowRoot ?? node;
      let hovered: HTMLElement | undefined;
      let originalCursor = "";
      const clearCursor = () => {
        if (hovered) hovered.style.cursor = originalCursor;
        hovered = undefined;
      };
      const clear = () => {
        clearCursor();
        references.clear();
      };
      const hit = (event: MouseEvent) => {
        if ((!event.metaKey && !event.ctrlKey) || event.altKey || event.shiftKey) return null;
        const source = attached.get(node)?.file;
        if (!source) return null;
        const row = event
          .composedPath()
          .find(
            (part): part is HTMLElement =>
              part instanceof HTMLElement &&
              part.hasAttribute("data-line") &&
              part.closest("[data-code]") !== null,
          );
        if (!row) return null;
        const location =
          typeof source === "function"
            ? source(row)
            : { file: source, line: Number(row.dataset.line), partial: false };
        if (!location || location.file.contents.length > 2_000_000) return null;
        const current = location.file;
        for (const token of linesFor(current, location.partial).get(location.line) ?? []) {
          const range = textRange(row, token.start, token.end);
          if (!range) continue;
          for (const rect of range.getClientRects()) {
            if (
              rect.left <= event.clientX &&
              event.clientX < rect.right &&
              rect.top <= event.clientY &&
              event.clientY < rect.bottom
            )
              return { row, file: current, offset: token.offset };
          }
        }
        return null;
      };
      const move = (event: Event) => {
        clearCursor();
        const target = hit(event as MouseEvent);
        if (target) {
          hovered = target.row;
          originalCursor = hovered.style.cursor;
          hovered.style.cursor = "pointer";
        }
      };
      const down = (event: Event) => {
        const mouse = event as MouseEvent;
        if (mouse.button !== 0 || !hit(mouse)) return;
        // Keep the editor from starting a selection or comment while following a symbol.
        event.preventDefault();
        event.stopImmediatePropagation();
      };
      const click = (event: Event) => {
        const mouse = event as MouseEvent;
        if (mouse.button !== 0) return;
        const target = hit(mouse);
        if (!target) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        clear();
        const request = ++requestId;
        navigate(target.file, target.offset, () => request === requestId);
      };
      root.addEventListener("pointermove", move);
      node.addEventListener("pointerleave", clearCursor);
      root.addEventListener("pointerdown", down, true);
      root.addEventListener("mousedown", down, true);
      root.addEventListener("click", click, true);
      window.addEventListener("keyup", clearCursor);
      window.addEventListener("blur", clear);
      attached.set(node, {
        file,
        contents,
        dispose: () => {
          clear();
          root.removeEventListener("pointermove", move);
          node.removeEventListener("pointerleave", clearCursor);
          root.removeEventListener("pointerdown", down, true);
          root.removeEventListener("mousedown", down, true);
          root.removeEventListener("click", click, true);
          window.removeEventListener("keyup", clearCursor);
          window.removeEventListener("blur", clear);
        },
      });
    },
    dispose() {
      requestId++;
      for (const entry of attached.values()) entry.dispose();
      attached.clear();
      references.dispose();
    },
  };
}
