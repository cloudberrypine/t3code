import {
  compileResolvedKeybindingsConfig,
  mergeWithDefaultKeybindings,
} from "@t3tools/shared/keybindings";
import { assert, describe, it } from "vite-plus/test";

import {
  formatShortcutLabel,
  resolveShortcutCommand,
  shortcutLabelForCommand,
} from "../../keybindings";
import { isPlayWebBuildShortcut, PLAY_WEB_BUILD_COMMAND } from "./playWebBuildShortcut";

const MAC = "MacIntel";
const TERMINAL_FOCUS = {
  terminalFocus: true,
  terminalOpen: true,
  previewFocus: false,
  previewOpen: false,
  isWeb: false,
  isDesktop: true,
};

// A project whose "Play" script took mod+shift+d, as saved by the script editor.
const keybindings = mergeWithDefaultKeybindings(
  compileResolvedKeybindingsConfig([{ key: "mod+shift+d", command: "script.play.run" }]),
);

// Option+Shift+D types "Î" on a US Mac layout.
const playWebBuildPress = {
  key: "Î",
  code: "KeyD",
  metaKey: true,
  ctrlKey: false,
  shiftKey: true,
  altKey: true,
};

describe("play web build shortcut", () => {
  it("plays on Option+Shift+Cmd+D by default, also from the terminal", () => {
    const options = { platform: MAC, context: TERMINAL_FOCUS };
    assert.isTrue(isPlayWebBuildShortcut(playWebBuildPress, keybindings, options));
    assert.strictEqual(shortcutLabelForCommand(keybindings, PLAY_WEB_BUILD_COMMAND, MAC), "⌥⇧⌘D");
  });

  it("leaves Shift+Cmd+D to the Play script", () => {
    const playPress = { ...playWebBuildPress, key: "D", altKey: false };
    const options = { platform: MAC, context: TERMINAL_FOCUS };
    assert.isFalse(isPlayWebBuildShortcut(playPress, keybindings, options));
    assert.strictEqual(resolveShortcutCommand(playPress, keybindings, options), "script.play.run");
  });

  it("follows a user's rebinding", () => {
    const rebound = mergeWithDefaultKeybindings(
      compileResolvedKeybindingsConfig([{ key: "mod+shift+b", command: PLAY_WEB_BUILD_COMMAND }]),
    );
    const options = { platform: MAC };
    assert.isFalse(isPlayWebBuildShortcut(playWebBuildPress, rebound, options));
    const binding = rebound.find((rule) => rule.command === PLAY_WEB_BUILD_COMMAND);
    assert.strictEqual(binding && formatShortcutLabel(binding.shortcut, MAC), "⇧⌘B");
  });
});
