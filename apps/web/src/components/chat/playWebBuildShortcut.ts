/**
 * Fork: the "Play web build" keybinding command. Its default lives in
 * @t3tools/shared/keybindings; users rebind it in Settings → Keybindings.
 */
import type { ResolvedKeybindingsConfig } from "@t3tools/contracts";

import { resolveShortcutCommand, type ShortcutEventLike } from "../../keybindings";

export const PLAY_WEB_BUILD_COMMAND = "play.webBuild";

/** Whether the key press plays the web build. The terminal lets it through to the app. */
export function isPlayWebBuildShortcut(
  event: ShortcutEventLike,
  keybindings: ResolvedKeybindingsConfig,
  options?: Parameters<typeof resolveShortcutCommand>[2],
): boolean {
  return resolveShortcutCommand(event, keybindings, options) === PLAY_WEB_BUILD_COMMAND;
}
