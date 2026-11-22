import {
  isAngelScriptPath,
  angelScriptLineSemantics,
  colorAngelScriptTokens,
  angelScriptColors,
  type AngelScriptSemanticToken,
} from "@t3tools/shared/angelscript";
import { useAngelScript, type AngelScriptWorkspace } from "../../lib/useAngelScript";
import { LegendList, type LegendListRef } from "@legendapp/list/react-native";
import { T, useGT } from "gt-react-native";
import { settlePromise } from "@t3tools/client-runtime/state/runtime";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import type { ComponentType } from "react";
import { useLayoutEffect, useRef, useState } from "react";
import {
  Platform,
  Pressable,
  ScrollView,
  Text as NativeText,
  useWindowDimensions,
  View,
} from "react-native";
import { NativeScrollView } from "../../native/NativeScrollViewMarker";
import { RefreshControl } from "../../components/ui/RefreshControl";
import { WebView } from "react-native-webview";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppText as Text } from "../../components/ui/AppText";
import { LoadingStrip } from "../../components/ui/LoadingStrip";
import { useNativeColumnLayoutMetrics } from "../../native/native-layout-metrics";
import {
  type NativeReviewDiffViewProps,
  resolveNativeReviewDiffView,
} from "../diffs/nativeReviewDiffSurface";
import { createNativeReviewDiffTheme } from "../review/nativeReviewDiffAdapter";
import { REVIEW_MONO_FONT_FAMILY, renderVisibleWhitespace } from "../review/reviewDiffRendering";
import type { HighlightedToken } from "../../lib/highlights";
import { cn } from "../../lib/cn";
import type { ResolvedMobileCodeSurface } from "../../lib/appearancePreferences";
import { useAppearanceCodeSurface } from "../settings/appearance/useAppearanceCodeSurface";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import {
  buildNativeSourceTokens,
  buildNativeSourceRows,
  NATIVE_SOURCE_CONTENT_WIDTH,
  nativeSourceRowId,
} from "./nativeSourceFileAdapter";
import { SourceText } from "@t3tools/mobile-source-text";

import type { ThreadId } from "@t3tools/contracts";
import {
  expandedColumnToOffset,
  lineNavigationTargets,
  offsetToExpandedColumn,
  splitTokensAtRanges,
  type LineRange,
} from "../code-navigation/sourceColumns";
import {
  useSourceCodeNavigation,
  type SymbolHighlight,
} from "../code-navigation/useSourceCodeNavigation";

import {
  boundedSelectableSourceTokens,
  prepareSourceFileDocument,
  selectableSourceHtml,
} from "./source-file-document";
import { sourceHighlightAtom } from "./sourceHighlightingState";

interface SourceFileSurfaceProps {
  readonly workspace?: AngelScriptWorkspace;
  /** Enables line comments; go to definition only needs the workspace. */
  readonly threadId?: ThreadId | null;
  readonly contents: string;
  readonly path: string;
  readonly embedded?: boolean;
  readonly initialLine?: number | null;
  readonly headerInsetTop?: number;
  readonly selectable?: boolean;
  readonly onLongPressLine?: (line: number) => void;
  readonly onRefresh?: () => Promise<void> | void;
}

type SourceHighlightStatus = "highlighting" | "ready" | "error";

