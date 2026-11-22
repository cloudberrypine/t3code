import { describe, expect, it } from "vite-plus/test";

import { classifyMarkdownImageSource } from "./markdownImages.js";

describe("classifyMarkdownImageSource", () => {
  it.each([
    ["images/result.png", "/workspace/project", "/workspace/project/images/result.png"],
    [
      "images\\result.png",
      "C:\\Users\\dara\\project",
      "C:\\Users\\dara\\project\\images\\result.png",
    ],
    ["file:///workspace/project/image%20one.png", null, "/workspace/project/image one.png"],
    ["file://server/share/image.png", "\\\\server\\share", "\\\\server\\share\\image.png"],
  ])("maps %s to a workspace file", (source, workspaceRoot, path) => {
    expect(classifyMarkdownImageSource(source, workspaceRoot)).toEqual({
      _tag: "WorkspaceFile",
      path,
      ...(source.startsWith("file:") ? {} : { relative: true }),
    });
  });

  // Fork: absolute paths, including percent-encoded generated-image paths agents write.
  it.each([
    ["/workspace/project/image.png", null, "/workspace/project/image.png"],
    [
      "/home/user/.codex/generated_images/otter%20%231%20(final).png",
      "/workspace/project",
      "/home/user/.codex/generated_images/otter #1 (final).png",
    ],
    [
      "C%3A%5CUsers%5Cdara%5C.codex%5Cgenerated_images%5Cotter.png",
      null,
      "C:\\Users\\dara\\.codex\\generated_images\\otter.png",
    ],
    ["/C:/Users/dara/project/image.png", null, "C:/Users/dara/project/image.png"],
    ["C:/Users/dara/project/image.png", null, "C:/Users/dara/project/image.png"],
  ])("maps absolute path %s to a workspace file", (source, workspaceRoot, path) => {
    expect(classifyMarkdownImageSource(source, workspaceRoot)).toEqual({
      _tag: "WorkspaceFile",
      path,
    });
  });

  it.each(["image.png", "javascript:alert(1)", "file://%"])(
    "blocks unsupported or unresolved source %s",
    (source) => {
      expect(classifyMarkdownImageSource(source)).toEqual({ _tag: "Blocked" });
    },
  );

  // Loading these makes Windows send the user's NTLM credentials to the named host.
  it.each([
    "file://attacker.test/share/cat.jpg",
    "\\\\attacker.test\\share\\cat.jpg",
    "/\\attacker.test\\share\\cat.jpg",
    "file:/%5Cattacker.test%5Cshare%5Ccat.jpg",
    "\\\\server\\other\\cat.jpg",
  ])("blocks network path %s outside the project", (source) => {
    expect(classifyMarkdownImageSource(source, "\\\\server\\share\\project")).toEqual({
      _tag: "Blocked",
    });
  });
});
