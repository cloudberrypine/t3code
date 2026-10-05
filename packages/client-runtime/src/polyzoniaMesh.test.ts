import { describe, expect, it } from "vite-plus/test";
import {
  dragMeshJoint,
  meshBounds,
  meshColor,
  meshViewport,
  parsePolyzoniaMesh,
  skinMesh,
} from "./polyzoniaMesh.js";

function fixture() {
  return {
    vertices: [
      { x: 10, y: 2 },
      { x: 20, y: 2 },
      { x: 15, y: 4 },
      { x: 15, y: 3 },
    ],
    layers: [{ triangles: [{ indices: [0, 1, 2], color: { x: 0.2, y: 0.5, z: 1, w: 0.5 } }] }],
    joints: [
      { name: "Root", parentI: -1, position: { x: 0, y: 0 } },
      { name: "Arm", parentI: 0, position: { x: 10, y: 0 } },
      { name: "Tip", parentI: 1, position: { x: 20, y: 0 } },
    ],
    weights: [
      { jointWeights: [{ jointI: 1, value: 1 }] },
      { jointWeights: [{ jointI: 2, value: 1 }] },
      {
        jointWeights: [
          { jointI: 0, value: 0.5 },
          { jointI: 1, value: 0.5 },
        ],
      },
      { jointWeights: [{ jointI: 0, value: 0 }] },
    ],
    decals: [] as {
      vertexI: number;
      layerI: number;
      triangleI: number;
      barycentric: { x: number; y: number; z: number };
    }[],
  };
}
function parse(value: unknown) {
  const mesh = parsePolyzoniaMesh("assets/meshes/Test.json", JSON.stringify(value));
  expect(mesh).not.toBeNull();
  return mesh!;
}
function point(
  actual: { readonly x: number; readonly y: number } | undefined,
  x: number,
  y: number,
) {
  expect(actual?.x).toBeCloseTo(x);
  expect(actual?.y).toBeCloseTo(y);
}

