import type { GitStatusEntry } from "@pierre/trees";
import { FileTree, useFileTree, useFileTreeSearch, useFileTreeSelector } from "@pierre/trees/react";
import { ChevronsDownUp, ChevronsUpDown } from "lucide";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { usePaneFindShortcut } from "~/hooks/usePaneFindShortcut";
import { FileSearchField } from "../files/FileSearchField";
import { useTheme } from "~/hooks/useTheme";
import { cn } from "~/lib/utils";
import { T3_PIERRE_ICONS } from "~/pierre-icons";
import { PIERRE_TREE_UNSAFE_CSS, pierreTreeStyle } from "~/pierre-tree-theme";

import { areAllDirectoriesExpanded, setAllDirectoriesExpanded } from "../files/fileTreeExpansion";
import { Button } from "../ui/button";
import { MorphIcon } from "~/components/MorphIcon";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  buildDiffFileTreeUpdates,
  compareDiffFileTreeEntries,
  collectDirectoryPaths,
  diffFileTreeRows,
  diffFileTreePositions,
  type DiffFileTreeEntry,
} from "./diffFileTree.logic";

const DIFF_FILE_TREE_UNSAFE_CSS = `${PIERRE_TREE_UNSAFE_CSS}
  [data-item-section='content']:has(+ [data-item-section='decoration'] > span) {
    flex: 1 1 auto;
  }
  [data-item-section='decoration']:has(> span) {
    flex: 0 0 auto;
    padding-inline-start: var(--trees-item-row-gap);
  }
`;

export type { DiffFileTreeEntry } from "./diffFileTree.logic";

interface DiffFileTreeProps {
  readonly entries: ReadonlyArray<DiffFileTreeEntry>;
  /** Called with the file's path when the reader picks a file row. */
  readonly onSelectFile: (path: string) => void;
  /**
   * The file the diff is currently showing, kept selected in the tree. Bump `revealRequestId` to
   * scroll the tree to the same path again.
   */
  readonly selectedPath?: string | null;
  readonly revealRequestId?: number;
  readonly ariaLabel: string;
  /** Right-aligned content in the header row, after the file count. */
  readonly headerAccessory?: ReactNode;
  /** Rendered under the tree, for a host that still has files to fetch. */
  readonly footer?: ReactNode;
  readonly className?: string;
}

/**
 * A directory tree of the files in a diff. Every directory starts open: a diff is a short list
 * compared to a workspace, and the reader came for the files, not the folders.
 */
