import type { CodeViewScrollTarget } from "@pierre/diffs";
import type { FileTree as FileTreeModel } from "@pierre/trees";
import { FileTree } from "@pierre/trees/react";
import { act, type MouseEvent, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { DiffFileTree, type DiffFileTreeEntry } from "./DiffFileTree";
import { useCodeViewFileReveal } from "./useCodeViewFileReveal";

vi.mock("../../hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "dark" }) }));
// Tooltip positioning is unrelated to the tree's actual model and activation path.
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ render }: { render: ReactNode }) => render,
  TooltipPopup: () => null,
}));

const entries: DiffFileTreeEntry[] = [
  { path: "01-tall.ts", status: "modified" },
  { path: "02-short.ts", status: "modified" },
  { path: "03-medium.ts", status: "modified" },
];

class TreeRow {
  constructor(readonly path: string) {}

  getAttribute(name: string) {
    return name === "data-item-path" ? this.path : null;
  }
}

describe("diff tree file activation", () => {
  let renderer: ReactTestRenderer | undefined;
  const targets: CodeViewScrollTarget[] = [];
  const viewer = {
    getInstance: () => viewer,
    scrollTo: (target: CodeViewScrollTarget) => targets.push(target),
  };

  function Panel({
    files = entries,
    selectedPath = null,
  }: {
    files?: DiffFileTreeEntry[];
    selectedPath?: string | null;
  }) {
    const reveal = useCodeViewFileReveal(viewer, "working-tree");
    return (
      <DiffFileTree
        entries={files}
        ariaLabel="Working tree files"
        selectedPath={selectedPath}
        onSelectFile={(path) => reveal(`${path}\0${path}`)}
      />
    );
  }

  const model = (): FileTreeModel => renderer!.root.findByType(FileTree).props.model;

  async function mount(props: Parameters<typeof Panel>[0] = {}) {
    await act(async () => {
      renderer = create(<Panel {...props} />);
    });
  }

  // Exercise T3's capture handler before the real Pierre model's selection transition.
  // Only DOM hit testing is represented here; native pointer/keyboard dispatch and diff
  // geometry are verified separately in the integrated client.
  async function activate(path: string, modifiers: Partial<MouseEvent<HTMLElement>> = {}) {
    const event = {
      button: 0,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      altKey: false,
      defaultPrevented: false,
      nativeEvent: { composedPath: () => [{}, new TreeRow(path), {}] },
      ...modifiers,
    } as MouseEvent<HTMLElement>;
    await act(async () => {
      renderer!.root
        .find((node) => String(node.type) === "file-tree-container")
        .props.onClickCapture?.(event);
      const tree = model();
      const item = tree.getItem(path)!;
      if (event.ctrlKey || event.metaKey) {
        item.toggleSelect();
      } else {
        for (const selected of tree.getSelectedPaths()) {
          if (selected !== path) tree.getItem(selected)?.deselect();
        }
        item.select();
      }
      item.focus();
      if ("toggle" in item && !event.ctrlKey && !event.metaKey && !event.shiftKey) item.toggle();
    });
  }

  beforeEach(() => {
    targets.length = 0;
    vi.useFakeTimers();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("HTMLElement", TreeRow);
  });

  afterEach(async () => {
    await act(async () => renderer?.unmount());
    renderer = undefined;
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("reissues the reveal when the sole selected file is activated again", async () => {
    await mount();
    await activate("02-short.ts");
    expect(model().getSelectedPaths()).toEqual(["02-short.ts"]);
    await activate("02-short.ts");
    expect(targets).toEqual([
      { type: "item", id: "02-short.ts\u000002-short.ts", align: "start" },
      { type: "item", id: "02-short.ts\u000002-short.ts", align: "start" },
    ]);
  });

  it("reveals newly selected files once in either direction", async () => {
    await mount();
    await activate("02-short.ts");
    await activate("01-tall.ts");
    await activate("03-medium.ts");
    expect(targets.map((target) => ("id" in target ? target.id : null))).toEqual(
      ["02-short.ts", "01-tall.ts", "03-medium.ts"].map((path) => `${path}\0${path}`),
    );
  });

  it("keeps focus-only navigation separate from button activation", async () => {
    await mount();
    await activate("02-short.ts");
    await act(async () => model().getItem("01-tall.ts")!.focus());
    expect(model().getSelectedPaths()).toEqual(["02-short.ts"]);
    expect(targets).toHaveLength(1);
    await activate("01-tall.ts", { detail: 0 });
    await activate("01-tall.ts", { detail: 0 });
    expect(targets).toHaveLength(3);
  });

  it.each(["ctrlKey", "metaKey"] as const)(
    "does not reveal a selected file that a %s click deselects",
    async (modifier) => {
      await mount();
      await activate("02-short.ts");
      await activate("02-short.ts", { [modifier]: true });
      expect(model().getSelectedPaths()).toEqual([]);
      expect(targets).toHaveLength(1);
    },
  );

  it("lets a click narrow multiple selected files without a second reveal", async () => {
    await mount();
    await activate("02-short.ts");
    await act(async () => model().getItem("01-tall.ts")!.select());
    expect(model().getSelectedPaths()).toHaveLength(2);
    targets.length = 0;
    await activate("02-short.ts");
    expect(model().getSelectedPaths()).toEqual(["02-short.ts"]);
    expect(targets).toHaveLength(1);
  });

  it("leaves directory selection and expansion to the tree", async () => {
    await mount({ files: [{ path: "src/app.ts", status: "modified" }] });
    const directory = model().getItem("src/")!;
    if (!("isExpanded" in directory)) throw new Error("Expected the directory handle");
    expect(directory.isExpanded()).toBe(true);
    await activate("src/");
    expect(directory.isExpanded()).toBe(false);
    await activate("src/");
    expect(directory.isExpanded()).toBe(true);
    expect(targets).toEqual([]);
  });

  it("does not echo controlled selection, but lets the reader activate it", async () => {
    await mount({ selectedPath: "02-short.ts" });
    expect(model().getSelectedPaths()).toEqual(["02-short.ts"]);
    expect(targets).toEqual([]);
    await activate("02-short.ts");
    expect(targets).toHaveLength(1);
    await act(async () => {
      renderer!.update(<Panel selectedPath="03-medium.ts" />);
    });
    expect(model().getSelectedPaths()).toEqual(["03-medium.ts"]);
    expect(targets).toHaveLength(1);
  });

  it.each([false, true])(
    "keeps a replacement file and old descendants selectable (reversed: %s)",
    async (reverse) => {
      const files: DiffFileTreeEntry[] = [
        { path: ".claude/skills/image-url-checker", status: "added", loadState: "unloaded" },
        { path: ".claude/skills/image-url-checker/SKILL.md", status: "deleted" },
        { path: ".claude/skills/image-url-checker/scripts/check.py", status: "deleted" },
      ];
      await mount({ files: reverse ? files.toReversed() : files });
      await activate(".claude/skills/image-url-checker (file)");
      await activate(".claude/skills/image-url-checker (file)");
      await activate(".claude/skills/image-url-checker/SKILL.md");
      await activate(".claude/skills/image-url-checker/");
      expect(targets.map((target) => ("id" in target ? target.id : null))).toEqual([
        ".claude/skills/image-url-checker\0.claude/skills/image-url-checker",
        ".claude/skills/image-url-checker\0.claude/skills/image-url-checker",
        ".claude/skills/image-url-checker/SKILL.md\0.claude/skills/image-url-checker/SKILL.md",
      ]);
    },
  );

  it("updates controlled selection as a collision appears and disappears during refresh", async () => {
    const replacement: DiffFileTreeEntry = { path: "skill", status: "added" };
    const child: DiffFileTreeEntry = { path: "skill/SKILL.md", status: "deleted" };
    await mount({ files: [replacement], selectedPath: "skill" });
    expect(model().getSelectedPaths()).toEqual(["skill"]);
    await act(async () =>
      renderer!.update(<Panel files={[replacement, child]} selectedPath="skill" />),
    );
    expect(model().getSelectedPaths()).toEqual(["skill (file)"]);
    await act(async () => renderer!.update(<Panel files={[replacement]} selectedPath="skill" />));
    expect(model().getSelectedPaths()).toEqual(["skill"]);
    expect(targets).toEqual([]);
    await activate("skill");
    expect(targets).toHaveLength(1);
  });

  it("handles directory-to-file and file-to-directory refreshes", async () => {
    const file: DiffFileTreeEntry = { path: "skill", status: "deleted" };
    const child: DiffFileTreeEntry = { path: "skill/SKILL.md", status: "added" };
    await mount({ files: [child] });
    for (const files of [[file, child], [file], [child], [file, child]]) {
      await act(async () => renderer!.update(<Panel files={files} />));
    }
    await activate("skill (file)");
    await activate("skill/SKILL.md");
    expect(targets).toHaveLength(2);
  });

  it("avoids display names already occupied by real files or directories", async () => {
    const paths = ["skill", "skill/SKILL.md", "skill (file)", "skill (file 2)/real.ts"];
    await mount({ files: paths.map((path) => ({ path, status: "modified" })) });
    for (const path of ["skill (file 3)", ...paths.slice(1)]) await activate(path);
    expect(targets.map((target) => ("id" in target ? target.id : null))).toEqual(
      paths.map((path) => `${path}\0${path}`),
    );
  });
});