const HighlightedSourceLine = function HighlightedSourceLine(props: {
  readonly codeSurface: ResolvedMobileCodeSurface;
  readonly index: number;
  readonly line: string;
  readonly tokens: ReadonlyArray<HighlightedToken> | null;
  readonly highlighted: boolean;
  readonly wordBreak: boolean;
  readonly onLongPress?: () => void;
  readonly awaitBackground?: string | undefined;
  /** Followable symbols on this line; long-pressing one calls onLongPressSymbol. */
  readonly symbols?: ReadonlyArray<LineRange> | undefined;
  readonly symbolHighlight?: LineRange | null;
  readonly symbolHighlightColor?: string;
  readonly onLongPressSymbol?: ((index: number, offset: number) => void) | undefined;
  readonly onLongPressLineNumber?: ((index: number) => void) | undefined;
}) {
  const gt = useGT();
  const { index, onLongPressSymbol } = props;
  const selectable = props.onLongPress === undefined;
  const row = (
    <View
      className={cn("flex-row", props.highlighted && "bg-primary/10")}
      style={{ minHeight: props.codeSurface.rowHeight, backgroundColor: props.awaitBackground }}
    >
      <NativeText
        onLongPress={
          props.onLongPressLineNumber ? () => props.onLongPressLineNumber?.(index) : undefined
        }
        className="select-none pr-3 text-right text-foreground-tertiary"
        style={{
          width: props.codeSurface.gutterWidth,
          fontFamily: REVIEW_MONO_FONT_FAMILY,
          fontSize: props.codeSurface.lineNumberFontSize,
          lineHeight: props.codeSurface.rowHeight,
        }}
      >
        {props.index + 1}
      </NativeText>
      <NativeText
        selectable={selectable}
        selectionColorClassName={Platform.OS === "android" ? "accent-focus/32" : undefined}
        numberOfLines={props.wordBreak ? undefined : 1}
        className="flex-1 font-normal text-foreground"
        style={{
          fontFamily: REVIEW_MONO_FONT_FAMILY,
          fontSize: props.codeSurface.fontSize,
          lineHeight: props.codeSurface.rowHeight,
          minWidth: props.wordBreak ? undefined : 320,
        }}
      >
        {props.symbols && onLongPressSymbol
          ? splitTokensAtRanges(
              props.tokens && props.tokens.length > 0
                ? props.tokens
                : [{ content: props.line, color: null, fontStyle: null }],
              props.symbols,
            ).map(({ token, start, range }) => {
              const fontWeight =
                token.fontStyle !== null && (token.fontStyle & 2) === 2 ? "700" : "400";
              const fontStyle =
                token.fontStyle !== null && (token.fontStyle & 1) === 1 ? "italic" : "normal";
              const highlighted =
                range !== null &&
                props.symbolHighlight?.start === range.start &&
                props.symbolHighlight.end === range.end;
              // Symbols take the long press, so they are not text-selectable; the rest is.
              return (
                <NativeText
                  key={`${start}:${token.content.length}`}
                  selectable={selectable && range === null}
                  suppressHighlighting
                  onLongPress={range ? () => onLongPressSymbol(index, range.start) : undefined}
                  style={{
                    color: token.color ?? undefined,
                    fontFamily: REVIEW_MONO_FONT_FAMILY,
                    fontWeight,
                    fontStyle,
                    backgroundColor: highlighted ? props.symbolHighlightColor : undefined,
                  }}
                >
                  {token.content.length > 0 ? renderVisibleWhitespace(token.content) : " "}
                </NativeText>
              );
            })
          : props.tokens && props.tokens.length > 0
            ? (() => {
                let offset = 0;
                return props.tokens.map((token) => {
                  const start = offset;
                  offset += token.content.length;

                  const fontWeight =
                    token.fontStyle !== null && (token.fontStyle & 2) === 2
                      ? ("700" as const)
                      : ("400" as const);
                  const fontStyle =
                    token.fontStyle !== null && (token.fontStyle & 1) === 1
                      ? ("italic" as const)
                      : ("normal" as const);

                  return (
                    <NativeText
                      key={`${start}:${token.content.length}:${token.color ?? ""}`}
                      selectable={selectable}
                      selectionColorClassName={
                        Platform.OS === "android" ? "accent-focus/32" : undefined
                      }
                      style={{
                        color: token.color ?? undefined,
                        fontFamily: REVIEW_MONO_FONT_FAMILY,
                        fontWeight,
                        fontStyle,
                      }}
                    >
                      {token.content.length > 0 ? renderVisibleWhitespace(token.content) : " "}
                    </NativeText>
                  );
                });
              })()
            : renderVisibleWhitespace(props.line || " ")}
      </NativeText>
    </View>
  );
  const onLongPress = props.onLongPress;
  return onLongPress ? (
    <Pressable
      onLongPress={onLongPress}
      accessibilityActions={[{ name: "longpress", label: gt("Select text") }]}
      onAccessibilityAction={(event) => {
        if (event.nativeEvent.actionName === "longpress") onLongPress();
      }}
    >
      {row}
    </Pressable>
  ) : (
    row
  );
};

