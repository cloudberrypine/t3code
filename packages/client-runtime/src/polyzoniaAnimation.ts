import {
  constrainMeshIK,
  skinMesh,
  type MeshCurveKeyframe,
  type MeshJointAnimation,
  type MeshPoint,
  type MeshVertexAnimation,
  type PolyzoniaMesh,
} from "./polyzoniaMesh.ts";

export type MeshAnimationClip = {
  readonly id: string;
  readonly label: string;
  readonly duration: number;
} & (
  | { readonly kind: "vertex"; readonly animation: MeshVertexAnimation }
  | { readonly kind: "joint"; readonly animation: MeshJointAnimation }
);

export function meshAnimationClips(mesh: PolyzoniaMesh): MeshAnimationClip[] {
  return [
    ...mesh.vertexAnimations.flatMap((animation, i): MeshAnimationClip[] =>
      animation.duration > 0 && animation.keyframes.length
        ? [
            {
              id: `vertex:${i}`,
              label: `${animation.name || `Animation ${i + 1}`} · Vertices`,
              duration: animation.duration,
              kind: "vertex",
              animation,
            },
          ]
        : [],
    ),
    ...mesh.jointAnimations.flatMap((animation, i): MeshAnimationClip[] =>
      animation.framesPerSecond > 0 &&
      animation.durationInFrames > 0 &&
      Number.isFinite(animation.durationInFrames / animation.framesPerSecond) &&
      mesh.joints.length
        ? [
            {
              id: `joint:${i}`,
              label: `${animation.name || `Animation ${i + 1}`} · Joints`,
              duration: animation.durationInFrames / animation.framesPerSecond,
              kind: "joint",
              animation,
            },
          ]
        : [],
    ),
  ];
}

/** Tangents are offsets from their keys, and their x coordinate controls timing. */
export function evaluateMeshCurve(keys: readonly MeshCurveKeyframe[] = [], frame: number): number {
  const first = keys[0],
    last = keys.at(-1);
  if (!first || !last) return 0;
  if (frame <= first.value.x || keys.length === 1) return first.value.y;
  if (frame >= last.value.x) return last.value.y;
  for (let i = 1; i < keys.length; i++) {
    const a = keys[i - 1]!,
      b = keys[i]!;
    if (frame < a.value.x || frame > b.value.x) continue;
    const width = b.value.x - a.value.x;
    if (width < 0.0001) return a.value.y;
    if (Math.hypot(a.outDir.x, a.outDir.y) <= 0.0001 && Math.hypot(b.inDir.x, b.inDir.y) <= 0.0001)
      return a.value.y + ((b.value.y - a.value.y) * (frame - a.value.x)) / width;
    const cubic = (start: number, control1: number, control2: number, end: number, t: number) =>
      (1 - t) ** 3 * start +
      3 * (1 - t) ** 2 * t * control1 +
      3 * (1 - t) * t * t * control2 +
      t ** 3 * end;
    // Like the game's BezierCurve, start Newton iteration at normalized time.
    // Bisection alone can select a different root when time tangents overshoot.
    const c1 = a.value.x + a.outDir.x,
      c2 = b.value.x + b.inDir.x;
    const normalized = (frame - a.value.x) / width;
    let t = normalized,
      solved = false;
    for (let attempt = 0; attempt < 8; attempt++) {
      const error = cubic(a.value.x, c1, c2, b.value.x, t) - frame;
      if (Math.abs(error) < width * 0.0001) {
        solved = true;
        break;
      }
      const derivative =
        3 *
        ((c1 - a.value.x) * (1 - t) ** 2 + 2 * (c2 - c1) * (1 - t) * t + (b.value.x - c2) * t * t);
      if (Math.abs(derivative) < width * 0.000001) break;
      t -= error / derivative;
    }
    if (!solved) {
      let low = 0,
        high = 1;
      t = normalized;
      for (let attempt = 0; attempt < 40; attempt++) {
        const x = cubic(a.value.x, c1, c2, b.value.x, t);
        if (Math.abs(x - frame) < width * 0.0001) break;
        if (x < frame) low = t;
        else high = t;
        t = (low + high) / 2;
      }
    }
    return cubic(a.value.y, a.value.y + a.outDir.y, b.value.y + b.inDir.y, b.value.y, t);
  }
  return last.value.y;
}

