import { StackActions, useNavigation } from "@react-navigation/native";
import type { ThreadId } from "@t3tools/contracts";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import {
  resolveDefinitions,
  supportsDefinitionNavigation,
  type Definition,
} from "@t3tools/client-runtime/definition-navigation";
import type { AngelScriptApi } from "@t3tools/shared/angelscript";
import { navigationTargetAt } from "@t3tools/shared/angelscriptNavigation";
import * as Haptics from "expo-haptics";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Modal, Pressable, ScrollView, View } from "react-native";

import { AppText } from "../../components/AppText";
import type { AngelScriptWorkspace } from "../../lib/useAngelScript";
import { projectEnvironment } from "../../state/projects";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import { setReviewCommentTarget } from "../review/reviewCommentSelection";
import { fileLineCommentTarget } from "./fileLineComment";
import { projectContentSearch } from "./projectContentSearch";

/** The pressed symbol, as offsets into its zero-based line, tinted briefly. */
export interface SymbolHighlight {
  readonly lineIndex: number;
  readonly start: number;
  readonly end: number;
}

const HIGHLIGHT_MS = 700;
const success = <A, E>(result: AtomCommandResult<A, E>) =>
  result._tag === "Success" ? result.value : null;
const NOTICE_MS = 1_600;

/**
 * Long-press actions of a workspace source file: a symbol goes to its definition (resolved like
 * desktop, over the environment's file reads), a line number opens a line comment for the thread.
 */
export function useSourceCodeNavigation(input: {
  readonly workspace: AngelScriptWorkspace | undefined;
  readonly threadId: ThreadId | null | undefined;
  readonly path: string;
  readonly contents: string;
  readonly lines: ReadonlyArray<string>;
  readonly api: AngelScriptApi | null;
}) {
  const { workspace, threadId, path, contents, lines, api } = input;
  const navigation = useNavigation();
  const environmentId = workspace?.environmentId;
  const cwd = workspace?.cwd;
  const definitionsEnabled =
    environmentId !== undefined &&
    cwd !== undefined &&
    supportsDefinitionNavigation({ path, contents }, api);
  const commentsEnabled = environmentId !== undefined && !!threadId;
  const [highlight, setHighlight] = useState<SymbolHighlight | null>(null);
  const [choices, setChoices] = useState<ReadonlyArray<Definition> | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const request = useRef(0);
  const read = useAtomQueryRunner(projectEnvironment.readFile, {
    refresh: true,
    reportFailure: false,
  });
  const search = useAtomQueryRunner(projectContentSearch, { refresh: true, reportFailure: false });
  const findFiles = useAtomQueryRunner(projectEnvironment.searchEntries, {
    refresh: true,
    reportFailure: false,
  });
  const lineStarts = useMemo(() => {
    const starts = [0];
    for (const line of lines) starts.push(starts.at(-1)! + line.length + 1);
    return starts;
  }, [lines]);

  // A pending lookup must not navigate once the file changed or the screen went away.
  const shown = useRef({ path, contents });
  useEffect(() => {
    shown.current = { path, contents };
  }, [path, contents]);
  useEffect(
    () => () => {
      request.current++;
    },
    [],
  );
  useEffect(() => {
    if (!highlight) return;
    const timer = setTimeout(() => setHighlight(null), HIGHLIGHT_MS);
    return () => clearTimeout(timer);
  }, [highlight]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice]);

  const openDefinition = useCallback(
    (definition: Definition) => {
      if (environmentId === undefined || cwd === undefined) return;
      const segments = definition.path.split("/").filter(Boolean);
      const line = String(definition.line);
      // Pushed, so the back gesture or button returns to the symbol.
      navigation.dispatch(
        threadId
          ? StackActions.push("ThreadFile", {
              environmentId: String(environmentId),
              threadId: String(threadId),
              path: segments,
              line,
            })
          : StackActions.push("NewTaskFile", {
              environmentId: String(environmentId),
              cwd,
              path: segments,
              line,
            }),
      );
    },
    [cwd, environmentId, navigation, threadId],
  );

  /** Returns false when nothing followable is at that offset, so the press stays unhandled. */
  const pressSymbol = useCallback(
    (lineIndex: number, offset: number): boolean => {
      if (!definitionsEnabled || environmentId === undefined || cwd === undefined) return false;
      const lineStart = lineStarts[lineIndex];
      if (lineStart === undefined) return false;
      const source = { path, contents };
      const target = navigationTargetAt(source, lineStart + offset);
      if (!target) return false;
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      const targetLineStart = lineStarts[target.line - 1] ?? 0;
      setHighlight({
        lineIndex: target.line - 1,
        start: target.start - targetLineStart,
        end: target.end - targetLineStart,
      });
      const current = ++request.current;
      void resolveDefinitions({
        source,
        offset: target.start,
        api,
        read: async (relativePath) =>
          success(await read({ environmentId, input: { cwd, relativePath } })),
        search: async (query) =>
          success(
            await search({
              environmentId,
              input: {
                cwd,
                query,
                limit: 500,
                caseSensitive: true,
                wholeWord: false,
                useRegex: true,
              },
            }),
          ),
        findFiles: async (exactFileName) =>
          success(
            await findFiles({
              environmentId,
              input: { cwd, query: exactFileName, exactFileName, kind: "file", limit: 200 },
            }),
          ),
      })
        .then((definitions) => {
          if (
            current !== request.current ||
            shown.current.path !== path ||
            shown.current.contents !== contents
          )
            return;
          if (definitions.length === 1) openDefinition(definitions[0]!);
          else if (definitions.length > 1) setChoices(definitions);
          else {
            void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
            setNotice("No definition found");
          }
        })
        .catch(() => {
          if (current === request.current) setNotice("Unable to open definition");
        });
      return true;
    },
    [
      api,
      contents,
      cwd,
      definitionsEnabled,
      environmentId,
      findFiles,
      lineStarts,
      openDefinition,
      path,
      read,
      search,
    ],
  );

  const pressLineNumber = useCallback(
    (lineIndex: number) => {
      if (!commentsEnabled || !threadId || environmentId === undefined) return;
      if (lineIndex < 0 || lineIndex >= lines.length) return;
      void Haptics.selectionAsync();
      setReviewCommentTarget(fileLineCommentTarget(path, lines, lineIndex));
      navigation.navigate("ThreadReviewComment", { environmentId, threadId });
    },
    [commentsEnabled, environmentId, lines, navigation, path, threadId],
  );

  const overlay = (
    <CodeNavigationOverlay
      choices={choices}
      notice={notice}
      onChoose={(definition) => {
        setChoices(null);
        openDefinition(definition);
      }}
      onDismiss={() => setChoices(null)}
    />
  );

  return {
    definitionsEnabled,
    commentsEnabled,
    highlight,
    pressSymbol,
    pressLineNumber,
    overlay,
  };
}

