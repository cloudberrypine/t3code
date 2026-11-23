// Polyzonia: find inside a file preview. An editable file's editor has its own find panel, which
// mod+f opens only while the caret is in its text, so `openEditorFind` opens it from anywhere in
// the file view. A read-only preview (a file outside the project, a truncated read) has no editor:
// `useReadOnlyFileFind` gives it a find bar that paints every match and centres the current one.
import type { Editor } from "@pierre/diffs/edit";
import { VirtualizedFile, type File as FileInstance, type PostRenderPhase } from "@pierre/diffs";
import { useGT } from "gt-react";
import { ChevronDownIcon, ChevronUpIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";

import { textRange } from "~/components/diffs/diffSearch";
import { isMacPlatform } from "~/lib/utils";

const MAX_MATCHES = 10_000;
const MATCH = "t3-file-find";
const CURRENT = "t3-file-find-current";

export const FILE_FIND_CSS = `
::highlight(${MATCH}) { background-color: light-dark(#fde68a, #5c4d12); }
::highlight(${CURRENT}) { background-color: light-dark(#f59e0b, #d9a43a); color: light-dark(#1c1200, #1c1200); }
`;

export interface FileFindMatch {
  /** 1-based line. */
  line: number;
  /** Offsets within the line. */
  start: number;
  end: number;
}

/** Every match of `query` in `text`, line by line. Case-insensitive unless the query has capitals. */
export function findFileMatches(text: string, query: string): FileFindMatch[] {
  if (!query) return [];
  const caseSensitive = query !== query.toLowerCase();
  const needle = caseSensitive ? query : query.toLowerCase();
  const matches: FileFindMatch[] = [];
  const lines = text.split("\n");
  for (const [index, raw] of lines.entries()) {
    const line = caseSensitive ? raw : raw.toLowerCase();
    for (let at = line.indexOf(needle); at >= 0; at = line.indexOf(needle, at + needle.length)) {
      matches.push({ line: index + 1, start: at, end: at + needle.length });
      if (matches.length >= MAX_MATCHES) return matches;
    }
  }
  return matches;
}

/** mod+f: Cmd+F on macOS, Ctrl+F elsewhere. */
export function isFindShortcut(event: KeyboardEvent | ReactKeyboardEvent): boolean {
  const mac = isMacPlatform(navigator.platform);
  return (
    event.key.toLowerCase() === "f" &&
    (mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey) &&
    !event.altKey &&
    !event.shiftKey
  );
}

/**
 * Opens an editable file's own find panel, as mod+f in its text does, from wherever the file view
 * has focus. Returns false when nothing in the file answered, as when it has no editor.
 */
export function openEditorFind(
  editor: { focus: Editor<"file">["focus"]; getViewState: Editor<"file">["getViewState"] } | null,
  surface: HTMLElement | null,
): boolean {
  const content = surface
    ?.querySelector("diffs-container")
    ?.shadowRoot?.querySelector<HTMLElement>("[data-content]");
  if (!content) return false;
  // The panel opens from the caret: with none yet, it starts on the first line in view.
  if (editor) {
    const hasCaret = (editor.getViewState().selections?.length ?? 0) > 0;
    editor.focus(
      hasCaret ? { preventScroll: true } : { lineNumber: "first-visible", preventScroll: true },
    );
  } else content.focus({ preventScroll: true });
  const mac = isMacPlatform(navigator.platform);
  const event = new KeyboardEvent("keydown", {
    key: "f",
    code: "KeyF",
    metaKey: mac,
    ctrlKey: !mac,
    bubbles: true,
    composed: true,
    cancelable: true,
  });
  content.dispatchEvent(event);
  // The editor claims the shortcut when it opens its panel.
  return event.defaultPrevented;
}

/** Whether a key event comes from an editor's own text, which answers mod+f itself. */
export function isFromEditorText(event: ReactKeyboardEvent): boolean {
  const origin = event.nativeEvent.composedPath()[0];
  return origin instanceof HTMLElement && origin.closest("[data-content]") !== null;
}

/** Paints a find's matches into one rendered file and scrolls it to the current match. */
class FindPainter {
  #node: HTMLElement | null = null;
  #instance: FileInstance<unknown, undefined> | null = null;
  #ranges: Array<{ name: string; range: Range }> = [];

  attach(node: HTMLElement, instance: FileInstance<unknown, undefined>) {
    if (this.#node !== node) this.clear();
    this.#node = node;
    this.#instance = instance;
  }

  detach() {
    this.clear();
    this.#node = null;
    this.#instance = null;
  }

  clear() {
    for (const { name, range } of this.#ranges) CSS.highlights?.get(name)?.delete(range);
    this.#ranges = [];
  }

  paint(matches: readonly FileFindMatch[], index: number) {
    const node = this.#node;
    if (!node || typeof CSS === "undefined" || !CSS.highlights) return;
    this.clear();
    if (!matches.length) return;
    const byLine = new Map<number, Array<{ match: FileFindMatch; at: number }>>();
    matches.forEach((match, at) => {
      const list = byLine.get(match.line) ?? [];
      list.push({ match, at });
      byLine.set(match.line, list);
    });
    const root = node.shadowRoot ?? node;
    for (const row of root.querySelectorAll<HTMLElement>("[data-code] [data-line]")) {
      for (const { match, at } of byLine.get(Number(row.dataset.line)) ?? []) {
        const range = textRange(row, match.start, match.end);
        if (!range) continue;
        const name = at === index ? CURRENT : MATCH;
        let highlight = CSS.highlights.get(name);
        if (!highlight) {
          highlight = new Highlight();
          CSS.highlights.set(name, highlight);
        }
        highlight.add(range);
        this.#ranges.push({ name, range });
      }
    }
  }

  reveal(matches: readonly FileFindMatch[], index: number) {
    this.paint(matches, index);
    const match = matches[index];
    const instance = this.#instance;
    if (!match || !(instance instanceof VirtualizedFile)) return;
    instance.scrollToLine(match.line, "center", () => this.paint(matches, index));
  }
}

/** A find bar for a read-only file preview: mod+f opens it, Enter and Shift+Enter step, Esc closes. */
export function useReadOnlyFileFind(text: string) {
  const gt = useGT();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [current, setCurrent] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const [painter] = useState(() => new FindPainter());
  const matches = open ? findFileMatches(text, query) : [];
  const index = matches.length ? Math.min(current, matches.length - 1) : -1;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- paints the matches into the file's shadow DOM and scrolls the virtualized file to the current one
  useEffect(() => painter.reveal(matches, index), [painter, matches, index]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- removes this preview's match highlights when it unmounts
  useEffect(() => () => painter.detach(), [painter]);

  const openBar = () => {
    const selected = window.getSelection()?.toString() ?? "";
    if (selected && !selected.includes("\n") && selected.length <= 200) {
      setQuery(selected);
      setCurrent(0);
    }
    setOpen(true);
    requestAnimationFrame(() => {
      input.current?.focus();
      input.current?.select();
    });
  };
  const close = (focusTarget?: HTMLElement | null) => {
    setOpen(false);
    focusTarget?.focus({ preventScroll: true });
  };
  const step = (by: number) => {
    if (!matches.length) return;
    setCurrent((index + by + matches.length) % matches.length);
  };

  const onKeyDownCapture = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (!isFindShortcut(event)) return;
    event.preventDefault();
    event.stopPropagation();
    openBar();
  };
  const onPostRender = (
    node: HTMLElement,
    instance: FileInstance<unknown, undefined>,
    phase: PostRenderPhase,
  ) => {
    if (phase === "unmount") {
      painter.detach();
      return;
    }
    painter.attach(node, instance);
    // Rows mount as the file scrolls: paint the ones that just appeared.
    painter.paint(matches, index);
  };

  const count = !query
    ? ""
    : matches.length
      ? gt("{current} of {total}", { current: index + 1, total: matches.length })
      : gt("No results");
  const bar = open ? (
    <div
      className="absolute top-2 right-4 z-20 flex items-center gap-1 rounded-md border border-border bg-popover px-2 py-1 text-popover-foreground shadow-md"
      data-file-find=""
    >
      <input
        ref={input}
        aria-label={gt("Find in file")}
        className="w-52 bg-transparent px-1 text-sm outline-none placeholder:text-muted-foreground"
        placeholder={gt("Find")}
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setCurrent(0);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            step(event.shiftKey ? -1 : 1);
          } else if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            close(event.currentTarget.closest<HTMLElement>("[data-file-find-root]"));
          } else if (isFindShortcut(event)) {
            event.preventDefault();
            event.stopPropagation();
            event.currentTarget.select();
          }
        }}
      />
      <span className="min-w-16 text-right text-xs text-muted-foreground tabular-nums">
        {count}
      </span>
      <button
        type="button"
        aria-label={gt("Previous match")}
        className="rounded p-0.5 hover:bg-accent disabled:opacity-40"
        disabled={!matches.length}
        onClick={() => step(-1)}
      >
        <ChevronUpIcon className="size-3.5" />
      </button>
      <button
        type="button"
        aria-label={gt("Next match")}
        className="rounded p-0.5 hover:bg-accent disabled:opacity-40"
        disabled={!matches.length}
        onClick={() => step(1)}
      >
        <ChevronDownIcon className="size-3.5" />
      </button>
      <button
        type="button"
        aria-label={gt("Close find")}
        className="rounded p-0.5 hover:bg-accent"
        onClick={(event) =>
          close(event.currentTarget.closest<HTMLElement>("[data-file-find-root]"))
        }
      >
        <XIcon className="size-3.5" />
      </button>
    </div>
  ) : null;

  return { bar, onKeyDownCapture, onPostRender, open: openBar };
}
