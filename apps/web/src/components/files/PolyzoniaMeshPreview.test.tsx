import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { ComponentProps, ReactNode } from "react";
import { Select } from "~/components/ui/select";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { parsePolyzoniaMesh } from "@t3tools/client-runtime/polyzonia-mesh";
import { PolyzoniaMeshPreview } from "./PolyzoniaMeshPreview";

vi.mock("~/components/ui/button", () => ({
  Button: (props: ComponentProps<"button">) => <button {...props} />,
}));
vi.mock("~/components/ui/toggle", () => ({
  Toggle: ({
    pressed,
    onPressedChange,
    ...props
  }: ComponentProps<"button"> & {
    pressed: boolean;
    onPressedChange: (pressed: boolean) => void;
  }) => <button {...props} aria-pressed={pressed} onClick={() => onPressedChange(!pressed)} />,
}));

// Keep the canvas/playback test independent of the shared dropdown's DOM portal.
vi.mock("~/components/ui/select", () => ({
  Select: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectTrigger: ({ children }: { children: ReactNode }) => <button>{children}</button>,
  SelectValue: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  SelectPopup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectItem: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  await act(() => renderer?.unmount());
  vi.unstubAllGlobals();
});

function canvasFixture() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", { devicePixelRatio: 1 });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private callback: (entries: unknown[]) => void) {}
      observe() {
        this.callback([{ contentRect: { width: 264, height: 264 } }]);
      }
      disconnect() {}
    },
  );
  const context = {
    setTransform: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    closePath: vi.fn(),
    fill: vi.fn(),
    stroke: vi.fn(),
    arc: vi.fn(),
    strokeRect: vi.fn(),
  };
  const canvas = {
    getContext: () => context,
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
    focus: vi.fn(),
    setPointerCapture: vi.fn(),
    width: 0,
    height: 0,
  };
  return { context, canvas };
}

it("draws deformed geometry through pointer interaction, hides overlays, and resets the pose", async () => {
  const { context, canvas } = canvasFixture();
  const mesh = parsePolyzoniaMesh(
    "mesh.json",
    JSON.stringify({
      vertices: [
        { x: 0, y: 0 },
        { x: 20, y: 0 },
        { x: 0, y: 20 },
      ],
      layers: [{ triangles: [{ indices: [0, 1, 2], color: { x: 1, y: 0, z: 0, w: 1 } }] }],
      joints: [{ name: "Root", parentI: -1, position: { x: 0, y: 0 } }],
      weights: [0, 1, 2].map(() => ({ jointWeights: [{ jointI: 0, value: 1 }] })),
    }),
  )!;
  await act(() => {
    renderer = create(<PolyzoniaMeshPreview mesh={mesh} />, {
      createNodeMock: (element) => (element.type === "canvas" ? canvas : {}),
    });
  });
  // A 20-unit mesh fits in the 200px area inside 32px margins.
  expect(context.moveTo).toHaveBeenLastCalledWith(32, 32);
  const pointer = () => renderer!.root.findByType("canvas");
  await act(() =>
    pointer().props.onPointerDown({
      button: 0,
      pointerId: 1,
      pointerType: "mouse",
      clientX: 32,
      clientY: 32,
      currentTarget: canvas,
    }),
  );
  await act(() => pointer().props.onPointerMove({ pointerId: 1, clientX: 72, clientY: 62 }));
  expect(context.moveTo).toHaveBeenLastCalledWith(72, 62);
  await act(() => pointer().props.onPointerUp());
  const button = (text: string) =>
    renderer!.root.findAllByType("button").find((node) => node.children.includes(text))!;
  await act(() => button("Joints").props.onClick());
  context.arc.mockClear();
  await act(() => button("Fit").props.onClick());
  expect(context.arc).not.toHaveBeenCalled();
  await act(() => button("Vertices").props.onClick());
  expect(context.arc).toHaveBeenCalledTimes(3);
  await act(() => button("Reset pose").props.onClick());
  expect(context.moveTo).toHaveBeenLastCalledWith(32, 32);
  expect(mesh.vertices[0]).toEqual({ x: 0, y: 0 });
});

