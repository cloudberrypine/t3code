import type { ComponentProps, ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { parsePolyzoniaMesh } from "@t3tools/client-runtime/polyzonia-mesh";

import { act, render, stubGlobal, type Screen } from "../../../test/render";
import { PolyzoniaMeshPreview } from "./PolyzoniaMeshPreview";

vi.mock("~/components/ui/button", () => ({
  Button: (props: ComponentProps<"button">) => <button type="button" {...props} />,
}));
vi.mock("~/components/ui/toggle", () => ({
  Toggle: ({
    pressed,
    onPressedChange,
    ...props
  }: ComponentProps<"button"> & {
    pressed: boolean;
    onPressedChange: (pressed: boolean) => void;
  }) => (
    <button
      type="button"
      {...props}
      aria-pressed={pressed}
      onClick={() => onPressedChange(!pressed)}
    />
  ),
}));

// Keep the canvas/playback test independent of the shared dropdown's DOM portal: each Select
// reports its latest props under its trigger's label.
interface SelectProps {
  readonly value: unknown;
  readonly onValueChange: (value: unknown) => void;
  readonly children?: ReactNode;
}
const selects = vi.hoisted(() => new Map<string, SelectProps>());
vi.mock("~/components/ui/select", async () => {
  const { createContext, use } = await import("react");
  const Current = createContext<SelectProps | null>(null);
  return {
    Select: (props: SelectProps) => <Current value={props}>{props.children}</Current>,
    SelectTrigger: (props: { "aria-label"?: string; children?: ReactNode }) => {
      const select = use(Current);
      if (select && props["aria-label"]) selects.set(props["aria-label"], select);
      return <button type="button">{props.children}</button>;
    },
    SelectValue: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
    SelectPopup: () => null,
    SelectItem: () => null,
  };
});

/** Canvas spies and a fixed 264px viewport for one test: `using fixture = canvasFixture()`. */
function canvasFixture() {
  selects.clear();
  const disposables: Disposable[] = [
    stubGlobal(
      "ResizeObserver",
      class {
        constructor(private callback: (entries: unknown[]) => void) {}
        observe() {
          this.callback([{ contentRect: { width: 264, height: 264 } }]);
        }
        disconnect() {}
      },
    ),
  ];
  const proto = CanvasRenderingContext2D.prototype;
  const context = {
    moveTo: vi.spyOn(proto, "moveTo"),
    lineTo: vi.spyOn(proto, "lineTo"),
    arc: vi.spyOn(proto, "arc"),
  };
  disposables.push(
    context.moveTo,
    context.lineTo,
    context.arc,
    vi
      .spyOn(HTMLCanvasElement.prototype, "getBoundingClientRect")
      .mockReturnValue(new DOMRect(0, 0, 264, 264)),
    // A synthetic pointer id has no active pointer to capture.
    vi.spyOn(Element.prototype, "setPointerCapture").mockImplementation(() => {}),
  );
  return {
    context,
    [Symbol.dispose]() {
      for (const disposable of disposables.toReversed()) disposable[Symbol.dispose]();
    },
  };
}

function controls(screen: Screen) {
  const canvas = () => screen.container.querySelector("canvas")!;
  const pointer = (type: string, clientX: number, clientY: number) =>
    act(() => {
      canvas().dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          button: 0,
          pointerId: 1,
          pointerType: "mouse",
          clientX,
          clientY,
        }),
      );
    });
  const button = (text: string) =>
    [...screen.container.querySelectorAll("button")].find(
      (node) => node.textContent === text || node.getAttribute("aria-label") === text,
    )!;
  const click = (text: string) =>
    act(() => {
      button(text).click();
    });
  const select = (label: string, value: unknown) =>
    act(() => {
      selects.get(label)!.onValueChange(value);
    });
  return { canvas, pointer, button, click, select };
}

const triangle = [
  { x: 0, y: 0 },
  { x: 20, y: 0 },
  { x: 0, y: 20 },
];
const red = { x: 1, y: 0, z: 0, w: 1 };