function CodeNavigationOverlay(props: {
  readonly choices: ReadonlyArray<Definition> | null;
  readonly notice: string | null;
  readonly onChoose: (definition: Definition) => void;
  readonly onDismiss: () => void;
}) {
  return (
    <>
      {props.notice ? (
        <View
          pointerEvents="none"
          className="absolute inset-x-0 bottom-6 items-center"
          accessibilityLiveRegion="polite"
        >
          <View className="rounded-full bg-card px-4 py-2 shadow-sm">
            <AppText className="text-sm font-t3-medium text-foreground">{props.notice}</AppText>
          </View>
        </View>
      ) : null}
      <Modal
        visible={props.choices !== null}
        transparent
        animationType="fade"
        statusBarTranslucent
        navigationBarTranslucent
        onRequestClose={props.onDismiss}
      >
        <Pressable
          accessibilityLabel="Close definitions"
          className="flex-1 items-center justify-center bg-backdrop px-8"
          onPress={props.onDismiss}
        >
          <View className="max-h-[70%] w-full rounded-[24px] bg-card pb-2 pt-5">
            <AppText className="px-6 pb-2 text-lg font-t3-medium">Choose a definition</AppText>
            <ScrollView>
              {(props.choices ?? []).map((definition) => {
                const slash = definition.path.lastIndexOf("/");
                return (
                  <Pressable
                    key={`${definition.path}:${definition.line}`}
                    accessibilityRole="button"
                    className="px-6 py-2.5 active:bg-subtle"
                    onPress={() => props.onChoose(definition)}
                  >
                    <AppText className="font-mono text-sm text-foreground" numberOfLines={1}>
                      {definition.path.slice(slash + 1)}:{definition.line}
                    </AppText>
                    {slash > 0 ? (
                      <AppText
                        className="text-xs text-foreground-muted"
                        numberOfLines={1}
                        ellipsizeMode="middle"
                      >
                        {definition.path.slice(0, slash)}
                      </AppText>
                    ) : null}
                  </Pressable>
                );
              })}
            </ScrollView>
          </View>
        </Pressable>
      </Modal>
    </>
  );
}
