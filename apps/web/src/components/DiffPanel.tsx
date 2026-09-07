import { RefreshIcon } from "~/components/ui/refresh-icon";
import { encodeBase64Url } from "effect/Encoding";
import { useAtomValue } from "@effect/atom-react";
import type { FileDiffContentsLoader } from "@pierre/diffs";
import { useParams } from "@tanstack/react-router";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { safeErrorLogAttributes } from "@t3tools/client-runtime/errors";
import type { ReviewDiffPreviewFile, ScopedThreadRef, TurnId } from "@t3tools/contracts";
import {
  ArrowRightIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ChevronsDownUpIcon,
  ChevronsUpDownIcon,
  Columns2Icon,
  FolderTreeIcon,
  PilcrowIcon,
  Rows3Icon,
  SearchIcon,
  TextWrapIcon,
} from "lucide-react";
import * as Schema from "effect/Schema";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useCodeViewFileReveal } from "./diffs/useCodeViewFileReveal";
import { useOpenInPreferredEditor } from "../editorPreferences";
import { type DraftId } from "../composerDraftStore";
import { openDiffFilePrimaryAction } from "../diffFileActions";
import { useCheckpointDiff } from "~/lib/checkpointDiffState";
import { cn } from "~/lib/utils";
import { selectThreadDiffPanelSelection, useDiffPanelStore } from "../diffPanelStore";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { useTheme } from "../hooks/useTheme";
import {
  buildFileDiffContentVersion,
  buildFileDiffIdentityKey,
  buildReviewDiffPlaceholder,
  getDiffCollapseIconClassName,
  getDiffLineStat,
  getRenderablePatch,
  resolveDiffThemeName,
  resolveFileDiffPath,
  stripDiffTruncationMarker,
} from "../lib/diffRendering";
import { PREFERRED_HIGHLIGHTER } from "../lib/syntaxHighlighting";
import { areAllDiffFilesCollapsed, toggleAllDiffFiles } from "../lib/diffCollapse";
import { useTurnDiffSummaries } from "../hooks/useTurnDiffSummaries";
import { useWorkspaceMutationRefresh } from "../hooks/useWorkspaceMutationRefresh";
import { useProject, useThread } from "../state/entities";
import { resolveThreadRouteRef } from "../threadRoutes";
import { useClientSettings, useUpdateClientSettings } from "../hooks/useSettings";
import { formatShortTimestamp } from "../timestampFormat";
import { DiffFilePathCopyButton } from "./DiffFilePathCopyButton";
import { DiffPanelLoadingState, DiffPanelShell, type DiffPanelMode } from "./DiffPanelShell";
import { DiffStatLabel } from "./chat/DiffStatLabel";
import { AnnotatableCodeView, type AnnotatableCodeViewHandle } from "./diffs/AnnotatableCodeView";
import { FileBrowserPane } from "./files/FileBrowserPane";
import { DiffFileTree } from "./diffs/DiffFileTree";
import { diffFileTreeEntries, reviewDiffFileTreeEntries } from "./diffs/diffFileTree.logic";
import { Button } from "./ui/button";
import { ToggleGroup, Toggle } from "./ui/toggle-group";
import { Switch } from "./ui/switch";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxTrigger,
} from "./ui/combobox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "./ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { useEnvironmentQuery } from "../state/query";
import { useAtomCommand } from "../state/use-atom-command";
import { serverEnvironment } from "../state/server";
import { reviewEnvironment } from "../state/review";
import { vcsEnvironment } from "../state/vcs";
import { buildBaseRefChoices, filterBaseRefChoices } from "../lib/baseRefChoices";
import { createGitDiffFileContentsLoader } from "../lib/diffFileContents";

type DiffThemeType = "light" | "dark";
const AUTOMATIC_BASE_REF = "__automatic_base_ref__";
const DIFF_FILE_TREE_STORAGE_KEY = "t3code.diffFileTreeOpen";

interface CollapsedDiffFilesState {
  readonly scopeKey: string | null;
  readonly fileKeys: ReadonlySet<string>;
}

interface LoadedGitPatchesState {
  readonly scopeKey: string | null;
  readonly patchesByPath: Readonly<Record<string, string>>;
  readonly loadingPaths: ReadonlySet<string>;
  readonly error: { readonly filePath: string; readonly message: string } | null;
}

const EMPTY_COLLAPSED_DIFF_FILE_KEYS: ReadonlySet<string> = new Set();

interface DiffPanelProps {
  mode?: DiffPanelMode;
  composerDraftTarget: ScopedThreadRef | DraftId;
  initialGitScope: "branch" | "unstaged";
  workspaceMutationId: string | null;
}

