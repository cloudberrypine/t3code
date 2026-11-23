import { useGT } from "gt-react";
import { useEffect, useRef, type ComponentProps } from "react";
import type { File as FileInstance, PostRenderPhase } from "@pierre/diffs";
import type { EnvironmentId, ScopedThreadRef, ResolvedKeybindingsConfig } from "@t3tools/contracts";
import { isAngelScriptPath, usesAngelScript } from "@t3tools/shared/angelscript";
import { isBehaviourPath } from "@t3tools/shared/behaviour";
import { isCppPath } from "@t3tools/shared/cppNavigation";
import { resolveCppCounterpart } from "@t3tools/client-runtime/cpp-navigation";
import { useAngelScript } from "~/hooks/useAngelScript";
import { useDefinitionNavigation } from "~/hooks/useDefinitionNavigation";
import { createAngelScriptClickNavigation } from "~/lib/angelScriptNavigation";
import { createAngelScriptPainter } from "~/lib/angelScriptRendering";
import { createBehaviourPainter } from "~/lib/behaviourRendering";
import { fileNavigationAction } from "~/lib/fileJumpHistory";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";
import { projectEnvironment } from "~/state/projects";
import { useRightPanelStore } from "~/rightPanelStore";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";

type FilePostRender = <LAnnotation>(
  node: HTMLElement,
  instance: FileInstance<LAnnotation, undefined>,
  phase: PostRenderPhase,
) => void;

/** Add language navigation and reference coloring without coupling them to file-preview chrome. */
export function useFileSourceNavigation({
  environmentId,
  cwd,
  relativePath,
  contents,
  isHostFile,
  previewRevision,
  threadRef,
  keybindings,
  revealLine,
  revealRequestId,
  revealFileLine,
}: {
  environmentId: EnvironmentId;
  cwd: string;
  relativePath: string | null;
  contents: string;
  isHostFile: boolean;
  previewRevision: string;
  threadRef: ScopedThreadRef;
  keybindings: ResolvedKeybindingsConfig;
  revealLine: number | null;
  revealRequestId: number;
  revealFileLine: FilePostRender;
}) {
  const gt = useGT();
  const navigationRoot = useRef<HTMLDivElement>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- focuses the preview's DOM root after a line reveal so Back/Forward keys reach it
  useEffect(() => {
    if (relativePath !== null && revealLine !== null && revealRequestId > 0)
      navigationRoot.current?.focus({ preventScroll: true });
  }, [relativePath, revealLine, revealRequestId]);
  const api = useAngelScript(
    relativePath && isAngelScriptPath(relativePath) && !isHostFile
      ? { environmentId, cwd, revision: previewRevision }
      : undefined,
  );
  const angelScript = relativePath !== null && usesAngelScript(relativePath, contents, api);
  const painter = createAngelScriptPainter(api);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- releases the painter's CSS highlight ranges when it is replaced or unmounts
  useEffect(() => () => painter.dispose(), [painter]);
  const behaviour = relativePath !== null && isBehaviourPath(relativePath);
  const behaviourPainter = createBehaviourPainter();
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- releases the behaviour painter's CSS highlight ranges when it is replaced or unmounts
  useEffect(() => () => behaviourPainter.dispose(), [behaviourPainter]);
  const findDefinitionFiles = useAtomQueryRunner(projectEnvironment.searchEntries, {
    refresh: true,
    reportFailure: false,
  });
  const handleDefinitionClick = useDefinitionNavigation({ environmentId, cwd }, threadRef, api);
  const navigation = createAngelScriptClickNavigation(handleDefinitionClick, api);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- detaches the navigation's DOM listeners and reference highlights when it is replaced or unmounts
  useEffect(
    () => () => {
      navigation.dispose();
    },
    [navigation],
  );
  const onFilePostRender: FilePostRender = (node, instance, phase) => {
    painter.paint(node, instance.file, phase);
    behaviourPainter.paint(node, instance.file, phase);
    navigation.attach(
      node,
      (angelScript || behaviour || (relativePath !== null && isCppPath(relativePath))) &&
        !isHostFile
        ? instance.file
        : undefined,
      phase,
    );
    revealFileLine(node, instance, phase);
  };
  const containerProps = {
    ref: navigationRoot,
    tabIndex: -1,
    onPointerDownCapture: (event) => {
      if (
        event.button === 0 &&
        (event.metaKey || event.ctrlKey) &&
        event.nativeEvent
          .composedPath()
          .some((part) => part instanceof HTMLElement && part.closest("[data-code]") !== null)
      ) {
        event.currentTarget.focus({ preventScroll: true });
      }
    },
    onKeyDownCapture: (event) => {
      if (
        event.defaultPrevented ||
        event.nativeEvent.isComposing ||
        !event.nativeEvent.composedPath().includes(event.currentTarget)
      )
        return;
      const action = fileNavigationAction(event.nativeEvent, keybindings);
      if (!action) return;
      if (action === "counterpart") {
        if (!relativePath || !isCppPath(relativePath) || isHostFile) return;
        event.preventDefault();
        event.stopPropagation();
        const from = {
          path: relativePath,
          line: navigation.currentLine(relativePath, revealLine ?? 1),
        };
        const isCurrent = navigation.beginRequest();
        event.currentTarget.focus({ preventScroll: true });
        void resolveCppCounterpart(relativePath, async (exactFileName) => {
          const result = await findDefinitionFiles({
            environmentId,
            input: { cwd, query: exactFileName, exactFileName, kind: "file", limit: 200 },
          });
          return result._tag === "Success" ? result.value : null;
        })
          .then((target) => {
            if (!isCurrent()) return;
            if (target) useRightPanelStore.getState().jumpToFile(threadRef, cwd, from, target);
            else
              toastManager.add(
                stackedThreadToast({
                  type: "info",
                  title: gt("No unique source/header counterpart found"),
                }),
              );
          })
          .catch(() => {
            if (isCurrent())
              toastManager.add(
                stackedThreadToast({
                  type: "error",
                  title: gt("Unable to open source/header counterpart"),
                }),
              );
          });
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      navigation.cancelPending();
      if (useRightPanelStore.getState().traverseFileJumpHistory(threadRef, cwd, action)) {
        event.currentTarget.focus({ preventScroll: true });
      }
    },
  } satisfies ComponentProps<"div">;
  return { angelScript, onFilePostRender, containerProps };
}
