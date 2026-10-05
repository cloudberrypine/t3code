import {
  type CodeView,
  VirtualizedFileDiff,
  parseDiffFromFile,
  type CodeViewDiffItem,
  type CodeViewScrollTarget,
} from "@pierre/diffs";
import { expect, it, vi } from "vite-plus/test";
import { createDiffScrollMemory, hasDiffScrollPosition } from "./diffScrollMemory";

function fixture(diffStyle: "unified" | "split" = "unified") {
  const contents = Array.from({ length: 120 }, (_, i) => `line ${i + 1}\n`).join("");
  const fileDiff = parseDiffFromFile(
    { name: "a.cpp", contents },
    {
      name: "a.cpp",
      contents: contents
        .replace("line 30\n", "changed 30\n")
        .replace("line 100\n", "changed 100\n"),
    },
    { context: 3 },
  );
  const item: CodeViewDiffItem = { type: "diff", id: "a.cpp", fileDiff };
  // Geometry and expansion use the real renderer; only the DOM/scroll host is replaced.
  const codeView = {
    type: "advanced",
    instanceChanged: () => {},
    render: () => {},
  } as unknown as CodeView;
  const instance = new VirtualizedFileDiff({ diffStyle, collapsedContextThreshold: 0 }, codeView, {
    diffHeaderHeight: 32,
    lineHeight: 20,
    hunkSeparatorHeight: 24,
    paddingBottom: 8,
  });
  instance.prepareCodeViewItem(fileDiff, 0);
  let top = 1000;
  let scrollTop = 0;
  let visible = true;
  const scrollTo = vi.fn((target: CodeViewScrollTarget) => {
    if (target.type === "item") scrollTop = top - (target.offset ?? 0);
    if (target.type === "line")
      scrollTop =
        top +
        instance.getLinePosition(target.lineNumber, target.side)!.top -
        32 -
        (target.offset ?? 0);
  });
  const viewer = {
    getHeight: () => 100,
    getScrollTop: () => scrollTop,
    getTopForItem: (id: string) => (id === item.id ? top : undefined),
    getRenderedItems: () =>
      visible
        ? [
            {
              id: item.id,
              type: "diff" as const,
              item,
              version: undefined,
              element: {} as HTMLElement,
              instance,
            },
          ]
        : [],
    scrollTo,
  };
  return {
    item,
    instance,
    viewer,
    setTop: (value: number) => (top = value),
    setScroll: (value: number) => (scrollTop = value),
    setVisible: (value: boolean) => (visible = value),
  };
}

it.each(["unified", "split"] as const)(
  "returns to the same line and pixel offset after remount in %s",
  (style) => {
    const key = `position-${style}`;
    const before = fixture(style);
    const lineTop = before.instance.getLinePosition(30)!.top;
    before.setScroll(1000 + lineTop - 37);
    createDiffScrollMemory(key).save(before.viewer, [before.item]);
    expect(hasDiffScrollPosition(key)).toBe(true);
    const after = fixture(style);
    after.setTop(2000); // Another file above it has grown.
    createDiffScrollMemory(key).restore(after.viewer, [after.item]);
    expect(after.viewer.getScrollTop()).toBe(2000 + lineTop - 37);
    expect(after.viewer.scrollTo).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: "line", lineNumber: 30, offset: 5 }),
    );
  },
);

it.each(["unified", "split"] as const)(
  "restores expanded context in %s without saving intermediate mount positions",
  (style) => {
    const key = `context-${style}`;
    const before = fixture(style);
    before.instance.expandHunk(1, "up", 20);
    before.instance.consumeCodeViewLayoutChanges(before.item.fileDiff);
    before.instance.prepareCodeViewItem(before.item.fileDiff, 0);
    const lineTop = before.instance.getLinePosition(40)!.top;
    before.setScroll(1000 + lineTop - 36);
    createDiffScrollMemory(key).save(before.viewer, [before.item]);
    const after = fixture(style);
    after.setVisible(false);
    const memory = createDiffScrollMemory(key);
    memory.restore(after.viewer, [after.item]);
    memory.save(after.viewer, [after.item]);
    expect(after.viewer.scrollTo).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: "item" }),
    );
    after.setVisible(true);
    // Expansion and rendering happen in separate viewer passes.
    for (let i = 0; i < 4; i++) {
      memory.restore(after.viewer, [after.item]);
      after.instance.consumeCodeViewLayoutChanges(after.item.fileDiff);
      after.instance.prepareCodeViewItem(after.item.fileDiff, 0);
    }
    expect(after.viewer.scrollTo).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: "line", lineNumber: 40, offset: 4 }),
    );
    expect(after.instance.isLineRenderable(40)).toBe(true);
    const reopened = fixture(style);
    const second = createDiffScrollMemory(key);
    for (let i = 0; i < 4; i++) {
      second.restore(reopened.viewer, [reopened.item]);
      reopened.instance.consumeCodeViewLayoutChanges(reopened.item.fileDiff);
      reopened.instance.prepareCodeViewItem(reopened.item.fileDiff, 0);
    }
    expect(reopened.viewer.scrollTo).toHaveBeenLastCalledWith(
      expect.objectContaining({ lineNumber: 40 }),
    );
  },
);

