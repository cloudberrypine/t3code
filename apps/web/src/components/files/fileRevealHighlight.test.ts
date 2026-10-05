import { afterEach, expect, it, vi } from "vite-plus/test";
import { createFileRevealHighlight, FILE_LINK_REVEAL_ATTRIBUTE } from "./fileRevealHighlight";

class ElementStub extends EventTarget {
  attributes = new Set<string>();
  code = true;
  shadowRoot: ElementStub | null = null;
  row: ElementStub | undefined;
  gutter: ElementStub | undefined;
  closest() {
    return this.code ? this : null;
  }
  setAttribute(name: string) {
    this.attributes.add(name);
  }
  removeAttribute(name: string) {
    this.attributes.delete(name);
  }
  querySelectorAll() {
    return [this.row, this.gutter].filter(
      (element): element is ElementStub =>
        !!element && element.attributes.has(FILE_LINK_REVEAL_ATTRIBUTE),
    );
  }
  querySelector(selector: string) {
    return selector.includes("data-column-number") ? this.gutter : this.row;
  }
}

afterEach(() => vi.unstubAllGlobals());

function setup() {
  vi.stubGlobal("HTMLElement", ElementStub);
  const root = new ElementStub();
  root.row = new ElementStub();
  root.gutter = new ElementStub();
  root.gutter.code = false;
  const node = new ElementStub();
  node.shadowRoot = root;
  const highlight = createFileRevealHighlight();
  const dismiss = vi.fn();
  const paint = (id = 1) => highlight.paint(node as unknown as HTMLElement, 20, id, dismiss);
  const dispatch = (type: string, options = {}) =>
    root.dispatchEvent(
      Object.assign(new Event(type), {
        key: "ArrowRight",
        button: 0,
        metaKey: false,
        ctrlKey: false,
        composedPath: () => [root.row],
        ...options,
      }),
    );
  paint();
  return { root, highlight, dismiss, paint, dispatch };
}

it.each(["keydown", "pointerdown", "beforeinput"])(
  "clears the line and gutter on %s and keeps them clear through rerenders",
  (type) => {
    const { root, highlight, dismiss, paint, dispatch } = setup();
    expect(root.querySelectorAll()).toHaveLength(2);
    dispatch(type);
    expect(root.querySelectorAll()).toHaveLength(0);
    expect(dismiss).toHaveBeenCalledOnce();
    paint();
    expect(root.querySelectorAll()).toHaveLength(0);
    paint(2);
    expect(root.querySelectorAll()).toHaveLength(2);
    highlight.dispose();
  },
);

it("preserves the highlight for modifiers, scrolling, definition clicks and non-code interactions", () => {
  const { root, highlight, dismiss, dispatch } = setup();
  dispatch("keydown", { key: "Meta" });
  dispatch("pointerdown", { metaKey: true });
  dispatch("pointerdown", { button: 2 });
  dispatch("pointerdown", { composedPath: () => [root.gutter] });
  dispatch("wheel");
  expect(root.querySelectorAll()).toHaveLength(2);
  expect(dismiss).not.toHaveBeenCalled();
  highlight.dispose();
  dispatch("keydown");
  expect(dismiss).not.toHaveBeenCalled();
});
