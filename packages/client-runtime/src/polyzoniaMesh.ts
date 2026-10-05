import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const NumberValue = Schema.Number.check(Schema.isFinite());
const Index = Schema.Number.check(Schema.isInt());
const Point = Schema.Struct({ x: NumberValue, y: NumberValue });
const Joint = Schema.Struct({
  name: Schema.optionalKey(Schema.String),
  position: Point,
  parentI: Index,
});
const IKHandle = Schema.Struct({
  startJointI: Index,
  midJointI: Index,
  endJointI: Index,
  descendantJointI: Schema.optionalKey(Index),
  rootToMidLength: NumberValue,
  midToTipLength: NumberValue,
  midJointIsLeftOfLine: Schema.Boolean,
});
const CurveKeyframe = Schema.Struct({ value: Point, inDir: Point, outDir: Point });
const Curve = Schema.Array(CurveKeyframe);
const Track = Schema.Struct({ keyframes: Curve });
const VertexAnimation = Schema.Struct({
  name: Schema.String,
  duration: NumberValue,
  keyframes: Schema.Array(Schema.Struct({ t: NumberValue, vertices: Schema.Array(Point) })),
});
const JointAnimation = Schema.Struct({
  name: Schema.String,
  framesPerSecond: NumberValue,
  durationInFrames: NumberValue,
  rotations: Schema.optionalKey(Schema.Array(Track)),
  distances: Schema.optionalKey(Schema.Array(Track)),
  rootJointX: Schema.optionalKey(Curve),
  rootJointY: Schema.optionalKey(Curve),
  ikHandlesJointX: Schema.optionalKey(Schema.Array(Track)),
  ikHandlesJointY: Schema.optionalKey(Schema.Array(Track)),
});
const Mesh = Schema.Struct({
  vertices: Schema.Array(Point),
  vertexAnimations: Schema.optionalKey(Schema.Array(VertexAnimation)),
  jointAnimations: Schema.optionalKey(Schema.Array(JointAnimation)),
  layers: Schema.Array(
    Schema.Struct({
      triangles: Schema.Array(
        Schema.Struct({
          indices: Schema.Tuple([Index, Index, Index]),
          color: Schema.Struct({ x: NumberValue, y: NumberValue, z: NumberValue, w: NumberValue }),
        }),
      ),
    }),
  ),
  joints: Schema.optionalKey(Schema.Array(Joint)),
  ikHandles: Schema.optionalKey(Schema.Array(IKHandle)),
  weights: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        jointWeights: Schema.Array(Schema.Struct({ jointI: Index, value: NumberValue })),
      }),
    ),
  ),
  decals: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        vertexI: Index,
        layerI: Index,
        triangleI: Index,
        barycentric: Schema.Struct({ x: NumberValue, y: NumberValue, z: NumberValue }),
      }),
    ),
  ),
});
const decodeMesh = Schema.decodeUnknownOption(Schema.fromJsonString(Mesh));
export type MeshCurveKeyframe = typeof CurveKeyframe.Type;
export type MeshVertexAnimation = typeof VertexAnimation.Type;
export type MeshJointAnimation = typeof JointAnimation.Type;
export type MeshPoint = typeof Point.Type;
export type MeshJoint = typeof Joint.Type;
export type MeshIKHandle = typeof IKHandle.Type;
export type PolyzoniaMesh = NonNullable<ReturnType<typeof parsePolyzoniaMesh>>;

