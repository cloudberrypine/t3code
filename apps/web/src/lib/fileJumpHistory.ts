import type { ResolvedKeybindingsConfig } from "@t3tools/contracts";
import { resolveShortcutCommand, type ShortcutEventLike } from "~/keybindings";

import type { DiffPanelSelection } from "~/diffPanelStore";

export interface FileJumpLocation {
  path: string;
  line: number;
  diff?: { selection: DiffPanelSelection; side: "additions" | "deletions" };
}

interface FileJump {
  from: FileJumpLocation;
  to: FileJumpLocation;
  closeOnBack?: boolean;
}

export interface FileJumpHistory {
  cwd: string;
  back: FileJump[];
  forward: FileJump[];
}

export function recordFileJump(
  history: FileJumpHistory | undefined,
  cwd: string,
  from: FileJumpLocation,
  to: FileJumpLocation,
  closeOnBack = false,
): FileJumpHistory {
  const current = history?.cwd === cwd ? history : { cwd, back: [], forward: [] };
  if (from.path === to.path && from.line === to.line && !from.diff && !to.diff) return current;
  return {
    cwd,
    back: [...current.back, { from, to, ...(closeOnBack ? { closeOnBack } : {}) }].slice(-100),
    forward: [],
  };
}

/** Each step undoes/redoes one jump, even if the user scrolled before the next jump. */
export function traverseFileJumps(
  history: FileJumpHistory | undefined,
  cwd: string,
  direction: "back" | "forward",
) {
  if (!history || history.cwd !== cwd) return null;
  const jump = history[direction].at(-1);
  if (!jump) return null;
  const next: FileJumpHistory =
    direction === "back"
      ? { ...history, back: history.back.slice(0, -1), forward: [...history.forward, jump] }
      : { ...history, back: [...history.back, jump], forward: history.forward.slice(0, -1) };
  return {
    history: next,
    location: direction === "back" ? jump.from : jump.to,
    closePath: direction === "back" && jump.closeOnBack ? jump.to.path : null,
  };
}

export function fileNavigationAction(
  event: ShortcutEventLike,
  keybindings: ResolvedKeybindingsConfig,
  platform?: string,
) {
  const command = resolveShortcutCommand(event, keybindings, {
    ...(platform ? { platform } : {}),
    context: { filePreviewFocus: true },
  });
  return command === "file.jumpBack"
    ? "back"
    : command === "file.jumpForward"
      ? "forward"
      : command === "file.switchSourceHeader"
        ? "counterpart"
        : null;
}