/** Matches SampleVertexAnimation, including partial keyframes and the loop's closing segment. */
export function sampleMeshVertices(
  mesh: PolyzoniaMesh,
  animation: MeshVertexAnimation,
  time: number,
  loop: boolean,
) {
  const keys = animation.keyframes;
  const vertices = [...mesh.vertices];
  const copy = (points: readonly MeshPoint[]) => {
    for (let i = 0; i < Math.min(points.length, vertices.length); i++) vertices[i] = points[i]!;
    return vertices;
  };
  if (!keys.length) return vertices;
  if (keys.length === 1 || time <= keys[0]!.t) return copy(keys[0]!.vertices);
  if (!loop && time >= animation.duration) return copy(keys.at(-1)!.vertices);
  for (let i = 1; i <= keys.length; i++) {
    const previous = keys[i - 1]!,
      next = keys[i % keys.length]!;
    if (i < keys.length && next.t < time) continue;
    const end = i === keys.length ? animation.duration : next.t;
    const duration = end - previous.t;
    if (duration <= 0.000001) return copy(next.vertices);
    const progress = Math.max(0, Math.min(1, (time - previous.t) / duration));
    for (
      let j = 0;
      j < Math.min(vertices.length, previous.vertices.length, next.vertices.length);
      j++
    ) {
      const a = previous.vertices[j]!,
        b = next.vertices[j]!;
      vertices[j] = { x: a.x + (b.x - a.x) * progress, y: a.y + (b.y - a.y) * progress };
    }
    return vertices;
  }
  return vertices;
}

export function sampleMeshJoints(
  mesh: PolyzoniaMesh,
  animation: MeshJointAnimation,
  frame: number,
) {
  let pose = mesh.joints.map((joint) => ({ ...joint }));
  const rotations = Array.from({ length: pose.length }, () => 0);
  const order = mesh.joints.flatMap((joint, i) => (joint.parentI === -1 ? [i] : []));
  const children = new Map<number, number[]>();
  mesh.joints.forEach((joint, i) => {
    const entries = children.get(joint.parentI) ?? [];
    entries.push(i);
    children.set(joint.parentI, entries);
  });
  const rootOffset = {
    x: evaluateMeshCurve(animation.rootJointX, frame),
    y: evaluateMeshCurve(animation.rootJointY, frame),
  };
  for (let head = 0; head < order.length; head++) {
    const i = order[head]!,
      joint = mesh.joints[i]!;
    order.push(...(children.get(i) ?? []));
    const parent = mesh.joints[joint.parentI];
    if (!parent) {
      pose[i]!.position = {
        x: joint.position.x + rootOffset.x,
        y: joint.position.y + rootOffset.y,
      };
      continue;
    }
    const dx = joint.position.x - parent.position.x,
      dy = joint.position.y - parent.position.y;
    rotations[i] =
      rotations[joint.parentI]! + evaluateMeshCurve(animation.rotations?.[i]?.keyframes, frame);
    const angle = Math.atan2(dy, dx) + rotations[i]!;
    const distance =
      Math.hypot(dx, dy) + evaluateMeshCurve(animation.distances?.[i]?.keyframes, frame);
    const origin = pose[joint.parentI]!.position;
    pose[i]!.position = {
      x: origin.x + Math.cos(angle) * distance,
      y: origin.y + Math.sin(angle) * distance,
    };
  }
  mesh.ikHandles.forEach((handle, i) => {
    const dx = evaluateMeshCurve(animation.ikHandlesJointX?.[i]?.keyframes, frame);
    const dy = evaluateMeshCurve(animation.ikHandlesJointY?.[i]?.keyframes, frame);
    const end = pose[handle.endJointI]!;
    end.position = { x: end.position.x + dx, y: end.position.y + dy };
    const descendant = pose[handle.descendantJointI ?? -1];
    if (descendant)
      descendant.position = { x: descendant.position.x + dx, y: descendant.position.y + dy };
    pose = constrainMeshIK(pose, [handle]);
  });
  return pose;
}

export function sampleMeshAnimation(
  mesh: PolyzoniaMesh,
  clip: MeshAnimationClip,
  time: number,
  loop: boolean,
) {
  if (clip.kind === "vertex")
    return { joints: mesh.joints, vertices: sampleMeshVertices(mesh, clip.animation, time, loop) };
  const joints = sampleMeshJoints(mesh, clip.animation, time * clip.animation.framesPerSecond);
  return { joints, vertices: skinMesh(mesh, joints) };
}

export function advanceMeshPlayback(
  time: number,
  elapsedSeconds: number,
  duration: number,
  loop: boolean,
) {
  const next = time + elapsedSeconds;
  return {
    time: loop ? next % duration : Math.min(next, duration),
    playing: loop || next < duration,
  };
}