/** Detect by contents, so ordinary JSON files keep their source view. */
export function parsePolyzoniaMesh(path: string, contents: string, truncated = false) {
  if (truncated || !/\.json$/i.test(path)) return null;
  const decoded = decodeMesh(contents);
  if (Option.isNone(decoded)) return null;
  const mesh = decoded.value;
  const joints = mesh.joints ?? [];
  const weights = mesh.weights ?? [];
  const decals = mesh.decals ?? [];
  const ikHandles = mesh.ikHandles ?? [];
  const validIndex = (index: number, length: number) => index >= 0 && index < length;
  if (!mesh.vertices.length || !mesh.layers.some((layer) => layer.triangles.length)) return null;
  if (
    mesh.layers.some((layer) =>
      layer.triangles.some((triangle) =>
        triangle.indices.some((index) => !validIndex(index, mesh.vertices.length)),
      ),
    )
  )
    return null;
  // Reject cyclic/out-of-range parents without recursion, including unordered joint arrays.
  const visited = new Set<number>();
  for (let i = 0; i < joints.length; i++) {
    const chain = new Set<number>();
    let index = i;
    while (index !== -1 && !visited.has(index)) {
      if (!validIndex(index, joints.length) || chain.has(index)) return null;
      chain.add(index);
      index = joints[index]!.parentI;
    }
    for (const item of chain) visited.add(item);
  }
  if (
    ikHandles.some(
      (handle) =>
        ![handle.startJointI, handle.midJointI, handle.endJointI].every((i) =>
          validIndex(i, joints.length),
        ) ||
        joints[handle.midJointI]!.parentI !== handle.startJointI ||
        joints[handle.endJointI]!.parentI !== handle.midJointI ||
        handle.rootToMidLength <= 0 ||
        handle.midToTipLength <= 0 ||
        (handle.descendantJointI !== undefined &&
          handle.descendantJointI !== -1 &&
          (!validIndex(handle.descendantJointI, joints.length) ||
            joints[handle.descendantJointI]!.parentI !== handle.endJointI)),
    )
  )
    return null;
  if (
    weights.some(
      (weight) =>
        weight.jointWeights.length > 3 ||
        weight.jointWeights.some(
          (entry) =>
            entry.value < 0 || (entry.value !== 0 && !validIndex(entry.jointI, joints.length)),
        ),
    )
  )
    return null;
  if (
    decals.some(
      (decal) =>
        !validIndex(decal.vertexI, mesh.vertices.length) ||
        !validIndex(decal.layerI, mesh.layers.length) ||
        !validIndex(decal.triangleI, mesh.layers[decal.layerI]!.triangles.length),
    )
  )
    return null;
  return {
    ...mesh,
    joints,
    weights,
    decals,
    ikHandles,
    vertexAnimations: mesh.vertexAnimations ?? [],
    jointAnimations: mesh.jointAnimations ?? [],
    canSkin: joints.length > 0 && weights.length === mesh.vertices.length,
  };
}

function jointAngle(joints: readonly MeshJoint[], index: number) {
  const joint = joints[index]!;
  const parent = joints[joint.parentI];
  return parent
    ? Math.atan2(joint.position.y - parent.position.y, joint.position.x - parent.position.x)
    : 0;
}

function rotate(point: MeshPoint, origin: MeshPoint, angle: number): MeshPoint {
  const x = point.x - origin.x;
  const y = point.y - origin.y;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return { x: origin.x + x * c - y * s, y: origin.y + x * s + y * c };
}

/** Inspector pose behavior: rotate a bone and its descendants; translate the root. */
export function dragMeshJoint(
  joints: readonly MeshJoint[],
  index: number,
  target: MeshPoint,
  ikHandles: readonly MeshIKHandle[] = [],
) {
  const selected = joints[index];
  if (!selected) return joints;
  const parent = joints[selected.parentI];
  const angle = parent
    ? Math.atan2(target.y - parent.position.y, target.x - parent.position.x) -
      jointAngle(joints, index)
    : 0;
  const pose = joints.map((joint, i) => {
    let ancestor = i;
    while (ancestor !== -1) {
      // IK endpoints stay pinned when moving an ancestor. Dragging the endpoint
      // translates its descendants too, preserving the foot/toe offset.
      if (
        ikHandles.some((handle) => handle.endJointI === ancestor || handle.midJointI === ancestor)
      ) {
        if (ancestor === index && ikHandles.some((handle) => handle.endJointI === ancestor)) {
          return {
            ...joint,
            position: {
              x: joint.position.x + target.x - selected.position.x,
              y: joint.position.y + target.y - selected.position.y,
            },
          };
        }
        return joint;
      }
      if (ancestor === index) break;
      ancestor = joints[ancestor]!.parentI;
    }
    if (ancestor === -1) return joint;
    return {
      ...joint,
      position: parent
        ? rotate(joint.position, parent.position, angle)
        : {
            x: joint.position.x + target.x - selected.position.x,
            y: joint.position.y + target.y - selected.position.y,
          },
    };
  });
  return constrainMeshIK(pose, ikHandles);
}

