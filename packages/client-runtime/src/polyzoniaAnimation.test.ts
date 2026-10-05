import { describe, expect, it } from "vite-plus/test";
import {
  parsePolyzoniaMesh,
  type MeshCurveKeyframe,
  type MeshJointAnimation,
} from "./polyzoniaMesh.ts";
import {
  advanceMeshPlayback,
  evaluateMeshCurve,
  meshAnimationClips,
  sampleMeshAnimation,
  sampleMeshJoints,
  sampleMeshVertices,
} from "./polyzoniaAnimation.ts";

const key = (x: number, y: number): MeshCurveKeyframe => ({
  value: { x, y },
  inDir: { x: 0, y: 0 },
  outDir: { x: 0, y: 0 },
});
function fixture(extra = {}) {
  return parsePolyzoniaMesh(
    "mesh.json",
    JSON.stringify({
      vertices: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 0, y: 10 },
      ],
      layers: [{ triangles: [{ indices: [0, 1, 2], color: { x: 1, y: 1, z: 1, w: 1 } }] }],
      joints: [
        { parentI: -1, position: { x: 0, y: 0 } },
        { parentI: 0, position: { x: 10, y: 0 } },
        { parentI: 1, position: { x: 20, y: 0 } },
        { parentI: 2, position: { x: 30, y: 0 } },
        { parentI: 3, position: { x: 32, y: 0 } },
      ],
      weights: [0, 1, 2].map((jointI) => ({ jointWeights: [{ jointI, value: 1 }] })),
      ...extra,
    }),
  )!;
}
const vertexAnimation = {
  name: "Swim",
  duration: 2,
  keyframes: [
    {
      t: 0,
      vertices: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 0, y: 10 },
      ],
    },
    {
      t: 1,
      vertices: [
        { x: 10, y: 0 },
        { x: 20, y: 0 },
        { x: 10, y: 10 },
      ],
    },
  ],
};
const jointAnimation: MeshJointAnimation = {
  name: "Walk",
  framesPerSecond: 10,
  durationInFrames: 20,
};
function point(p: { readonly x: number; readonly y: number }, x: number, y: number) {
  expect(p.x).toBeCloseTo(x);
  expect(p.y).toBeCloseTo(y);
}

