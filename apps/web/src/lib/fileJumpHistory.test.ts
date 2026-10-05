import { expect, it } from "vite-plus/test";
import {
  DEFAULT_RESOLVED_KEYBINDINGS,
  compileResolvedKeybindingsConfig,
} from "@t3tools/shared/keybindings";
import { resolveShortcutCommand } from "~/keybindings";
import { fileNavigationAction, recordFileJump, type FileJumpHistory } from "./fileJumpHistory";

it("recognizes Option+Cmd arrows on Mac and Ctrl+Alt arrows on other platforms only in file previews", () => {
  const event = { key: "ArrowLeft", metaKey: true, ctrlKey: false, altKey: true, shiftKey: false };
  expect(fileNavigationAction(event, DEFAULT_RESOLVED_KEYBINDINGS, "MacIntel")).toBe("back");
  expect(
    fileNavigationAction({ ...event, key: "ArrowRight" }, DEFAULT_RESOLVED_KEYBINDINGS, "MacIntel"),
  ).toBe("forward");
  expect(
    fileNavigationAction(
      { ...event, ctrlKey: true, metaKey: false },
      DEFAULT_RESOLVED_KEYBINDINGS,
      "Win32",
    ),
  ).toBe("back");
  expect(
    fileNavigationAction({ ...event, altKey: false }, DEFAULT_RESOLVED_KEYBINDINGS, "MacIntel"),
  ).toBeNull();
  expect(
    resolveShortcutCommand(event, DEFAULT_RESOLVED_KEYBINDINGS, {
      platform: "MacIntel",
      context: { filePreviewFocus: false },
    }),
  ).toBeNull();
});

it("honors a customized history shortcut", () => {
  const bindings = compileResolvedKeybindingsConfig([
    { key: "mod+shift+h", command: "file.jumpBack", when: "filePreviewFocus" },
  ]);
  expect(
    fileNavigationAction(
      { key: "h", metaKey: true, ctrlKey: false, altKey: false, shiftKey: true },
      bindings,
      "MacIntel",
    ),
  ).toBe("back");
});

it("bounds session history without changing the most recent jump", () => {
  let history: FileJumpHistory | undefined;
  for (let line = 1; line <= 105; line++)
    history = recordFileJump(history, "/repo", { path: "a.as", line }, { path: "b.as", line });
  expect(history?.back).toHaveLength(100);
  expect(history?.back.at(-1)?.to).toEqual({ path: "b.as", line: 105 });
});

it("supports Control+Command arrows for history and the same source/header action in both vertical directions", () => {
  const event = { key: "ArrowLeft", metaKey: true, ctrlKey: true, altKey: false, shiftKey: false };
  for (const [key, action] of [
    ["ArrowLeft", "back"],
    ["ArrowRight", "forward"],
    ["ArrowUp", "counterpart"],
    ["ArrowDown", "counterpart"],
  ]) {
    expect(
      fileNavigationAction({ ...event, key: key! }, DEFAULT_RESOLVED_KEYBINDINGS, "MacIntel"),
    ).toBe(action);
    expect(
      resolveShortcutCommand({ ...event, key: key! }, DEFAULT_RESOLVED_KEYBINDINGS, {
        platform: "MacIntel",
        context: { filePreviewFocus: false },
      }),
    ).toBeNull();
  }
  expect(
    fileNavigationAction(
      { ...event, ctrlKey: false, key: "ArrowUp" },
      DEFAULT_RESOLVED_KEYBINDINGS,
      "MacIntel",
    ),
  ).toBeNull();
});