function useSourceFileModel(props: SourceFileSurfaceProps) {
  const { themeAppearance: theme } = useAppearancePreferences();
  const document = prepareSourceFileDocument(props.contents);
  const { contents: normalizedContents, lines } = document;
  // AngelScript tokenizes with the C++ lexer (resolveHighlightLanguage); its semantic colours,
  // from the workspace's ScriptingAPI.as, are laid over those tokens.
  const api = useAngelScript(isAngelScriptPath(props.path) ? props.workspace : undefined);
  const semantics = api
    ? angelScriptLineSemantics(normalizedContents, api)
    : new Map<number, AngelScriptSemanticToken[]>();
  const awaitLines = new Set(
    [...semantics]
      .filter(([, tokens]) => tokens.some((token) => token.kind === "await"))
      .map(([line]) => line),
  );
  const rowsJson = api
    ? JSON.stringify(
        buildNativeSourceRows(lines).map((row, index) =>
          awaitLines.has(index + 1)
            ? { ...row, awaitBackground: angelScriptColors[theme].background }
            : row,
        ),
      )
    : document.rowsJson;
  const targetIndex =
    props.initialLine !== null && props.initialLine !== undefined && props.initialLine > 0
      ? Math.min(Math.floor(props.initialLine) - 1, Math.max(0, lines.length - 1))
      : null;
  const highlightAtom = sourceHighlightAtom({
    path: props.path,
    contents: normalizedContents,
    theme,
  });
  const highlightResult = useAtomValue(highlightAtom);
  const rawTokens = AsyncResult.isSuccess(highlightResult) ? highlightResult.value : null;
  const tokens =
    rawTokens && semantics.size > 0
      ? rawTokens.map((line, index) =>
          colorAngelScriptTokens(line, semantics.get(index + 1) ?? [], theme),
        )
      : rawTokens;
  const status: SourceHighlightStatus = AsyncResult.isFailure(highlightResult)
    ? "error"
    : AsyncResult.isSuccess(highlightResult)
      ? "ready"
      : "highlighting";

  return {
    api,
    awaitLines,
    normalizedContents,
    lines,
    rowsJson,
    status,
    targetIndex,
    theme,
    tokens,
  };
}

function SourceHighlightStatusView(props: { readonly status: SourceHighlightStatus }) {
  if (props.status === "highlighting") {
    return <LoadingStrip />;
  }
  if (props.status === "error") {
    return (
      <View className="border-b border-border bg-card px-4 py-2">
        <Text className="text-2xs font-t3-medium uppercase text-foreground-muted">
          <T>Plain text</T>
        </Text>
      </View>
    );
  }
  return null;
}

function useSourceFileRefresh(onRefresh: SourceFileSurfaceProps["onRefresh"]) {
  const [isPullRefreshing, setIsPullRefreshing] = useState(false);
  const handlePullToRefresh = async () => {
    if (!onRefresh) {
      return;
    }
    setIsPullRefreshing(true);
    // RefreshControl only needs the spinner cleared; the caller surfaces its own errors.
    await settlePromise(async () => onRefresh());
    setIsPullRefreshing(false);
  };
  return { isPullRefreshing, handlePullToRefresh };
}

