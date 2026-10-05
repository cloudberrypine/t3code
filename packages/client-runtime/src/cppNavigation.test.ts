import { expect, it, vi } from "vite-plus/test";
import { resolveCppNavigation, resolveCppCounterpart } from "./cppNavigation.js";
import { angelScriptCppSymbol } from "@t3tools/shared/cppNavigation";
function fixture(files: Record<string, string>) {
  const read = vi.fn(async (relativePath: string) => {
    const contents = files[relativePath];
    return contents === undefined
      ? null
      : { relativePath, contents, byteLength: contents.length, truncated: false };
  });
  const search = vi.fn(async (query: string) => ({
    matches: Object.entries(files).flatMap(([path, contents]) =>
      contents
        .split("\n")
        .flatMap((lineContent, i) =>
          new RegExp(query).test(lineContent)
            ? [{ path, lineNumber: i + 1, lineContent, matchRanges: [] }]
            : [],
        ),
    ),
    truncated: false,
  }));
  const findFiles = vi.fn(async (name: string) => ({
    entries: Object.keys(files)
      .filter((path) => path.split("/").at(-1) === name)
      .map((path) => ({ path, kind: "file" as const })),
    truncated: false,
  }));
  return { read, search, findFiles };
}
it("follows generated API types, nested fields and generic binding wrappers in the supplied environment", async () => {
  const api = {
    path: "generated/ScriptingAPI.as",
    contents: "class Position_Bounds {\n int width;\n}\nclass World {\n Entity entity(int id);\n}",
  };
  const reader = fixture({
    "src/types.h": "namespace Process { struct Position { struct Bounds {\n int width;\n}; }; }",
    "src/register.cpp":
      'engine->RegisterObjectMethod("World", "Entity entity(int id)", asFUNCTION(World_entity), asCALL_GENERIC);',
    "src/wrappers.cpp": "namespace Process {\nvoid World_entity(asIScriptGeneric *gen) {}\n}",
  });
  for (const [needle, path, line] of [
    ["width", "src/types.h", 2],
    ["entity(", "src/wrappers.cpp", 2],
  ] as const) {
    const offset = api.contents.indexOf(needle);
    expect(
      await resolveCppNavigation({
        source: api,
        offset,
        apiSymbol: angelScriptCppSymbol(api, offset)!,
        ...reader,
      }),
    ).toEqual({ path, line });
  }
});
it("reopens a method implementation from its prototype and follows pointer member uses", async () => {
  const files = {
    "src/model.h":
      "namespace Process {\nstruct Model {\n void move(int amount);\n int value;\n};\n}",
    "src/model.cpp":
      "namespace Process {\nvoid Model::move(int amount) {}\nvoid run(Model* model) { model->move(3); }\n}",
  };
  const reader = fixture(files);
  const header = { path: "src/model.h", contents: files["src/model.h"] };
  expect(
    await resolveCppNavigation({
      source: header,
      offset: header.contents.indexOf("move("),
      ...reader,
    }),
  ).toEqual({ path: "src/model.cpp", line: 2 });
  const cpp = { path: "src/model.cpp", contents: files["src/model.cpp"] };
  expect(
    await resolveCppNavigation({
      source: cpp,
      offset: cpp.contents.lastIndexOf("move("),
      ...reader,
    }),
  ).toEqual({ path: "src/model.cpp", line: 2 });
});
it("follows quoted and angle includes, preferring relative files and rejecting ambiguous basenames", async () => {
  const reader = fixture({
    "src/local.h": "",
    "include/lib/math.hpp": "",
    "one/common.h": "",
    "two/common.h": "",
  });
  const source = {
    path: "src/main.cpp",
    contents: '#include "local.h"\n#include <lib/math.hpp>\n#include "common.h"',
  };
  expect(
    await resolveCppNavigation({ source, offset: source.contents.indexOf("local.h"), ...reader }),
  ).toEqual({ path: "src/local.h", line: 1 });
  expect(
    await resolveCppNavigation({ source, offset: source.contents.indexOf("math.hpp"), ...reader }),
  ).toEqual({ path: "include/lib/math.hpp", line: 1 });
  expect(
    await resolveCppNavigation({ source, offset: source.contents.indexOf("common.h"), ...reader }),
  ).toBeNull();
});
it("uses the current unsaved buffer for locals without searching or reading", async () => {
  const reader = fixture({});
  const source = { path: "main.cpp", contents: "void run() {\n int local = 2;\n local++;\n}" };
  expect(
    await resolveCppNavigation({ source, offset: source.contents.lastIndexOf("local"), ...reader }),
  ).toEqual({ path: source.path, line: 2 });
  expect(reader.search).not.toHaveBeenCalled();
  expect(reader.read).not.toHaveBeenCalled();
});
it("does not return a definition from truncated file contents", async () => {
  const reader = fixture({ "src/type.h": "struct Thing {};" });
  reader.read.mockImplementation(async (relativePath) => ({
    relativePath,
    contents: "struct Thing {};",
    byteLength: 10000000,
    truncated: true,
  }));
  expect(
    await resolveCppNavigation({
      source: { path: "main.cpp", contents: "Thing item;" },
      offset: 0,
      ...reader,
    }),
  ).toBeNull();
});
it("bounds cross-file reads even when search returns hundreds of candidates", async () => {
  const reader = fixture(
    Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`src/${i}.h`, "struct Thing {};"])),
  );
  await resolveCppNavigation({
    source: { path: "main.cpp", contents: "Thing item;" },
    offset: 0,
    ...reader,
  });
  expect(reader.read.mock.calls.length).toBeLessThanOrEqual(24);
});
it("does not reuse data across workspaces", async () => {
  const source = { path: "main.cpp", contents: "void run() { target(); }" };
  for (const path of ["first/target.cpp", "second/target.cpp"]) {
    expect(
      await resolveCppNavigation({
        source,
        offset: source.contents.indexOf("target"),
        ...fixture({ [path]: "void target() {}" }),
      }),
    ).toEqual({ path, line: 1 });
  }
});

