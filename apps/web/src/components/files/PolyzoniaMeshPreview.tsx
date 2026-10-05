import { useMeshAnimation } from "./useMeshAnimation";
import { MeshAnimationControls } from "./MeshAnimationControls";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  dragMeshJoint,
  meshBounds,
  meshColor,
  meshViewport,
  skinMesh,
  type MeshJoint,
  type MeshPoint,
  type PolyzoniaMesh,
} from "@t3tools/client-runtime/polyzonia-mesh";
import { Button } from "~/components/ui/button";
import { Toggle } from "~/components/ui/toggle";

export function PolyzoniaMeshPreview({ mesh }: { mesh: PolyzoniaMesh }) {
  const animation = useMeshAnimation(mesh);
  const [showVertices, setShowVertices] = useState(false);
  const [showJoints, setShowJoints] = useState(true);
  const [ikEnabled, setIkEnabled] = useState(true);
  const ikEndJoints = useMemo(
    () => new Set(ikEnabled ? mesh.ikHandles.map((handle) => handle.endJointI) : []),
    [mesh, ikEnabled],
  );
  const [poseState, setPose] = useState({ mesh, joints: mesh.joints });
  const pose =
    animation.sample?.joints ?? (poseState.mesh === mesh ? poseState.joints : mesh.joints);
  const [selected, setSelected] = useState<number | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [size, setSize] = useState({ width: 1, height: 1 });
  const canvas = useRef<HTMLCanvasElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const drag = useRef<{
    pointerId: number;
    mesh: PolyzoniaMesh;
    index: number | null;
    joints: readonly MeshJoint[];
    start: MeshPoint;
    pan: MeshPoint;
    offset: MeshPoint;
  } | null>(null);
  const bounds = useMemo(() => meshBounds(mesh), [mesh]);
  const vertices = useMemo(
    () => animation.sample?.vertices ?? skinMesh(mesh, pose),
    [animation.sample, mesh, pose],
  );
  const fit = meshViewport(bounds, size.width, size.height, zoom);
  const view = { ...fit, x: fit.x + pan.x, y: fit.y + pan.y };
  const colors = useMemo(
    () => mesh.layers.flatMap((layer) => layer.triangles.map((t) => meshColor(t.color))),
    [mesh],
  );

  useEffect(() => {
    const element = surface.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // Draw only when geometry, controls, or viewport change; no idle animation loop.
  useEffect(() => {
    const element = canvas.current;
    const context = element?.getContext("2d");
    if (!element || !context) return;
    const ratio = window.devicePixelRatio || 1;
    element.width = Math.max(1, Math.round(size.width * ratio));
    element.height = Math.max(1, Math.round(size.height * ratio));
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    const screen = (p: MeshPoint) => ({
      x: p.x * view.scale + view.x,
      y: p.y * view.scale + view.y,
    });
    let triangleIndex = 0;
    for (const layer of mesh.layers)
      for (const triangle of layer.triangles) {
        context.beginPath();
        triangle.indices.forEach((index, corner) => {
          const p = screen(vertices[index]!);
          if (corner === 0) context.moveTo(p.x, p.y);
          else context.lineTo(p.x, p.y);
        });
        context.closePath();
        context.fillStyle = colors[triangleIndex++]!;
        context.fill();
      }
    const circle = (p: MeshPoint, radius: number, fill: string) => {
      const point = screen(p);
      context.beginPath();
      context.arc(point.x, point.y, radius, 0, Math.PI * 2);
      context.fillStyle = fill;
      context.fill();
      context.strokeStyle = "#18181b";
      context.lineWidth = 1;
      context.stroke();
    };
    if (showVertices) for (const vertex of vertices) circle(vertex, 2.5, "#f87171");
    if (showJoints) {
      for (const joint of pose) {
        const parent = pose[joint.parentI];
        if (!parent) continue;
        const a = screen(parent.position),
          b = screen(joint.position);
        context.beginPath();
        context.moveTo(a.x, a.y);
        context.lineTo(b.x, b.y);
        context.strokeStyle = "#18181b";
        context.lineWidth = 4;
        context.stroke();
        context.strokeStyle = "#fbbf24";
        context.lineWidth = 2;
        context.stroke();
      }
      pose.forEach((joint, i) => {
        const isHandle = ikEndJoints.has(i);
        circle(
          joint.position,
          i === selected ? 7 : 5,
          i === selected ? "#fff" : isHandle ? "#38bdf8" : "#fbbf24",
        );
        if (isHandle) {
          const p = screen(joint.position);
          context.strokeStyle = "#38bdf8";
          context.strokeRect(p.x - 9, p.y - 9, 18, 18);
        }
      });
    }
  }, [
    mesh,
    vertices,
    pose,
    colors,
    selected,
    showJoints,
    ikEndJoints,
    showVertices,
    size,
    view.x,
    view.y,
    view.scale,
  ]);

  const localPoint = (event: { clientX: number; clientY: number }) => {
    const rect = canvas.current!.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };
  const worldPoint = (p: MeshPoint) => ({
    x: (p.x - view.x) / view.scale,
    y: (p.y - view.y) / view.scale,
  });
  const reset = () => {
    drag.current = null;
    animation.select("");
    setPose({ mesh, joints: mesh.joints });
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <MeshAnimationControls animation={animation} />
      <div className="flex flex-wrap items-center gap-1 border-b border-border/60 px-3 py-1.5">
        <Toggle size="sm" pressed={showVertices} onPressedChange={setShowVertices}>
          Vertices
        </Toggle>
        <Toggle
          size="sm"
          pressed={showJoints}
          onPressedChange={setShowJoints}
          disabled={!mesh.joints.length}
        >
          Joints
        </Toggle>
        {mesh.ikHandles.length > 0 && (
          <Toggle
            size="sm"
            pressed={ikEnabled}
            onPressedChange={setIkEnabled}
            disabled={!mesh.canSkin || animation.clip !== null}
            aria-label="Inverse kinematics"
          >
            IK
          </Toggle>
        )}
        <Button
          size="sm"
          variant="ghost"
          onClick={reset}
          disabled={!mesh.canSkin && !animation.clip}
        >
          Reset pose
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            setPan({ x: 0, y: 0 });
            setZoom(1);
          }}
        >
          Fit
        </Button>
        <span className="ml-auto text-[11px] text-muted-foreground">
          {mesh.vertices.length} vertices · {colors.length} triangles
        </span>
      </div>
      <div ref={surface} className="relative min-h-0 flex-1 overflow-hidden bg-muted/30">
        <canvas
          ref={canvas}
          className="absolute inset-0 size-full touch-none outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          tabIndex={0}
          aria-label="Mesh preview. Drag joints to pose, drag background to pan, scroll to zoom. Select a joint and use arrow keys to pose; Escape resets."
          onPointerDown={(event) => {
            if (event.button !== 0 || drag.current) return;
            event.currentTarget.focus();
            const point = localPoint(event);
            let index: number | null = null,
              distance = event.pointerType === "touch" ? 24 : 12;
            if (showJoints && mesh.canSkin && !animation.clip)
              pose.forEach((joint, i) => {
                const d = Math.hypot(
                  joint.position.x * view.scale + view.x - point.x,
                  joint.position.y * view.scale + view.y - point.y,
                );
                if (d < distance) {
                  index = i;
                  distance = d;
                }
              });
            setSelected(index);
            const p = worldPoint(point);
            const joint = index === null ? null : pose[index];
            drag.current = {
              pointerId: event.pointerId,
              mesh,
              index,
              joints: pose,
              start: point,
              pan,
              offset: joint
                ? { x: joint.position.x - p.x, y: joint.position.y - p.y }
                : { x: 0, y: 0 },
            };
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            const current = drag.current;
            if (
              !current ||
              current.pointerId !== event.pointerId ||
              current.mesh !== mesh ||
              (current.index !== null && animation.clip)
            )
              return;
            const point = localPoint(event);
            if (current.index === null)
              setPan({
                x: current.pan.x + point.x - current.start.x,
                y: current.pan.y + point.y - current.start.y,
              });
            else {
              const p = worldPoint(point);
              setPose({
                mesh,
                joints: dragMeshJoint(
                  current.joints,
                  current.index,
                  {
                    x: p.x + current.offset.x,
                    y: p.y + current.offset.y,
                  },
                  ikEnabled ? mesh.ikHandles : [],
                ),
              });
            }
          }}
          onPointerUp={() => {
            drag.current = null;
          }}
          onPointerCancel={() => {
            drag.current = null;
          }}
          onLostPointerCapture={() => {
            drag.current = null;
          }}
          onWheel={(event) => {
            if (!drag.current)
              setZoom((value) =>
                Math.max(0.1, Math.min(20, value * Math.exp(-event.deltaY * 0.001))),
              );
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              reset();
              return;
            }
            const step = (event.shiftKey ? 10 : 2) / view.scale;
            const delta = {
              ArrowLeft: [-step, 0],
              ArrowRight: [step, 0],
              ArrowUp: [0, -step],
              ArrowDown: [0, step],
            }[event.key];
            if (!delta || selected === null || !showJoints || !mesh.canSkin || animation.clip)
              return;
            event.preventDefault();
            event.stopPropagation();
            const joint = pose[selected];
            if (joint)
              setPose({
                mesh,
                joints: dragMeshJoint(
                  pose,
                  selected,
                  {
                    x: joint.position.x + delta[0]!,
                    y: joint.position.y + delta[1]!,
                  },
                  ikEnabled ? mesh.ikHandles : [],
                ),
              });
          }}
        />
      </div>
      <div className="shrink-0 border-t border-border/60 px-3 py-1.5 text-[11px] text-muted-foreground">
        {selected !== null && pose[selected]
          ? `${pose[selected]!.name || `Joint ${selected}`} · `
          : ""}
        {mesh.canSkin
          ? "Drag joints to pose · "
          : mesh.joints.length
            ? "No skinning weights · "
            : ""}
        {ikEndJoints.size > 0 ? "Drag square IK handles to bend limbs · " : ""}
        Drag background to pan · Scroll to zoom · Preview only
      </div>
    </div>
  );
}