function NativeSourceFileSurface(
  props: SourceFileSurfaceProps & {
    readonly NativeView: ComponentType<NativeReviewDiffViewProps>;
  },
) {
  const { NativeView, onLongPressLine, onRefresh } = props;
  const insets = useSafeAreaInsets();
  const columnMetrics = useNativeColumnLayoutMetrics();
  const safeArea = columnMetrics?.safeArea ?? insets;
  const { codeSurface, codeWordBreak, nativeSourceStyle } = useAppearanceCodeSurface();
  const { themeAppearance, themeId } = useAppearancePreferences();
  const appTheme = useUniwindTheme();
  const { width: viewportWidth } = useWindowDimensions();
  const { api, lines, normalizedContents, rowsJson, status, targetIndex, tokens } =
    useSourceFileModel(props);
  const codeNavigation = useSourceCodeNavigation({
    workspace: props.workspace,
    threadId: props.threadId,
    path: props.path,
    contents: normalizedContents,
    lines,
    api,
  });
  const {
    commentsEnabled,
    highlight: symbolHighlight,
    pressLineNumber,
    pressSymbol,
  } = codeNavigation;
  const symbolHighlightJson = nativeSymbolHighlightJson(symbolHighlight, lines);
  const { isPullRefreshing, handlePullToRefresh } = useSourceFileRefresh(onRefresh);
  const tokensJson = JSON.stringify(buildNativeSourceTokens(tokens));
  const selectedRowIdsJson = JSON.stringify(
    targetIndex === null ? [] : [nativeSourceRowId(targetIndex)],
  );
  const themeJson = JSON.stringify(createNativeReviewDiffTheme(themeAppearance, themeId, appTheme));
  const styleJson = JSON.stringify(nativeSourceStyle);
  const contentWidth = codeWordBreak
    ? Math.max(240, viewportWidth - codeSurface.gutterWidth - 24)
    : NATIVE_SOURCE_CONTENT_WIDTH;

  return (
    <View className="relative flex-1 bg-sheet">
      <SourceHighlightStatusView status={status} />
      <NativeView
        collapsable={false}
        testID="source-native-code-view"
        style={{ flex: 1 }}
        appearanceScheme={themeAppearance}
        contentResetKey={props.path}
        contentWidth={contentWidth}
        contentInsetTop={props.embedded ? 0 : (props.headerInsetTop ?? safeArea.top)}
        contentInsetBottom={props.embedded ? 0 : safeArea.bottom + 8}
        initialRowIndex={targetIndex ?? -1}
        rowHeight={nativeSourceStyle.rowHeight ?? codeSurface.rowHeight}
        rowsJson={rowsJson}
        selectedRowIdsJson={selectedRowIdsJson}
        styleJson={styleJson}
        themeJson={themeJson}
        tokensJson={tokensJson}
        symbolHighlightJson={symbolHighlightJson}
        onPressLine={({ nativeEvent }) => {
          if (nativeEvent.gesture !== "longPress") return;
          // A line number opens a line comment and a symbol its definition; any other long
          // press keeps upstream's behaviour.
          const { region, column, rowId } = nativeEvent;
          const index = rowId?.startsWith("source-line:") ? Number(rowId.slice(12)) : NaN;
          if (Number.isInteger(index)) {
            if (region === "gutter" && commentsEnabled) {
              pressLineNumber(index);
              return;
            }
            if (
              region === "code" &&
              column !== undefined &&
              pressSymbol(index, expandedColumnToOffset(lines[index] ?? "", column))
            )
              return;
          }
          if (nativeEvent.newLineNumber !== undefined) {
            onLongPressLine?.(nativeEvent.newLineNumber);
          }
        }}
        {...(onRefresh
          ? {
              refreshing: isPullRefreshing,
              onPullToRefresh: () => void handlePullToRefresh(),
            }
          : {})}
      />
      {codeNavigation.overlay}
    </View>
  );
}

function nativeSymbolHighlightJson(
  highlight: SymbolHighlight | null,
  lines: ReadonlyArray<string>,
): string {
  const line = highlight ? lines[highlight.lineIndex] : undefined;
  if (!highlight || line === undefined) return "";
  return JSON.stringify({
    rowId: nativeSourceRowId(highlight.lineIndex),
    start: offsetToExpandedColumn(line, highlight.start),
    end: offsetToExpandedColumn(line, highlight.end),
  });
}

