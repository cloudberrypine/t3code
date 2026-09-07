/* oxlint-disable eslint/no-restricted-imports -- This is the single styled adapter around Pierre's raw viewer. */
import {
  CodeView,
  type CodeViewHandle,
  type CodeViewProps,
  type ControlledCodeViewProps,
  type UncontrolledCodeViewProps,
} from "@pierre/diffs/react";
/* oxlint-enable eslint/no-restricted-imports */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useImperativeHandle,
  useState,
  type Ref,
} from "react";
import type { CodeViewItem } from "@pierre/diffs";

import { DiffWorkerPoolProvider } from "../DiffWorkerPoolProvider";
import { isAngelScriptPath, usesAngelScript } from "@t3tools/shared/angelscript";
import { useAngelScript, type AngelScriptWorkspace } from "~/hooks/useAngelScript";
import {
  ANGELSCRIPT_CSS,
  createAngelScriptPainter,
  withAngelScriptLanguage,
} from "~/lib/angelScriptRendering";

import { useDiffSearch } from "./useDiffSearch";
import { findAnchoredDiffItem } from "./diffScrollAnchor";

import { createDiffContextController, DIFF_CONTEXT_LINES } from "~/lib/diffContext";

import {
  DIFF_SURFACE_THEME_UNSAFE_CSS,
  getDiffLineStat,
  resolveFileDiffPath,
} from "~/lib/diffRendering";

/** React owns counts because Pierre can retain cached header HTML when an item updates. */
function renderDiffHeaderMetadata(item: CodeViewItem<unknown>) {
  if (item.type !== "diff") return null;
  const { additions, deletions } = getDiffLineStat([item.fileDiff]);
  return (
    <span className="inline-flex items-center gap-2 font-mono text-[11px] leading-none tabular-nums">
      {(deletions > 0 || additions === 0) && <span className="text-destructive">-{deletions}</span>}
      {(additions > 0 || deletions === 0) && (
        <span className="text-emerald-600 dark:text-emerald-300/90">+{additions}</span>
      )}
    </span>
  );
}