describe("mesh animation sampling", () => {
  it("discovers both animation types and converts frame duration to seconds", () => {
    const clips = meshAnimationClips(
      fixture({ vertexAnimations: [vertexAnimation], jointAnimations: [jointAnimation] }),
    );
    expect(clips.map((clip) => [clip.kind, clip.duration])).toEqual([
      ["vertex", 2],
      ["joint", 2],
    ]);
    expect(clips.map((clip) => clip.label)).toEqual(["Swim · Vertices", "Walk · Joints"]);
  });
  it("omits empty or zero-duration animations without disabling the mesh preview", () => {
    const mesh = fixture({
      vertexAnimations: [
        { ...vertexAnimation, keyframes: [] },
        { ...vertexAnimation, duration: 0 },
      ],
      jointAnimations: [{ ...jointAnimation, framesPerSecond: 0 }],
    });
    expect(mesh).not.toBeNull();
    expect(meshAnimationClips(mesh)).toEqual([]);
  });
  it("interpolates vertices and closes the loop back to the first key", () => {
    const mesh = fixture();
    point(sampleMeshVertices(mesh, vertexAnimation, 0.25, true)[0]!, 2.5, 0);
    point(sampleMeshVertices(mesh, vertexAnimation, 1.5, true)[0]!, 5, 0);
    point(sampleMeshVertices(mesh, vertexAnimation, 2, true)[0]!, 0, 0);
    point(sampleMeshVertices(mesh, vertexAnimation, 2, false)[0]!, 10, 0);
  });
  it("retains unmatched mesh vertices, ignores extra keyed vertices, and handles one key", () => {
    const mesh = fixture();
    const short = {
      ...vertexAnimation,
      keyframes: [
        { t: 0, vertices: [{ x: 1, y: 2 }] },
        { t: 1, vertices: [{ x: 3, y: 4 }] },
      ],
    };
    const sample = sampleMeshVertices(mesh, short, 0.5, true);
    expect(sample).toEqual([{ x: 2, y: 3 }, mesh.vertices[1], mesh.vertices[2]]);
    const single = {
      ...short,
      keyframes: [
        { t: 0, vertices: [...vertexAnimation.keyframes[1]!.vertices, { x: 999, y: 999 }] },
      ],
    };
    expect(sampleMeshVertices(mesh, single, 1.5, true)).toHaveLength(3);
    expect(sampleMeshVertices(mesh, { ...short, keyframes: [] }, 1, true)).toEqual(mesh.vertices);
  });
  it("evaluates empty, constant, linear, and clamped curves", () => {
    expect(evaluateMeshCurve([], 5)).toBe(0);
    expect(evaluateMeshCurve([key(3, 7)], 100)).toBe(7);
    const keys = [key(0, 0), key(10, 100)];
    expect(evaluateMeshCurve(keys, -1)).toBe(0);
    expect(evaluateMeshCurve(keys, 2.5)).toBe(25);
    expect(evaluateMeshCurve(keys, 11)).toBe(100);
  });
  it("inverts Bezier time and honors relative tangent offsets", () => {
    const keys = [
      { ...key(0, 0), outDir: { x: 0, y: 1 } },
      { ...key(1, 0), inDir: { x: -1, y: 1 } },
    ];
    // x(t)=t³, y(t)=3t(1-t): x=1/8 corresponds to t=1/2, not t=1/8.
    expect(evaluateMeshCurve(keys, 0.125)).toBeCloseTo(0.75);
  });
  it("chooses the same curve root as the game when time tangents overshoot", () => {
    const keys = [
      { ...key(31, 0), outDir: { x: 10.5, y: 10 } },
      { ...key(39, 20), inDir: { x: -10.5, y: -10 } },
    ];
    // Reference values from Polyzonia's BezierCurve::evaluate.
    expect(evaluateMeshCurve(keys, 34.6)).toBeCloseTo(12.2159986, 4);
    expect(evaluateMeshCurve(keys, 35.4)).toBeCloseTo(7.78400469, 4);
  });
  it("accumulates joint rotation, distance deltas and root offsets", () => {
    const mesh = fixture();
    const anim = {
      ...jointAnimation,
      rootJointX: [key(0, 5)],
      rootJointY: [key(0, 3)],
      rotations: [
        { keyframes: [] },
        { keyframes: [key(0, 0), key(10, Math.PI / 2)] },
        { keyframes: [key(0, Math.PI / 2)] },
      ],
      distances: [{ keyframes: [] }, { keyframes: [] }, { keyframes: [key(0, 2)] }],
    };
    const pose = sampleMeshJoints(mesh, anim, 10);
    point(pose[0]!.position, 5, 3);
    point(pose[1]!.position, 5, 13);
    point(pose[2]!.position, -7, 13);
    point(mesh.joints[2]!.position, 20, 0);
  });
  it("applies IK offsets on top of ancestor animation and carries the toe", () => {
    const mesh = fixture({
      ikHandles: [
        {
          startJointI: 1,
          midJointI: 2,
          endJointI: 3,
          descendantJointI: 4,
          rootToMidLength: 10,
          midToTipLength: 10,
          midJointIsLeftOfLine: true,
        },
      ],
    });
    const anim = {
      ...jointAnimation,
      rootJointX: [key(0, 5)],
      rotations: [{ keyframes: [] }, { keyframes: [key(0, Math.PI / 2)] }],
      ikHandlesJointX: [{ keyframes: [key(0, 10)] }],
      ikHandlesJointY: [{ keyframes: [key(0, -10)] }],
    };
    const pose = sampleMeshJoints(mesh, anim, 0);
    point(pose[1]!.position, 5, 10);
    point(pose[2]!.position, 5, 20);
    point(pose[3]!.position, 15, 20);
    point(pose[4]!.position, 15, 22);
  });
  it("uses clip FPS when sampling a joint animation in seconds, then skins vertices", () => {
    const mesh = fixture({
      jointAnimations: [{ ...jointAnimation, rootJointX: [key(0, 0), key(10, 20)] }],
    });
    const sample = sampleMeshAnimation(mesh, meshAnimationClips(mesh)[0]!, 0.5, true);
    point(sample.joints[0]!.position, 10, 0);
    point(sample.vertices[0]!, 10, 0);
  });
  it("wraps looping playback and stops exactly at the end without looping", () => {
    expect(advanceMeshPlayback(1.9, 0.2, 2, true).time).toBeCloseTo(0.1);
    expect(advanceMeshPlayback(0, 5.5, 2, true)).toEqual({ time: 1.5, playing: true });
    expect(advanceMeshPlayback(1.9, 0.2, 2, false)).toEqual({ time: 2, playing: false });
  });
});