describe("Polyzonia mesh previews", () => {
  it("detects mesh content regardless of directory and keeps unrelated/truncated JSON as source", () => {
    expect(parsePolyzoniaMesh("example.JSON", JSON.stringify(fixture()))).not.toBeNull();
    for (const text of ["{", "null", "[]", '{"vertices": [], "layers": []}', '{"name":"mesh"}'])
      expect(parsePolyzoniaMesh("example.json", text)).toBeNull();
    expect(parsePolyzoniaMesh("example.txt", JSON.stringify(fixture()))).toBeNull();
    expect(parsePolyzoniaMesh("example.json", JSON.stringify(fixture()), true)).toBeNull();
  });
  it("previews static meshes with no rig and preserves triangle layer order and alpha", () => {
    const { joints: _j, weights: _w, decals: _d, ...data } = fixture();
    data.layers.push({ triangles: [{ indices: [2, 1, 0], color: { x: 1, y: 0, z: 0, w: 0.2 } }] });
    const mesh = parse(data);
    expect(mesh.canSkin).toBe(false);
    expect(skinMesh(mesh, [])).toBe(mesh.vertices);
    expect(mesh.layers[1]?.triangles[0]?.indices).toEqual([2, 1, 0]);
    expect(meshColor(mesh.layers[0]!.triangles[0]!.color)).toBe("rgba(51,128,255,0.5)");
  });
  it.each(["triangle", "parent", "cycle", "weight", "decal", "finite"])(
    "rejects invalid %s data safely",
    (kind) => {
      const data = fixture();
      if (kind === "triangle") data.layers[0]!.triangles[0]!.indices[2] = 400;
      if (kind === "parent") data.joints[1]!.parentI = -2;
      if (kind === "cycle") data.joints[0]!.parentI = 2;
      if (kind === "weight") data.weights[0]!.jointWeights[0]!.jointI = 100;
      if (kind === "decal")
        data.decals.push({
          vertexI: 3,
          layerI: 1,
          triangleI: 0,
          barycentric: { x: 1, y: 0, z: 0 },
        });
      const json =
        kind === "finite"
          ? JSON.stringify(data).replace('"x":10', '"x":1e999')
          : JSON.stringify(data);
      expect(parsePolyzoniaMesh("test.json", json)).toBeNull();
    },
  );
  it("accepts parents stored after their children", () => {
    const data = fixture();
    data.joints = [data.joints[1]!, data.joints[0]!, data.joints[2]!];
    data.joints[0]!.parentI = 1;
    data.joints[2]!.parentI = 0;
    expect(parse(data).joints).toHaveLength(3);
  });
  it("preserves bind pose and translates zero-weight vertices with the root", () => {
    const mesh = parse(fixture());
    skinMesh(mesh, mesh.joints).forEach((p, i) =>
      point(p, mesh.vertices[i]!.x, mesh.vertices[i]!.y),
    );
    const moved = dragMeshJoint(mesh.joints, 0, { x: 7, y: -3 });
    skinMesh(mesh, moved).forEach((p, i) =>
      point(p, mesh.vertices[i]!.x + 7, mesh.vertices[i]!.y - 3),
    );
    expect(mesh.joints[0]!.position).toEqual({ x: 0, y: 0 });
  });
  it("rotates descendants around the parent without stretching bones and blends weights", () => {
    const mesh = parse(fixture());
    const pose = dragMeshJoint(mesh.joints, 1, { x: 0, y: 50 });
    point(pose[0]!.position, 0, 0);
    point(pose[1]!.position, 0, 10);
    point(pose[2]!.position, 0, 20);
    const vertices = skinMesh(mesh, pose);
    point(vertices[0], -2, 10);
    point(vertices[1], -2, 20);
    point(vertices[2], 5.5, 9.5);
    point(vertices[3], 15, 3);
  });
  it("uses each bone's absolute angle for an already bent bind pose", () => {
    const data = fixture();
    data.joints[2]!.position = { x: 10, y: 10 };
    data.vertices[1] = { x: 8, y: 10 };
    const mesh = parse(data);
    const pose = dragMeshJoint(mesh.joints, 2, { x: 30, y: 0 });
    point(skinMesh(mesh, pose)[1], 20, 2);
    expect(pose[1]).toBe(mesh.joints[1]);
  });
  it("does not normalize authored weights and ignores unused joint indices", () => {
    const data = fixture();
    data.weights[0]!.jointWeights = [
      { jointI: 1, value: 0.25 },
      { jointI: 999, value: 0 },
    ];
    const mesh = parse(data);
    point(skinMesh(mesh, mesh.joints)[0], 2.5, 0.5);
  });
  it("repositions decal vertices barycentrically after skinning", () => {
    const data = fixture();
    data.decals.push({
      vertexI: 3,
      layerI: 0,
      triangleI: 0,
      barycentric: { x: 0.25, y: 0.25, z: 0.5 },
    });
    const mesh = parse(data);
    const vertices = skinMesh(mesh, dragMeshJoint(mesh.joints, 1, { x: 0, y: 10 }));
    point(vertices[3], 1.75, 12.25);
  });
  it("fits geometry and joints into narrow previews without zero scale", () => {
    const mesh = parse(fixture());
    const bounds = meshBounds(mesh);
    const view = meshViewport(bounds, 200, 400);
    for (const p of [...mesh.vertices, ...mesh.joints.map((joint) => joint.position)]) {
      expect(p.x * view.scale + view.x).toBeGreaterThanOrEqual(32);
      expect(p.x * view.scale + view.x).toBeLessThanOrEqual(168);
      expect(p.y * view.scale + view.y).toBeGreaterThanOrEqual(32);
      expect(p.y * view.scale + view.y).toBeLessThanOrEqual(368);
    }
    expect(meshViewport(bounds, 0, 0).scale).toBeGreaterThan(0);
  });
});

