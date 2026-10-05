import { useMeshAnimation } from "./useMeshAnimation";
import { MeshAnimationControls } from "./MeshAnimationControls";
// Mesh indices are stable identities: posing never inserts or reorders geometry.
/* oxlint-disable react/no-array-index-key */
import { useMemo, useRef, useState } from "react";
import { Pressable, View } from "react-native";
import Svg, { Circle, G, Line, Polygon, Rect } from "react-native-svg";
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
import { AppText as Text } from "../../components/AppText";

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
  const [size, setSize] = useState({ width: 1, height: 1 });
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [selected, setSelected] = useState<number | null>(null);
  const drag = useRef<{
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
  const triangles = useMemo(
    () =>
      mesh.layers.flatMap((layer) =>
        layer.triangles.map((triangle) => ({ ...triangle, fill: meshColor(triangle.color) })),
      ),
    [mesh],
  );
  const fit = meshViewport(bounds, size.width, size.height, zoom);
  const view = { ...fit, x: fit.x + pan.x, y: fit.y + pan.y };
  const screen = (p: MeshPoint) => ({ x: p.x * view.scale + view.x, y: p.y * view.scale + view.y });
  const world = (p: MeshPoint) => ({
    x: (p.x - view.x) / view.scale,
    y: (p.y - view.y) / view.scale,
  });
  const controls = [
    { label: "Vertices", selected: showVertices, run: () => setShowVertices(!showVertices) },
    {
      label: "Joints",
      selected: showJoints,
      disabled: !mesh.joints.length,
      run: () => setShowJoints(!showJoints),
    },
    ...(mesh.ikHandles.length
      ? [
          {
            label: "IK",
            accessibilityLabel: "Inverse kinematics",
            selected: ikEnabled,
            disabled: !mesh.canSkin || animation.clip !== null,
            run: () => setIkEnabled(!ikEnabled),
          },
        ]
      : []),
    {
      label: "Reset pose",
      disabled: !mesh.canSkin && !animation.clip,
      run: () => {
        animation.select("");
        setPose({ mesh, joints: mesh.joints });
      },
    },
    {
      label: "Fit",
      run: () => {
        setZoom(1);
        setPan({ x: 0, y: 0 });
      },
    },
    { label: "−", accessibilityLabel: "Zoom out", run: () => setZoom(Math.max(0.1, zoom / 1.25)) },
    { label: "+", accessibilityLabel: "Zoom in", run: () => setZoom(Math.min(20, zoom * 1.25)) },
  ];
  return (
    <View className="flex-1 bg-sheet">
      <MeshAnimationControls animation={animation} />
      <View className="flex-row flex-wrap gap-1 border-b border-border px-2 py-1">
        {controls.map((control) => (
          <Pressable
            key={control.label}
            accessibilityRole="button"
            accessibilityLabel={control.accessibilityLabel ?? control.label}
            accessibilityState={{
              ...(control.selected === undefined ? {} : { selected: control.selected }),
              disabled: control.disabled ?? false,
            }}
            disabled={control.disabled}
            onPress={control.run}
            className={`min-h-11 justify-center rounded-lg px-3 ${control.selected ? "bg-surface" : ""} ${control.disabled ? "opacity-40" : ""}`}
          >
            <Text className="text-xs text-foreground">{control.label}</Text>
          </Pressable>
        ))}
      </View>
      <View
        className="flex-1 overflow-hidden"
        onLayout={(event) =>
          setSize({
            width: event.nativeEvent.layout.width,
            height: event.nativeEvent.layout.height,
          })
        }
      >
        <Svg width={size.width} height={size.height} pointerEvents="none">
          {triangles.map((triangle, i) => (
            <Polygon
              key={i}
              fill={triangle.fill}
              points={triangle.indices
                .map((index) => {
                  const p = screen(vertices[index]!);
                  return `${p.x},${p.y}`;
                })
                .join(" ")}
            />
          ))}
          {showVertices &&
            vertices.map((vertex, i) => {
              const p = screen(vertex);
              return <Circle key={i} cx={p.x} cy={p.y} r={2.5} fill="#f87171" stroke="#18181b" />;
            })}
          {showJoints &&
            pose.map((joint, i) => {
              const parent = pose[joint.parentI];
              if (!parent) return null;
              const a = screen(parent.position),
                b = screen(joint.position);
              return (
                <Line
                  key={i}
                  x1={a.x}
                  y1={a.y}
                  x2={b.x}
                  y2={b.y}
                  stroke="#fbbf24"
                  strokeWidth={2}
                />
              );
            })}
          {showJoints &&
            pose.map((joint, i) => {
              const p = screen(joint.position);
              return (
                <G key={i}>
                  {ikEndJoints.has(i) && (
                    <Rect
                      x={p.x - 10}
                      y={p.y - 10}
                      width={20}
                      height={20}
                      fill="none"
                      stroke="#38bdf8"
                    />
                  )}
                  <Circle
                    cx={p.x}
                    cy={p.y}
                    r={i === selected ? 8 : 6}
                    fill={i === selected ? "#fff" : ikEndJoints.has(i) ? "#38bdf8" : "#fbbf24"}
                    stroke="#18181b"
                  />
                </G>
              );
            })}
        </Svg>
        <View
          style={{ position: "absolute", inset: 0 }}
          accessibilityLabel="Mesh preview. Drag joints to pose or the background to pan."
          onStartShouldSetResponder={() => true}
          onResponderGrant={(event) => {
            const point = { x: event.nativeEvent.locationX, y: event.nativeEvent.locationY };
            let index: number | null = null,
              distance = 24;
            if (showJoints && mesh.canSkin && !animation.clip)
              pose.forEach((joint, i) => {
                const p = screen(joint.position);
                const d = Math.hypot(p.x - point.x, p.y - point.y);
                if (d < distance) {
                  index = i;
                  distance = d;
                }
              });
            setSelected(index);
            const p = world(point),
              joint = index === null ? null : pose[index];
            drag.current = {
              mesh,
              index,
              joints: pose,
              start: point,
              pan,
              offset: joint
                ? { x: joint.position.x - p.x, y: joint.position.y - p.y }
                : { x: 0, y: 0 },
            };
          }}
          onResponderMove={(event) => {
            const current = drag.current;
            if (!current || current.mesh !== mesh || (current.index !== null && animation.clip))
              return;
            const point = { x: event.nativeEvent.locationX, y: event.nativeEvent.locationY };
            if (current.index === null)
              setPan({
                x: current.pan.x + point.x - current.start.x,
                y: current.pan.y + point.y - current.start.y,
              });
            else {
              const p = world(point);
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
          onResponderRelease={() => {
            drag.current = null;
          }}
          onResponderTerminate={() => {
            drag.current = null;
          }}
        />
      </View>
      <Text className="px-3 py-2 text-xs text-foreground-muted">
        {selected !== null && pose[selected]
          ? `${pose[selected]!.name || `Joint ${selected}`} · `
          : ""}
        {mesh.canSkin
          ? "Drag joints to pose · "
          : mesh.joints.length
            ? "No skinning weights · "
            : ""}
        {ikEndJoints.size > 0 ? "Drag square IK handles to bend limbs · " : ""}
        Preview only
      </Text>
    </View>
  );
}