export function DiffFileTree({
  entries,
  onSelectFile,
  selectedPath = null,
  revealRequestId = 0,
  ariaLabel,
  headerAccessory,
  footer,
  className,
}: DiffFileTreeProps) {
  const { resolvedTheme } = useTheme();
  const searchInputRef = useRef<HTMLInputElement>(null);
  const findShortcut = usePaneFindShortcut(() => {
    searchInputRef.current?.focus();
    searchInputRef.current?.select();
  });
  const rows = useMemo(() => diffFileTreeRows(entries), [entries]);
  const paths = useMemo(() => rows.map((row) => row.treePath), [rows]);
  const treePathByFile = useMemo(
    () => new Map(rows.map((row) => [row.path, row.treePath])),
    [rows],
  );
  const directoryPaths = useMemo(() => collectDirectoryPaths(paths), [paths]);
  const positions = useMemo(() => diffFileTreePositions(paths), [paths]);
  const [ordering] = useState(() => {
    let currentPositions: ReadonlyMap<string, number> = new Map();
    return {
      sort: compareDiffFileTreeEntries(() => currentPositions),
      update: (nextPositions: ReadonlyMap<string, number>) => {
        currentPositions = nextPositions;
      },
    };
  });
  const gitStatus = useMemo<ReadonlyArray<GitStatusEntry>>(
    () => rows.map((row) => ({ path: row.treePath, status: row.status })),
    [rows],
  );
  const filePathsRef = useRef(new Map(rows.map((row) => [row.treePath, row.path])));
  const onSelectFileRef = useRef(onSelectFile);
  // Selection driven by `selectedPath` below is an echo of a file already on screen, not a
  // request to scroll to it again.
  const syncingSelectionRef = useRef(false);
  const handledRevealRef = useRef<{ path: string; revealRequestId: number } | null>(null);
  const mountedPathsRef = useRef<ReadonlyArray<string> | null>(null);

  useEffect(() => {
    filePathsRef.current = new Map(rows.map((row) => [row.treePath, row.path]));
    onSelectFileRef.current = onSelectFile;
  }, [rows, onSelectFile]);

  const { model } = useFileTree({
    density: "compact",
    fileTreeSearchMode: "hide-non-matches",
    flattenEmptyDirectories: true,
    initialExpansion: "open",
    icons: T3_PIERRE_ICONS,
    onSelectionChange: (selectedPaths) => {
      if (syncingSelectionRef.current) return;
      const treePath = selectedPaths.at(-1);
      const path = treePath === undefined ? undefined : filePathsRef.current.get(treePath);
      if (path !== undefined) onSelectFileRef.current(path);
    },
    paths: [],
    search: false,
    sort: ordering.sort,
    unsafeCSS: DIFF_FILE_TREE_UNSAFE_CSS,
  });
  const search = useFileTreeSearch(model);
  const allDirectoriesExpanded = useFileTreeSelector(model, (currentModel) =>
    areAllDirectoriesExpanded(currentModel, directoryPaths),
  );

  useEffect(() => {
    ordering.update(positions);
    const mountedPaths = mountedPathsRef.current;
    if (mountedPaths === paths) return;
    if (mountedPaths === null) {
      model.resetPaths(paths);
    } else if (mountedPaths.every((path, index) => paths[index] === path)) {
      // PR slices only append files, so keep the existing tree and its open folders.
      const updates = buildDiffFileTreeUpdates(mountedPaths, paths);
      if (updates.length > 0) model.batch(updates);
    } else {
      // A refreshed diff can change the rank of existing siblings. Mutations do not reorder
      // those rows, so rebuild while carrying the reader's folder expansion forward.
      const collapsedDirectories = directoryPaths.filter((path) => {
        const directory = model.getItem(path);
        return directory !== null && "isExpanded" in directory && !directory.isExpanded();
      });
      model.resetPaths(paths);
      for (const path of collapsedDirectories) {
        const directory = model.getItem(path);
        if (directory !== null && "collapse" in directory) directory.collapse();
      }
    }
    mountedPathsRef.current = paths;
    model.setGitStatus(gitStatus);
  }, [directoryPaths, gitStatus, model, ordering, paths, positions]);

  useEffect(() => {
    if (selectedPath === null) {
      handledRevealRef.current = null;
      return;
    }
    // A path list that changes under an already-revealed file (a refresh, a later slice) must
    // not pull the tree back to it over whatever the reader has picked since.
    const treePath = treePathByFile.get(selectedPath);
    const item = treePath === undefined ? null : model.getItem(treePath);
    if (treePath === undefined || item === null || item.isDirectory()) {
      // A file that left the diff has to be revealed again when it comes back.
      handledRevealRef.current = null;
      return;
    }
    const handled = handledRevealRef.current;
    if (handled?.path === treePath && handled.revealRequestId === revealRequestId) return;
    handledRevealRef.current = { path: treePath, revealRequestId };
    syncingSelectionRef.current = true;
    for (const path of model.getSelectedPaths()) {
      if (path !== treePath) model.getItem(path)?.deselect();
    }
    let ancestor = "";
    for (const segment of treePath.split("/").slice(0, -1)) {
      ancestor += `${segment}/`;
      const directory = model.getItem(ancestor);
      if (directory !== null && "expand" in directory) directory.expand();
    }
    item.select();
    model.scrollToPath(treePath, { offset: "nearest" });
    queueMicrotask(() => {
      syncingSelectionRef.current = false;
    });
    // The path map changes when a file arrives or its display name changes after a refresh.
  }, [model, revealRequestId, selectedPath, treePathByFile]);

  return (
    <div
      {...findShortcut}
      className={cn("flex min-h-0 flex-1 flex-col bg-background outline-none", className)}
    >
      <div
        className="flex h-10 min-h-10 shrink-0 items-center gap-1 border-b border-border/60 bg-background px-2 text-xs text-muted-foreground in-data-[preview-panel-mode=inline]:mb-3 in-data-[preview-panel-mode=inline]:h-7 in-data-[preview-panel-mode=inline]:min-h-7 in-data-[preview-panel-mode=inline]:border-b-transparent"
        data-surface-subheader
      >
        <FileSearchField
          inputRef={searchInputRef}
          name="diff-files-search"
          ariaLabel="Search changed files"
          value={search.value}
          onValueChange={(value) => (value.trim() ? search.setValue(value) : search.close())}
          onClose={search.close}
        />
        <span className="ml-auto tabular-nums">{entries.length}</span>
        {headerAccessory}
        {directoryPaths.length > 0 ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  aria-label={
                    allDirectoriesExpanded ? "Collapse all folders" : "Expand all folders"
                  }
                  onClick={() =>
                    setAllDirectoriesExpanded(model, directoryPaths, !allDirectoriesExpanded)
                  }
                />
              }
            >
              <MorphIcon
                className="size-3.5"
                icon={allDirectoriesExpanded ? ChevronsDownUp : ChevronsUpDown}
              />
            </TooltipTrigger>
            <TooltipPopup>
              {allDirectoriesExpanded ? "Collapse all folders" : "Expand all folders"}
            </TooltipPopup>
          </Tooltip>
        ) : null}
      </div>
      <FileTree
        model={model}
        aria-label={ariaLabel}
        onClickCapture={(event) => {
          if (
            event.defaultPrevented ||
            event.button !== 0 ||
            event.ctrlKey ||
            event.metaKey ||
            event.shiftKey ||
            event.altKey
          ) {
            return;
          }
          // Pierre does not emit a selection change for its sole selected row.
          // Read selection before the row handles the click so new selections reveal only once.
          const selected = model.getSelectedPaths();
          const path = selected.length === 1 ? selected[0] : undefined;
          const filePath = path === undefined ? undefined : filePathsRef.current.get(path);
          if (filePath === undefined) return;
          const clickedSelectedRow = event.nativeEvent
            .composedPath()
            .some(
              (node) => node instanceof HTMLElement && node.getAttribute("data-item-path") === path,
            );
          if (clickedSelectedRow) onSelectFileRef.current(filePath);
        }}
        className="min-h-0 flex-1 overflow-hidden"
        style={pierreTreeStyle(resolvedTheme)}
      />
      {footer}
    </div>
  );
}