function JavaScriptSourceFileSurface(props: SourceFileSurfaceProps) {
  const usesAutomaticInsets = Platform.OS === "ios" && !props.embedded;
  const appTheme = useUniwindTheme();
  const foreground = appTheme["--color-foreground"];
  const { codeSurface, codeWordBreak } = useAppearanceCodeSurface();
  const { api, normalizedContents, lines, status, targetIndex, tokens, awaitLines, theme } =
    useSourceFileModel(props);
  // Attachments (one selectable text) have no workspace to navigate or comment in.
  const codeNavigation = useSourceCodeNavigation({
    workspace: props.selectable ? undefined : props.workspace,
    threadId: props.selectable ? null : props.threadId,
    path: props.path,
    contents: normalizedContents,
    lines,
    api,
  });
  const { definitionsEnabled, commentsEnabled, highlight, pressLineNumber, pressSymbol } =
    codeNavigation;
  const symbolsByLine = definitionsEnabled
    ? lineNavigationTargets(props.path, normalizedContents)
    : null;
  const symbolHighlightColor = appTheme["--color-subtle-strong"];
  const selectableTokens = props.selectable ? boundedSelectableSourceTokens(tokens) : null;
  const listRef = useRef<LegendListRef>(null);
  const { isPullRefreshing, handlePullToRefresh } = useSourceFileRefresh(props.onRefresh);
  const refreshControl = props.onRefresh ? (
    <RefreshControl refreshing={isPullRefreshing} onRefresh={() => void handlePullToRefresh()} />
  ) : undefined;

  const usesLineList = !props.selectable;
  // Android lays out a full selectable TextView on the UI thread, which can stall large files.
  const usesWebSelection = props.selectable === true && Platform.OS === "android";
  const usesTextSelection = props.selectable === true && !usesWebSelection;

  // Layout effect so a pending jump is cancelled in the commit that swaps the file.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- scrolls the list to the target line and cancels a pending jump when the file changes
  useLayoutEffect(() => {
    if (targetIndex === null || !usesLineList) {
      return;
    }
    const frame = requestAnimationFrame(() => {
      void listRef.current?.scrollToIndex({
        index: targetIndex,
        animated: false,
        viewPosition: 0.3,
      });
    });
    return () => cancelAnimationFrame(frame);
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Opening another file at the same line index, or leaving selection mode, scrolls the remounted list to it.
  }, [props.path, targetIndex, usesLineList]);

  const { onLongPressLine } = props;
  const renderLine = ({ item, index }: { item: string; index: number }) => (
    <HighlightedSourceLine
      codeSurface={codeSurface}
      index={index}
      line={item}
      tokens={tokens?.[index] ?? null}
      highlighted={index === targetIndex}
      wordBreak={codeWordBreak}
      onLongPress={onLongPressLine ? () => onLongPressLine(index + 1) : undefined}
      awaitBackground={
        // Half strength like desktop and the native canvas, which tint this row at 50% alpha.
        awaitLines.has(index + 1) ? `${angelScriptColors[theme].background}80` : undefined
      }
      symbols={symbolsByLine?.get(index)}
      symbolHighlight={highlight?.lineIndex === index ? highlight : null}
      symbolHighlightColor={symbolHighlightColor}
      onLongPressSymbol={
        symbolsByLine ? (line, offset) => void pressSymbol(line, offset) : undefined
      }
      onLongPressLineNumber={commentsEnabled ? pressLineNumber : undefined}
    />
  );

  // One native text view permits document-wide selection; virtualized rows cannot.
  const selectableBlock = usesTextSelection ? (
    <SourceText
      selectable
      style={{
        color: foreground,
        fontFamily: REVIEW_MONO_FONT_FAMILY,
        fontSize: codeSurface.fontSize,
        lineHeight: codeSurface.rowHeight,
      }}
    >
      {selectableTokens
        ? lines.map(
            (
              line,
              index,
            ) => /* oxlint-disable react/no-array-index-key -- Source lines and highlight tokens are stateless positions within the loaded file. */ {
                const lineTokens = selectableTokens[index] ?? null;
                const body =
                  lineTokens && lineTokens.length > 0
                    ? lineTokens.map((token, tokenIndex) => (
                        <SourceText
                          key={`${index}:${tokenIndex}`}
                          style={{
                            color: token.color ?? foreground,
                            fontWeight:
                              token.fontStyle !== null && (token.fontStyle & 2) === 2
                                ? "700"
                                : "400",
                            fontStyle:
                              token.fontStyle !== null && (token.fontStyle & 1) === 1
                                ? "italic"
                                : "normal",
                          }}
                        >
                          {token.content}
                        </SourceText>
                      ))
                    : line;
                return (
                  <SourceText key={index}>
                    {body}
                    {index < lines.length - 1 ? "\n" : ""}
                  </SourceText>
                );
              } /* oxlint-enable react/no-array-index-key */,
          )
        : normalizedContents}
    </SourceText>
  ) : null;

  const webSelection = usesWebSelection ? (
    <WebView
      source={{
        html: selectableSourceHtml(normalizedContents, {
          foreground,
          selection: appTheme["--color-focus"],
          fontSize: codeSurface.fontSize,
          rowHeight: codeSurface.rowHeight,
          wordBreak: codeWordBreak,
        }),
      }}
      originWhitelist={["*"]}
      // Android pastes copied HTML as styled text with collapsed whitespace, so copy plain text.
      // Wrapped text reflows once the WebView reaches its final width, so scroll again then.
      injectedJavaScript={`addEventListener("copy",(event)=>{event.clipboardData.setData("text/plain",getSelection().toString());event.preventDefault();});${
        targetIndex === null
          ? ""
          : `const line=document.getElementById("L${targetIndex + 1}");const reveal=()=>line?.scrollIntoView({block:"center"});reveal();addEventListener("resize",reveal,{once:true});`
      }true;`}
      domStorageEnabled={false}
      cacheEnabled={false}
      setSupportMultipleWindows={false}
      onShouldStartLoadWithRequest={(request) => request.url === "about:blank"}
      style={{ flex: 1, backgroundColor: "transparent" }}
    />
  ) : null;

  const list = (
    <LegendList
      ref={listRef}
      // An embedded viewer sits inside another screen's scroll surface.
      renderScrollComponent={props.embedded ? undefined : NativeScrollView}
      contentInsetAdjustmentBehavior={usesAutomaticInsets ? "automatic" : "never"}
      automaticallyAdjustsScrollIndicatorInsets={usesAutomaticInsets}
      refreshControl={refreshControl}
      data={lines}
      keyExtractor={(_line, index) => String(index)}
      extraData={{
        tokens,
        targetIndex,
        codeSurface,
        codeWordBreak,
        onLongPressLine,
        highlight,
        symbolsByLine,
        commentsEnabled,
      }}
      estimatedItemSize={codeSurface.rowHeight}
      getFixedItemSize={codeWordBreak ? undefined : () => codeSurface.rowHeight}
      drawDistance={codeSurface.rowHeight * 40}
      recycleItems
      contentContainerStyle={{
        minWidth: codeWordBreak ? undefined : "100%",
        paddingBottom: codeSurface.rowHeight,
        paddingTop: 8,
      }}
      renderItem={renderLine}
    />
  );

  const padded = (
    <ScrollView
      refreshControl={refreshControl}
      className="flex-1"
      contentInsetAdjustmentBehavior={usesAutomaticInsets ? "automatic" : "never"}
      automaticallyAdjustsScrollIndicatorInsets={usesAutomaticInsets}
      contentContainerStyle={{
        paddingBottom: codeSurface.rowHeight,
        paddingHorizontal: 12,
        paddingTop: 8,
      }}
    >
      {selectableBlock}
    </ScrollView>
  );

  return (
    <View className="relative flex-1 bg-sheet">
      {usesWebSelection ? null : <SourceHighlightStatusView status={status} />}
      {usesLineList ? (
        codeWordBreak ? (
          list
        ) : (
          <ScrollView horizontal bounces={false} className="flex-1">
            {list}
          </ScrollView>
        )
      ) : usesWebSelection ? (
        webSelection
      ) : codeWordBreak ? (
        padded
      ) : (
        <ScrollView horizontal bounces={false} className="flex-1">
          {padded}
        </ScrollView>
      )}
      {codeNavigation.overlay}
    </View>
  );
}

export function SourceFileSurface(props: SourceFileSurfaceProps) {
  const NativeView = resolveNativeReviewDiffView();
  const { codeWordBreak } = useAppearanceCodeSurface();
  const surface =
    NativeView && !codeWordBreak && !props.selectable ? (
      <NativeSourceFileSurface {...props} NativeView={NativeView} />
    ) : (
      <JavaScriptSourceFileSurface {...props} />
    );
  return surface;
}