export default function DiffPanel({
  mode = "inline",
  composerDraftTarget,
  initialGitScope: initialGitScopeProp,
  workspaceMutationId,
}: DiffPanelProps) {
  const { resolvedTheme } = useTheme();
  const settings = useClientSettings();
  const [initialGitScope] = useState(initialGitScopeProp);
  const diffLayout = settings.diffLayout;
  const updateClientSettings = useUpdateClientSettings();
  const [wordWrap, setWordWrap] = useState(settings.wordWrap);
  const [diffIgnoreWhitespace, setDiffIgnoreWhitespace] = useState(settings.diffIgnoreWhitespace);
  const [fileTreeOpen, setFileTreeOpen] = useLocalStorage(
    DIFF_FILE_TREE_STORAGE_KEY,
    false,
    Schema.Boolean,
  );
  const [baseRefQuery, setBaseRefQuery] = useState("");
  const [collapsedDiffFiles, setCollapsedDiffFiles] = useState<CollapsedDiffFilesState>(() => ({
    scopeKey: null,
    fileKeys: EMPTY_COLLAPSED_DIFF_FILE_KEYS,
  }));
  const [codeViewRevision, setCodeViewRevision] = useState(0);
  const [codeView, setCodeView] = useState<AnnotatableCodeViewHandle | null>(null);
  const [loadedGitPatches, setLoadedGitPatches] = useState<LoadedGitPatchesState>({
    scopeKey: null,
    patchesByPath: {},
    loadingPaths: new Set(),
    error: null,
  });
  const inFlightGitFileLoadsRef = useRef(new Set<string>());
  const pendingGitFileRevealRef = useRef<{ scopeKey: string; filePath: string } | null>(null);

  const routeThreadRef = useParams({
    strict: false,
    select: (params) => resolveThreadRouteRef(params),
  });
  const activeThreadId = routeThreadRef?.threadId ?? null;
  const activeThread = useThread(routeThreadRef);
  const activeProjectId = activeThread?.projectId ?? null;
  const activeProject = useProject(
    activeThread && activeProjectId
      ? {
          environmentId: activeThread.environmentId,
          projectId: activeProjectId,
        }
      : null,
  );
  const activeCwd = activeThread?.worktreePath ?? activeProject?.workspaceRoot;
  const activeRepositoryRoot = activeThread?.worktreePath
    ? undefined
    : activeProject?.repositoryIdentity?.rootPath;
  const serverConfig = useAtomValue(
    serverEnvironment.configValueAtom(activeThread?.environmentId ?? null),
  );
  const openInPreferredEditor = useOpenInPreferredEditor(
    activeThread?.environmentId ?? null,
    serverConfig?.availableEditors ?? [],
  );
  const getDiffFileContents = useAtomCommand(reviewEnvironment.diffFileContents);
  const gitStatusQuery = useEnvironmentQuery(
    activeThread !== null && activeThread !== undefined && activeCwd != null
      ? vcsEnvironment.status({
          environmentId: activeThread.environmentId,
          input: { cwd: activeCwd },
        })
      : null,
  );
  const diffSelection = useDiffPanelStore((state) =>
    selectThreadDiffPanelSelection(
      state.byThreadKey,
      routeThreadRef,
      initialGitScope === "unstaged",
    ),
  );
  const isGitRepo = gitStatusQuery.data?.isRepo ?? true;
  const { turnDiffSummaries, inferredCheckpointTurnCountByTurnId } =
    useTurnDiffSummaries(activeThread);
  const orderedTurnDiffSummaries = useMemo(
    () =>
      [...turnDiffSummaries].toSorted((left, right) => {
        const leftTurnCount =
          left.checkpointTurnCount ?? inferredCheckpointTurnCountByTurnId[left.turnId] ?? 0;
        const rightTurnCount =
          right.checkpointTurnCount ?? inferredCheckpointTurnCountByTurnId[right.turnId] ?? 0;
        if (leftTurnCount !== rightTurnCount) {
          return rightTurnCount - leftTurnCount;
        }
        return right.completedAt.localeCompare(left.completedAt);
      }),
    [inferredCheckpointTurnCountByTurnId, turnDiffSummaries],
  );

  useEffect(() => {
    if (!routeThreadRef || diffSelection.kind !== "turn") return;
    useDiffPanelStore.getState().reconcileTurnSelection(
      routeThreadRef,
      orderedTurnDiffSummaries.map((summary) => summary.turnId),
    );
  }, [diffSelection, orderedTurnDiffSummaries, routeThreadRef]);

  const selectedTurnId = diffSelection.kind === "turn" ? diffSelection.turnId : null;
  const selectedGitScope = diffSelection.kind === "unstaged" ? "unstaged" : "branch";
  const selectedBaseRef = diffSelection.kind === "branch" ? diffSelection.baseRef : null;
  const selectedFilePath = diffSelection.kind === "turn" ? diffSelection.filePath : null;
  const selectedFileRevealRequestId =
    diffSelection.kind === "turn" ? diffSelection.revealRequestId : 0;
  const selectedTurn =
    selectedTurnId === null
      ? undefined
      : (orderedTurnDiffSummaries.find((summary) => summary.turnId === selectedTurnId) ??
        orderedTurnDiffSummaries[0]);
  const selectedCheckpointTurnCount =
    selectedTurn &&
    (selectedTurn.checkpointTurnCount ?? inferredCheckpointTurnCountByTurnId[selectedTurn.turnId]);
  const latestTurn = orderedTurnDiffSummaries[0];
  const selectedScopeLabel =
    selectedTurnId === null
      ? selectedGitScope === "unstaged"
        ? "Working tree"
        : "Branch changes"
      : selectedTurn?.turnId === latestTurn?.turnId
        ? "Latest turn"
        : `Turn ${selectedCheckpointTurnCount ?? "?"}`;
  const reviewSectionId = selectedTurn ? `turn:${selectedTurn.turnId}` : selectedGitScope;
  const collapseScopeKey = routeThreadRef
    ? `${routeThreadRef.environmentId}:${routeThreadRef.threadId}:${reviewSectionId}`
    : null;
  const codeViewMountKey = `${collapseScopeKey ?? reviewSectionId}:${codeViewRevision}`;
  const collapsedDiffFileKeys =
    collapsedDiffFiles.scopeKey === collapseScopeKey
      ? collapsedDiffFiles.fileKeys
      : EMPTY_COLLAPSED_DIFF_FILE_KEYS;
  const reviewSectionTitle = selectedTurn
    ? `Turn ${selectedCheckpointTurnCount ?? "?"}`
    : selectedGitScope === "unstaged"
      ? "Working tree"
      : "Branch changes";
  const selectedCheckpointRange = useMemo(
    () =>
      typeof selectedCheckpointTurnCount === "number"
        ? {
            fromTurnCount: Math.max(0, selectedCheckpointTurnCount - 1),
            toTurnCount: selectedCheckpointTurnCount,
          }
        : null,
    [selectedCheckpointTurnCount],
  );
  const activeCheckpointDiff = useCheckpointDiff(
    {
      environmentId: activeThread?.environmentId ?? null,
      threadId: activeThreadId,
      fromTurnCount: selectedCheckpointRange?.fromTurnCount ?? null,
      toTurnCount: selectedCheckpointRange?.toTurnCount ?? null,
      ignoreWhitespace: diffIgnoreWhitespace,
      cacheScope: selectedTurn ? `turn:${selectedTurn.turnId}` : null,
    },
    { enabled: isGitRepo && selectedTurn !== undefined },
  );
  const branchDiffPreview = useEnvironmentQuery(
    selectedTurnId === null && activeThread && activeCwd
      ? reviewEnvironment.diffPreview({
          environmentId: activeThread.environmentId,
          input: {
            cwd: activeCwd,
            ...(selectedBaseRef ? { baseRef: selectedBaseRef } : {}),
            ignoreWhitespace: diffIgnoreWhitespace,
            sourceKind: selectedGitScope === "unstaged" ? "working-tree" : "branch-range",
          },
        })
      : null,
  );
  const refreshBranchDiffPreview = branchDiffPreview.refresh;
  const canRefreshGitDiff =
    isGitRepo && selectedTurnId === null && activeThread != null && activeCwd != null;
  const activeThreadRefreshKey = routeThreadRef
    ? `${routeThreadRef.environmentId}:${routeThreadRef.threadId}`
    : null;

  useEffect(() => {
    if (!canRefreshGitDiff) return;
    const refreshOnFocus = () => refreshBranchDiffPreview();
    window.addEventListener("focus", refreshOnFocus);
    return () => window.removeEventListener("focus", refreshOnFocus);
  }, [canRefreshGitDiff, refreshBranchDiffPreview]);

  useWorkspaceMutationRefresh({
    enabled: canRefreshGitDiff,
    mutationId: workspaceMutationId,
    refresh: refreshBranchDiffPreview,
    resourceKey: `diff:${activeThreadRefreshKey ?? ""}`,
  });

  const selectedGitSource = branchDiffPreview.data?.sources.find(
    (source) => source.kind === (selectedGitScope === "unstaged" ? "working-tree" : "branch-range"),
  );
  const gitPatchScopeKey =
    selectedTurnId === null && selectedGitSource && collapseScopeKey
      ? `${collapseScopeKey}:${selectedGitSource.kind}:${selectedGitSource.diffHash}`
      : null;
  const activeLoadedGitPatches =
    loadedGitPatches.scopeKey === gitPatchScopeKey ? loadedGitPatches : null;
  const currentLoadDiffFiles = useMemo<FileDiffContentsLoader | undefined>(() => {
    const preview = branchDiffPreview.data;
    if (selectedTurn && selectedCheckpointRange && activeThread && activeCwd) {
      const baseRef =
        selectedCheckpointRange.fromTurnCount === 0
          ? `refs/t3/checkpoints/${encodeBase64Url(activeThread.id)}/turn/0`
          : activeThread.checkpoints.find(
              (checkpoint) =>
                checkpoint.checkpointTurnCount === selectedCheckpointRange.fromTurnCount,
            )?.checkpointRef;
      if (!baseRef) return undefined;
      return createGitDiffFileContentsLoader(getDiffFileContents, {
        environmentId: activeThread.environmentId,
        cwd: activeCwd,
        sourceKind: "branch-range",
        baseRefMode: "exact",
        baseRef,
        headRef: selectedTurn.checkpointRef,
        cacheKey: `checkpoint:${baseRef}:${selectedTurn.checkpointRef}`,
      });
    }
    if (selectedTurnId !== null || !activeThread || !preview || !selectedGitSource) {
      return undefined;
    }

    return createGitDiffFileContentsLoader(getDiffFileContents, {
      environmentId: activeThread.environmentId,
      cwd: preview.cwd,
      sourceKind: selectedGitSource.kind,
      baseRef: selectedGitSource.baseRef,
      headRef: selectedGitSource.headRef,
      cacheKey: gitPatchScopeKey ?? selectedGitSource.diffHash,
    });
  }, [
    activeCwd,
    selectedTurn,
    selectedCheckpointRange,
    activeThread,
    branchDiffPreview.data,
    getDiffFileContents,
    gitPatchScopeKey,
    selectedGitSource,
    selectedTurnId,
  ]);

  const loadDiffFilesRef = useRef(currentLoadDiffFiles);
  loadDiffFilesRef.current = currentLoadDiffFiles;
  const loadDiffFiles = useCallback<FileDiffContentsLoader>(async (fileDiff) => {
    const loader = loadDiffFilesRef.current;
    if (!loader) throw new Error("Diff file contents are unavailable for this selection.");
    return loader(fileDiff);
  }, []);

  const localBranchRefs = useEnvironmentQuery(
    selectedTurnId === null &&
      selectedGitScope === "branch" &&
      activeThread &&
      branchDiffPreview.data?.cwd
      ? vcsEnvironment.listRefs({
          environmentId: activeThread.environmentId,
          input: {
            cwd: branchDiffPreview.data.cwd,
            includeMatchingRemoteRefs: true,
            refKind: "local",
            ...(baseRefQuery.trim().length > 0 ? { query: baseRefQuery.trim() } : {}),
            limit: 100,
          },
        })
      : null,
  );
  const remoteBranchRefs = useEnvironmentQuery(
    selectedTurnId === null &&
      selectedGitScope === "branch" &&
      activeThread &&
      branchDiffPreview.data?.cwd
      ? vcsEnvironment.listRefs({
          environmentId: activeThread.environmentId,
          input: {
            cwd: branchDiffPreview.data.cwd,
            includeMatchingRemoteRefs: true,
            refKind: "remote",
            ...(baseRefQuery.trim().length > 0 ? { query: baseRefQuery.trim() } : {}),
            limit: 100,
          },
        })
      : null,
  );
  const baseRefChoices = buildBaseRefChoices(
    localBranchRefs.data?.refs.filter((ref) => ref.name !== selectedGitSource?.headRef) ?? [],
    remoteBranchRefs.data?.refs ?? [],
  );
  const matchingBaseRefChoices = filterBaseRefChoices(baseRefChoices, baseRefQuery);
  const valueForBaseRefChoice = (choice: (typeof baseRefChoices)[number]) =>
    selectedBaseRef && selectedBaseRef === choice.remote?.name
      ? selectedBaseRef
      : (choice.local?.name ?? choice.remote?.name ?? choice.id);
  const baseRefItems = [AUTOMATIC_BASE_REF, ...baseRefChoices.map(valueForBaseRefChoice)];
  const filteredBaseRefItems = [
    ...(baseRefQuery.trim().length === 0 ? [AUTOMATIC_BASE_REF] : []),
    ...matchingBaseRefChoices.map(valueForBaseRefChoice),
  ];
  const selectedGitFiles = selectedGitSource?.files ?? [];
  const loadedPatchesByPath = activeLoadedGitPatches?.patchesByPath ?? {};
  const gitDiff = selectedGitSource
    ? [selectedGitSource.diff, ...Object.values(loadedPatchesByPath)]
        .filter((patch) => patch.trim().length > 0)
        .join("\n")
    : undefined;

  const selectedPatch = selectedTurn
    ? activeCheckpointDiff.data?.diff
    : gitDiff === undefined
      ? undefined
      : stripDiffTruncationMarker(gitDiff);
  const loadedGitFileCount = selectedGitFiles.filter(
    (file) => file.patchIncluded || loadedPatchesByPath[file.newPath] !== undefined,
  ).length;
  const omittedGitFileCount = selectedGitFiles.length - loadedGitFileCount;
  const loadingGitFileCount = activeLoadedGitPatches?.loadingPaths.size ?? 0;
  const isSelectedPatchTruncated =
    !selectedTurn &&
    (selectedGitFiles.length > 0
      ? omittedGitFileCount > 0 || selectedGitSource?.fileListTruncated === true
      : selectedGitSource?.truncated === true);
  const isLoadingSelectedPatch = selectedTurn
    ? activeCheckpointDiff.isPending
    : branchDiffPreview.isPending;
  const selectedPatchError = selectedTurn ? activeCheckpointDiff.error : branchDiffPreview.error;
  const hasResolvedPatch = typeof selectedPatch === "string";
  const hasNoNetChanges = hasResolvedPatch && selectedPatch.trim().length === 0;
  const renderablePatch = useMemo(
    () =>
      getRenderablePatch(selectedPatch, `diff-panel:${resolvedTheme}`, {
        compactPartialHunkOffsets: selectedTurnId === null,
      }),
    [resolvedTheme, selectedPatch, selectedTurnId],
  );
  const renderableFiles = useMemo(() => {
    if (!renderablePatch || renderablePatch.kind !== "files") {
      return [];
    }
    return renderablePatch.files.toSorted((left, right) =>
      resolveFileDiffPath(left).localeCompare(resolveFileDiffPath(right), undefined, {
        numeric: true,
        sensitivity: "base",
      }),
    );
  }, [renderablePatch]);
  const codeViewFileEntries = useMemo(() => {
    if (selectedTurnId !== null || selectedGitFiles.length === 0) {
      return renderableFiles.map((fileDiff) => ({
        fileDiff,
        fileKey: buildFileDiffIdentityKey(fileDiff),
        fileVersion: buildFileDiffContentVersion(fileDiff),
        loaded: true,
        previewFile: null,
      }));
    }

    const loadedFilesByPath = new Map(
      renderableFiles.map((fileDiff) => [resolveFileDiffPath(fileDiff), fileDiff] as const),
    );
    return selectedGitFiles
      .toSorted((left, right) =>
        left.newPath.localeCompare(right.newPath, undefined, {
          numeric: true,
          sensitivity: "base",
        }),
      )
      .map((previewFile) => {
        const loadedFile = loadedFilesByPath.get(previewFile.newPath);
        const loaded =
          previewFile.patchIncluded ||
          Object.prototype.hasOwnProperty.call(loadedPatchesByPath, previewFile.newPath);
        const fileDiff =
          loadedFile ??
          buildReviewDiffPlaceholder(
            previewFile,
            gitPatchScopeKey ?? selectedGitSource?.diffHash ?? "review",
          );
        return {
          fileDiff,
          fileKey: buildFileDiffIdentityKey(fileDiff),
          fileVersion: buildFileDiffContentVersion(fileDiff),
          loaded,
          previewFile,
        };
      });
  }, [
    gitPatchScopeKey,
    loadedPatchesByPath,
    renderableFiles,
    selectedGitFiles,
    selectedGitSource?.diffHash,
    selectedTurnId,
  ]);
  const codeViewFiles = useMemo(
    () =>
      codeViewFileEntries.map(({ fileDiff, fileKey, fileVersion, loaded, previewFile }) => {
        return {
          fileDiff,
          filePath: resolveFileDiffPath(fileDiff),
          fileKey,
          fileVersion,
          collapsed: !loaded || collapsedDiffFileKeys.has(fileKey),
          loaded,
          previewFile,
        };
      }),
    [codeViewFileEntries, collapsedDiffFileKeys],
  );
  const showsCodeView =
    renderablePatch?.kind === "files" ||
    (!renderablePatch && selectedTurnId === null && selectedGitFiles.length > 0);
  const diffFileKeys = useMemo(
    () => codeViewFiles.filter((file) => file.loaded).map((file) => file.fileKey),
    [codeViewFiles],
  );
  const allDiffFilesCollapsed = areAllDiffFilesCollapsed(diffFileKeys, collapsedDiffFileKeys);
  const diffLineStat = useMemo(
    () =>
      selectedTurnId === null && selectedGitFiles.length > 0
        ? selectedGitFiles.reduce(
            (total, file) => ({
              additions: total.additions + file.additions,
              deletions: total.deletions + file.deletions,
            }),
            { additions: 0, deletions: 0 },
          )
        : getDiffLineStat(renderableFiles),
    [renderableFiles, selectedGitFiles, selectedTurnId],
  );
  const fileTreeEntries = useMemo(() => {
    if (selectedTurnId !== null || selectedGitFiles.length === 0) {
      return diffFileTreeEntries(renderableFiles);
    }
    return reviewDiffFileTreeEntries(
      selectedGitFiles,
      new Set(codeViewFiles.filter((file) => file.loaded).map((file) => file.filePath)),
      activeLoadedGitPatches?.loadingPaths ?? new Set(),
      activeLoadedGitPatches?.error?.filePath ?? null,
    );
  }, [activeLoadedGitPatches, codeViewFiles, renderableFiles, selectedGitFiles, selectedTurnId]);
  const selectedDiffFileKey = selectedFilePath
    ? (codeViewFiles.find((candidate) => candidate.filePath === selectedFilePath)?.fileKey ?? null)
    : null;
  const [activeDiffFilePath, setActiveDiffFilePath] = useState<string | null>(null);

  useEffect(() => {
    if (!selectedDiffFileKey || !codeView?.getInstance()) return;
    codeView.scrollTo({ type: "item", id: selectedDiffFileKey, align: "start" });
  }, [codeView, codeViewMountKey, selectedDiffFileKey, selectedFileRevealRequestId]);

  const treeRevealScope = useMemo(
    () => ({ collapseScopeKey, diffSelection }),
    [collapseScopeKey, diffSelection],
  );
  const requestTreeReveal = useCodeViewFileReveal(codeView, treeRevealScope);
  useEffect(() => {
    const pending = pendingGitFileRevealRef.current;
    if (!pending || pending.scopeKey !== gitPatchScopeKey) return;
    const file = codeViewFiles.find((candidate) => candidate.filePath === pending.filePath);
    if (!file?.loaded) return;
    pendingGitFileRevealRef.current = null;
    requestTreeReveal(file.fileKey);
  }, [codeViewFiles, gitPatchScopeKey, requestTreeReveal]);

  const loadOmittedGitFile = useCallback(
    async (file: ReviewDiffPreviewFile) => {
      const loadKey = gitPatchScopeKey ? `${gitPatchScopeKey}\0${file.newPath}` : null;
      if (
        !activeThread ||
        !branchDiffPreview.data ||
        !selectedGitSource ||
        !gitPatchScopeKey ||
        !loadKey ||
        inFlightGitFileLoadsRef.current.has(loadKey)
      ) {
        return;
      }
      inFlightGitFileLoadsRef.current.add(loadKey);
      pendingGitFileRevealRef.current = { scopeKey: gitPatchScopeKey, filePath: file.newPath };
      setLoadedGitPatches((current) => {
        const scoped =
          current.scopeKey === gitPatchScopeKey
            ? current
            : {
                scopeKey: gitPatchScopeKey,
                patchesByPath: {},
                loadingPaths: new Set<string>(),
                error: null,
              };
        return {
          ...scoped,
          loadingPaths: new Set([...scoped.loadingPaths, file.newPath]),
          error: null,
        };
      });
      const result = await getDiffFileContents({
        environmentId: activeThread.environmentId,
        input: {
          cwd: branchDiffPreview.data.cwd,
          sourceKind: selectedGitSource.kind,
          changeType: file.changeType,
          baseRef: selectedGitSource.baseRef,
          headRef: selectedGitSource.headRef,
          oldPath: file.oldPath,
          newPath: file.newPath,
          isUntracked: file.isUntracked,
          includePatch: true,
          ignoreWhitespace: diffIgnoreWhitespace,
        },
      });
      inFlightGitFileLoadsRef.current.delete(loadKey);
      if (
        (result._tag !== "Success" || result.value.patch === undefined) &&
        pendingGitFileRevealRef.current?.scopeKey === gitPatchScopeKey
      ) {
        pendingGitFileRevealRef.current = null;
      }
      setLoadedGitPatches((current) => {
        if (current.scopeKey !== gitPatchScopeKey) return current;
        const loadingPaths = new Set(current.loadingPaths);
        loadingPaths.delete(file.newPath);
        if (result._tag !== "Success") {
          if (isAtomCommandInterrupted(result)) return { ...current, loadingPaths };
          const error = squashAtomCommandFailure(result);
          return {
            ...current,
            loadingPaths,
            error: {
              filePath: file.newPath,
              message: error instanceof Error ? error.message : `Could not load ${file.newPath}.`,
            },
          };
        }
        if (result.value.patch === undefined) {
          return {
            ...current,
            loadingPaths,
            error: {
              filePath: file.newPath,
              message: `The server did not return a patch for ${file.newPath}.`,
            },
          };
        }
        return {
          ...current,
          patchesByPath: { ...current.patchesByPath, [file.newPath]: result.value.patch },
          loadingPaths,
          error: null,
        };
      });
    },
    [
      activeThread,
      branchDiffPreview.data,
      diffIgnoreWhitespace,
      getDiffFileContents,
      gitPatchScopeKey,
      selectedGitSource,
    ],
  );
  const revealDiffFile = useCallback(
    (filePath: string) => {
      const file = codeViewFiles.find((candidate) => candidate.filePath === filePath);
      if (!file?.loaded) {
        const omittedFile = selectedGitFiles.find((candidate) => candidate.newPath === filePath);
        if (omittedFile) void loadOmittedGitFile(omittedFile);
        return;
      }
      if (file.collapsed) {
        setCollapsedDiffFiles((current) => {
          const next = new Set(current.scopeKey === collapseScopeKey ? current.fileKeys : []);
          next.delete(file.fileKey);
          return { scopeKey: collapseScopeKey, fileKeys: next };
        });
      }
      requestTreeReveal(file.fileKey);
    },
    [codeViewFiles, collapseScopeKey, requestTreeReveal, loadOmittedGitFile, selectedGitFiles],
  );

  const openDiffFile = useCallback(
    (filePath: string) => {
      openDiffFilePrimaryAction({
        threadRef: routeThreadRef,
        filePath,
        activeCwd,
        repositoryRoot: activeRepositoryRoot,
        openInEditor: (targetPath) => {
          void (async () => {
            const result = await openInPreferredEditor(targetPath);
            if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
              console.warn("Failed to open diff file in editor.", {
                operation: "open-diff-file",
                ...(routeThreadRef
                  ? {
                      environmentId: routeThreadRef.environmentId,
                      threadId: routeThreadRef.threadId,
                    }
                  : {}),
                ...safeErrorLogAttributes(squashAtomCommandFailure(result)),
              });
            }
          })();
        },
      });
    },
    [activeCwd, activeRepositoryRoot, openInPreferredEditor, routeThreadRef],
  );
  const toggleDiffFileCollapsed = useCallback(
    (fileKey: string) => {
      const file = codeViewFiles.find((candidate) => candidate.fileKey === fileKey);
      if (file && !file.loaded && file.previewFile) {
        void loadOmittedGitFile(file.previewFile);
        return;
      }
      setCollapsedDiffFiles((current) => {
        const next = new Set(current.scopeKey === collapseScopeKey ? current.fileKeys : []);
        if (next.has(fileKey)) {
          next.delete(fileKey);
        } else {
          next.add(fileKey);
        }
        return { scopeKey: collapseScopeKey, fileKeys: next };
      });
    },
    [codeViewFiles, collapseScopeKey, loadOmittedGitFile],
  );

  const toggleDiffFileCollapse = useCallback(() => {
    setCodeViewRevision((current) => current + 1);
    setCollapsedDiffFiles((current) => {
      const currentKeys =
        current.scopeKey === collapseScopeKey ? current.fileKeys : EMPTY_COLLAPSED_DIFF_FILE_KEYS;

      return {
        scopeKey: collapseScopeKey,
        fileKeys: toggleAllDiffFiles(diffFileKeys, currentKeys),
      };
    });
  }, [collapseScopeKey, diffFileKeys]);

  const selectTurn = (turnId: TurnId) => {
    if (!routeThreadRef) return;
    useDiffPanelStore.getState().selectTurn(routeThreadRef, turnId);
  };
  const selectGitScope = (scope: "branch" | "unstaged") => {
    if (!routeThreadRef) return;
    useDiffPanelStore.getState().selectGitScope(routeThreadRef, scope);
  };
  const selectBranchBaseRef = (baseRef: string | null) => {
    if (!routeThreadRef) return;
    useDiffPanelStore.getState().selectBranchBaseRef(routeThreadRef, baseRef);
  };
  const fileTreeFooter =
    selectedTurnId === null && omittedGitFileCount > 0 ? (
      <div className="border-t border-border/60 px-3 py-2 text-[11px] text-muted-foreground">
        {loadingGitFileCount > 0
          ? `Loading ${loadingGitFileCount} file${loadingGitFileCount === 1 ? "" : "s"}…`
          : `${omittedGitFileCount} file diff${omittedGitFileCount === 1 ? " is" : "s are"} not loaded. Select one to load it.`}
      </div>
    ) : null;

  const headerRow = (
    <>
      <div className="flex min-w-0 flex-1 items-center gap-3 [-webkit-app-region:no-drag]">
        <DropdownMenu>
          <DropdownMenuTrigger
            className="inline-flex h-6 max-w-full items-center gap-1 rounded-md bg-accent px-2 text-xs font-medium text-accent-foreground outline-none transition-colors hover:bg-accent/80 focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={`Diff scope: ${selectedScopeLabel}`}
          >
            <span className="truncate">{selectedScopeLabel}</span>
            <ChevronDownIcon className="size-3.5 shrink-0 opacity-70" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-60">
            <DropdownMenuItem
              className={
                selectedTurnId === null && selectedGitScope === "unstaged"
                  ? "bg-foreground/[0.08]"
                  : undefined
              }
              onClick={() => selectGitScope("unstaged")}
            >
              <span>Working tree</span>
            </DropdownMenuItem>
            <DropdownMenuItem
              className={
                selectedTurnId === null && selectedGitScope === "branch"
                  ? "bg-foreground/[0.08]"
                  : undefined
              }
              onClick={() => selectGitScope("branch")}
            >
              <span>Branch changes</span>
            </DropdownMenuItem>
            <DropdownMenuItem
              className={
                selectedTurnId !== null && selectedTurn?.turnId === latestTurn?.turnId
                  ? "bg-foreground/[0.08]"
                  : undefined
              }
              onClick={() => {
                if (latestTurn) selectTurn(latestTurn.turnId);
              }}
            >
              <span>Latest turn</span>
            </DropdownMenuItem>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>Turn</DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-64">
                {orderedTurnDiffSummaries.map((summary) => {
                  const turnCount =
                    summary.checkpointTurnCount ??
                    inferredCheckpointTurnCountByTurnId[summary.turnId] ??
                    "?";
                  return (
                    <DropdownMenuItem
                      key={summary.turnId}
                      className={
                        summary.turnId === selectedTurn?.turnId ? "bg-foreground/[0.08]" : undefined
                      }
                      onClick={() => selectTurn(summary.turnId)}
                    >
                      <span>Turn {turnCount}</span>
                      <span className="ml-auto text-xs tabular-nums text-muted-foreground">
                        {formatShortTimestamp(summary.completedAt, settings.timestampFormat)}
                      </span>
                    </DropdownMenuItem>
                  );
                })}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          </DropdownMenuContent>
        </DropdownMenu>
        {selectedTurnId === null && selectedGitScope === "branch" && selectedGitSource?.baseRef && (
          <div
            className="flex min-w-0 max-w-full items-center gap-2 overflow-hidden text-xs text-muted-foreground"
            aria-label={`Comparing ${selectedGitSource.headRef ?? "HEAD"} against ${selectedGitSource.baseRef}`}
          >
            <Tooltip>
              <TooltipTrigger render={<span className="flex min-w-0 items-center gap-2" />}>
                <span className="min-w-0 max-w-48 truncate">
                  {selectedGitSource.headRef ?? "HEAD"}
                </span>
                <ArrowRightIcon className="size-3.5 shrink-0 opacity-70" />
              </TooltipTrigger>
              <TooltipPopup side="top">
                {`${selectedGitSource.headRef ?? "HEAD"} → ${selectedGitSource.baseRef}`}
              </TooltipPopup>
            </Tooltip>
            <Combobox
              items={baseRefItems}
              filteredItems={filteredBaseRefItems}
              value={selectedBaseRef ?? AUTOMATIC_BASE_REF}
              onOpenChange={(open) => {
                if (!open) setBaseRefQuery("");
              }}
              onValueChange={(value) => {
                if (!value) return;
                selectBranchBaseRef(value === AUTOMATIC_BASE_REF ? null : value);
              }}
            >
              <ComboboxTrigger
                className="inline-flex min-w-0 max-w-48 items-center gap-1 overflow-hidden rounded-md px-1.5 py-1 outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                aria-label={`Change comparison target. Currently ${selectedGitSource.baseRef}`}
              >
                <span className="min-w-0 truncate">{selectedGitSource.baseRef}</span>
                <ChevronDownIcon className="size-3.5 shrink-0 opacity-70" />
              </ComboboxTrigger>
              <ComboboxPopup
                align="start"
                className="w-72 min-w-0 max-w-[calc(100vw-1rem)] overflow-hidden"
              >
                <div className="min-w-0 shrink-0 px-3 pt-2.5">
                  <div className="relative -translate-y-px border-b border-border/70 pb-1.5 transition-colors focus-within:border-ring">
                    <SearchIcon
                      aria-hidden="true"
                      className="pointer-events-none absolute top-1.5 left-0 size-4 shrink-0 text-muted-foreground/55"
                    />
                    <ComboboxInput
                      className="[&_input]:h-6.5 [&_input]:ps-5 [&_input]:font-sans [&_input]:leading-6.5"
                      inputClassName="rounded-none bg-transparent text-sm"
                      placeholder="Search refs..."
                      showTrigger={false}
                      size="sm"
                      unstyled
                      value={baseRefQuery}
                      onChange={(event) => setBaseRefQuery(event.target.value)}
                    />
                  </div>
                </div>
                <div className="grid shrink-0 grid-cols-[1rem_minmax(0,1fr)] items-center gap-2 border-b border-border/70 ps-3 pe-6.5 pt-2 pb-1.5 font-medium text-[10px] text-muted-foreground uppercase tracking-wide">
                  <span aria-hidden="true" />
                  <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_2rem] items-center">
                    <span>Branch</span>
                    <span className="text-right">Remote</span>
                  </div>
                </div>
                <ComboboxEmpty>No matching refs.</ComboboxEmpty>
                <ComboboxList className="max-h-64 min-w-0 overflow-x-hidden">
                  <ComboboxItem
                    className="h-8 w-full min-w-0 grid-cols-[1rem_minmax(0,1fr)] py-0"
                    contentClassName="w-full min-w-0 overflow-hidden"
                    value={AUTOMATIC_BASE_REF}
                  >
                    <span className="block min-w-0 truncate">Automatic</span>
                  </ComboboxItem>
                  {baseRefChoices.map((choice) => {
                    const item = valueForBaseRefChoice(choice);
                    const hasBoth = choice.local !== null && choice.remote !== null;
                    const useRemote = choice.remote?.name === item;
                    return (
                      <ComboboxItem
                        key={choice.id}
                        className="h-8 w-full min-w-0 grid-cols-[1rem_minmax(0,1fr)] py-0"
                        contentClassName="w-full min-w-0 overflow-hidden"
                        value={item}
                      >
                        <div className="grid w-full min-w-0 grid-cols-[minmax(0,1fr)_2rem] items-center overflow-hidden">
                          <span className="block min-w-0 truncate pe-2">{choice.label}</span>
                          {hasBoth ? (
                            <div
                              className="flex justify-end"
                              onClick={(event) => event.stopPropagation()}
                              onPointerDown={(event) => event.stopPropagation()}
                            >
                              <Switch
                                aria-label={`Use remote version of ${choice.label}`}
                                checked={useRemote}
                                className="[--thumb-size:--spacing(3)]"
                                onCheckedChange={(checked) => {
                                  const nextRef = checked
                                    ? choice.remote?.name
                                    : choice.local?.name;
                                  if (nextRef) selectBranchBaseRef(nextRef);
                                }}
                              />
                            </div>
                          ) : choice.remote ? (
                            <Tooltip>
                              <TooltipTrigger
                                render={
                                  <span className="flex justify-end text-muted-foreground">
                                    <CheckIcon
                                      role="img"
                                      aria-label="Remote only"
                                      className="size-3"
                                    />
                                  </span>
                                }
                              />
                              <TooltipPopup side="top">Remote only</TooltipPopup>
                            </Tooltip>
                          ) : null}
                        </div>
                      </ComboboxItem>
                    );
                  })}
                </ComboboxList>
              </ComboboxPopup>
            </Combobox>
          </div>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1 [-webkit-app-region:no-drag]">
        {fileTreeEntries.length > 0 && (
          <DiffStatLabel
            additions={diffLineStat.additions}
            deletions={diffLineStat.deletions}
            className="mr-1 text-[11px]"
            layout="inline"
          />
        )}
        {canRefreshGitDiff && (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  aria-label={branchDiffPreview.isPending ? "Refreshing diff" : "Refresh diff"}
                  onClick={refreshBranchDiffPreview}
                />
              }
            >
              <RefreshIcon className="size-3.5" refreshing={branchDiffPreview.isPending} />
            </TooltipTrigger>
            <TooltipPopup side="top">
              {branchDiffPreview.isPending ? "Refreshing diff…" : "Refresh diff"}
            </TooltipPopup>
          </Tooltip>
        )}
        {showsCodeView && diffFileKeys.length > 0 && (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  aria-label={
                    allDiffFilesCollapsed ? "Expand all loaded files" : "Collapse all loaded files"
                  }
                  onClick={toggleDiffFileCollapse}
                />
              }
            >
              {allDiffFilesCollapsed ? (
                <ChevronsUpDownIcon className="size-3.5" />
              ) : (
                <ChevronsDownUpIcon className="size-3.5" />
              )}
            </TooltipTrigger>
            <TooltipPopup side="top">
              {allDiffFilesCollapsed ? "Expand all loaded files" : "Collapse all loaded files"}
            </TooltipPopup>
          </Tooltip>
        )}
        <ToggleGroup
          aria-label="Diff layout"
          className="shrink-0"
          variant="segmented"
          value={[diffLayout]}
          onValueChange={(value) => {
            const next = value[0];
            if (next === "stacked" || next === "split") {
              updateClientSettings({ diffLayout: next });
            }
          }}
        >
          <Toggle aria-label="Stacked diff view" value="stacked">
            <Rows3Icon className="size-3.5" />
          </Toggle>
          <Toggle aria-label="Split diff view" value="split">
            <Columns2Icon className="size-3.5" />
          </Toggle>
        </ToggleGroup>
        <Tooltip>
          <TooltipTrigger
            render={
              <Toggle
                aria-label={wordWrap ? "Disable diff line wrapping" : "Enable diff line wrapping"}
                variant="ghost"
                size="sm"
                pressed={wordWrap}
                onPressedChange={(pressed) => {
                  setWordWrap(Boolean(pressed));
                }}
              />
            }
          >
            <TextWrapIcon className="size-3.5" />
          </TooltipTrigger>
          <TooltipPopup side="top">
            {wordWrap ? "Disable line wrapping" : "Enable line wrapping"}
          </TooltipPopup>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Toggle
                aria-label={
                  diffIgnoreWhitespace ? "Show whitespace changes" : "Hide whitespace changes"
                }
                variant="ghost"
                size="sm"
                pressed={diffIgnoreWhitespace}
                onPressedChange={(pressed) => {
                  setDiffIgnoreWhitespace(Boolean(pressed));
                }}
              />
            }
          >
            <PilcrowIcon className="size-3.5" />
          </TooltipTrigger>
          <TooltipPopup side="top">
            {diffIgnoreWhitespace ? "Show whitespace changes" : "Hide whitespace changes"}
          </TooltipPopup>
        </Tooltip>
        {fileTreeEntries.length > 0 && (
          <Tooltip>
            <TooltipTrigger
              render={
                <Toggle
                  aria-label={fileTreeOpen ? "Hide file tree" : "Show file tree"}
                  variant="ghost"
                  size="sm"
                  pressed={fileTreeOpen}
                  onPressedChange={(pressed) => setFileTreeOpen(Boolean(pressed))}
                />
              }
            >
              <FolderTreeIcon className="size-3.5" />
            </TooltipTrigger>
            <TooltipPopup side="top">
              {fileTreeOpen ? "Hide file tree" : "Show file tree"}
            </TooltipPopup>
          </Tooltip>
        )}
      </div>
    </>
  );

  return (
    <DiffPanelShell mode={mode} header={headerRow}>
      {!activeThread ? (
        <div className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
          Select a thread to inspect turn diffs.
        </div>
      ) : !isGitRepo ? (
        <div className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
          Turn diffs are unavailable because this project is not a git repository.
        </div>
      ) : selectedTurnId !== null && orderedTurnDiffSummaries.length === 0 ? (
        <div className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
          No completed turns yet.
        </div>
      ) : (
        <>
          <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background">
            {isSelectedPatchTruncated && (
              <div className="flex shrink-0 items-center gap-2 border-b border-border/70 bg-muted/40 px-3 py-1.5 text-[11px] text-muted-foreground">
                <p className="min-w-0 flex-1">
                  {selectedGitFiles.length > 0
                    ? `${omittedGitFileCount > 0 ? `${omittedGitFileCount} file diff${omittedGitFileCount === 1 ? " is" : "s are"} collapsed and will load when expanded.` : "All listed file diffs are loaded."}${selectedGitSource?.fileListTruncated === true ? " The changed-file manifest exceeded its safety limit, so additional filenames may be unavailable." : ""}`
                    : "This diff exceeded the preview limit. Open it in a terminal to inspect changes the connected server could not list."}
                </p>
                {selectedGitFiles.length > 0 && !fileTreeOpen ? (
                  <Button size="xs" variant="outline" onClick={() => setFileTreeOpen(true)}>
                    Show files
                  </Button>
                ) : null}
              </div>
            )}
            {activeLoadedGitPatches?.error ? (
              <p className="shrink-0 border-b border-border/70 px-3 py-1.5 text-[11px] text-error/80">
                {activeLoadedGitPatches.error.message}
              </p>
            ) : null}
            {selectedPatchError && !renderablePatch && (
              <div className="px-3">
                <p className="mb-2 text-[11px] text-error/80">{selectedPatchError}</p>
              </div>
            )}
            {!renderablePatch && codeViewFiles.length === 0 ? (
              isLoadingSelectedPatch ? (
                <DiffPanelLoadingState
                  label={
                    selectedTurn
                      ? "Loading checkpoint diff..."
                      : selectedGitScope === "unstaged"
                        ? "Loading working tree diff..."
                        : "Loading branch diff..."
                  }
                />
              ) : selectedTurnId === null && selectedGitFiles.length > 0 ? (
                <div className="flex min-h-0 flex-1 overflow-hidden">
                  <div className="flex min-w-0 flex-1 items-center justify-center px-3 py-2 text-center text-xs text-muted-foreground/70">
                    <p>Select a file from the file tree to load its diff.</p>
                  </div>
                  {fileTreeOpen ? (
                    <FileBrowserPane
                      besidePreview
                      storageKey="t3code.diffFileExplorerWidth"
                      defaultWidth={256}
                    >
                      <DiffFileTree
                        ariaLabel={`${reviewSectionTitle} files`}
                        entries={fileTreeEntries}
                        onSelectFile={revealDiffFile}
                        footer={fileTreeFooter}
                      />
                    </FileBrowserPane>
                  ) : null}
                </div>
              ) : (
                <div className="flex h-full items-center justify-center px-3 py-2 text-xs text-muted-foreground/70">
                  <p>
                    {hasNoNetChanges
                      ? "No net changes in this selection."
                      : "No patch available for this selection."}
                  </p>
                </div>
              )
            ) : showsCodeView ? (
              <div className="flex min-h-0 flex-1 overflow-hidden">
                <div
                  className="min-h-0 min-w-0 flex-1"
                  onClickCapture={(event) => {
                    const composedPath = event.nativeEvent.composedPath?.() ?? [];
                    for (const node of composedPath) {
                      if (!(node instanceof HTMLElement)) continue;
                      // Header controls keep their own actions. In particular, the chevron must
                      // not also trigger the row handler or the two toggles cancel each other.
                      if (node instanceof HTMLButtonElement || node instanceof HTMLAnchorElement) {
                        return;
                      }
                    }
                    const title = composedPath.find(
                      (node): node is HTMLElement =>
                        node instanceof HTMLElement && node.hasAttribute("data-title"),
                    );
                    const filePath = title?.textContent?.trim();
                    // The filename remains the explicit "open in editor" affordance.
                    if (filePath) {
                      openDiffFile(filePath);
                      return;
                    }
                    const header = composedPath.find(
                      (node): node is HTMLElement =>
                        node instanceof HTMLElement && node.hasAttribute("data-diffs-header"),
                    );
                    const headerFilePath = header
                      ?.querySelector("[data-title]")
                      ?.textContent?.trim();
                    if (!headerFilePath) return;
                    const file = codeViewFiles.find(
                      (candidate) => candidate.filePath === headerFilePath,
                    );
                    if (file) toggleDiffFileCollapsed(file.fileKey);
                  }}
                >
                  <AnnotatableCodeView
                    {...(activeThread && activeCwd
                      ? {
                          workspace: {
                            environmentId: activeThread.environmentId,
                            cwd: activeCwd,
                            revision: workspaceMutationId,
                          },
                        }
                      : {})}
                    key={collapseScopeKey ?? reviewSectionId}
                    viewerRef={setCodeView}
                    onRevealItem={toggleDiffFileCollapsed}
                    codeViewKey={codeViewMountKey}
                    onActiveFileChange={setActiveDiffFilePath}
                    className="h-full min-h-0 overflow-auto"
                    files={codeViewFiles}
                    sectionId={reviewSectionId}
                    sectionTitle={reviewSectionTitle}
                    composerDraftTarget={composerDraftTarget}
                    renderHeaderFilenameSuffix={(fileDiff) => {
                      const filePath = resolveFileDiffPath(fileDiff);
                      const file = codeViewFiles.find(
                        (candidate) => candidate.filePath === filePath,
                      );
                      const loading =
                        !file?.loaded &&
                        activeLoadedGitPatches?.loadingPaths.has(filePath) === true;
                      const failed =
                        !file?.loaded && activeLoadedGitPatches?.error?.filePath === filePath;
                      return (
                        <>
                          {!file?.loaded ? (
                            <span
                              className={cn(
                                "rounded-full border px-1.5 py-0.5 text-[10px] font-medium",
                                failed
                                  ? "border-error/30 text-error/80"
                                  : "border-border/70 text-muted-foreground",
                              )}
                            >
                              {loading ? "Loading…" : failed ? "Retry" : "Not loaded"}
                            </span>
                          ) : null}
                          <DiffFilePathCopyButton filePath={filePath} />
                        </>
                      );
                    }}
                    renderHeaderPrefix={(fileDiff, fileKey, collapsed) => {
                      const filePath = resolveFileDiffPath(fileDiff);
                      const file = codeViewFiles.find((candidate) => candidate.fileKey === fileKey);
                      const loading =
                        !file?.loaded &&
                        activeLoadedGitPatches?.loadingPaths.has(filePath) === true;
                      return (
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <Button
                                size="icon-micro"
                                variant="ghost"
                                className={cn(
                                  "-ms-0.5 [--control-icon-color:currentColor] bg-transparent hover:bg-foreground/10",
                                  getDiffCollapseIconClassName(fileDiff),
                                )}
                                aria-label={
                                  loading
                                    ? `Loading ${filePath}`
                                    : !file?.loaded
                                      ? `Load and expand ${filePath}`
                                      : collapsed
                                        ? `Expand ${filePath}`
                                        : `Collapse ${filePath}`
                                }
                                aria-expanded={!collapsed}
                                disabled={loading}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  toggleDiffFileCollapsed(fileKey);
                                }}
                              />
                            }
                          >
                            {collapsed ? (
                              <ChevronRightIcon className="size-4" />
                            ) : (
                              <ChevronDownIcon className="size-4" />
                            )}
                          </TooltipTrigger>
                          <TooltipPopup side="top">
                            {loading
                              ? "Loading diff"
                              : !file?.loaded
                                ? "Load and expand diff"
                                : collapsed
                                  ? "Expand diff"
                                  : "Collapse diff"}
                          </TooltipPopup>
                        </Tooltip>
                      );
                    }}
                    options={{
                      diffStyle: diffLayout === "split" ? "split" : "unified",
                      lineDiffType: "none",
                      overflow: wordWrap ? "wrap" : "scroll",
                      theme: resolveDiffThemeName(resolvedTheme),
                      preferredHighlighter: PREFERRED_HIGHLIGHTER,
                      themeType: resolvedTheme as DiffThemeType,
                      stickyHeaders: true,
                      ...(currentLoadDiffFiles ? { loadDiffFiles } : {}),
                    }}
                  />
                </div>
                {fileTreeOpen ? (
                  <FileBrowserPane
                    besidePreview
                    storageKey="t3code.diffFileExplorerWidth"
                    defaultWidth={256}
                  >
                    <DiffFileTree
                      ariaLabel={`${reviewSectionTitle} files`}
                      entries={fileTreeEntries}
                      selectedPath={activeDiffFilePath}
                      revealRequestId={selectedFileRevealRequestId}
                      onSelectFile={revealDiffFile}
                      footer={fileTreeFooter}
                    />
                  </FileBrowserPane>
                ) : null}
              </div>
            ) : (
              <div className="min-h-0 flex-1 overflow-auto p-2">
                <div className="space-y-2">
                  <p className="text-[11px] text-muted-foreground/75">
                    {renderablePatch?.kind === "raw"
                      ? renderablePatch.reason
                      : "No patch available for this selection."}
                  </p>
                  <pre
                    className={cn(
                      "max-h-[72vh] rounded-md border border-border/70 bg-background/70 p-3 font-mono text-[11px] leading-relaxed text-muted-foreground/90",
                      wordWrap
                        ? "overflow-auto whitespace-pre-wrap wrap-break-word"
                        : "overflow-auto",
                    )}
                  >
                    {renderablePatch?.kind === "raw" ? renderablePatch.text : ""}
                  </pre>
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </DiffPanelShell>
  );
}