it("prefers the CLion bridge namespace over vendor example types with the same name", async () => {
  const source = { path: "ScriptingAPI.as", contents: "class Position {}" };
  const reader = fixture({
    "external/example.cpp": "struct Position {};",
    "src/types.h": "namespace Process {\nstruct Position {};\n}",
  });
  expect(
    await resolveCppNavigation({
      source,
      offset: 6,
      apiSymbol: { name: "Position", typeOnly: true },
      ...reader,
    }),
  ).toEqual({ path: "src/types.h", line: 2 });
});

it("resolves struct references without counting forward declarations as variables", async () => {
  const source = {
    path: "src/Dive.cpp",
    contents:
      "namespace Process {\nvoid wake(Entity e) { if (ScriptRunner *runner = e.get<ScriptRunner>()) runner->start(e); }\n}",
  };
  const reader = fixture({
    "src/Forward.h": "namespace Process { struct ScriptRunner; }",
    "src/Behavior.h":
      "namespace Process {\nstruct ScriptRunner;\nstruct ScriptRunner { void start(Entity e); };\n}",
  });
  for (const offset of [
    source.contents.indexOf("ScriptRunner"),
    source.contents.lastIndexOf("ScriptRunner"),
  ])
    expect(await resolveCppNavigation({ source, offset, ...reader })).toEqual({
      path: "src/Behavior.h",
      line: 3,
    });
});
it("keeps anonymous-namespace helpers in the current file ahead of unrelated helpers", async () => {
  const source = {
    path: "src/Dive.cpp",
    contents:
      "namespace Process {\nnamespace {\nstruct Limits {};\nvoid Finish(int n) {}\n}\nvoid run() { Limits bounds; Finish(1); }\n}",
  };
  const reader = fixture({
    "src/Other.cpp": "namespace Process { namespace { void Finish(int n) {} } }",
  });
  expect(
    await resolveCppNavigation({
      source,
      offset: source.contents.lastIndexOf("Finish"),
      ...reader,
    }),
  ).toEqual({ path: source.path, line: 4 });
  expect(
    await resolveCppNavigation({
      source,
      offset: source.contents.lastIndexOf("Limits"),
      ...reader,
    }),
  ).toEqual({ path: source.path, line: 3 });
  expect(reader.search).not.toHaveBeenCalled();
});
it("searches a header declaration's qualified method before generic names exhaust the read budget", async () => {
  const source = {
    path: "src/Behavior.h",
    contents:
      "namespace Process {\nstruct Other { void start(int n); };\nstruct ScriptRunner { void start(int n = 1); };\n}",
  };
  const reader = fixture({
    ...Object.fromEntries(
      Array.from({ length: 20 }, (_, i) => [
        `src/noise${i}.cpp`,
        `namespace Noise${i} { void start(int n) {} }`,
      ]),
    ),
    "src/Execution.cpp": "namespace Process {\nvoid ScriptRunner::start(int n) {}\n}",
  });
  expect(
    await resolveCppNavigation({ source, offset: source.contents.lastIndexOf("start"), ...reader }),
  ).toEqual({ path: "src/Execution.cpp", line: 2 });
  expect(reader.read.mock.calls).toEqual([["src/Execution.cpp"]]);
});
it("does not jump back onto a prototype when its implementation is unavailable", async () => {
  const source = { path: "src/Model.h", contents: "struct Model { void start(int n); };" };
  expect(
    await resolveCppNavigation({
      source,
      offset: source.contents.indexOf("start"),
      ...fixture({}),
    }),
  ).toBeNull();
});
it("resolves implicit members in out-of-class bodies and members of indexed vectors", async () => {
  const source = {
    path: "src/Dive.cpp",
    contents:
      '#include "Types.h"\nnamespace Process {\nvoid Dive::run(Pose &pose) {\n state = 1;\n pose.joints[0].position = 2;\n}\n}',
  };
  const reader = fixture({
    "include/Types.h":
      "namespace Process {\nstruct Joint { int position; };\nstruct Pose { std::vector<Joint> joints; };\nstruct Dive { int state; void run(Pose &pose); };\nstruct Other { int position; int state; };\n}",
  });
  expect(
    await resolveCppNavigation({ source, offset: source.contents.indexOf("state ="), ...reader }),
  ).toEqual({ path: "include/Types.h", line: 4 });
  expect(
    await resolveCppNavigation({
      source,
      offset: source.contents.indexOf("position ="),
      ...reader,
    }),
  ).toEqual({ path: "include/Types.h", line: 2 });
});
it("does not mistake using-directives or unrelated macros for definitions", async () => {
  const source = {
    path: "src/Dive.cpp",
    contents: "void run() { calc(M_PI); glm::length(value); }",
  };
  const reader = fixture({
    "external/vendor.c": "#define M_PI 3.14",
    "external/exports.cppm": "namespace glm { using glm::length; }",
  });
  expect(
    await resolveCppNavigation({ source, offset: source.contents.indexOf("M_PI"), ...reader }),
  ).toBeNull();
  expect(
    await resolveCppNavigation({ source, offset: source.contents.indexOf("length"), ...reader }),
  ).toBeNull();
});

