import type { EnvironmentId, ReviewDiffPreviewFile, ThreadId } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { MenuAction } from "@react-native-menu/menu";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  NativeHeaderToolbar,
  NativeStackScreenOptions,
  nativeHeaderScrollEdgeEffects,
} from "../../native/StackHeader";
import { Screen, ScreenStack, ScreenStackHeaderConfig } from "react-native-screens";
import {
  memo,
  type Ref,
  type ReactElement,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ActivityIndicator,
  FlatList,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  type NativeSyntheticEvent,
  StyleSheet,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { AndroidHeaderIconButton, AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { ControlPillMenu } from "../../components/ControlPill";
import { environmentCatalog } from "../../connection/catalog";
import { useEnvironmentPresentation } from "../../state/presentation";
import { useAtomCommand } from "../../state/use-atom-command";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import { IOS_NAV_BAR_HEIGHT } from "../../lib/layoutMetrics";
import { useThreadDraftForThread } from "../../state/use-thread-composer-state";
import { EnvironmentConnectionNotice } from "../connection/EnvironmentConnectionNotice";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import {
  useAdaptiveWorkspaceLayout,
  useAdaptiveWorkspacePaneRole,
  useRegisterWorkspaceInspector,
} from "../layout/AdaptiveWorkspaceLayout";
import { useEnvironmentQuery } from "../../state/query";
import { useSelectedThreadGitActions } from "../../state/use-selected-thread-git-actions";
import { useSelectedThreadGitState } from "../../state/use-selected-thread-git-state";
import { useSelectedThreadWorktree } from "../../state/use-selected-thread-worktree";
import { useThreadSelection } from "../../state/use-thread-selection";
import { vcsEnvironment } from "../../state/vcs";
import { reviewEnvironment } from "../../state/review";
import { WorkspaceSidebarToolbar } from "../layout/workspace-sidebar-toolbar";
import { ThreadGitMenu } from "../threads/ThreadGitControls";
import { setReviewGitFilePatch, useReviewCacheForThread } from "./reviewState";
import {
  isNativeReviewDiffDrawEvent,
  type NativeReviewDiffViewHandle,
  resolveNativeReviewDiffView,
} from "../diffs/nativeReviewDiffSurface";
import { NATIVE_REVIEW_DIFF_CONTENT_WIDTH } from "./nativeReviewDiffAdapter";
import { useAppearanceCodeSurface } from "../settings/appearance/useAppearanceCodeSurface";
import { useReviewDiffData } from "./useReviewDiffData";
import { useReviewDiffPrewarming } from "./useReviewDiffPrewarming";
import { useReviewFileVisibility } from "./reviewFileVisibility";
import { useReviewSections } from "./useReviewSections";
import { useNativeReviewDiffBridge } from "./useNativeReviewDiffBridge";
import { useReviewCommentSelectionController } from "./useReviewCommentSelectionController";
import { resolveReviewAvailability } from "./reviewAvailability";
import { resolveSelectedReviewFileId } from "./reviewPaneSelection";
import { buildReviewSectionMenu } from "./review-section-menu";
import type { ReviewSectionItem } from "./reviewModel";
import { reportShowcaseSceneRendered } from "../showcase/showcaseRenderSignal";

const REVIEW_HEADER_SPACING = 0;
const SHOWCASE_ENABLED = process.env.EXPO_PUBLIC_SHOWCASE === "1";

const ReviewNotice = memo(function ReviewNotice(props: { readonly notice: string }) {
  return (
    <View className="border-b border-warning-border bg-warning px-4 py-3">
      <Text className="text-xs font-t3-bold uppercase text-warning-foreground">Partial diff</Text>
      <Text className="text-xs leading-normal text-warning-foreground">{props.notice}</Text>
    </View>
  );
});

function ReviewSelectionActionBar(props: {
  readonly bottomInset: number;
  readonly title: string | null;
  readonly onOpenComment: (() => void) | null;
  readonly onClear: () => void;
}) {
  if (!props.title) {
    return null;
  }

  const content = (
    <>
      <SymbolView
        name={props.onOpenComment ? "text.bubble" : "line.3.horizontal.decrease.circle"}
        size={16}
        tintColorClassName={"accent-primary-foreground"}
        type="monochrome"
      />
      <Text className="text-base font-t3-bold text-primary-foreground">{props.title}</Text>
    </>
  );

  return (
    <View
      pointerEvents="box-none"
      style={{
        position: "absolute",
        left: 18,
        right: 18,
        bottom: Math.max(props.bottomInset, 10) + 18,
        flexDirection: "row",
        justifyContent: "center",
        gap: 10,
      }}
    >
      {props.onOpenComment ? (
        <Pressable
          className="h-12 flex-1 flex-row items-center justify-center gap-2 rounded-full bg-primary px-5"
          onPress={props.onOpenComment}
        >
          {content}
        </Pressable>
      ) : (
        <View className="h-12 flex-1 flex-row items-center justify-center gap-2 rounded-full bg-primary px-5">
          {content}
        </View>
      )}

      <Pressable
        className="h-12 w-12 items-center justify-center rounded-full bg-primary"
        onPress={props.onClear}
      >
        <SymbolView
          name="xmark"
          size={16}
          tintColorClassName={"accent-primary-foreground"}
          type="monochrome"
        />
      </Pressable>
    </View>
  );
}

interface ReviewNavigatorFile {
  readonly id: string;
  readonly path: string;
  readonly additions: number;
  readonly deletions: number;
  readonly previewFile: ReviewDiffPreviewFile | null;
  readonly loaded: boolean;
}

interface GitFileLoadState {
  readonly scopeKey: string | null;
  readonly loadingPaths: ReadonlySet<string>;
  readonly error: string | null;
}

const EMPTY_GIT_FILE_LOAD_STATE: GitFileLoadState = {
  scopeKey: null,
  loadingPaths: new Set(),
  error: null,
};

const ReviewFileNavigatorRow = memo(function ReviewFileNavigatorRow(props: {
  readonly file: ReviewNavigatorFile;
  readonly selected: boolean;
  readonly loading: boolean;
  readonly onSelectFile: (file: ReviewNavigatorFile | null) => void;
}) {
  const { file, loading, selected, onSelectFile } = props;
  // Tapping the selected file again returns to the all-files diff.
  const handlePress = useCallback(() => {
    onSelectFile(selected ? null : file);
  }, [file, onSelectFile, selected]);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      className={
        selected
          ? "mt-1 min-h-12 justify-center rounded-xl bg-subtle-strong px-3 py-2"
          : "mt-1 min-h-12 justify-center rounded-xl px-3 py-2 active:bg-subtle"
      }
      onPress={handlePress}
    >
      <Text
        className={
          selected
            ? "text-xs font-t3-bold text-foreground"
            : "text-xs font-t3-medium text-foreground-secondary"
        }
        numberOfLines={2}
      >
        {file.path}
      </Text>
      <View className="mt-1 flex-row gap-2">
        <Text className="text-2xs font-t3-bold text-emerald-600">+{file.additions}</Text>
        <Text className="text-2xs font-t3-bold text-rose-600">-{file.deletions}</Text>
        {!file.loaded ? (
          <Text className="text-2xs font-t3-medium text-foreground-muted">
            {loading ? "Loading…" : "Tap to load"}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
});

interface ReviewFileNavigatorHandle {
  readonly setVisibleFile: (fileId: string | null) => void;
}

interface ReviewFileNavigatorProps {
  readonly files: ReadonlyArray<ReviewNavigatorFile>;
  readonly headerInset: number;
  readonly sectionId: string | null;
  readonly loadingPaths: ReadonlySet<string>;
  readonly onSelectFile: (file: ReviewNavigatorFile | null) => void;
  readonly ref?: Ref<ReviewFileNavigatorHandle>;
}

function ReviewFileNavigator({
  files,
  headerInset,
  loadingPaths,
  sectionId,
  onSelectFile,
  ref,
}: ReviewFileNavigatorProps) {
  const insets = useSafeAreaInsets();
  const theme = useUniwindTheme();
  const sheetColor = theme["--color-sheet"];
  const foregroundColor = theme["--color-foreground"];
  const headerScrollEdgeEffects = nativeHeaderScrollEdgeEffects(Platform.OS, Platform.Version);
  const [fileSelection, setFileSelection] = useState<{
    readonly sectionId: string | null;
    readonly fileId: string | null;
  }>({ sectionId: null, fileId: null });
  const availableFileIds = useMemo(() => files.map((file) => file.id), [files]);
  const selectedFileId = resolveSelectedReviewFileId({
    selection: fileSelection,
    sectionId,
    availableFileIds,
  });

  useImperativeHandle(
    ref,
    () => ({
      setVisibleFile: (fileId) => {
        if (fileId !== null && !availableFileIds.includes(fileId)) {
          return;
        }
        setFileSelection((current) => {
          if (current.sectionId === sectionId && current.fileId === fileId) {
            return current;
          }
          return { sectionId, fileId };
        });
      },
    }),
    [availableFileIds, sectionId],
  );

  const handleSelectFile = useCallback(
    (file: ReviewNavigatorFile | null) => {
      setFileSelection({ sectionId, fileId: file?.id ?? null });
      onSelectFile(file);
    },
    [onSelectFile, sectionId],
  );

  const renderFile = useCallback(
    ({ item }: { readonly item: ReviewNavigatorFile }) => (
      <ReviewFileNavigatorRow
        file={item}
        selected={selectedFileId === item.id}
        loading={loadingPaths.has(item.path)}
        onSelectFile={handleSelectFile}
      />
    ),
    [handleSelectFile, loadingPaths, selectedFileId],
  );

  const fileList = (
    <FlatList
      data={files}
      extraData={selectedFileId}
      keyExtractor={(file) => file.id}
      contentContainerStyle={{
        paddingHorizontal: 8,
        paddingBottom: 8,
        // The nested native header is translucent; start the list below it so
        // the scroll-edge effect can sample the content (same treatment as
        // FileTreeBrowser in the Files pane).
        paddingTop: Platform.OS === "ios" ? insets.top + IOS_NAV_BAR_HEIGHT + 8 : 8,
      }}
      scrollIndicatorInsets={
        Platform.OS === "ios" ? { top: insets.top + IOS_NAV_BAR_HEIGHT } : undefined
      }
      renderItem={renderFile}
    />
  );

  if (Platform.OS === "ios") {
    return (
      <View className="flex-1 border-l border-border bg-sheet">
        <ScreenStack style={{ flex: 1 }}>
          <Screen
            activityState={2}
            enabled
            isNativeStack
            screenId="review-file-navigator-native"
            scrollEdgeEffects={headerScrollEdgeEffects}
            style={{ backgroundColor: sheetColor, flex: 1 }}
          >
            {fileList}
            <ScreenStackHeaderConfig
              backgroundColor="rgba(0,0,0,0)"
              color={foregroundColor}
              hideBackButton
              hideShadow={false}
              navigationItemStyle="editor"
              subtitle={`${files.length} ${files.length === 1 ? "file" : "files"}`}
              title="Changed files"
              titleColor={foregroundColor}
              titleFontSize={17}
              titleFontWeight="700"
              translucent
            />
          </Screen>
        </ScreenStack>
      </View>
    );
  }

  return (
    <View className="flex-1 border-l border-border bg-sheet">
      <View className="border-b border-border" style={{ paddingTop: headerInset }}>
        <View className="px-4 py-3">
          <Text className="text-sm font-t3-bold text-foreground">Changed files</Text>
          <Text className="text-xs text-foreground-muted">
            {files.length} {files.length === 1 ? "file" : "files"}
          </Text>
        </View>
      </View>
      {fileList}
    </View>
  );
}

type ReviewSheetProps = StaticScreenProps<{
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}>;

export function ReviewSheet(props: ReviewSheetProps) {
  const isAndroid = Platform.OS === "android";
  const { nativeReviewDiffStyle } = useAppearanceCodeSurface();
  useAdaptiveWorkspacePaneRole("inspector");
  const { panes, showAuxiliaryPane, toggleAuxiliaryPane } = useAdaptiveWorkspaceLayout();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { themeAppearance: selectedTheme } = useAppearancePreferences();
  const headerIcon = String(useUniwindTheme()["--color-icon"]);
  const { environmentId, threadId } = props.route.params;
  const environment = useEnvironmentPresentation(environmentId);
  const retryEnvironment = useAtomCommand(environmentCatalog.retryNow, "environment retry");
  const isEnvironmentReady = environment.presentation?.connection.phase === "connected";
  const { draftMessage } = useThreadDraftForThread({ environmentId, threadId });
  const reviewCache = useReviewCacheForThread({ environmentId, threadId });
  const getDiffFileContents = useAtomCommand(reviewEnvironment.diffFileContents);
  const [gitFileLoadState, setGitFileLoadState] =
    useState<GitFileLoadState>(EMPTY_GIT_FILE_LOAD_STATE);
  const inFlightGitFileLoadsRef = useRef(new Set<string>());
  const pendingGitFileRevealRef = useRef<{ scopeKey: string; filePath: string } | null>(null);
  /* ─── Git actions for the toolbar menu (commit/push without leaving review) ── */
  const { selectedThread } = useThreadSelection();
  const { selectedThreadCwd } = useSelectedThreadWorktree();
  const gitState = useSelectedThreadGitState();
  const gitActions = useSelectedThreadGitActions();
  const gitStatusQuery = useEnvironmentQuery(
    selectedThread !== null && selectedThreadCwd !== null
      ? vcsEnvironment.status({
          environmentId: selectedThread.environmentId,
          input: { cwd: selectedThreadCwd },
        })
      : null,
  );
  // The selection-based git hooks only apply when this review belongs to the
  // selected thread (it always does when reached from the thread's toolbar).
  const gitMenuAvailable =
    selectedThread !== null && String(selectedThread.id) === String(threadId);
  // With a solid (non-overlay) header the content lays out below the header
  // natively, so no manual top inset is needed. (Android renders its own
  // in-flow AndroidScreenHeader, so it needs no inset either.)
  const topContentInset = 0;

  useEffect(() => {
    showAuxiliaryPane("inspector");
  }, [environmentId, showAuxiliaryPane, threadId]);
  const { error, reviewSections, selectedSection, refreshSelectedSection, selectSection } =
    useReviewSections({
      enabled: isEnvironmentReady,
      environmentId,
      threadId,
      reviewCache,
    });
  useReviewDiffPrewarming({
    threadKey: reviewCache.threadKey,
    sections: reviewSections,
    selectedSectionId: selectedSection?.id ?? null,
  });
  const { headerDiffSummary, nativeReviewDiffData, parsedDiff, pendingReviewCommentCount } =
    useReviewDiffData({
      threadKey: reviewCache.threadKey,
      selectedSection,
      draftMessage,
    });
  // Resolution returns null while Expo registers the native view (or forever
  // when the binary lacks it). Rendering a null component type crashes the
  // app, so callers must fall back — ThreadFeed's ReviewCommentCard does the
  // same check.
  const NativeReviewDiffView = resolveNativeReviewDiffView();
  const nativeReviewDiffViewRef = useRef<NativeReviewDiffViewHandle>(null);
  const showcasedReviewDrawRef = useRef<string | null>(null);
  // Native pull-to-refresh on the diff surface (replaces the old Refresh menu item).
  const [isPullRefreshing, setIsPullRefreshing] = useState(false);
  const handlePullToRefresh = useCallback(async () => {
    setIsPullRefreshing(true);
    try {
      await refreshSelectedSection();
    } finally {
      setIsPullRefreshing(false);
    }
  }, [refreshSelectedSection]);
  const reviewFileNavigatorRef = useRef<ReviewFileNavigatorHandle>(null);
  const selectedGitSource = selectedSection?.source ?? null;
  const gitFileLoadScopeKey =
    selectedGitSource && reviewCache.threadKey
      ? `${reviewCache.threadKey}:${selectedGitSource.kind}:${selectedGitSource.diffHash}`
      : null;
  const activeGitFileLoadState =
    gitFileLoadState.scopeKey === gitFileLoadScopeKey
      ? gitFileLoadState
      : EMPTY_GIT_FILE_LOAD_STATE;
  const loadingGitFilePaths = activeGitFileLoadState.loadingPaths;
  const gitFileLoadError = activeGitFileLoadState.error;
  const reviewFiles = parsedDiff.kind === "files" ? parsedDiff.files : [];
  const navigatorFiles = useMemo<ReadonlyArray<ReviewNavigatorFile>>(() => {
    if (selectedGitSource?.files && selectedGitSource.files.length > 0) {
      return selectedGitSource.files.map((previewFile) => {
        const loadedFile = reviewFiles.find((file) => file.path === previewFile.newPath);
        return {
          id: loadedFile?.id ?? `pending:${previewFile.newPath}`,
          path: previewFile.newPath,
          additions: previewFile.additions,
          deletions: previewFile.deletions,
          previewFile,
          loaded: loadedFile?.loaded === true,
        };
      });
    }
    return reviewFiles.map((file) => ({
      id: file.id,
      path: file.path,
      additions: file.additions,
      deletions: file.deletions,
      previewFile: null,
      loaded: true,
    }));
  }, [reviewFiles, selectedGitSource]);
  const fileVisibility = useReviewFileVisibility({
    threadKey: reviewCache.threadKey,
    sectionId: selectedSection?.id ?? null,
    files: reviewFiles,
    cachedExpandedFileIds: selectedSection?.id
      ? reviewCache.expandedFileIdsBySection[selectedSection.id]
      : undefined,
    cachedViewedFileIds: selectedSection?.id
      ? reviewCache.viewedFileIdsBySection[selectedSection.id]
      : undefined,
  });
  const { collapsedFileIds, toggleExpandedFile, toggleViewedFile, viewedFileIds } = fileVisibility;
  const commentSelection = useReviewCommentSelectionController({
    environmentId,
    threadId,
    selectedSection,
    nativeReviewDiffData,
  });
  const nativeBridge = useNativeReviewDiffBridge({
    ...(gitMenuAvailable && selectedThread?.environmentId === environmentId && selectedThreadCwd
      ? { workspace: { environmentId, cwd: selectedThreadCwd, revision: selectedSection?.diff } }
      : {}),
    threadKey: reviewCache.threadKey,
    sectionId: selectedSection?.id ?? null,
    diff: selectedSection?.diff,
    data: nativeReviewDiffData,
    collapsedFileIds,
    viewedFileIds,
    selectedRowIds: commentSelection.selectedRowIds,
    canHighlight: parsedDiff.kind === "files",
  });
  const showcaseReviewKey =
    SHOWCASE_ENABLED && parsedDiff.kind === "files" && selectedSection
      ? `${reviewCache.threadKey}:${selectedSection.id}:${nativeBridge.tokensResetKey}:${nativeBridge.themeId}`
      : null;
  const handleNativeDebug = useCallback(
    (event: NativeSyntheticEvent<Record<string, unknown>>) => {
      nativeBridge.onDebug(event);
      if (
        showcaseReviewKey === null ||
        showcasedReviewDrawRef.current === showcaseReviewKey ||
        !isNativeReviewDiffDrawEvent(event.nativeEvent)
      ) {
        return;
      }
      showcasedReviewDrawRef.current = showcaseReviewKey;
      reportShowcaseSceneRendered({ scene: "review", themeId: nativeBridge.themeId });
    },
    [nativeBridge.onDebug, nativeBridge.themeId, showcaseReviewKey],
  );

  const navigateToReviewFile = useCallback(
    (fileId: string | null) => {
      commentSelection.clearSelection();
      if (fileId !== null && collapsedFileIds.includes(fileId)) {
        toggleExpandedFile(fileId);
      }
      const navigation =
        fileId === null
          ? nativeReviewDiffViewRef.current?.scrollToTop(true)
          : nativeReviewDiffViewRef.current?.scrollToFile(fileId, true);
      void navigation?.catch((error: unknown) => {
        console.error("[review] Failed to navigate to diff file", error);
      });
    },
    [collapsedFileIds, commentSelection, toggleExpandedFile],
  );
  const loadGitFilePatch = useCallback(
    async (file: ReviewNavigatorFile) => {
      const previewFile = file.previewFile;
      const loadKey = gitFileLoadScopeKey ? `${gitFileLoadScopeKey}\0${file.path}` : null;
      if (
        !previewFile ||
        !selectedGitSource ||
        !selectedThreadCwd ||
        !reviewCache.threadKey ||
        !gitFileLoadScopeKey ||
        !loadKey ||
        inFlightGitFileLoadsRef.current.has(loadKey)
      ) {
        return;
      }
      inFlightGitFileLoadsRef.current.add(loadKey);
      pendingGitFileRevealRef.current = { scopeKey: gitFileLoadScopeKey, filePath: file.path };
      setGitFileLoadState((current) => {
        const scoped =
          current.scopeKey === gitFileLoadScopeKey
            ? current
            : { scopeKey: gitFileLoadScopeKey, loadingPaths: new Set<string>(), error: null };
        return {
          ...scoped,
          loadingPaths: new Set([...scoped.loadingPaths, file.path]),
          error: null,
        };
      });
      const result = await getDiffFileContents({
        environmentId,
        input: {
          cwd: selectedThreadCwd,
          sourceKind: selectedGitSource.kind,
          changeType: previewFile.changeType,
          baseRef: selectedGitSource.baseRef,
          headRef: selectedGitSource.headRef,
          oldPath: previewFile.oldPath,
          newPath: previewFile.newPath,
          isUntracked: previewFile.isUntracked,
          includePatch: true,
        },
      });
      inFlightGitFileLoadsRef.current.delete(loadKey);
      if (result._tag !== "Success") {
        if (pendingGitFileRevealRef.current?.scopeKey === gitFileLoadScopeKey) {
          pendingGitFileRevealRef.current = null;
        }
        if (!isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          setGitFileLoadState((current) => {
            if (current.scopeKey !== gitFileLoadScopeKey) return current;
            const loadingPaths = new Set(current.loadingPaths);
            loadingPaths.delete(file.path);
            return {
              ...current,
              loadingPaths,
              error: error instanceof Error ? error.message : `Could not load ${file.path}.`,
            };
          });
        } else {
          setGitFileLoadState((current) => {
            if (current.scopeKey !== gitFileLoadScopeKey) return current;
            const loadingPaths = new Set(current.loadingPaths);
            loadingPaths.delete(file.path);
            return { ...current, loadingPaths };
          });
        }
        return;
      }
      if (result.value.patch === undefined) {
        if (pendingGitFileRevealRef.current?.scopeKey === gitFileLoadScopeKey) {
          pendingGitFileRevealRef.current = null;
        }
        setGitFileLoadState((current) => {
          if (current.scopeKey !== gitFileLoadScopeKey) return current;
          const loadingPaths = new Set(current.loadingPaths);
          loadingPaths.delete(file.path);
          return {
            ...current,
            loadingPaths,
            error: `The server did not return a patch for ${file.path}.`,
          };
        });
        return;
      }
      const updated = setReviewGitFilePatch({
        threadKey: reviewCache.threadKey,
        sourceKind: selectedGitSource.kind,
        diffHash: selectedGitSource.diffHash,
        filePath: file.path,
        patch: result.value.patch,
      });
      if (!updated && pendingGitFileRevealRef.current?.scopeKey === gitFileLoadScopeKey) {
        pendingGitFileRevealRef.current = null;
      }
      setGitFileLoadState((current) => {
        if (current.scopeKey !== gitFileLoadScopeKey) return current;
        const loadingPaths = new Set(current.loadingPaths);
        loadingPaths.delete(file.path);
        return { ...current, loadingPaths, error: null };
      });
    },
    [
      environmentId,
      getDiffFileContents,
      gitFileLoadScopeKey,
      reviewCache.threadKey,
      selectedGitSource,
      selectedThreadCwd,
    ],
  );
  const handleSelectFile = useCallback(
    (file: ReviewNavigatorFile | null) => {
      if (file === null) {
        navigateToReviewFile(null);
      } else if (file.loaded) {
        navigateToReviewFile(file.id);
      } else {
        void loadGitFilePatch(file);
      }
    },
    [loadGitFilePatch, navigateToReviewFile],
  );
  useEffect(() => {
    const pending = pendingGitFileRevealRef.current;
    if (!pending || pending.scopeKey !== gitFileLoadScopeKey) return;
    const loadedFile = reviewFiles.find((file) => file.path === pending.filePath);
    if (!loadedFile?.loaded) return;
    pendingGitFileRevealRef.current = null;
    reviewFileNavigatorRef.current?.setVisibleFile(loadedFile.id);
    navigateToReviewFile(loadedFile.id);
  }, [gitFileLoadScopeKey, navigateToReviewFile, reviewFiles]);
  const handleVisibleFileChange = useCallback(
    (event: NativeSyntheticEvent<{ readonly fileId?: string | null }>) => {
      reviewFileNavigatorRef.current?.setVisibleFile(event.nativeEvent.fileId ?? null);
    },
    [],
  );
  const renderInspector = useCallback(
    () => (
      <ReviewFileNavigator
        ref={reviewFileNavigatorRef}
        files={navigatorFiles}
        // The workspace inspector column spans the full window height, so the
        // pane clears the status bar itself.
        headerInset={insets.top}
        sectionId={selectedSection?.id ?? null}
        loadingPaths={loadingGitFilePaths}
        onSelectFile={handleSelectFile}
      />
    ),
    [handleSelectFile, insets.top, loadingGitFilePaths, navigatorFiles, selectedSection?.id],
  );

  const handleNativeToggleFile = useCallback(
    (event: NativeSyntheticEvent<{ readonly fileId?: string }>) => {
      const { fileId } = event.nativeEvent;
      if (fileId) {
        const file = navigatorFiles.find((candidate) => candidate.id === fileId);
        if (file && !file.loaded) {
          void loadGitFilePatch(file);
          return;
        }
        toggleExpandedFile(fileId);
      }
    },
    [loadGitFilePatch, navigatorFiles, toggleExpandedFile],
  );

  const handleNativeToggleViewedFile = useCallback(
    (event: NativeSyntheticEvent<{ readonly fileId?: string }>) => {
      const { fileId } = event.nativeEvent;
      if (fileId) {
        toggleViewedFile(fileId);
      }
    },
    [toggleViewedFile],
  );

  const previewFiles = selectedGitSource?.files ?? [];
  const previewLoadedFileCount = previewFiles.filter((file) => file.patchIncluded).length;
  const previewNotice =
    previewFiles.length > 0 &&
    (previewLoadedFileCount < previewFiles.length || selectedGitSource?.fileListTruncated === true)
      ? `${previewFiles.length - previewLoadedFileCount > 0 ? `${previewFiles.length - previewLoadedFileCount} file diff${previewFiles.length - previewLoadedFileCount === 1 ? " is" : "s are"} collapsed and will load when expanded.` : "All listed file diffs are loaded."}${selectedGitSource?.fileListTruncated === true ? " The changed-file manifest exceeded its safety limit, so additional filenames may be unavailable." : ""}`
      : null;
  const parsedDiffNotice =
    previewNotice ??
    (parsedDiff.kind === "files" || parsedDiff.kind === "raw" ? parsedDiff.notice : null);
  const hasCachedSelectedDiff = selectedSection?.diff != null;
  const hasAnyCachedDiff = reviewSections.some((section) => section.diff != null);
  const sectionMenu = useMemo(() => buildReviewSectionMenu(reviewSections), [reviewSections]);
  const { showConnectionNotice, showSectionToolbar } = resolveReviewAvailability({
    hasEnvironmentPresentation: environment.isReady,
    isEnvironmentConnected: isEnvironmentReady,
    hasCachedSelectedDiff,
    hasAnyCachedDiff,
  });
  const androidSectionMenuActions = useMemo<MenuAction[]>(() => {
    const sectionAction = (section: ReviewSectionItem | null, title: string): MenuAction => ({
      id: section ? `section:${section.id}` : `unavailable:${title}`,
      title: section?.id === selectedSection?.id ? `${title} (selected)` : title,
      attributes: section ? undefined : { disabled: true },
    });
    const actions: MenuAction[] = [
      sectionAction(sectionMenu.workingTree, "Working tree"),
      sectionAction(sectionMenu.branchChanges, "Branch changes"),
      sectionAction(sectionMenu.latestTurn, "Latest turn"),
    ];

    if (sectionMenu.turns.length > 0) {
      actions.push({
        id: "turns",
        title: "Turn",
        subactions: sectionMenu.turns.map((section) => ({
          id: `section:${section.id}`,
          title: section.id === selectedSection?.id ? `${section.title} (selected)` : section.title,
          subtitle: section.subtitle ?? undefined,
        })),
      });
    }

    // The Android native diff surface has no pull-to-refresh, so refresh
    // stays a menu action there (iOS refreshes via pull-to-refresh instead).
    actions.push({
      id: "refresh",
      title: "Refresh current diff",
      attributes: {
        disabled: !selectedSection || selectedSection.isLoading,
      },
    });
    return actions;
  }, [sectionMenu, selectedSection]);
  const handleAndroidSectionMenuAction = useCallback(
    (event: { nativeEvent: { event: string } }) => {
      const id = event.nativeEvent.event;
      if (id === "refresh") {
        void refreshSelectedSection();
      } else if (id.startsWith("section:")) {
        selectSection(id.slice("section:".length));
      }
    },
    [refreshSelectedSection, selectSection],
  );
  const handleRetryEnvironment = useCallback(() => {
    void retryEnvironment(environmentId);
  }, [environmentId, retryEnvironment]);
  const handleReturnToThread = useCallback(() => {
    if (navigation.canGoBack()) {
      navigation.goBack();
      return;
    }
    navigation.navigate("Thread", {
      environmentId: String(environmentId),
      threadId: String(threadId),
    });
  }, [environmentId, navigation, threadId]);
  const androidHeaderSubtitle = [
    selectedSection?.title,
    headerDiffSummary.additions,
    headerDiffSummary.deletions,
  ]
    .filter((part): part is string => Boolean(part))
    .join(" · ");

  // The changed-files navigator drives the native diff surface via
  // scrollToFile, so it is only useful when that surface resolved. In raw
  // fallback mode the ref is necessarily null and the raw patch neither
  // scrolls nor filters — registering the navigator would present working
  // controls that cannot navigate.
  const showChangedFilesPane =
    !showConnectionNotice &&
    selectedSection !== null &&
    navigatorFiles.length > 0 &&
    (parsedDiff.kind !== "files" || NativeReviewDiffView !== null);
  useRegisterWorkspaceInspector(showChangedFilesPane ? renderInspector : undefined);
  // Raw fallback renders the patch inline with no inspector content, so the
  // pane toggle would open an empty column — hide it in exactly that case.
  const showChangedFilesToggle =
    panes.supportsAuxiliaryPane &&
    !(
      !showConnectionNotice &&
      selectedSection !== null &&
      parsedDiff.kind === "files" &&
      NativeReviewDiffView === null
    );

  const listHeader = useMemo(() => {
    const children: ReactElement[] = [];

    if (error) {
      children.push(
        <View key="review-error" className="border-b border-border bg-card px-4 py-3">
          <Text className="text-sm font-t3-bold text-foreground">Review unavailable</Text>
          <Text className="text-xs leading-normal text-foreground-muted">{error}</Text>
        </View>,
      );
    }

    if (gitFileLoadError) {
      children.push(
        <View key="review-file-error" className="border-b border-border bg-card px-4 py-3">
          <Text className="text-sm font-t3-bold text-foreground">File diff unavailable</Text>
          <Text className="text-xs leading-normal text-foreground-muted">{gitFileLoadError}</Text>
        </View>,
      );
    }

    if (parsedDiffNotice) {
      children.push(<ReviewNotice key="review-notice" notice={parsedDiffNotice} />);
    }

    if (children.length === 0) {
      return null;
    }

    return <>{children}</>;
  }, [error, gitFileLoadError, parsedDiffNotice]);
  const headerSubtitle = [
    headerDiffSummary.additions,
    headerDiffSummary.deletions,
    pendingReviewCommentCount > 0
      ? `${pendingReviewCommentCount} comment${pendingReviewCommentCount === 1 ? "" : "s"}`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const headerTitleText = selectedSection?.title ?? "Review changes";

  return (
    <>
      <NativeStackScreenOptions
        options={
          isAndroid
            ? // Android draws its own in-flow header (AndroidScreenHeader below).
              { headerShown: false }
            : {
                // Static header config lives in Stack.tsx (SOLID_HEADER_OPTIONS — the native
                // diff scrolls internally, nothing for glass to sample). Only dynamic values
                // here.
                headerTintColor: headerIcon,
                headerTitle: headerTitleText,
                title: headerTitleText,
                unstable_headerSubtitle:
                  Platform.OS === "ios" && headerSubtitle.length > 0 ? headerSubtitle : undefined,
              }
        }
      />

      {isAndroid ? (
        <AndroidScreenHeader
          title="Review changes"
          subtitle={androidHeaderSubtitle || "Select a diff"}
          onBack={handleReturnToThread}
          trailing={
            showSectionToolbar ? (
              <ControlPillMenu
                actions={androidSectionMenuActions}
                isAnchoredToRight
                onPressAction={handleAndroidSectionMenuAction}
              >
                <AndroidHeaderIconButton
                  accessibilityLabel="Select review diff"
                  icon="ellipsis.circle"
                />
              </ControlPillMenu>
            ) : null
          }
        />
      ) : null}

      <WorkspaceSidebarToolbar>
        <NativeHeaderToolbar.Button
          accessibilityLabel="Back to chat"
          icon="chevron.left"
          onPress={handleReturnToThread}
        />
      </WorkspaceSidebarToolbar>

      {!isAndroid && (showSectionToolbar || panes.supportsAuxiliaryPane || gitMenuAvailable) ? (
        <NativeHeaderToolbar placement="right">
          {showChangedFilesToggle ? (
            <NativeHeaderToolbar.Button
              accessibilityLabel={
                panes.auxiliaryPaneVisible ? "Hide changed files" : "Show changed files"
              }
              icon="sidebar.right"
              onPress={toggleAuxiliaryPane}
              separateBackground
            />
          ) : null}
          {gitMenuAvailable && selectedThread !== null ? (
            <ThreadGitMenu
              environmentId={environmentId}
              threadId={threadId}
              currentBranch={selectedThread.branch ?? null}
              gitStatus={gitStatusQuery.data}
              gitOperationLabel={gitState.gitOperationLabel}
              onPull={gitActions.onPullSelectedThreadBranch}
              onRunAction={gitActions.onRunSelectedThreadGitAction}
            />
          ) : null}
          {showSectionToolbar ? (
            <NativeHeaderToolbar.Menu icon="ellipsis" title="Select diff" separateBackground>
              <NativeHeaderToolbar.Menu inline>
                <NativeHeaderToolbar.MenuAction
                  disabled={sectionMenu.workingTree === null}
                  isOn={selectedSection?.id === sectionMenu.workingTree?.id}
                  onPress={() => {
                    if (sectionMenu.workingTree) {
                      selectSection(sectionMenu.workingTree.id);
                    }
                  }}
                >
                  <NativeHeaderToolbar.Label>Working tree</NativeHeaderToolbar.Label>
                </NativeHeaderToolbar.MenuAction>
                <NativeHeaderToolbar.MenuAction
                  disabled={sectionMenu.branchChanges === null}
                  isOn={selectedSection?.id === sectionMenu.branchChanges?.id}
                  onPress={() => {
                    if (sectionMenu.branchChanges) {
                      selectSection(sectionMenu.branchChanges.id);
                    }
                  }}
                >
                  <NativeHeaderToolbar.Label>Branch changes</NativeHeaderToolbar.Label>
                </NativeHeaderToolbar.MenuAction>
                <NativeHeaderToolbar.MenuAction
                  disabled={sectionMenu.latestTurn === null}
                  isOn={selectedSection?.id === sectionMenu.latestTurn?.id}
                  onPress={() => {
                    if (sectionMenu.latestTurn) {
                      selectSection(sectionMenu.latestTurn.id);
                    }
                  }}
                >
                  <NativeHeaderToolbar.Label>Latest turn</NativeHeaderToolbar.Label>
                </NativeHeaderToolbar.MenuAction>
                {sectionMenu.turns.length > 0 ? (
                  <NativeHeaderToolbar.Menu title="Turn">
                    {sectionMenu.turns.map((section) => (
                      <NativeHeaderToolbar.MenuAction
                        key={section.id}
                        isOn={section.id === selectedSection?.id}
                        onPress={() => selectSection(section.id)}
                        subtitle={section.subtitle ?? undefined}
                      >
                        <NativeHeaderToolbar.Label>{section.title}</NativeHeaderToolbar.Label>
                      </NativeHeaderToolbar.MenuAction>
                    ))}
                  </NativeHeaderToolbar.Menu>
                ) : null}
              </NativeHeaderToolbar.Menu>
            </NativeHeaderToolbar.Menu>
          ) : null}
        </NativeHeaderToolbar>
      ) : null}

      <View className="flex-1 bg-sheet">
        {showConnectionNotice ? (
          <View className="flex-1" style={{ paddingTop: topContentInset }}>
            <EnvironmentConnectionNotice
              environmentLabel={environment.presentation?.entry.target.label ?? "Environment"}
              connection={
                environment.presentation?.connection ?? {
                  phase: "available",
                  error: null,
                  traceId: null,
                }
              }
              resourceName="review"
              onRetry={handleRetryEnvironment}
            />
          </View>
        ) : selectedSection && parsedDiff.kind === "files" && NativeReviewDiffView ? (
          <View
            className="flex-1"
            style={{
              backgroundColor: nativeBridge.theme.background,
            }}
          >
            <View
              className="min-w-0 flex-1"
              style={{ paddingTop: topContentInset + REVIEW_HEADER_SPACING }}
            >
              {listHeader}
              <View className="min-w-0 flex-1" collapsable={false}>
                <NativeReviewDiffView
                  collapsable={false}
                  testID="review-native-diff-view"
                  refreshing={isPullRefreshing}
                  onPullToRefresh={() => void handlePullToRefresh()}
                  style={StyleSheet.absoluteFill}
                  appearanceScheme={selectedTheme}
                  collapsedFileIdsJson={nativeBridge.collapsedFileIdsJson}
                  collapsedCommentIdsJson={nativeBridge.collapsedCommentIdsJson}
                  contentResetKey={`${reviewCache.threadKey}:${selectedSection.id}`}
                  contentWidth={NATIVE_REVIEW_DIFF_CONTENT_WIDTH}
                  nativeViewRef={nativeReviewDiffViewRef}
                  rowHeight={nativeReviewDiffStyle.rowHeight}
                  rowsJson={nativeBridge.rowsJson}
                  selectedRowIdsJson={nativeBridge.selectedRowIdsJson}
                  styleJson={nativeBridge.styleJson}
                  themeJson={nativeBridge.themeJson}
                  tokensPatchJson={nativeBridge.tokensPatchJson}
                  tokensResetKey={nativeBridge.tokensResetKey}
                  viewedFileIdsJson={nativeBridge.viewedFileIdsJson}
                  onDebug={handleNativeDebug}
                  onPressLine={commentSelection.onPressLine}
                  onVisibleFileChange={handleVisibleFileChange}
                  onToggleComment={nativeBridge.onToggleComment}
                  onToggleFile={handleNativeToggleFile}
                  onToggleViewedFile={handleNativeToggleViewedFile}
                />
              </View>
            </View>
          </View>
        ) : (
          <ScrollView
            contentInsetAdjustmentBehavior="never"
            contentInset={{ top: topContentInset, bottom: Math.max(insets.bottom, 18) + 18 }}
            contentOffset={{ x: 0, y: -topContentInset }}
            scrollIndicatorInsets={{
              top: topContentInset,
              bottom: Math.max(insets.bottom, 18) + 18,
            }}
            showsVerticalScrollIndicator={false}
            className="flex-1"
            refreshControl={
              // The native diff surface owns pull-to-refresh via onPullToRefresh;
              // the raw fallback (and empty states) need an explicit control —
              // iOS has no other refresh affordance here (the explicit
              // "Refresh current diff" menu is Android-only).
              <RefreshControl
                refreshing={isPullRefreshing}
                onRefresh={() => void handlePullToRefresh()}
              />
            }
          >
            {listHeader}
            {!selectedSection ? (
              <View className="border-b border-border bg-card px-4 py-5">
                <Text className="text-sm font-t3-bold text-foreground">No review diffs</Text>
                <Text className="text-xs leading-normal text-foreground-muted">
                  This thread has no ready turn diffs and the worktree diff is empty.
                </Text>
              </View>
            ) : selectedSection.isLoading && selectedSection.diff === null ? (
              <View className="items-center gap-3 border-b border-border bg-card px-4 py-6">
                <ActivityIndicator size="small" />
                <Text className="text-xs text-foreground-muted">Loading diff…</Text>
              </View>
            ) : parsedDiff.kind === "empty" ? (
              <View className="border-b border-border bg-card px-4 py-5">
                <Text className="text-sm font-t3-bold text-foreground">
                  {navigatorFiles.length > 0 ? "File previews not loaded" : "No changes"}
                </Text>
                <Text className="text-xs leading-normal text-foreground-muted">
                  {navigatorFiles.length > 0
                    ? "Open Changed files and select a file to load its diff."
                    : (selectedSection.subtitle ?? "This diff is empty.")}
                </Text>
              </View>
            ) : parsedDiff.kind === "raw" ? (
              <View className="gap-3 border-b border-border bg-card px-4 py-4">
                <Text className="text-xs leading-normal text-foreground-muted">
                  {parsedDiff.reason}
                </Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} bounces={false}>
                  <Text selectable className="font-mono text-xs leading-relaxed text-foreground">
                    {parsedDiff.text}
                  </Text>
                </ScrollView>
              </View>
            ) : parsedDiff.kind === "files" ? (
              // The native diff surface could not be resolved on this binary;
              // degrade to the raw patch instead of crashing the app.
              <View className="gap-3 border-b border-border bg-card px-4 py-4">
                <Text className="text-xs leading-normal text-foreground-muted">
                  Native diff view unavailable. Showing the raw patch.
                </Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} bounces={false}>
                  <Text selectable className="font-mono text-xs leading-relaxed text-foreground">
                    {selectedSection?.diff ?? ""}
                  </Text>
                </ScrollView>
              </View>
            ) : null}
          </ScrollView>
        )}
        <ReviewSelectionActionBar
          bottomInset={insets.bottom}
          title={commentSelection.selectionAction?.title ?? null}
          onOpenComment={commentSelection.selectionAction?.onOpenComment ?? null}
          onClear={commentSelection.clearSelection}
        />
      </View>
    </>
  );
}
