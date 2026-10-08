// @vitest-environment jsdom

import {
  CodeView,
  preloadHighlighter,
  type CodeViewDiffItem,
  type FileDiffMetadata,
} from "@pierre/diffs";
import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { useCodeViewFileReveal } from "./useCodeViewFileReveal";

// Jumps to a diff file while the lazily loaded files around it are still arriving.

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

describe("diff file jump", () => {
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
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });
  afterEach(() => {
    document.body.textContent = "";
    vi.unstubAllGlobals();
  });

  // Exercises the anchor capture our @pierre/diffs patch backports from 1.5.2 (`reconcileItems`).
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

  // A tree click on an unloaded file appends it after the few loaded files, where a short file
  // cannot reach the top. Files then load above and after it, until the reader scrolls.
  it("lands on a clicked file that loads after the files around it", () => {
    const { viewer, root } = mountViewer();
    const handle = { getInstance: () => viewer, scrollTo: viewer.scrollTo.bind(viewer) };
    const scope = {};
    let reveal: (fileKey: string) => void = () => {};
    function Harness({ fileKeys }: { fileKeys: ReadonlyArray<string> }) {
      const request = useCodeViewFileReveal(handle, scope, fileKeys);
      useEffect(() => {
        reveal = request;
      }, [request]);
      return null;
    }
    const container = document.createElement("div");
    const reactRoot = createRoot(container);
    const show = (items: CodeViewDiffItem[]) => {
      viewer.setItems(items);
      act(() => reactRoot.render(<Harness fileKeys={items.map((item) => item.id)} />));
      flushFrames();
    };
    const loaded = Array.from({ length: 12 }, (_, index) => diffItem(`a${index}`));
    const above = Array.from({ length: 8 }, (_, index) => diffItem(`m${index}`));
    const after = Array.from({ length: 8 }, (_, index) => diffItem(`z${index}`));
    const target = diffItem("t");

    show(loaded);
    act(() => reveal("t"));
    show([...loaded, target]);
    expect(viewer.getScrollTop()).toBeGreaterThan(0);
    show([...loaded, ...above, target]);
    show([...loaded, ...above, target, ...after]);
    expect(viewer.getScrollTop()).toBe(viewer.getTopForItem("t"));

    // Once the reader scrolls, later loads leave the view to them.
    root.dispatchEvent(new Event("wheel", { bubbles: true }));
    viewer.scrollTo({ type: "position", position: 0 });
    flushFrames();
    show([...loaded, ...above, target, ...after, diffItem("zz")]);
    expect(viewer.getScrollTop()).toBe(0);

    act(() => reactRoot.unmount());
    viewer.cleanUp();
  });
});
