import { afterEach, expect, it, vi } from "vite-plus/test";
import { createFileScrollMemory, getFileScrollPosition } from "./fileScrollMemory";

class ScrollContainer extends EventTarget {
  scrollTop = 0;
  scrollLeft = 0;
  clientHeight = 600;
  isConnected = true;
}
let sequence = 0;
function setup() {
  const key = `file-scroll-${++sequence}`;
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++frameId, callback);
    return frameId;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  const tick = () => {
    const queued = [...frames.values()];
    frames.clear();
    for (const callback of queued) callback(0);
  };
  const settle = () => {
    for (let i = 0; i < 35; i++) tick();
    expect(frames.size).toBe(0);
  };
  const mount = (requestId = 0, hasReveal = false, targetKey = key) => {
    const container = new ScrollContainer();
    const node = { closest: () => container, style: { minHeight: "" } };
    const memory = createFileScrollMemory(targetKey, requestId, hasReveal);
    memory.attach(node as unknown as HTMLElement, 100_000);
    const scroll = (top: number, left = 0) => {
      container.scrollTop = top;
      container.scrollLeft = left;
      container.dispatchEvent(new Event("scroll"));
    };
    return { container, node, memory, scroll };
  };
  return { key, mount, tick, settle };
}
afterEach(() => vi.unstubAllGlobals());

it("restores both offsets through repeated file tab mounts and late layout resets", () => {
  const { mount, tick, settle } = setup();
  const first = mount();
  first.scroll(48_765, 125);
  first.memory.dispose();
  const second = mount();
  tick();
  expect(second.container.scrollTop).toBe(48_765);
  second.scroll(0); // A late editor restore must not erase the saved position.
  settle();
  expect(second.container.scrollTop).toBe(48_765);
  expect(second.container.scrollLeft).toBe(125);
  expect(second.node.style.minHeight).toBe("100000px");
  second.scroll(21_234, 45);
  second.memory.dispose();
  const third = mount();
  settle();
  expect(third.container.scrollTop).toBe(21_234);
  expect(third.container.scrollLeft).toBe(45);
  third.memory.dispose();
});

it("restores a visited definition but lets a fresh jump replace the saved position", () => {
  const { key, mount, settle } = setup();
  const first = mount(1, true);
  first.scroll(87_100);
  first.memory.dispose();
  expect(getFileScrollPosition(key)?.revealRequestId).toBe(1);
  const tabReturn = mount(1, true);
  settle();
  expect(tabReturn.container.scrollTop).toBe(87_100);
  tabReturn.memory.dispose();
  const newJump = mount(2, true);
  newJump.scroll(34_500);
  settle();
  expect(newJump.container.scrollTop).toBe(34_500);
  expect(getFileScrollPosition(key)?.revealRequestId).toBe(2);
  newJump.memory.dispose();
});

it.each(["wheel", "pointerdown", "keydown", "touchstart"])(
  "yields restoration to %s and saves subsequent scrolling",
  (event) => {
    const { mount, tick, settle } = setup();
    const first = mount();
    first.scroll(4_000);
    first.memory.dispose();
    const second = mount();
    tick();
    second.container.dispatchEvent(new Event(event));
    second.scroll(6_000);
    settle();
    expect(second.container.scrollTop).toBe(6_000);
    second.memory.dispose();
    const third = mount();
    settle();
    expect(third.container.scrollTop).toBe(6_000);
    third.memory.dispose();
  },
);

it("keeps workspace/file keys separate and ignores detached teardown geometry", () => {
  const { mount, settle } = setup();
  const first = mount();
  first.scroll(20_000);
  first.container.isConnected = false;
  first.scroll(0);
  first.memory.dispose();
  const other = mount(0, false, "other-workspace-file");
  settle();
  expect(other.container.scrollTop).toBe(0);
  other.memory.dispose();
  const returning = mount();
  settle();
  expect(returning.container.scrollTop).toBe(20_000);
  returning.memory.dispose();
});

it("preserves an unrestored bookmark when a tab is switched away immediately", () => {
  const { mount, settle } = setup();
  const first = mount();
  first.scroll(15_000);
  first.memory.dispose();
  mount().memory.dispose();
  const returning = mount();
  settle();
  expect(returning.container.scrollTop).toBe(15_000);
  returning.memory.dispose();
});