it("switches between matching source/header files in both directions", async () => {
  const reader = fixture({
    "src/behavior/DiveMovement.h": "",
    "src/behavior/DiveMovement.cpp": "",
    "other/DiveMovement.cpp": "",
  });
  expect(await resolveCppCounterpart("src/behavior/DiveMovement.h", reader.findFiles)).toEqual({
    path: "src/behavior/DiveMovement.cpp",
    line: 1,
  });
  expect(await resolveCppCounterpart("src/behavior/DiveMovement.cpp", reader.findFiles)).toEqual({
    path: "src/behavior/DiveMovement.h",
    line: 1,
  });
});
it("finds split include/src counterparts and leaves missing or ambiguous matches alone", async () => {
  const reader = fixture({
    "include/Model.hpp": "",
    "src/Model.cc": "",
    "first/Shared.cpp": "",
    "other/Shared.cpp": "",
  });
  expect(await resolveCppCounterpart("include/Model.hpp", reader.findFiles)).toEqual({
    path: "src/Model.cc",
    line: 1,
  });
  expect(await resolveCppCounterpart("src/Model.cc", reader.findFiles)).toEqual({
    path: "include/Model.hpp",
    line: 1,
  });
  expect(await resolveCppCounterpart("include/Shared.h", reader.findFiles)).toBeNull();
  expect(await resolveCppCounterpart("Missing.cpp", reader.findFiles)).toBeNull();
  expect(await resolveCppCounterpart("Model.as", reader.findFiles)).toBeNull();
});

it("toggles a method implementation back to its header declaration", async () => {
  const files = {
    "src/DiveMovement.h": "struct DiveMovement {\n void surface(World &world, Entity e);\n};",
    "src/DiveMovement.cpp":
      "void DiveMovement::surface(World &world, Entity e) {\n}\nvoid run(DiveMovement &movement) { movement.surface(world, e); }",
  };
  const reader = fixture(files);
  const source = { path: "src/DiveMovement.cpp", contents: files["src/DiveMovement.cpp"] };
  expect(
    await resolveCppNavigation({ source, offset: source.contents.indexOf("surface"), ...reader }),
  ).toEqual({ path: "src/DiveMovement.h", line: 2 });
  expect(reader.search).not.toHaveBeenCalled();
  expect(
    await resolveCppNavigation({
      source,
      offset: source.contents.lastIndexOf("surface"),
      ...reader,
    }),
  ).toEqual({ path: "src/DiveMovement.cpp", line: 1 });
  const header = { path: "src/DiveMovement.h", contents: files["src/DiveMovement.h"] };
  expect(
    await resolveCppNavigation({
      source: header,
      offset: header.contents.indexOf("surface"),
      ...reader,
    }),
  ).toEqual({ path: "src/DiveMovement.cpp", line: 1 });
});

it("leaves an implementation without a matching declaration unresolved", async () => {
  const source = { path: "helper.cpp", contents: "void helper(int amount) {}" };
  expect(
    await resolveCppNavigation({
      source,
      offset: source.contents.indexOf("helper"),
      ...fixture({ "helper.cpp": source.contents }),
    }),
  ).toBeNull();
});

