// Local fork: AngelScript and behaviour-language colouring and definition navigation, back/forward through file jumps,
// a jump back to a line in a diff, and the file the reader is in, layered on the shared viewer.
// StyledDiffCodeView keeps upstream's shape and only wires these in.
import { useAtomValue } from "@effect/atom-react";
import type {
  CodeViewItem,
  FileContents,
  FileDiff,
  FileDiffContentsLoader,
  PostRenderPhase,
} from "@pierre/diffs";
import type { CodeViewHandle } from "@pierre/diffs/react";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { isAngelScriptPath, usesAngelScript } from "@t3tools/shared/angelscript";
import { isBehaviourPath } from "@t3tools/shared/behaviour";
import { isCppPath } from "@t3tools/shared/cppNavigation";
import { useGT } from "gt-react";
import {
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type KeyboardEvent,
  type Ref,
} from "react";

import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import type { DiffJumpReveal, DiffPanelSelection } from "~/diffPanelStore";
import { useAngelScript, type AngelScriptWorkspace } from "~/hooks/useAngelScript";
import { useDefinitionNavigation } from "~/hooks/useDefinitionNavigation";
import { useStableCallback } from "~/hooks/useStableCallback";
import {
  ANGELSCRIPT_CSS,
  createAngelScriptPainter,
  withAngelScriptLanguage,
} from "~/lib/angelScriptRendering";
import { BEHAVIOUR_CSS, createBehaviourPainter } from "~/lib/behaviourRendering";
import { createDiffDefinitionNavigation } from "~/lib/diffDefinitionNavigation";
import { diffJumpExpansion } from "~/lib/diffJumpReveal";
import { getDiffLineStat, resolveFileDiffPath } from "~/lib/diffRendering";
import { fileNavigationAction } from "~/lib/fileJumpHistory";
import { useRightPanelStore } from "~/rightPanelStore";
import { primaryServerKeybindingsAtom } from "~/state/server";

import { findAnchoredDiffItem } from "./diffScrollAnchor";

/** What a post-render needs of the item, narrowed by the caller. */
export type RenderedItem<LAnnotation> =
  | {
      readonly type: "diff";
      readonly item: { readonly id: string; readonly collapsed?: boolean | undefined };
      readonly instance: Pick<FileDiff<LAnnotation, undefined>, "fileDiff" | "expandHunk">;
    }
  | { readonly type: "file"; readonly file: FileContents | undefined };

export interface DiffCodeViewExtrasProps<LAnnotation> {
  readonly items: readonly CodeViewItem<LAnnotation>[];
  readonly loadDiffFiles: FileDiffContentsLoader | undefined;
  readonly viewerRef: Ref<CodeViewHandle<LAnnotation, undefined>> | undefined;
  readonly workspace?: AngelScriptWorkspace | undefined;
  readonly navigationThread?: ScopedThreadRef | undefined;
  readonly navigationSelection?: DiffPanelSelection | undefined;
  readonly navigationReveal?: DiffJumpReveal | undefined;
  readonly onNavigationRestored?: (() => void) | undefined;
  readonly onActiveFileChange?: ((path: string | null) => void) | undefined;
}

/** React owns counts because Pierre can retain cached header HTML when an item updates. */
export function renderDiffHeaderMetadata(item: CodeViewItem<unknown>) {
  if (item.type !== "diff") return null;
  const { additions, deletions } = getDiffLineStat([item.fileDiff]);
  return (
    <span className="inline-flex items-center gap-2 font-mono text-2xs leading-none tabular-nums">
      {(deletions > 0 || additions === 0) && <span className="text-destructive">-{deletions}</span>}
      {(additions > 0 || deletions === 0) && (
        <span className="text-diff-addition">+{additions}</span>
      )}
    </span>
  );
}

function diffSample(diff: { additionLines: string[]; deletionLines: string[] }) {
  return diff.additionLines.slice(0, 100).join("") + diff.deletionLines.slice(0, 100).join("");
}

