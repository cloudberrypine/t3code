import type { CodeViewItem } from "@pierre/diffs";
import type { CodeViewHandle } from "@pierre/diffs/react";
import { ArrowDown, ArrowUp, CaseSensitive, Regex, WholeWord, X } from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type RefObject,
  type ComponentProps,
} from "react";

import { Button } from "~/components/ui/button";
import { Tooltip, TooltipTrigger, TooltipPopup } from "~/components/ui/tooltip";
import { Input } from "~/components/ui/input";
import { usePaneFindShortcut } from "~/hooks/usePaneFindShortcut";

import {
  diffSearchRowLine,
  searchDiffItems,
  textRange,
  type DiffSearchOptions,
} from "./diffSearch";

function SearchButton({ label, ...props }: ComponentProps<typeof Button> & { label: string }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={<Button size="icon-xs" variant="ghost" aria-label={label} {...props} />}
      />
      <TooltipPopup>{label}</TooltipPopup>
    </Tooltip>
  );
}

export function useDiffSearch<T>(
  items: readonly CodeViewItem<T>[],
  viewer: RefObject<CodeViewHandle<T> | null>,
  onRevealItem?: (id: string) => void,
) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [options, setOptions] = useState<DiffSearchOptions>({
    caseSensitive: false,
    wholeWord: false,
    regex: false,
  });
  const [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const pane = useRef<HTMLDivElement>(null);
  const highlightName = `diff-search-${useId().replace(/[^a-zA-Z0-9-]/g, "")}`;
  const result = useMemo(
    () => searchDiffItems(items, open ? query : "", options),
    [items, open, query, options],
  );
  const activeIndex = result.matches.length ? index % result.matches.length : 0;
  const active = result.matches[activeIndex];
  const matchesByItem = useMemo(() => {
    const grouped = new Map<string, Map<string, typeof result.matches>>();
    for (const match of result.matches) {
      let lines = grouped.get(match.id);
      if (!lines) grouped.set(match.id, (lines = new Map()));
      const key = `${match.side}:${match.line}`;
      const matches = lines.get(key) ?? [];
      matches.push(match);
      lines.set(key, matches);
    }
    return grouped;
  }, [result]);
  const findShortcut = usePaneFindShortcut(() => {
    setOpen(true);
    input.current?.focus();
    input.current?.select();
  });
  useEffect(() => {
    if (open) {
      input.current?.focus();
      input.current?.select();
    }
  }, [open]);

  const paint = useCallback(() => {
    if (typeof CSS === "undefined" || !CSS.highlights) return;
    const all = new Highlight();
    const current = new Highlight();
    for (const item of viewer.current?.getInstance()?.getRenderedItems() ?? []) {
      const lines = matchesByItem.get(item.id);
      if (!lines) continue;
      for (const row of item.element.shadowRoot?.querySelectorAll<HTMLElement>(
        "[data-code] [data-line]",
      ) ?? []) {
        const { side, line } = diffSearchRowLine(row);
        for (const match of lines.get(`${side}:${line}`) ?? []) {
          const range = textRange(row, match.start, match.end);
          if (range) {
            all.add(range);
            if (match === active) current.add(range);
          }
        }
      }
    }
    CSS.highlights.set(highlightName, all);
    CSS.highlights.set(`${highlightName}-active`, current);
  }, [active, highlightName, matchesByItem, viewer]);
  const paintRef = useRef(paint);
  useEffect(() => {
    paintRef.current = paint;
  });
  const frame = useRef<number | null>(null);
  const schedulePaint = useCallback(() => {
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      paintRef.current();
    });
  }, []);
  useEffect(() => {
    paint();
    return () => {
      if (typeof CSS !== "undefined" && CSS.highlights) {
        CSS.highlights.delete(highlightName);
        CSS.highlights.delete(`${highlightName}-active`);
      }
    };
  }, [paint, highlightName]);
  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    },
    [],
  );

  useEffect(() => {
    if (!active) return;
    const item = items.find((candidate) => candidate.id === active.id);
    if (item?.collapsed) {
      onRevealItem?.(item.id);
      return;
    }
    viewer.current?.scrollTo({
      type: "line",
      id: active.id,
      lineNumber: active.line,
      side: active.side,
      align: "center",
      behavior: "instant",
    });
    schedulePaint();
  }, [active, items, onRevealItem, viewer, schedulePaint]);

  const navigate = (direction: number) =>
    setIndex((activeIndex + direction + result.matches.length) % (result.matches.length || 1));
  const close = () => {
    setOpen(false);
    pane.current?.focus({ preventScroll: true });
  };
  return {
    pane,
    findShortcut,
    onPostRender: open && result.matches.length ? schedulePaint : () => {},
    css: `::highlight(${highlightName}) { background-color: #eab30870; color: inherit; }
      ::highlight(${highlightName}-active) { background-color: #f59e0b; color: #171717; }`,
    popup: open ? (
      <div
        role="search"
        aria-label="Find in diffs"
        className="absolute right-2 top-2 z-20 flex max-w-[calc(100%_-_1rem)] flex-wrap items-center gap-1 rounded-md border border-border bg-popover p-1.5 text-popover-foreground shadow-lg"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            close();
          }
          if (event.key === "Enter") {
            event.preventDefault();
            event.stopPropagation();
            navigate(event.shiftKey ? -1 : 1);
          }
        }}
      >
        <Input
          ref={input}
          size="sm"
          className="w-44 min-w-20 flex-1"
          aria-label="Find in diffs"
          placeholder="Find in diffs"
          value={query}
          aria-invalid={result.error !== null}
          spellCheck={false}
          onChange={(event) => {
            setQuery(event.target.value);
            setIndex(0);
          }}
        />
        {(
          [
            ["caseSensitive", "Match case", CaseSensitive],
            ["wholeWord", "Match whole word", WholeWord],
            ["regex", "Use regular expression", Regex],
          ] as const
        ).map(([key, label, Icon]) => (
          <SearchButton
            key={key}
            size="icon-xs"
            variant={options[key] ? "secondary" : "ghost"}
            label={label}
            aria-pressed={options[key]}
            onClick={() => {
              setOptions((current) => ({ ...current, [key]: !current[key] }));
              setIndex(0);
            }}
          >
            <Icon className="size-3.5" />
          </SearchButton>
        ))}
        <span role="status" className="px-1 text-xs tabular-nums text-muted-foreground">
          {result.error ??
            (result.matches.length
              ? `${activeIndex + 1} of ${result.matches.length}${result.truncated ? "+" : ""}`
              : "No results")}
        </span>
        <SearchButton
          size="icon-xs"
          variant="ghost"
          label="Previous match (Shift+Enter)"
          disabled={!active}
          onClick={() => navigate(-1)}
        >
          <ArrowUp />
        </SearchButton>
        <SearchButton
          size="icon-xs"
          variant="ghost"
          label="Next match (Enter)"
          disabled={!active}
          onClick={() => navigate(1)}
        >
          <ArrowDown />
        </SearchButton>
        <SearchButton size="icon-xs" variant="ghost" label="Close search (Escape)" onClick={close}>
          <X />
        </SearchButton>
      </div>
    ) : null,
  };
}