it("bends a leg when dragging its IK handle and restores direct rotation when IK is disabled", async () => {
  const { context, canvas } = canvasFixture();
  const mesh = parsePolyzoniaMesh(
    "leg.json",
    JSON.stringify({
      vertices: [
        { x: 0, y: 0 },
        { x: 20, y: 0 },
        { x: 0, y: 20 },
      ],
      layers: [{ triangles: [{ indices: [0, 1, 2], color: { x: 1, y: 0, z: 0, w: 1 } }] }],
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
  await act(() => {
    renderer = create(<PolyzoniaMeshPreview mesh={mesh} />, {
      createNodeMock: (element) => (element.type === "canvas" ? canvas : {}),
    });
  });
  const pointer = () => renderer!.root.findByType("canvas");
  const button = (text: string) =>
    renderer!.root.findAllByType("button").find((node) => node.children.includes(text))!;
  const dragFoot = async () => {
    await act(() =>
      pointer().props.onPointerDown({
        button: 0,
        pointerId: 1,
        pointerType: "mouse",
        clientX: 232,
        clientY: 32,
        currentTarget: canvas,
      }),
    );
    context.lineTo.mockClear();
    await act(() => pointer().props.onPointerMove({ pointerId: 1, clientX: 132, clientY: 132 }));
    await act(() => pointer().props.onPointerUp());
  };
  await dragFoot();
  // The third vertex belongs to the upper leg, which rotates 90° under IK.
  expect(context.lineTo.mock.calls[1]![0]).toBeCloseTo(-168);
  expect(context.lineTo.mock.calls[1]![1]).toBeCloseTo(32);
  await act(() => button("Reset pose").props.onClick());
  await act(() => button("IK").props.onClick());
  await dragFoot();
  // Direct foot rotation leaves the upper leg's vertex in its original position.
  expect(context.lineTo.mock.calls[1]).toEqual([32, 232]);
});

it("scrubs and plays animation geometry, stops at the end, and does no background or paused work", async () => {
  const { context, canvas } = canvasFixture();
  const doc = Object.assign(new EventTarget(), { hidden: false });
  vi.stubGlobal("document", doc);
  let sequence = 0;
  const callbacks = new Map<number, FrameRequestCallback>();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callbacks.set(++sequence, callback);
    return sequence;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => callbacks.delete(id));
  const tick = async (now: number) => {
    const pending = [...callbacks.values()];
    callbacks.clear();
    await act(() => {
      pending.forEach((callback) => callback(now));
    });
  };
  const vertices = [
    { x: 0, y: 0 },
    { x: 20, y: 0 },
    { x: 0, y: 20 },
  ];
  const mesh = parsePolyzoniaMesh(
    "swim.json",
    JSON.stringify({
      vertices,
      layers: [{ triangles: [{ indices: [0, 1, 2], color: { x: 1, y: 0, z: 0, w: 1 } }] }],
      vertexAnimations: [
        {
          name: "Swim",
          duration: 2,
          keyframes: [
            { t: 0, vertices },
            { t: 1, vertices: vertices.map((p) => ({ x: p.x + 10, y: p.y })) },
          ],
        },
      ],
    }),
  )!;
  await act(() => {
    renderer = create(<PolyzoniaMeshPreview mesh={mesh} />, {
      createNodeMock: (element) => (element.type === "canvas" ? canvas : {}),
    });
  });
  const select = (label: string) =>
    renderer!.root.findAllByType(Select)[label === "Mesh animation" ? 0 : 1]!;
  const button = (text: string) =>
    renderer!.root.findAllByType("button").find((node) => node.children.includes(text))!;
  await act(() => select("Mesh animation").props.onValueChange("vertex:0"));
  expect(callbacks.size).toBe(0);
  await act(() => renderer!.root.findByType("input").props.onChange({ target: { value: "0.5" } }));
  expect(context.moveTo).toHaveBeenLastCalledWith(82, 32);
  await act(() => button("Play").props.onClick());
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
  await act(() => button("Pause").props.onClick());
  expect(callbacks.size).toBe(0);
  await act(() => button("Loop").props.onClick());
  await act(() => button("Play").props.onClick());
  await tick(1000);
  await tick(4000);
  expect(context.moveTo).toHaveBeenLastCalledWith(132, 32);
  expect(callbacks.size).toBe(0);
  expect(button("Play")).toBeDefined();
  await act(() => select("Playback speed").props.onValueChange(2));
  await act(() => button("Play").props.onClick());
  await tick(5000);
  await act(() => {
    doc.hidden = true;
    doc.dispatchEvent(new Event("visibilitychange"));
  });
  expect(callbacks.size).toBe(0);
  await act(() => {
    doc.hidden = false;
    doc.dispatchEvent(new Event("visibilitychange"));
  });
  await tick(50000);
  await tick(50250);
  // Resuming does not count the hidden time; 0.25 seconds at 2× advances 0.5 seconds.
  expect(context.moveTo).toHaveBeenLastCalledWith(82, 32);
  await act(() => select("Mesh animation").props.onValueChange(""));
  expect(context.moveTo).toHaveBeenLastCalledWith(32, 32);
  expect(callbacks.size).toBe(0);
  await act(() => select("Mesh animation").props.onValueChange("vertex:0"));
  await act(() => button("Play").props.onClick());
  await act(() => renderer!.update(<PolyzoniaMeshPreview mesh={{ ...mesh }} />));
  expect(callbacks.size).toBe(0);
  expect(select("Mesh animation").props.value).toBe("");
});