export function useDiffCodeViewExtras<LAnnotation>({
  items: originalItems,
  loadDiffFiles,
  viewerRef,
  workspace,
  navigationThread,
  navigationSelection,
  navigationReveal,
  onNavigationRestored,
  onActiveFileChange,
}: DiffCodeViewExtrasProps<LAnnotation>) {
  const gt = useGT();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const hasScripts = originalItems.some((item) =>
    isAngelScriptPath(item.type === "file" ? item.file.name : item.fileDiff.name),
  );
  const api = useAngelScript(hasScripts ? workspace : undefined);
  const painter = createAngelScriptPainter(api, loadDiffFiles);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- releases the painter's highlight decorations when it is replaced or unmounted
  useEffect(() => () => painter.dispose(), [painter]);
  const behaviourPainter = createBehaviourPainter(loadDiffFiles);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- releases the behaviour painter's highlight decorations when it is replaced or unmounted
  useEffect(() => () => behaviourPainter.dispose(), [behaviourPainter]);
  const items = originalItems.map((item) => {
    if (item.type === "file" && usesAngelScript(item.file.name, item.file.contents, api))
      return {
        ...item,
        file: withAngelScriptLanguage(item.file),
        version: (item.version ?? 0) + 1,
      };
    if (item.type === "diff" && usesAngelScript(item.fileDiff.name, diffSample(item.fileDiff), api))
      return {
        ...item,
        fileDiff: withAngelScriptLanguage(item.fileDiff),
        version: (item.version ?? 0) + 1,
      };
    return item;
  });
  const navigate = useDefinitionNavigation(
    workspace,
    navigationThread,
    api,
    true,
    navigationSelection,
  );
  const loadErrorTitle = gt("Unable to load definition source. Refresh the diff and try again.");
  const navigation = createDiffDefinitionNavigation(navigate, loadDiffFiles, () =>
    toastManager.add(stackedThreadToast({ type: "error", title: loadErrorTitle })),
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- detaches the navigation's click listeners from rendered rows when it is replaced or unmounted
  useEffect(() => () => navigation.dispose(), [navigation]);

  const pane = useRef<HTMLDivElement>(null);
  const internalRef = useRef<CodeViewHandle<LAnnotation, undefined>>(null);
  const [viewer, setViewer] = useState<CodeViewHandle<LAnnotation, undefined> | null>(null);
  const attachViewer = (handle: CodeViewHandle<LAnnotation, undefined> | null) => {
    internalRef.current = handle;
    setViewer(handle);
  };
  useImperativeHandle(viewerRef, () => viewer!, [viewer]);

  const activeFile = useRef<string | null | undefined>(undefined);
  const activeFrame = useRef<number | null>(null);
  const updateActiveFile = useStableCallback(() => {
    if (!onActiveFileChange || activeFrame.current !== null) return;
    activeFrame.current = requestAnimationFrame(() => {
      activeFrame.current = null;
      const instance = internalRef.current?.getInstance();
      if (!instance) return;
      const item = findAnchoredDiffItem(items, instance.getScrollTop(), (id) =>
        instance.getTopForItem(id),
      );
      const path =
        item?.type === "diff" ? resolveFileDiffPath(item.fileDiff) : (item?.file.name ?? null);
      if (path === activeFile.current) return;
      activeFile.current = path;
      onActiveFileChange(path);
    });
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the imperative viewer's scroll position again whenever the items change; cancels its animation frame on unmount
  useEffect(() => {
    updateActiveFile();
    return () => {
      if (activeFrame.current !== null) cancelAnimationFrame(activeFrame.current);
      activeFrame.current = null;
    };
  }, [
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- new items move the file under the sticky header.
    items,
    updateActiveFile,
  ]);

  const revealFrame = useRef<number | null>(null);
  const expandedJump = useRef<DiffJumpReveal | undefined>(undefined);
  const handledJump = useRef<DiffJumpReveal | undefined>(undefined);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- cancels a pending animation frame that would scroll the viewer to a replaced jump
  useEffect(() => {
    if (!navigationReveal) return;
    return () => {
      if (revealFrame.current !== null) cancelAnimationFrame(revealFrame.current);
      revealFrame.current = null;
    };
  }, [navigationReveal]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- scrolls the imperative viewer to the file a jump back returns to
  useEffect(() => {
    if (!navigationReveal || !viewer?.getInstance() || handledJump.current === navigationReveal)
      return;
    const item = items.find(
      (entry) =>
        entry.type === "diff" && resolveFileDiffPath(entry.fileDiff) === navigationReveal.path,
    );
    if (!item || item.collapsed) return;
    viewer.scrollTo({ type: "item", id: item.id, align: "start" });
  }, [items, navigationReveal, viewer]);

  const onKeyDownCapture = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented) return;
    if (!navigationThread || !workspace) return;
    const action = fileNavigationAction(event.nativeEvent, keybindings);
    if (action !== "back" && action !== "forward") return;
    event.preventDefault();
    event.stopPropagation();
    navigation.cancelPending();
    useRightPanelStore.getState().traverseFileJumpHistory(navigationThread, workspace.cwd, action);
  };

  // Called from the viewer's post-render handler with the item narrowed to a diff or a file.
  const onItemPostRender = useStableCallback(
    (node: HTMLElement, phase: PostRenderPhase, rendered: RenderedItem<LAnnotation>) => {
      updateActiveFile();
      const renderedFile = rendered.type === "diff" ? rendered.instance.fileDiff : rendered.file;
      painter.paint(node, renderedFile, phase);
      behaviourPainter.paint(node, renderedFile, phase);
      if (rendered.type !== "diff") return;
      const diff = rendered.instance.fileDiff;
      navigation.attach(
        node,
        workspace &&
          navigationThread &&
          diff &&
          (isCppPath(diff.name) ||
            isBehaviourPath(diff.name) ||
            usesAngelScript(diff.name, diffSample(diff), api))
          ? diff
          : undefined,
        phase,
      );
      if (
        !navigationReveal ||
        phase === "unmount" ||
        !diff ||
        rendered.item.collapsed ||
        resolveFileDiffPath(diff) !== navigationReveal.path ||
        handledJump.current === navigationReveal ||
        revealFrame.current !== null
      )
        return;
      const expansion = diffJumpExpansion(diff, navigationReveal.line, navigationReveal.side);
      if (expansion && expandedJump.current !== navigationReveal) {
        expandedJump.current = navigationReveal;
        rendered.instance.expandHunk(expansion.index, expansion.direction, expansion.count);
      } else if (!expansion || !diff.isPartial) {
        const id = rendered.item.id;
        revealFrame.current = requestAnimationFrame(() => {
          revealFrame.current = null;
          handledJump.current = navigationReveal;
          pane.current?.focus({ preventScroll: true });
          internalRef.current?.scrollTo({
            type: "line",
            id,
            lineNumber: navigationReveal.line,
            side: navigationReveal.side,
            align: "center",
          });
          onNavigationRestored?.();
        });
      }
    },
  );

  return {
    items,
    css: `${ANGELSCRIPT_CSS}\n${BEHAVIOUR_CSS}`,
    attachViewer,
    updateActiveFile,
    onItemPostRender,
    paneRef: pane,
    wrapperProps: {
      tabIndex: -1,
      onKeyDownCapture,
      className: "relative flex h-full min-h-0 min-w-0 flex-1 flex-col outline-none",
    },
  };
}