it("draws deformed geometry through pointer interaction, hides overlays, and resets the pose", async () => {
  using fixture = canvasFixture();
  const { context } = fixture;
  const mesh = parsePolyzoniaMesh(
    "mesh.json",
    JSON.stringify({
      vertices: triangle,
      layers: [{ triangles: [{ indices: [0, 1, 2], color: red }] }],
      joints: [{ name: "Root", parentI: -1, position: { x: 0, y: 0 } }],
      weights: [0, 1, 2].map(() => ({ jointWeights: [{ jointI: 0, value: 1 }] })),
    }),
  )!;
  await using screen = await render(<PolyzoniaMeshPreview mesh={mesh} />, { router: false });
  const ui = controls(screen);
  // A 20-unit mesh fits in the 200px area inside 32px margins.
  expect(context.moveTo).toHaveBeenLastCalledWith(32, 32);
  await ui.pointer("pointerdown", 32, 32);
  await ui.pointer("pointermove", 72, 62);
  expect(context.moveTo).toHaveBeenLastCalledWith(72, 62);
  await ui.pointer("pointerup", 72, 62);
  await ui.click("Joints");
  context.arc.mockClear();
  await ui.click("Fit");
  expect(context.arc).not.toHaveBeenCalled();
  await ui.click("Vertices");
  expect(context.arc).toHaveBeenCalledTimes(3);
  await ui.click("Reset pose");
  expect(context.moveTo).toHaveBeenLastCalledWith(32, 32);
  expect(mesh.vertices[0]).toEqual({ x: 0, y: 0 });
});

it("bends a leg when dragging its IK handle and restores direct rotation when IK is disabled", async () => {
  using fixture = canvasFixture();
  const { context } = fixture;
  const mesh = parsePolyzoniaMesh(
    "leg.json",
    JSON.stringify({
      vertices: triangle,
      layers: [{ triangles: [{ indices: [0, 1, 2], color: red }] }],
      joints: [
        { name: "Hip", parentI: -1, position: { x: 0, y: 0 } },
        { name: "Knee", parentI: 0, position: { x: 10, y: 0 } },
        { name: "Foot", parentI: 1, position: { x: 20, y: 0 } },
      ],
      weights: [1, 2, 1].map((jointI) => ({ jointWeights: [{ jointI, value: 1 }] })),
      ikHandles: [
        {
          startJointI: 0,
          midJointI: 1,
          endJointI: 2,
          rootToMidLength: 10,
          midToTipLength: 10,
          midJointIsLeftOfLine: true,
        },
      ],
    }),
  )!;
  await using screen = await render(<PolyzoniaMeshPreview mesh={mesh} />, { router: false });
  const ui = controls(screen);
  const dragFoot = async () => {
    await ui.pointer("pointerdown", 232, 32);
    context.lineTo.mockClear();
    await ui.pointer("pointermove", 132, 132);
    await ui.pointer("pointerup", 132, 132);
  };
  await dragFoot();
  // The third vertex belongs to the upper leg, which rotates 90° under IK.
  expect(context.lineTo.mock.calls[1]![0]).toBeCloseTo(-168);
  expect(context.lineTo.mock.calls[1]![1]).toBeCloseTo(32);
  await ui.click("Reset pose");
  await ui.click("Inverse kinematics");
  await dragFoot();
  // Direct foot rotation leaves the upper leg's vertex in its original position.
  expect(context.lineTo.mock.calls[1]).toEqual([32, 232]);
});

