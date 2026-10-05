import { afterEach, expect, it, vi } from "vite-plus/test";
import { createAngelScriptClickNavigation } from "./angelScriptNavigation";

// Geometry is supplied explicitly: these tests exercise event handling without a browser layout engine.
vi.mock("~/components/diffs/diffSearch", () => ({
  textRange: (_row: unknown, start: number, end: number) => ({
    getClientRects: () => [
      { left: start * 10, right: end * 10, top: 0, bottom: 20 },
      { left: 0, right: (end - start) * 10, top: 20, bottom: 40 },
    ],
  }),
}));

class ElementStub extends EventTarget {
  ownerDocument = new EventTarget();
  shadowRoot: EventTarget | null = null;
  dataset = { line: "1" };
  style = { cursor: "text" };
  code = true;
  hasAttribute(name: string) {
    return name === "data-line";
  }
  closest() {
    return this.code ? this : null;
  }
}

function setup(contents = "void helper() {}\nhelper();") {
  vi.stubGlobal("HTMLElement", ElementStub);
  vi.stubGlobal("window", new EventTarget());
  const node = new ElementStub();
  node.code = false;
  const root = new EventTarget();
  node.shadowRoot = root;
  const row = new ElementStub();
  row.dataset.line = "2";
  const navigate = vi.fn();
  const navigation = createAngelScriptClickNavigation(navigate);
  const file = { name: "main.as", contents };
  navigation.attach(node as unknown as HTMLElement, file);
  function dispatch(type = "click", options: Record<string, unknown> = {}) {
    const event = Object.assign(new Event(type, { cancelable: true }), {
      button: 0,
      metaKey: true,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      clientX: 15,
      clientY: 10,
      composedPath: () => [row, root, node],
      ...options,
    });
    root.dispatchEvent(event);
    return event;
  }
  return { node, row, root, navigate, navigation, file, dispatch };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("follows Cmd/Ctrl-clicks on code text across shadow DOM and wrapped text rectangles", () => {
  const { navigation, navigate, dispatch, file } = setup();
  expect(dispatch().defaultPrevented).toBe(true);
  expect(navigate).toHaveBeenLastCalledWith(
    file,
    file.contents.lastIndexOf("helper"),
    expect.any(Function),
  );
  dispatch("click", { metaKey: false, ctrlKey: true, clientY: 30 });
  expect(navigate).toHaveBeenCalledTimes(2);
  navigation.dispose();
});

it("preserves ordinary selection, other buttons and clicks outside code text", () => {
  const { navigation, navigate, dispatch, row } = setup();
  for (const options of [
    { metaKey: false },
    { button: 1 },
    { altKey: true },
    { shiftKey: true },
    { clientX: 200 },
  ]) {
    expect(dispatch("click", options).defaultPrevented).toBe(false);
  }
  row.code = false;
  expect(dispatch().defaultPrevented).toBe(false);
  expect(navigate).not.toHaveBeenCalled();
  navigation.dispose();
});

it("suppresses editor selection on a modifier press and restores the cursor on release", () => {
  const { navigation, navigate, dispatch, row } = setup();
  expect(dispatch("pointerdown").defaultPrevented).toBe(true);
  expect(dispatch("mousedown").defaultPrevented).toBe(true);
  expect(navigate).not.toHaveBeenCalled();
  dispatch("pointermove");
  expect(row.style.cursor).toBe("pointer");
  window.dispatchEvent(new Event("keyup"));
  expect(row.style.cursor).toBe("text");
  navigation.dispose();
});

it("uses the latest edited text, deduplicates render listeners, and detaches on unmount", () => {
  const { navigation, navigate, dispatch, node } = setup();
  const edited = { name: "main.as", contents: "// changed\nother();" };
  navigation.attach(node as unknown as HTMLElement, edited);
  navigation.attach(node as unknown as HTMLElement, edited);
  dispatch();
  expect(navigate).toHaveBeenCalledExactlyOnceWith(
    edited,
    edited.contents.indexOf("other"),
    expect.any(Function),
  );
  navigation.attach(node as unknown as HTMLElement, edited, "unmount");
  expect(dispatch().defaultPrevented).toBe(false);
  expect(navigate).toHaveBeenCalledTimes(1);
  navigation.dispose();
});

it("ignores comments and strings but follows include filenames", () => {
  for (const text of ["// helper()", '"helper()"', "/* helper() */"]) {
    const { navigation, navigate, dispatch } = setup(`\n${text}`);
    dispatch();
    expect(navigate).not.toHaveBeenCalled();
    navigation.dispose();
  }
  for (const include of ['"Bee.as"', "<Bee.hpp>"]) {
    const { navigation, navigate, dispatch, file } = setup(`\n#include ${include}`);
    dispatch("click", { clientX: 110 });
    expect(navigate).toHaveBeenCalledExactlyOnceWith(
      file,
      file.contents.indexOf("Bee"),
      expect.any(Function),
    );
    navigation.dispose();
  }
});

it("invalidates pending resolutions after another click, an edit, or disposal", () => {
  const { navigation, navigate, dispatch, node } = setup();
  dispatch();
  const first = navigate.mock.calls[0]![2] as () => boolean;
  expect(first()).toBe(true);
  dispatch();
  const second = navigate.mock.calls[1]![2] as () => boolean;
  expect(first()).toBe(false);
  expect(second()).toBe(true);
  navigation.attach(node as unknown as HTMLElement, {
    name: "main.as",
    contents: "// edited\nhelper();",
  });
  expect(second()).toBe(false);
  dispatch();
  const third = navigate.mock.calls[2]![2] as () => boolean;
  navigation.dispose();
  expect(third()).toBe(false);
});

it("hit-tests a diff row against its selected side and hunk-local line", () => {
  const { navigation, navigate, dispatch, node, row } = setup();
  const oldFile = { name: "code.cpp", contents: "  oldCall();\n" };
  const newFile = { name: "code.cpp", contents: "  newCall();\n" };
  navigation.attach(node as unknown as HTMLElement, (element) => ({
    file: element.dataset.line === "40" ? oldFile : newFile,
    line: 1,
  }));
  row.dataset.line = "40";
  expect(dispatch("click", { clientX: 30 }).defaultPrevented).toBe(true);
  expect(navigate).toHaveBeenLastCalledWith(oldFile, 2, expect.any(Function));
  row.dataset.line = "42";
  dispatch("click", { clientX: 30 });
  expect(navigate).toHaveBeenLastCalledWith(newFile, 2, expect.any(Function));
  navigation.dispose();
});

it("cancels pending navigation when the displayed path changes with identical contents", () => {
  const { navigation, navigate, dispatch, node, file } = setup();
  dispatch();
  const isCurrent = navigate.mock.calls[0]![2] as () => boolean;
  navigation.attach(node as unknown as HTMLElement, { ...file, name: "different.as" });
  expect(isCurrent()).toBe(false);
  navigation.dispose();
});

it("follows tree state names and library filenames, leaving labels and ordinary comments alone", () => {
  const contents =
    "// State tree (generated; update with --check-script <file> --write-tree):\n//   |-- Life::Rest ? (Life.as)\nnamespace Otter {}";
  const { navigation, navigate, dispatch, file } = setup(contents);
  dispatch("click", { clientX: 110 });
  expect(navigate).toHaveBeenLastCalledWith(
    file,
    contents.indexOf("Life::Rest"),
    expect.any(Function),
  );
  dispatch("click", { clientX: 240 });
  expect(navigate).toHaveBeenLastCalledWith(
    file,
    contents.indexOf("Life.as"),
    expect.any(Function),
  );
  expect(dispatch("click", { clientX: 195 }).defaultPrevented).toBe(false);
  navigation.dispose();
  const ordinary = setup("// notes\n//   Rest");
  ordinary.dispatch("click", { clientX: 60 });
  expect(ordinary.navigate).not.toHaveBeenCalled();
  ordinary.navigation.dispose();
});

it("hit-tests a partial tree row before the diff loads its complete revision", () => {
  const { navigation, navigate, dispatch, node, row } = setup();
  const file = { name: "otter.as", contents: "//   |-- Rest ?\n" };
  navigation.attach(node as unknown as HTMLElement, () => ({ file, line: 1, partial: true }));
  row.dataset.line = "10";
  dispatch("click", { clientX: 100 });
  expect(navigate).toHaveBeenCalledExactlyOnceWith(
    file,
    file.contents.indexOf("Rest"),
    expect.any(Function),
  );
  navigation.dispose();
});

it("does not change reference highlighting on pointer hover or intercept ordinary selection", () => {
  vi.useFakeTimers();
  vi.stubGlobal("CSS", { highlights: new Map() });
  vi.stubGlobal("Highlight", Set);
  const { navigation, root, row, dispatch } = setup("int value;\nvalue++;");
  const declarationRow = new ElementStub();
  Object.assign(root, { querySelectorAll: () => [declarationRow, row] });
  dispatch("pointermove", { metaKey: false });
  vi.advanceTimersByTime(100);
  expect(CSS.highlights.has("as-reference")).toBe(false);
  expect(dispatch("pointerdown", { metaKey: false }).defaultPrevented).toBe(false);
  dispatch("pointermove", { metaKey: false, clientX: 200 });
  expect(CSS.highlights.has("as-reference")).toBe(false);
  navigation.dispose();
});