const DIFF_VIEW_UNSAFE_CSS = `${DIFF_SURFACE_THEME_UNSAFE_CSS}
:is(
  [data-line],
  [data-line-annotation],
  [data-merge-conflict],
  [data-merge-conflict-actions],
  [data-no-newline]
)[data-selected-line] {
  --diffs-line-bg: light-dark(
    color-mix(
      in lab,
      var(--code-background) 88%,
      color-mix(in srgb, var(--code-background) 50%, var(--diffs-modified-base))
    ),
    color-mix(
      in lab,
      var(--code-background) 80%,
      color-mix(in srgb, var(--code-background) 70%, var(--diffs-modified-base))
    )
  ) !important;
}

:is([data-gutter-buffer], [data-column-number])[data-selected-line] {
  --diffs-line-bg: light-dark(
    color-mix(
      in lab,
      var(--code-background) 91%,
      color-mix(in srgb, var(--code-background) 35%, var(--diffs-modified-base))
    ),
    color-mix(
      in lab,
      var(--code-background) 85%,
      color-mix(in srgb, var(--code-background) 60%, var(--diffs-modified-base))
    )
  ) !important;
}

[data-indicators="bars"]
  :is([data-column-number], [data-gutter-buffer="annotation"])[data-selected-line] {
  position: relative;
}

[data-indicators="bars"]
  :is([data-column-number], [data-gutter-buffer="annotation"])[data-selected-line]::before {
  position: absolute !important;
  inset-block: 0 !important;
  inset-inline-start: 0 !important;
  display: block !important;
  width: 4px !important;
  min-width: 4px !important;
  max-width: 4px !important;
  height: auto !important;
  padding: 0 !important;
  content: "" !important;
  background-color: var(--diffs-modified-base) !important;
  background-image: none !important;
}

[data-file-info] {
  background-color: var(--code-background) !important;
  border-block-color: transparent !important;
  color: var(--code-foreground) !important;
}

[data-diffs-header] {
  --diff-header-bg: light-dark(
    color-mix(in srgb, var(--code-background) 94%, var(--primary)),
    color-mix(in srgb, var(--code-background) 85%, var(--primary))
  );
  position: sticky !important;
  top: 0;
  z-index: 4;
  background-color: var(--diff-header-bg) !important;
  border-bottom-color: color-mix(in srgb, var(--code-background) 80%, var(--primary)) !important;
  align-items: center !important;
  font-family: var(--font-sans) !important;
  font-size: 12px !important;
  line-height: 1 !important;
  min-height: 32px !important;
  padding-block: 6px !important;
  padding-inline: 8px 12px !important;
}

[data-diffs-header]:hover {
  background-color: light-dark(
    color-mix(in srgb, var(--code-background) 91%, var(--primary)),
    color-mix(in srgb, var(--code-background) 81%, var(--primary))
  ) !important;
}

:is([data-separator="line-info"], [data-separator="line-info-basic"]) {
  --context-row-bg: color-mix(in srgb, var(--code-background) 91%, var(--primary));
  --context-row-border: color-mix(in srgb, var(--code-background) 80%, var(--primary));
  height: 24px !important;
  margin-block: 0 !important;
  background-color: var(--context-row-bg) !important;
}

:is([data-separator="line-info"], [data-separator="line-info-basic"]):is(:hover, :focus-within) {
  --context-row-bg: color-mix(in srgb, var(--code-background) 86%, var(--primary));
}

:is([data-separator="line-info"], [data-separator="line-info-basic"])
  [data-separator-wrapper] {
  padding-inline: 8px 12px !important;
  background-color: var(--context-row-bg) !important;
  box-shadow:
    inset 0 1px var(--context-row-border),
    inset 0 -1px var(--context-row-border);
}

:is([data-separator="line-info"], [data-separator="line-info-basic"])
  [data-separator-content] {
  gap: 8px;
  padding-inline: 0 !important;
  background-color: transparent !important;
  color: color-mix(in srgb, var(--code-foreground) 78%, var(--code-background)) !important;
  font-family: var(--font-sans) !important;
  font-size: 11px !important;
  text-decoration: none !important;
}

:is([data-separator="line-info"], [data-separator="line-info-basic"])
  [data-unmodified-lines] {
  display: flex !important;
  min-width: 0;
  flex: 1 1 auto;
  align-items: center;
  gap: 8px;
}

[data-context-controls] {
  grid-template-columns: auto minmax(0, 1fr) auto !important;
  /* Pierre stacks its two expand buttons on fine pointers; our controls share one row. */
  grid-template-rows: minmax(0, 1fr) !important;
  align-items: center;
  gap: 8px;
  height: 24px;
}

[data-separator-first] [data-context-controls] {
  grid-template-columns: minmax(0, 1fr) auto !important;
}

[data-separator-last] [data-context-controls] {
  grid-template-columns: auto minmax(0, 1fr) !important;
}

[data-context-controls] button {
  appearance: none;
  border: 0;
  background: transparent;
  color: color-mix(in srgb, var(--code-foreground) 78%, var(--code-background));
  font: 500 11px var(--font-sans);
  border-radius: 3px;
  white-space: nowrap;
  padding: 2px 4px;
  cursor: pointer;
}

[data-context-controls] button:hover:not(:disabled) {
  color: var(--code-foreground);
  background: color-mix(in srgb, var(--code-background) 78%, var(--primary));
}

[data-context-controls] button:focus-visible {
  outline: 2px solid var(--primary);
  outline-offset: -2px;
  border-radius: 3px;
}

[data-context-controls] button:disabled {
  cursor: default;
}

[data-context-count] {
  flex: 1;
  min-width: 0;
}

[data-unmodified-lines]::before,
[data-unmodified-lines]::after {
  height: 1px;
  flex: 1;
  content: "";
  background-color: var(--context-row-border);
}

[data-diffs-header] [data-header-content] {
  align-items: center !important;
  line-height: 1 !important;
}

[data-diffs-header] [data-metadata] {
  align-items: center !important;
  line-height: 1 !important;
  font-variant-numeric: tabular-nums;
}

[data-diffs-header] [data-additions-count],
[data-diffs-header] [data-deletions-count] {
  display: none !important;
}

[data-diffs-header] [data-change-icon],
[data-diffs-header] [data-rename-icon] {
  display: block;
  flex-shrink: 0;
}

[data-title] {
  cursor: pointer;
  transition:
    color 120ms ease,
    text-decoration-color 120ms ease;
  text-decoration: underline;
  text-decoration-color: transparent;
  text-underline-offset: 2px;
  font-family: var(--font-sans) !important;
}

[data-title]:hover {
  color: color-mix(in srgb, var(--code-foreground) 84%, var(--primary)) !important;
  text-decoration-color: currentColor;
}

/* Expanding a file mounts its body all at once; easing it in matches the 200ms the app's
   collapsibles take. Appearance only — the viewer owns geometry, so height cannot animate.
   Departing content cuts, the same one-way rule the pull request chrome fold follows. */
[data-diff],
[data-file] {
  transition: opacity 200ms ease-out;
}

@starting-style {
  [data-diff],
  [data-file] {
    opacity: 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  [data-diff],
  [data-file] {
    transition: none;
  }
}
`;