it("finds a local function template called with a capturing lambda without searching the workspace", async () => {
  const source = {
    path: "src/ui/InGameGUIHelpers.cpp",
    contents: `namespace Process {
template <typename Callback>
static void ForEachWaterBodyForDistanceChecks(const Ground &ground, Callback &&callback)
{
    for (const WaterBody &waterBody : ground.waterBodies) callback(waterBody);
}
float DistanceToClosestWaterBody(const Ground &ground, float x)
{
    float distance = 0;
    ForEachWaterBodyForDistanceChecks(ground, [&](const WaterBody &waterBody) {
        distance = DistanceToWaterBodyInterval(waterBody, x);
    });
    return distance;
}
}`,
  };
  const reader = fixture({ [source.path]: source.contents });
  expect(
    await resolveCppNavigation({
      source,
      offset: source.contents.indexOf("ForEachWaterBodyForDistanceChecks(ground"),
      ...reader,
    }),
  ).toEqual({ path: source.path, line: 3 });
  expect(reader.search).not.toHaveBeenCalled();
  expect(reader.read).not.toHaveBeenCalled();
  expect(reader.findFiles).not.toHaveBeenCalled();
});

it("bridges generated methods whose world/entity context parameters are hidden from AngelScript", async () => {
  const source = {
    path: "assets/scripts/ScriptingAPI.as",
    contents: `class DiveMovement {
    void dive(uint64 targetEntityId); /** await(Succeeded) */
    void surface(); /** await(Succeeded) */
  }`,
  };
  const reader = fixture({
    "src/behavior/DiveMovement.h": `namespace Process { struct DiveMovement {
      void dive(flecs::world &world, flecs::entity e, flecs::entity_t targetEntityId);
      void surface(flecs::world &world, flecs::entity e);
    }; }`,
    "src/behavior/DiveMovement.cpp": `namespace Process {
      void DiveMovement::dive(flecs::world &world, flecs::entity e, flecs::entity_t targetEntityId) {}
      void DiveMovement::surface(flecs::world &world, flecs::entity e) {}
    }`,
    "external/example.cpp": "struct DiveMovement { void dive(int id) {} void surface() {} };",
  });
  for (const [name, line] of [
    ["dive", 2],
    ["surface", 3],
  ] as const) {
    const offset = source.contents.indexOf(name + "(");
    expect(
      await resolveCppNavigation({
        source,
        offset,
        apiSymbol: angelScriptCppSymbol(source, offset)!,
        ...reader,
      }),
    ).toEqual({ path: "src/behavior/DiveMovement.cpp", line });
  }
});

it("still rejects ambiguous bridge overloads and selects an exact parameter count when available", async () => {
  const source = { path: "ScriptingAPI.as", contents: "class Movement { void move(int target); }" };
  const offset = source.contents.indexOf("move(");
  for (const exact of [false, true]) {
    const reader = fixture({
      "src/Movement.h":
        "namespace Process { struct Movement { void move(World &w, Entity e, int target); void move(World &w, int target); }; }",
      "src/Movement.cpp": `namespace Process {
        void Movement::move(World &w, Entity e, int target) {}
        void Movement::move(World &w, int target) {}
        ${exact ? "void Movement::move(int target) {}" : ""}
      }`,
    });
    expect(
      await resolveCppNavigation({
        source,
        offset,
        apiSymbol: angelScriptCppSymbol(source, offset)!,
        ...reader,
      }),
    ).toEqual(exact ? { path: "src/Movement.cpp", line: 4 } : null);
  }
});

it("does not relax argument counts for ordinary C++ calls", async () => {
  const source = { path: "main.cpp", contents: "void run() { Movement::move(1); }" };
  expect(
    await resolveCppNavigation({
      source,
      offset: source.contents.indexOf("move("),
      ...fixture({ "src/Movement.cpp": "void Movement::move(World &w, Entity e, int target) {}" }),
    }),
  ).toBeNull();
});

it("finds renamed generated await implementations using the original native signature", async () => {
  const source = {
    path: "ScriptingAPI.as",
    contents: "class Timer { bool Wait(float seconds); /** await(Succeeded) */ }",
  };
  const offset = source.contents.indexOf("Wait");
  const reader = fixture({
    "src/Timer.h": "struct Timer { void wait(World& w, Entity e, float seconds); };",
    "src/Timer.cpp": "void Timer::wait(World& w, Entity e, float seconds) {}",
  });
  expect(
    await resolveCppNavigation({
      source,
      offset,
      apiSymbol: angelScriptCppSymbol(source, offset)!,
      ...reader,
    }),
  ).toEqual({ path: "src/Timer.cpp", line: 1 });
});