export function constrainMeshIK(joints: readonly MeshJoint[], ikHandles: readonly MeshIKHandle[]) {
  const pose = [...joints];
  // Match Mesh::ConstrainPoseToIKHandles, including its straight-line fallback
  // for unreachable targets: the endpoint follows the pointer and the leg stretches.
  for (const handle of ikHandles) {
    const origin = pose[handle.startJointI]!.position;
    const end = pose[handle.endJointI]!.position;
    const dx = end.x - origin.x,
      dy = end.y - origin.y;
    const distance = Math.hypot(dx, dy);
    const a = handle.rootToMidLength,
      b = handle.midToTipLength;
    let position: MeshPoint;
    if (distance >= a + b - 0.01 || distance <= Math.abs(a - b) + 0.01) {
      position = { x: origin.x + (dx * a) / (a + b), y: origin.y + (dy * a) / (a + b) };
    } else {
      const bend = Math.acos(
        Math.max(-1, Math.min(1, (distance * distance + a * a - b * b) / (2 * distance * a))),
      );
      const angle = Math.atan2(dy, dx) + (handle.midJointIsLeftOfLine ? bend : -bend);
      position = { x: origin.x + a * Math.cos(angle), y: origin.y + a * Math.sin(angle) };
    }
    pose[handle.midJointI] = { ...pose[handle.midJointI]!, position };
  }
  return pose;
}

/** Polyzonia's CalculateTransform is translation(position) * rotation(parent→joint).
 * Apply current * inverse(bind), then the authored weights (without renormalizing).
 */
export function skinMesh(mesh: PolyzoniaMesh, pose: readonly MeshJoint[]): readonly MeshPoint[] {
  if (!mesh.canSkin || pose.length !== mesh.joints.length) return mesh.vertices;
  const transforms = mesh.joints.map((joint, i) => {
    const angle = jointAngle(pose, i) - jointAngle(mesh.joints, i);
    return {
      c: Math.cos(angle),
      s: Math.sin(angle),
      bind: joint.position,
      position: pose[i]!.position,
    };
  });
  const apply = (point: MeshPoint, index: number): MeshPoint => {
    const t = transforms[index]!;
    const x = point.x - t.bind.x;
    const y = point.y - t.bind.y;
    return { x: t.position.x + x * t.c - y * t.s, y: t.position.y + x * t.s + y * t.c };
  };
  const vertices = mesh.vertices.map((vertex, i) => {
    const weights = mesh.weights[i]!.jointWeights;
    if (weights.reduce((sum, w) => sum + w.value, 0) <= 0.0001) return apply(vertex, 0);
    return weights.reduce(
      (sum, weight) => {
        if (weight.value === 0) return sum;
        const p = apply(vertex, weight.jointI);
        return { x: sum.x + p.x * weight.value, y: sum.y + p.y * weight.value };
      },
      { x: 0, y: 0 },
    );
  });
  for (const decal of mesh.decals) {
    const triangle = mesh.layers[decal.layerI]!.triangles[decal.triangleI]!;
    const [a, b, c] = triangle.indices.map((index) => vertices[index]!) as [
      MeshPoint,
      MeshPoint,
      MeshPoint,
    ];
    const w = decal.barycentric;
    vertices[decal.vertexI] = {
      x: a.x * w.x + b.x * w.y + c.x * w.z,
      y: a.y * w.x + b.y * w.y + c.y * w.z,
    };
  }
  return vertices;
}

export function meshBounds(mesh: PolyzoniaMesh) {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const point of [...mesh.vertices, ...mesh.joints.map((joint) => joint.position)]) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  return {
    x: (minX + maxX) / 2,
    y: (minY + maxY) / 2,
    width: Math.max(1, maxX - minX),
    height: Math.max(1, maxY - minY),
  };
}

export function meshViewport(
  bounds: ReturnType<typeof meshBounds>,
  width: number,
  height: number,
  zoom = 1,
) {
  const scale =
    Math.max(
      0.001,
      Math.min(Math.max(1, width - 64) / bounds.width, Math.max(1, height - 64) / bounds.height),
    ) * zoom;
  return { scale, x: width / 2 - bounds.x * scale, y: height / 2 - bounds.y * scale };
}

export function meshColor(color: {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly w: number;
}) {
  const channel = (value: number) => Math.round(Math.max(0, Math.min(1, value)) * 255);
  return `rgba(${channel(color.x)},${channel(color.y)},${channel(color.z)},${Math.max(0, Math.min(1, color.w))})`;
}
