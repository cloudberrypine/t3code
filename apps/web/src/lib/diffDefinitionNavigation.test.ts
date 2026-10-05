import {
  hydratePartialDiff,
  parseDiffFromFile,
  type FileContents,
  type FileDiffContentsLoader,
} from "@pierre/diffs";
import { expect, it, vi } from "vite-plus/test";
import type { NavigationSource } from "./angelScriptNavigation";
import { getRenderablePatch } from "./diffRendering";

const state = vi.hoisted(() => ({
  source: undefined as NavigationSource | undefined,
  click: undefined as
    | ((file: FileContents, offset: number, isCurrent: () => boolean) => void)
    | undefined,
  current: true,
}));
vi.mock("./angelScriptNavigation", () => ({
  createAngelScriptClickNavigation: (click: typeof state.click) => {
    state.click = click;
    state.current = true;
    return {
      attach: (_node: unknown, source: NavigationSource | undefined) => {
        state.source = source;
      },
      cancelPending: () => {
        state.current = false;
      },
      dispose: () => {
        state.current = false;
      },
    };
  },
}));
import { createDiffDefinitionNavigation, diffDefinitionOffset } from "./diffDefinitionNavigation";

function fixture() {
  const oldFile = {
    name: "old.cpp",
    contents: "void oldCall() {}\nvoid newCall() {}\nvoid run() {\n  oldCall();\n}\n",
  };
  const newFile = {
    name: "new.cpp",
    contents: "void oldCall() {}\nvoid newCall() {}\n\nvoid run() {\n  newCall();\n}\n",
  };
  const patch = getRenderablePatch(
    [
      "diff --git a/old.cpp b/new.cpp",
      "--- a/old.cpp",
      "+++ b/new.cpp",
      "@@ -3,3 +3,4 @@",
      "+",
      " void run() {",
      "-  oldCall();",
      "+  newCall();",
      " }",
      "",
    ].join("\n"),
  );
  if (patch?.kind !== "files" || !patch.files[0]) throw new Error("Invalid fixture");
  return { oldFile, newFile, partial: patch.files[0], full: parseDiffFromFile(oldFile, newFile) };
}
function row(line: number, side: "new" | "old-unified" | "old-split") {
  return {
    dataset: {
      line: String(line),
      lineType: side === "old-unified" ? "change-deletion" : "context",
    },
    closest: () => (side === "old-split" ? {} : null),
  } as unknown as HTMLElement;
}
function hit(line: number, side: Parameters<typeof row>[1]) {
  if (typeof state.source !== "function") throw new Error("Missing diff source");
  const source = state.source(row(line, side));
  if (!source) throw new Error("Missing row");
  const lineOffset = source.file.contents
    .split("\n")
    .slice(0, source.line - 1)
    .reduce((offset, text) => offset + text.length + 1, 0);
  state.click!(source.file, lineOffset + 2, () => state.current);
  return source;
}

it.each(["new", "old-unified", "old-split"] as const)(
  "resolves %s using its complete revision and original line numbers",
  async (side) => {
    const { oldFile, newFile, partial } = fixture();
    const navigate = vi.fn();
    const loaded = Promise.resolve({ oldFile, newFile });
    const load = vi.fn(() => loaded);
    const error = vi.fn();
    const controller = createDiffDefinitionNavigation(navigate, load, error);
    controller.attach({} as HTMLElement, partial);
    expect(load).not.toHaveBeenCalled();
    const old = side !== "new";
    hit(old ? 4 : 5, side);
    await loaded;
    expect(navigate).toHaveBeenCalledExactlyOnceWith(
      { ...(old ? oldFile : newFile), name: "new.cpp" },
      (old ? oldFile : newFile).contents.lastIndexOf(old ? "oldCall" : "newCall"),
      expect.any(Function),
      old ? "deletions" : "additions",
    );
    expect(error).not.toHaveBeenCalled();
  },
);

it.each(["new", "old-unified", "old-split"] as const)(
  "uses hydrated %s content without fetching",
  (side) => {
    const { full, oldFile, newFile } = fixture();
    const navigate = vi.fn();
    const load = vi.fn();
    const controller = createDiffDefinitionNavigation(navigate, load, vi.fn());
    controller.attach({} as HTMLElement, full);
    const old = side !== "new";
    hit(old ? 4 : 5, side);
    expect(navigate).toHaveBeenCalledExactlyOnceWith(
      { name: "new.cpp", contents: (old ? oldFile : newFile).contents },
      (old ? oldFile : newFile).contents.lastIndexOf(old ? "oldCall" : "newCall"),
      expect.any(Function),
      old ? "deletions" : "additions",
    );
    expect(load).not.toHaveBeenCalled();
  },
);

it("ignores missing rows and detaches an unmounted or unsupported file", () => {
  const controller = createDiffDefinitionNavigation(vi.fn(), undefined, vi.fn());
  const { partial } = fixture();
  controller.attach({} as HTMLElement, partial);
  expect(typeof state.source === "function" && state.source(row(2, "new"))).toBeNull();
  controller.attach({} as HTMLElement, partial, "unmount");
  expect(state.source).toBeUndefined();
});