it("scrubs and plays animation geometry, stops at the end, and does no background or paused work", async () => {
  using fixture = canvasFixture();
  const { context } = fixture;
  let hidden = false;
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
  let sequence = 0;
  const callbacks = new Map<number, FrameRequestCallback>();
  using _requestFrame = stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callbacks.set(++sequence, callback);
    return sequence;
  });
  using _cancelFrame = stubGlobal("cancelAnimationFrame", (id: number) => callbacks.delete(id));
  const tick = async (now: number) => {
    const pending = [...callbacks.values()];
    callbacks.clear();
    await act(() => {
      pending.forEach((callback) => callback(now));
    });
  };
  const mesh = parsePolyzoniaMesh(
    "swim.json",
    JSON.stringify({
      vertices: triangle,
      layers: [{ triangles: [{ indices: [0, 1, 2], color: red }] }],
      vertexAnimations: [
        {
          name: "Swim",
          duration: 2,
          keyframes: [
            { t: 0, vertices: triangle },
            { t: 1, vertices: triangle.map((p) => ({ x: p.x + 10, y: p.y })) },
          ],
        },
      ],
    }),
  )!;
  try {
    await using screen = await render(<PolyzoniaMeshPreview mesh={mesh} />, { router: false });
    const ui = controls(screen);
    await ui.select("Mesh animation", "vertex:0");
    expect(callbacks.size).toBe(0);
    const position = screen.container.querySelector<HTMLInputElement>(
      'input[aria-label="Animation position"]',
    )!;
    await act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        position,
        "0.5",
      );
      position.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(context.moveTo).toHaveBeenLastCalledWith(82, 32);
    await ui.click("Play");
    await tick(0);
    // Both 120Hz and 60Hz display frames must update the same geometry as scrubbing.
    for (const now of [1000 / 120, 1000 / 60, 25, 1000 / 30]) {
      context.moveTo.mockClear();
      await tick(now);
      expect(context.moveTo).toHaveBeenCalledTimes(1);
      expect(context.moveTo.mock.calls[0]![0]).toBeCloseTo(82 + now / 10);
      expect(context.moveTo.mock.calls[0]![1]).toBe(32);
    }
    await tick(250);
    expect(context.moveTo.mock.lastCall![0]).toBeCloseTo(107);
    expect(context.moveTo.mock.lastCall![1]).toBe(32);
    await ui.click("Pause");
    expect(callbacks.size).toBe(0);
    await ui.click("Loop");
    await ui.click("Play");
    await tick(1000);
    await tick(4000);
    expect(context.moveTo).toHaveBeenLastCalledWith(132, 32);
    expect(callbacks.size).toBe(0);
    expect(ui.button("Play")).toBeDefined();
    await ui.select("Playback speed", 2);
    await ui.click("Play");
    await tick(5000);
    await act(() => {
      hidden = true;
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(callbacks.size).toBe(0);
    await act(() => {
      hidden = false;
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await tick(50000);
    await tick(50250);
    // Resuming does not count the hidden time; 0.25 seconds at 2× advances 0.5 seconds.
    expect(context.moveTo).toHaveBeenLastCalledWith(82, 32);
    await ui.select("Mesh animation", "");
    expect(context.moveTo).toHaveBeenLastCalledWith(32, 32);
    expect(callbacks.size).toBe(0);
    await ui.select("Mesh animation", "vertex:0");
    await ui.click("Play");
    await screen.rerender(<PolyzoniaMeshPreview mesh={{ ...mesh }} />);
    expect(callbacks.size).toBe(0);
    expect(selects.get("Mesh animation")!.value).toBe("");
  } finally {
    // The page's own property comes back once the override is removed.
    delete (document as { hidden?: boolean }).hidden;
  }
});

it("leaves the wheel to the page when embedded and zooms with its buttons", async () => {
  using fixture = canvasFixture();
  const { context } = fixture;
  const mesh = parsePolyzoniaMesh(
    "mesh.json",
    JSON.stringify({
      vertices: triangle,
      layers: [{ triangles: [{ indices: [0, 1, 2], color: red }] }],
    }),
  )!;
  await using screen = await render(<PolyzoniaMeshPreview mesh={mesh} wheelZoom={false} />, {
    router: false,
  });
  const ui = controls(screen);
  expect(context.moveTo).toHaveBeenLastCalledWith(32, 32);
  await act(() => {
    ui.canvas().dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -500 }));
  });
  expect(context.moveTo).toHaveBeenLastCalledWith(32, 32);
  await ui.click("Zoom in");
  expect(context.moveTo).not.toHaveBeenLastCalledWith(32, 32);
});