function ikFixture(left = true) {
  const data = fixture();
  data.joints.push({ name: "Toe", parentI: 2, position: { x: 22, y: 0 } });
  return {
    ...data,
    ikHandles: [
      {
        startJointI: 0,
        midJointI: 1,
        endJointI: 2,
        descendantJointI: 3,
        rootToMidLength: 10,
        midToTipLength: 10,
        midJointIsLeftOfLine: left,
      },
    ],
  };
}

describe("Polyzonia IK posing", () => {
  it.each([true, false])(
    "drags the foot and toe while bending the knee on its authored side (%s)",
    (left) => {
      const mesh = parse(ikFixture(left));
      const pose = dragMeshJoint(mesh.joints, 2, { x: 10, y: 10 }, mesh.ikHandles);
      point(pose[0]!.position, 0, 0);
      point(pose[1]!.position, left ? 0 : 10, left ? 10 : 0);
      point(pose[2]!.position, 10, 10);
      point(pose[3]!.position, 12, 10);
      for (const [a, b] of [
        [0, 1],
        [1, 2],
      ] as const) {
        expect(
          Math.hypot(
            pose[a]!.position.x - pose[b]!.position.x,
            pose[a]!.position.y - pose[b]!.position.y,
          ),
        ).toBeCloseTo(10);
      }
      point(skinMesh(mesh, pose)[0], left ? -2 : 10, left ? 10 : 2);
      point(mesh.joints[2]!.position, 20, 0);
    },
  );

  it("keeps feet planted when moving the root and releases them when IK is off", () => {
    const mesh = parse(ikFixture());
    const pose = dragMeshJoint(mesh.joints, 0, { x: 5, y: 0 }, mesh.ikHandles);
    point(pose[0]!.position, 5, 0);
    point(pose[2]!.position, 20, 0);
    point(pose[3]!.position, 22, 0);
    point(pose[1]!.position, 12.5, Math.sqrt(100 - 7.5 ** 2));
    const released = dragMeshJoint(mesh.joints, 0, { x: 5, y: 0 });
    point(released[2]!.position, 25, 0);
    point(released[3]!.position, 27, 0);
    const rotated = dragMeshJoint(mesh.joints, 2, { x: 10, y: 10 });
    point(rotated[1]!.position, 10, 0);
    point(rotated[3]!.position, 10, 12);
  });

  it.each([0, 2, 25])("matches the game's straight-line fallback at distance %s", (distance) => {
    const data = ikFixture();
    data.ikHandles[0]!.rootToMidLength = 12;
    data.ikHandles[0]!.midToTipLength = 8;
    const mesh = parse(data);
    const pose = dragMeshJoint(mesh.joints, 2, { x: distance, y: 0 }, mesh.ikHandles);
    point(pose[1]!.position, distance * 0.6, 0);
    point(pose[2]!.position, distance, 0);
    expect(skinMesh(mesh, pose).every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))).toBe(
      true,
    );
  });

  it("does not move another foot while dragging one handle", () => {
    const data = ikFixture();
    data.joints.push(
      { name: "Other knee", parentI: 0, position: { x: -10, y: 0 } },
      { name: "Other foot", parentI: 4, position: { x: -20, y: 0 } },
    );
    data.ikHandles.push({
      ...data.ikHandles[0]!,
      midJointI: 4,
      endJointI: 5,
      descendantJointI: -1,
    });
    const mesh = parse(data);
    const pose = dragMeshJoint(mesh.joints, 2, { x: 10, y: 10 }, mesh.ikHandles);
    point(pose[5]!.position, -20, 0);
    point(pose[2]!.position, 10, 10);
  });

  it.each(["index", "chain", "length", "descendant"])("rejects invalid IK %s", (kind) => {
    const data = ikFixture();
    if (kind === "index") data.ikHandles[0]!.endJointI = 500;
    if (kind === "chain") data.ikHandles[0]!.midJointI = 2;
    if (kind === "length") data.ikHandles[0]!.rootToMidLength = 0;
    if (kind === "descendant") data.ikHandles[0]!.descendantJointI = 0;
    expect(parsePolyzoniaMesh("mesh.json", JSON.stringify(data))).toBeNull();
  });
});