it("does not open a stale result after disposal", async () => {
  const files = fixture();
  const loaded = Promise.resolve(files);
  const navigate = vi.fn();
  const controller = createDiffDefinitionNavigation(navigate, () => loaded, vi.fn());
  controller.attach({} as HTMLElement, files.partial);
  hit(5, "new");
  controller.dispose();
  await loaded;
  expect(navigate).not.toHaveBeenCalled();
});

it.each(["missing loader", "mismatched content", "missing side", "rejected loader"])(
  "reports %s without navigating",
  async (kind) => {
    const { partial, oldFile, newFile } = fixture();
    const load: FileDiffContentsLoader | undefined =
      kind === "missing loader"
        ? undefined
        : async () => {
            if (kind === "rejected loader") throw new Error("unavailable");
            return {
              oldFile: kind === "missing side" ? null : oldFile,
              newFile: { ...newFile, contents: "different\n" },
            };
          };
    const navigate = vi.fn();
    let reportFailure = () => {};
    const failed = new Promise<void>((resolve) => {
      reportFailure = resolve;
    });
    const error = vi.fn(() => reportFailure());
    const controller = createDiffDefinitionNavigation(navigate, load, error);
    controller.attach({} as HTMLElement, partial);
    if (kind === "missing side") hit(4, "old-split");
    else hit(5, "new");
    await failed;
    expect(error).toHaveBeenCalledOnce();
    expect(navigate).not.toHaveBeenCalled();
  },
);

it("keeps a pending click valid when context expansion hydrates the diff", async () => {
  const { partial, oldFile, newFile } = fixture();
  const loaded = Promise.resolve({ oldFile, newFile });
  const navigate = vi.fn();
  const controller = createDiffDefinitionNavigation(navigate, () => loaded, vi.fn());
  const node = {} as HTMLElement;
  controller.attach(node, partial);
  const initialSource = state.source;
  hit(5, "new");
  hydratePartialDiff("merge", partial, { oldFile, newFile });
  controller.attach(node, partial);
  expect(state.source).toBe(initialSource);
  expect(state.current).toBe(true);
  await loaded;
  expect(navigate).toHaveBeenCalledOnce();
  hit(5, "new");
  expect(navigate).toHaveBeenCalledTimes(2);
});

it("maps clicks when whitespace-hidden context has different indentation or spacing", () => {
  const displayed = "  target += back * sin(kickPhase);\n";
  const full = "// header\n\ttarget+=back * sin( kickPhase );\n";
  const offset = displayed.indexOf("kickPhase");
  expect(diffDefinitionOffset(displayed, offset, 2, full)).toBe(full.indexOf("kickPhase"));
  expect(diffDefinitionOffset(displayed, displayed.indexOf("back"), 2, full)).toBe(
    full.indexOf("back"),
  );
});

it("does not block a click because another line in the hunk changed", () => {
  const displayed = "oldCall();\n  kickPhase();\n";
  const full = "newCall();\n  kickPhase();\n";
  expect(diffDefinitionOffset(displayed, displayed.indexOf("kickPhase"), 1, full)).toBe(
    full.indexOf("kickPhase"),
  );
});

it("rejects changed tokens, changed string contents, and missing source lines", () => {
  const displayed = '  helper("a b");\n';
  expect(diffDefinitionOffset(displayed, 2, 1, '  other("a b");\n')).toBeNull();
  expect(diffDefinitionOffset(displayed, 2, 1, 'helper("ab");\n')).toBeNull();
  expect(diffDefinitionOffset(displayed, 2, 2, "")).toBeNull();
});

it.each(["new", "old-split"] as const)(
  "resolves tree comments in a partial %s diff against the full revision",
  async (side) => {
    const { createAngelScriptNavigation } = await import("@t3tools/shared/angelscriptNavigation");
    const header = "// State tree (generated; update with --check-script <file> --write-tree):\n";
    const oldFile = {
      name: "Otter.as",
      contents:
        header +
        "//   Main [initial]\n//   `-- Rest ?\nnamespace Otter {\n state Main {}\n state Rest {}\n}\n",
    };
    const newFile = { name: "Otter.as", contents: oldFile.contents.replaceAll("Rest", "Dive") };
    const patch = getRenderablePatch(
      "diff --git a/Otter.as b/Otter.as\n--- a/Otter.as\n+++ b/Otter.as\n@@ -3 +3 @@\n-//   `-- Rest ?\n+//   `-- Dive ?\n",
    );
    if (patch?.kind !== "files" || !patch.files[0]) throw new Error("Invalid fixture");
    const results: unknown[] = [];
    const loaded = Promise.resolve({ oldFile, newFile });
    const error = vi.fn();
    const controller = createDiffDefinitionNavigation(
      (file, offset) => {
        results.push(
          createAngelScriptNavigation([{ path: file.name, contents: file.contents }]).resolve(
            file.name,
            offset,
          ),
        );
      },
      () => loaded,
      error,
    );
    controller.attach({} as HTMLElement, patch.files[0]);
    if (typeof state.source !== "function") throw new Error("Missing source");
    const source = state.source(row(3, side))!;
    state.click!(
      source.file,
      source.file.contents.indexOf(side === "new" ? "Dive" : "Rest"),
      () => true,
    );
    await loaded;
    expect(results).toEqual([{ path: "Otter.as", line: 6 }]);
    expect(error).not.toHaveBeenCalled();
  },
);