it("keeps scopes separate, restores a file header, and lets navigation cancel a pending restore", () => {
  const view = fixture();
  view.setScroll(1000);
  createDiffScrollMemory("scope-a").save(view.viewer, [view.item]);
  createDiffScrollMemory("scope-b").restore(view.viewer, [view.item]);
  expect(view.viewer.scrollTo).not.toHaveBeenCalled();
  const canceled = createDiffScrollMemory("scope-a");
  canceled.cancel();
  canceled.restore(view.viewer, [view.item]);
  expect(view.viewer.scrollTo).not.toHaveBeenCalled();
  createDiffScrollMemory("scope-a").restore(view.viewer, [view.item]);
  expect(view.viewer.scrollTo).toHaveBeenCalledExactlyOnceWith({
    type: "item",
    id: "a.cpp",
    align: "start",
    offset: 0,
    behavior: "instant",
  });
});

it("waits for files to load and requests expansion only once for a collapsed target", () => {
  const view = fixture();
  view.setScroll(1000 + view.instance.getLinePosition(30)!.top - 32);
  createDiffScrollMemory("collapsed").save(view.viewer, [view.item]);
  const memory = createDiffScrollMemory("collapsed");
  const reveal = vi.fn();
  memory.restore(view.viewer, [], reveal);
  memory.restore(view.viewer, [{ ...view.item, collapsed: true }], reveal);
  memory.restore(view.viewer, [{ ...view.item, collapsed: true }], reveal);
  expect(reveal).toHaveBeenCalledExactlyOnceWith("a.cpp");
  expect(view.viewer.scrollTo).not.toHaveBeenCalled();
  memory.restore(view.viewer, [view.item], reveal);
  expect(view.viewer.scrollTo).toHaveBeenCalledWith(expect.objectContaining({ lineNumber: 30 }));
});

it("bounds session memory and safely handles a removed file", () => {
  const view = fixture();
  view.setScroll(1000);
  for (let i = 0; i < 101; i++)
    createDiffScrollMemory(`bounded-${i}`).save(view.viewer, [view.item]);
  expect(hasDiffScrollPosition("bounded-0")).toBe(false);
  expect(hasDiffScrollPosition("bounded-100")).toBe(true);
  const memory = createDiffScrollMemory("bounded-100");
  memory.restore(view.viewer, [{ ...view.item, id: "other.cpp" }]);
  memory.restore(view.viewer, [view.item]);
  expect(view.viewer.scrollTo).not.toHaveBeenCalled();
});

it("restores the end of an expanded file as well as the first visible line", () => {
  const before = fixture();
  before.instance.expandHunk(2, "up", 20);
  before.instance.consumeCodeViewLayoutChanges(before.item.fileDiff);
  before.instance.prepareCodeViewItem(before.item.fileDiff, 0);
  const lineTop = before.instance.getLinePosition(117)!.top;
  before.setScroll(1000 + lineTop - 36);
  createDiffScrollMemory("file-end").save(before.viewer, [before.item]);
  const after = fixture();
  const memory = createDiffScrollMemory("file-end");
  for (let i = 0; i < 4; i++) {
    memory.restore(after.viewer, [after.item]);
    after.instance.consumeCodeViewLayoutChanges(after.item.fileDiff);
    after.instance.prepareCodeViewItem(after.item.fileDiff, 0);
  }
  expect(after.viewer.scrollTo).toHaveBeenLastCalledWith(
    expect.objectContaining({ lineNumber: 117, offset: 4 }),
  );
  expect(after.instance.isLineRenderable(120)).toBe(true);
});
