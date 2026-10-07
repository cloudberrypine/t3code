// @vitest-environment jsdom

import {
  CodeView,
  preloadHighlighter,
  type CodeViewDiffItem,
  type FileDiffMetadata,
} from "@pierre/diffs";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";

// Exercises the anchor capture our @pierre/diffs patch backports from 1.5.2 (`reconcileItems`).

const VIEWPORT_HEIGHT = 200;

let frames: FrameRequestCallback[] = [];
function flushFrames() {
  for (let guard = 0; frames.length > 0 && guard < 20; guard++) {
    const pending = frames;
    frames = [];
    for (const frame of pending) frame(performance.now());
  }
}

function diffItem(path: string): CodeViewDiffItem {
  const fileDiff: FileDiffMetadata = {
    name: path,
    type: "change",
    hunks: [],
    additionLines: [],
    deletionLines: [],
    splitLineCount: 0,
    unifiedLineCount: 0,
    isPartial: true,
    cacheKey: `${path}:pending`,
  };
  // Collapsed items are header-only, so their height comes from metrics, not DOM measurement.
  return { id: path, type: "diff", fileDiff, collapsed: true };
}

function mountViewer() {
  const root = document.createElement("div");
  let scrollTop = 0;
  Object.defineProperty(root, "scrollTop", {
    get: () => scrollTop,
    set: (value: number) => {
      scrollTop = value;
    },
  });
  root.scrollTo = ((options: ScrollToOptions) => {
    scrollTop = options.top ?? scrollTop;
  }) as typeof root.scrollTo;
  root.getBoundingClientRect = () => ({ height: VIEWPORT_HEIGHT, width: 600 }) as DOMRect;
  document.body.appendChild(root);
  const viewer = new CodeView({ stickyHeaders: true });
  viewer.setup(root);
  return { viewer, root };
}

describe("CodeView item insertion", () => {
  // Newer CodeView versions wait for the shared highlighter before their first render.
  beforeAll(() => preloadHighlighter({ themes: ["pierre-dark", "pierre-light"], langs: [] }));
  beforeEach(() => {
    frames = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
  });
  afterEach(() => {
    document.body.textContent = "";
    vi.unstubAllGlobals();
  });

  // A diff-tree jump lands before the files above the target load. They arrive later and are
  // inserted above it; the target must stay where the jump put it.
  it("keeps a jumped-to file at the top when files load above it", () => {
    const { viewer } = mountViewer();
    const loaded = ["a", "b"].map(diffItem);
    const target = diffItem("t");
    const after = Array.from({ length: 30 }, (_, index) => diffItem(`z${index}`));
    viewer.setItems([...loaded, target, ...after]);
    flushFrames();

    viewer.scrollTo({ type: "item", id: "t", align: "start" });
    flushFrames();
    const jumpedTop = viewer.getScrollTop();
    expect(jumpedTop).toBeGreaterThan(0);
    expect(viewer.getTopForItem("t")).toBe(jumpedTop);

    const above = Array.from({ length: 8 }, (_, index) => diffItem(`m${index}`));
    viewer.setItems([...loaded, ...above, target, ...after]);
    flushFrames();

    expect(viewer.getTopForItem("t")).toBeGreaterThan(jumpedTop);
    expect(viewer.getScrollTop()).toBe(viewer.getTopForItem("t"));
    viewer.cleanUp();
  });
});