export type StyledDiffCodeViewOptions<LAnnotation> = Omit<
  NonNullable<CodeViewProps<LAnnotation>["options"]>,
  "unsafeCSS" | "itemMetrics" | "layout"
>;

type StyledDiffCodeViewProps<LAnnotation> = (
  | Omit<ControlledCodeViewProps<LAnnotation>, "options">
  | Omit<UncontrolledCodeViewProps<LAnnotation>, "options">
) & {
  readonly options?: StyledDiffCodeViewOptions<LAnnotation>;
  readonly viewerRef?: Ref<CodeViewHandle<LAnnotation>>;
  readonly onRevealItem?: (id: string) => void;
  readonly onActiveFileChange?: (path: string | null) => void;
  /**
   * Appended to the shared stylesheet inside the viewer's shadow root, for a surface that has
   * to restyle chrome the viewer owns — such as replacing its per-file line counts.
   */
  readonly unsafeCSSExtra?: string;
  readonly workspace?: AngelScriptWorkspace;
};

/** The shared web CodeView surface: app styling and virtualized geometry stay paired here. */
export function StyledDiffCodeView<LAnnotation = undefined>({
  options,
  viewerRef,
  onRevealItem,
  onActiveFileChange,
  onScroll,
  className,
  unsafeCSSExtra,
  workspace,
  ...props
}: StyledDiffCodeViewProps<LAnnotation>) {
  const originalItems = props.items ?? props.initialItems ?? [];
  const hasScripts = originalItems.some((item) =>
    isAngelScriptPath(item.type === "file" ? item.file.name : item.fileDiff.name),
  );
  const api = useAngelScript(hasScripts ? workspace : undefined);
  const painter = useMemo(() => createAngelScriptPainter(api), [api]);
  useEffect(() => () => painter.dispose(), [painter]);
  const items = useMemo(
    () =>
      originalItems.map((item) => {
        if (item.type === "file" && usesAngelScript(item.file.name, item.file.contents, api))
          return {
            ...item,
            file: withAngelScriptLanguage(item.file),
            version: (item.version ?? 0) + 1,
          };
        if (
          item.type === "diff" &&
          usesAngelScript(
            item.fileDiff.name,
            item.fileDiff.additionLines.slice(0, 100).join("") +
              item.fileDiff.deletionLines.slice(0, 100).join(""),
            api,
          )
        )
          return {
            ...item,
            fileDiff: withAngelScriptLanguage(item.fileDiff),
            version: (item.version ?? 0) + 1,
          };
        return item;
      }),
    [originalItems, api],
  );
  const context = useMemo(
    () => createDiffContextController(options?.loadDiffFiles),
    [options?.loadDiffFiles],
  );
  const internalRef = useRef<CodeViewHandle<LAnnotation>>(null);
  const [viewer, setViewer] = useState<CodeViewHandle<LAnnotation> | null>(null);
  const attachViewer = useCallback((handle: CodeViewHandle<LAnnotation> | null) => {
    internalRef.current = handle;
    setViewer(handle);
  }, []);
  useImperativeHandle(viewerRef, () => viewer!, [viewer]);
  const activeFile = useRef<string | null | undefined>(undefined);
  const activeFrame = useRef<number | null>(null);
  const updateActiveFile = useCallback(() => {
    if (!onActiveFileChange || activeFrame.current !== null) return;
    activeFrame.current = requestAnimationFrame(() => {
      activeFrame.current = null;
      const viewer = internalRef.current?.getInstance();
      if (!viewer) return;
      const item = findAnchoredDiffItem(items, viewer.getScrollTop(), (id) =>
        viewer.getTopForItem(id),
      );
      const path =
        item?.type === "diff" ? resolveFileDiffPath(item.fileDiff) : (item?.file.name ?? null);
      if (path === activeFile.current) return;
      activeFile.current = path;
      onActiveFileChange(path);
    });
  }, [items, onActiveFileChange]);
  useEffect(() => {
    updateActiveFile();
    return () => {
      if (activeFrame.current !== null) cancelAnimationFrame(activeFrame.current);
      activeFrame.current = null;
    };
  }, [updateActiveFile]);
  const { pane, findShortcut, popup, css, onPostRender } = useDiffSearch(
    props.items ?? props.initialItems ?? [],
    internalRef,
    onRevealItem,
  );
  return (
    <DiffWorkerPoolProvider>
      <div
        ref={pane}
        {...findShortcut}
        className="relative flex h-full min-h-0 min-w-0 flex-1 flex-col outline-none"
      >
        {popup}
        <CodeView<LAnnotation>
          {...(props.items !== undefined ? { ...props, items } : { ...props, initialItems: items })}
          renderHeaderMetadata={props.renderHeaderMetadata ?? renderDiffHeaderMetadata}
          onScroll={(scrollTop, viewer) => {
            updateActiveFile();
            onScroll?.(scrollTop, viewer);
          }}
          ref={attachViewer}
          // The custom element itself is focusable for keyboard scrolling. Its native outline sits
          // outside the panel clipping boundary; actual controls inside retain their own indicators.
          className={
            className
              ? `diff-render-surface [--code-background:var(--background)] outline-none ${className}`
              : "diff-render-surface [--code-background:var(--background)] outline-none"
          }
          options={{
            ...options,
            lineDiffType: "none",
            expansionLineCount: DIFF_CONTEXT_LINES,
            collapsedContextThreshold: 0,
            ...(context.loadDiffFiles ? { loadDiffFiles: context.loadDiffFiles } : {}),
            onPostRender(node, instance, phase, itemContext) {
              updateActiveFile();
              onPostRender();
              painter.paint(
                node,
                itemContext.type === "diff"
                  ? itemContext.instance.fileDiff
                  : itemContext.instance.file,
                phase,
              );
              if (itemContext.type === "diff") {
                context.render(
                  node,
                  itemContext.instance,
                  phase,
                  itemContext.item.collapsed ?? false,
                );
                options?.onPostRender?.(node, itemContext.instance, phase, itemContext);
              } else {
                options?.onPostRender?.(node, itemContext.instance, phase, itemContext);
              }
            },
            unsafeCSS: `${DIFF_VIEW_UNSAFE_CSS}\n${ANGELSCRIPT_CSS}\n${css}\n${unsafeCSSExtra ?? ""}`,
            itemMetrics: {
              diffHeaderHeight: 32,
              hunkSeparatorHeight: 24,
              // Pierre uses its general file spacing as a fallback in expanded-file layout paths.
              // Keep it zero alongside the explicit paddingTop or expanding the first file can
              // reintroduce the library's default 8px gap above its header.
              spacing: 0,
              paddingTop: 0,
              // Unlike the gap above, the 8px under a file's last line is painted
              // unconditionally by Pierre's stylesheet (`--diffs-gap-fallback`), so the metric has
              // to count it: at zero every expanded file's virtual height ran 8px short of its
              // rendered height, and the end of the list sat past the reachable scroll range —
              // one clipped file row per expanded file above it.
              paddingBottom: 8,
            },
            layout: { paddingTop: 0, paddingBottom: 0, gap: 0 },
          }}
        />
      </div>
    </DiffWorkerPoolProvider>
  );
}
