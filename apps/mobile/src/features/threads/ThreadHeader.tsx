import { useGT, useMessages } from "gt-react-native";
import { Platform } from "react-native";

import { AppBar } from "../../components/ui/AppBar";
import type { AppBarAction, AppBarMenu } from "../../components/ui/AppBar.types";
import {
  useAdaptiveWorkspaceLayout,
  useWorkspacePaneState,
} from "../layout/AdaptiveWorkspaceLayout";
import type { ThreadInspectorMode } from "./thread-inspector-navigation";
import { useWorkspaceBackNavigation } from "../layout/workspace/useAndroidWorkspaceNavigation";
import {
  threadTerminalMenu,
  useThreadGitMenuDefinition,
  type ThreadGitControlsProps,
} from "./ThreadGitControls";
import { playWebBuildHeaderAction, playWebBuildOptionsVersion } from "../play/playWebBuildButton";

export function ThreadHeader(props: {
  readonly title: string;
  readonly subtitle: string;
  readonly gitControls: ThreadGitControlsProps;
  readonly onReturnToThread?: () => void;
  readonly draft?: boolean;
  readonly hasThreadCwd: boolean;
  readonly inspectorMode: ThreadInspectorMode | null;
  readonly onOpenFilesInspector: () => void;
}) {
  const gt = useGT();
  const m = useMessages();
  const goBack = useWorkspaceBackNavigation();
  const { layout, toggleAuxiliaryPane, startNewTask } = useAdaptiveWorkspaceLayout();
  const { panes } = useWorkspacePaneState();
  const gitMenu = useThreadGitMenuDefinition(props.gitControls);
  // Fork: the compact iPhone bar drops the terminal menu so the thread title keeps its room.
  const terminalMenu =
    Platform.OS === "ios" && !layout.usesSplitView
      ? null
      : threadTerminalMenu(props.gitControls, m);
  const playAction = playWebBuildHeaderAction(props.gitControls.playWebBuild, gt);
  const filesVisible = props.inspectorMode === "files" && panes.auxiliaryPaneVisible;
  const actions: AppBarAction[] = props.hasThreadCwd
    ? [
        {
          accessibilityLabel: filesVisible ? gt("Close files") : gt("Open files"),
          icon: "folder",
          selected: filesVisible,
          disabled: !props.gitControls.canOpenFiles,
          separateBackground: false,
          onPress: filesVisible ? toggleAuxiliaryPane : props.onOpenFilesInspector,
        },
      ]
    : [];
  if (playAction) actions.push(playAction);
  const menus = [gitMenu, terminalMenu].filter((menu): menu is AppBarMenu => menu !== null);

  return (
    <AppBar
      title={props.title}
      subtitle={props.subtitle}
      onBackToList={goBack}
      onCompose={props.draft ? undefined : startNewTask}
      backInSplitView={
        props.onReturnToThread
          ? {
              accessibilityLabel: gt("Return to chat"),
              icon: "chevron.left",
              onPress: props.onReturnToThread,
            }
          : undefined
      }
      actions={actions}
      menus={menus}
      hideBottomBorder
      optionsVersion={playWebBuildOptionsVersion(props.gitControls.playWebBuild)}
    />
  );
}
