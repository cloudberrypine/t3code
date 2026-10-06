import type { FileJumpLocation } from "~/lib/fileJumpHistory";
import type { DiffPanelSelection } from "~/diffPanelStore";
import type { FileContents } from "@pierre/diffs";
import type { ScopedThreadRef } from "@t3tools/contracts";
import type { AngelScriptApi } from "@t3tools/shared/angelscript";
import { resolveDefinitions } from "@t3tools/client-runtime/definition-navigation";
import { useCallback } from "react";
import { revisionLine } from "~/lib/revisionLine";
import type { AngelScriptWorkspace } from "./useAngelScript";
import { projectEnvironment, projectContentSearch } from "~/state/projects";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";
import { useRightPanelStore } from "~/rightPanelStore";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";

/** All code surfaces resolve against the selected environment and open results in Files. */
export function useDefinitionNavigation(
  workspace: AngelScriptWorkspace | undefined,
  threadRef: ScopedThreadRef | undefined,
  api: AngelScriptApi | null,
  fromRevision = false,
  diffSelection?: DiffPanelSelection,
) {
  const environmentId = workspace?.environmentId;
  const cwd = workspace?.cwd;
  const readDefinitionFile = useAtomQueryRunner(projectEnvironment.readFile, {
    refresh: true,
    reportFailure: false,
  });
  const searchDefinitionContents = useAtomQueryRunner(projectContentSearch, {
    refresh: true,
    reportFailure: false,
  });
  const findDefinitionFiles = useAtomQueryRunner(projectEnvironment.searchEntries, {
    refresh: true,
    reportFailure: false,
  });
  return useCallback(
    (
      current: FileContents,
      offset: number,
      isCurrent: () => boolean,
      side?: "additions" | "deletions",
    ) => {
      if (!environmentId || !cwd || !threadRef) return;
      const from: FileJumpLocation = {
        path: current.name,
        line: current.contents.slice(0, offset).split("\n").length,
        ...(diffSelection && side ? { diff: { selection: diffSelection, side } } : {}),
      };
      const source = { path: current.name, contents: current.contents };
      const read = async (path: string) => {
        const result = await readDefinitionFile({
          environmentId,
          input: { cwd, relativePath: path },
        });
        return result._tag === "Success" ? result.value : null;
      };
      const resolve = async () => {
        const definitions = await resolveDefinitions({
          source,
          offset,
          api,
          read,
          search: async (query) => {
            const result = await searchDefinitionContents({
              environmentId,
              input: {
                cwd,
                query,
                limit: 500,
                caseSensitive: true,
                wholeWord: false,
                useRegex: true,
              },
            });
            return result._tag === "Success" ? result.value : null;
          },
          findFiles: async (exactFileName) => {
            const result = await findDefinitionFiles({
              environmentId,
              input: { cwd, query: exactFileName, exactFileName, kind: "file", limit: 200 },
            });
            return result._tag === "Success" ? result.value : null;
          },
        });
        return definitions.length === 1 ? definitions[0]! : null;
      };
      void resolve()
        .then(async (definition) => {
          if (!isCurrent() || !definition) return definition;
          if (!fromRevision) return definition;
          const currentFile = await read(source.path);
          if (!isCurrent()) return null;
          if (currentFile && !currentFile.truncated) {
            if (!from.diff)
              from.line =
                revisionLine(source.contents, currentFile.contents, from.line) ?? from.line;
            if (definition.path !== source.path) return definition;
            const line = revisionLine(source.contents, currentFile.contents, definition.line);
            return line === null ? null : { ...definition, line };
          }
          return definition.path === source.path ? null : definition;
        })
        .then((definition) => {
          if (!isCurrent()) return;
          if (definition) {
            useRightPanelStore.getState().jumpToFile(threadRef, cwd, from, definition);
          } else {
            toastManager.add(stackedThreadToast({ type: "info", title: "No definition found" }));
          }
        })
        .catch(() => {
          if (!isCurrent()) return;
          toastManager.add(
            stackedThreadToast({ type: "error", title: "Unable to open definition" }),
          );
        });
    },
    [
      api,
      cwd,
      environmentId,
      readDefinitionFile,
      searchDefinitionContents,
      findDefinitionFiles,
      threadRef,
      fromRevision,
      diffSelection,
    ],
  );
}
