import { describe, expect, it } from "vite-plus/test";
import { angelScriptNavigationFile, createAngelScriptNavigation } from "./angelscriptNavigation.js";

function resolve(contents: string, needle: string, api = "", occurrence = "last") {
  const navigation = createAngelScriptNavigation([
    { path: "scripts/main.as", contents },
    { path: "scripts/ScriptingAPI.as", contents: api },
  ]);
  const offset = occurrence === "last" ? contents.lastIndexOf(needle) : contents.indexOf(needle);
  return navigation.resolve("scripts/main.as", offset);
}

describe("AngelScript definition navigation", () => {
  it("jumps from enum State members to matching behavior state blocks in the same scope", () => {
    const source =
      "namespace Otter {\n enum State { Roaming, EnteringWater, Diving, JoiningHunt, BuildingDen, ReturningToDen, AtDen }\n state Roaming { void run() {} }\n state EnteringWater { void run() {} }\n}";
    expect(resolve(source, "Roaming", "", "first")).toEqual({ path: "scripts/main.as", line: 3 });
    expect(resolve(source, "EnteringWater", "", "first")).toEqual({
      path: "scripts/main.as",
      line: 4,
    });
    expect(
      resolve(
        source + "\nnamespace Other { enum State { EnteringWater }\n state EnteringWater {} }",
        "EnteringWater",
        "",
        "first",
      ),
    ).toEqual({ path: "scripts/main.as", line: 4 });
  });

  it("does not redirect other enums or states from another behavior/file", () => {
    expect(resolve("enum Mode { Running }\nstate Running {}", "Running", "", "first")).toEqual({
      path: "scripts/main.as",
      line: 1,
    });
    expect(resolve("enum State { Running }", "Running", "state Running {}", "first")).toBeNull();
    expect(
      resolve(
        "namespace Bee { enum State { Running } }\nnamespace Ant { state Running {} }",
        "Running",
        "",
        "first",
      ),
    ).toBeNull();
    expect(
      resolve("enum State { Running }\nstate Running {}\nstate Running {}", "Running", "", "first"),
    ).toBeNull();
    expect(
      resolve("enum State { Running }\n// state Running {}", "Running", "", "first"),
    ).toBeNull();
    expect(resolve("enum State { Running }\nstate Running {}\nState::Running;", "Running")).toEqual(
      { path: "scripts/main.as", line: 1 },
    );
  });
  it("resolves local functions, parameters and the innermost live variable", () => {
    const source =
      "void helper() {}\nvoid run(int value) {\n int count = 1;\n { int count = 2;\n count++; }\n count++;\n value++;\n helper();\n}";
    expect(resolve(source, "helper();")).toEqual({ path: "scripts/main.as", line: 1 });
    expect(resolve(source, "value++")).toEqual({ path: "scripts/main.as", line: 2 });
    expect(resolve(source, "count++", "", "first")).toEqual({ path: "scripts/main.as", line: 4 });
    expect(resolve(source, "count++")).toEqual({ path: "scripts/main.as", line: 3 });
  });

  it("never borrows locals or parameters from a different function", () => {
    expect(
      resolve("void a(int value) { int local; }\nvoid b() { value++; local++; }", "value++"),
    ).toBeNull();
    expect(
      resolve("void a(int value) { int local; }\nvoid b() { value++; local++; }", "local++"),
    ).toBeNull();
  });

  it("keeps loop variables inside the loop", () => {
    const source =
      "void run() {\n int value;\n for (int value = 0; value < 2; value++) { value++; }\n value++;\n}";
    expect(resolve(source, "value++", "", "first")).toEqual({ path: "scripts/main.as", line: 3 });
    expect(resolve(source, "value++")).toEqual({ path: "scripts/main.as", line: 2 });
  });

  it("resolves API types, globals, functions, enum values and members", () => {
    const api =
      "class World {\n void wait();\n}\nclass Context {\n World world;\n}\nContext@ context;\nWorld getWorld();\nenum Mode { Active, Inactive }";
    expect(resolve("Context@ c;", "Context", api)).toEqual({
      path: "scripts/ScriptingAPI.as",
      line: 4,
    });
    expect(resolve("context.world.wait();", "context", api)).toEqual({
      path: "scripts/ScriptingAPI.as",
      line: 7,
    });
    expect(resolve("context.world.wait();", "world", api)).toEqual({
      path: "scripts/ScriptingAPI.as",
      line: 5,
    });
    expect(resolve("context.world.wait();", "wait", api)).toEqual({
      path: "scripts/ScriptingAPI.as",
      line: 2,
    });
    expect(resolve("getWorld().wait();", "wait", api)).toEqual({
      path: "scripts/ScriptingAPI.as",
      line: 2,
    });
    expect(resolve("Mode::Active;", "Active", api)).toEqual({
      path: "scripts/ScriptingAPI.as",
      line: 9,
    });
  });

  it("infers receivers from parameters, handles, auto, get<T>(), and this", () => {
    const api = "class World {\n void wait();\n}\nWorld getWorld();";
    for (const source of [
      "void run(World@ world) { world.wait(); }",
      "void run() { auto world = getWorld(); world.wait(); }",
      "get<World>().wait();",
    ])
      expect(resolve(source, "wait", api)).toEqual({ path: "scripts/ScriptingAPI.as", line: 2 });
    expect(
      resolve("class Local {\n int field;\n void run() { this.field++; }\n}", "field++"),
    ).toEqual({ path: "scripts/main.as", line: 2 });
  });

  it("follows Polyzonia-style generic getters and preserves concrete generic return types", () => {
    const api =
      "class Context {\n T@ getObject<T>();\n}\nclass World {\n Entity singleton<T>();\n}\nclass Entity {\n uint64 id();\n T@ gett<T>(uint64 target);\n}";
    const source =
      "namespace AntNest { class Object {\n int antCount;\n} }\nvoid run(Context@ c) { c.getObject<AntNest::Object>().antCount++; }";
    expect(resolve(source, "getObject", api)).toEqual({ path: "scripts/ScriptingAPI.as", line: 2 });
    expect(resolve(source, "antCount++", api)).toEqual({ path: "scripts/main.as", line: 2 });
    expect(resolve("void run(World@ w) { w.singleton<Something>().id(); }", "id", api)).toEqual({
      path: "scripts/ScriptingAPI.as",
      line: 8,
    });
    expect(
      resolve(
        "namespace AntNest { class Object {\n int antCount;\n} }\nvoid run(Entity e) { e.gett<AntNest::Object>(42).antCount++; }",
        "antCount++",
        api,
      ),
    ).toEqual({ path: "scripts/main.as", line: 2 });
  });

  it("distinguishes overloads by argument count, including optional and string arguments", () => {
    const api =
      "class World {\n void fireEvent(uint64 type);\n bool fireEvent(uint64 type, Entity target);\n void message(string value, bool show = false);\n}";
    expect(
      resolve("void run(World@ w) { w.fireEvent(EventType_OtterHunt); }", "fireEvent", api),
    ).toEqual({ path: "scripts/ScriptingAPI.as", line: 2 });
    expect(
      resolve("void run(World@ w) { w.fireEvent(event(), getEntity(1, 2)); }", "fireEvent", api),
    ).toEqual({ path: "scripts/ScriptingAPI.as", line: 3 });
    expect(resolve('void run(World@ w) { w.message("hello, world"); }', "message", api)).toEqual({
      path: "scripts/ScriptingAPI.as",
      line: 4,
    });
  });

  it("resolves unqualified enum values locally before consulting API enums", () => {
    const api = "enum Result { Failed, Succeeded }";
    expect(
      resolve(
        "enum RenderLocation { Burrow, Ground, Tree }\nvoid run() { int location = Burrow; }",
        "Burrow",
        api,
      ),
    ).toEqual({ path: "scripts/main.as", line: 1 });
    expect(resolve("void run() { int result = Failed; }", "Failed", api)).toEqual({
      path: "scripts/ScriptingAPI.as",
      line: 1,
    });
    expect(
      resolve("enum LocalResult { Failed }\nvoid run() { int result = Failed; }", "Failed", api),
    ).toEqual({ path: "scripts/main.as", line: 1 });
  });

  it("resolves namespace-qualified types and methods without confusing same-named classes", () => {
    const api =
      "namespace A { class Object {\n void wait();\n} }\nnamespace B { class Object {\n void wait();\n} }";
    expect(resolve("B::Object obj; obj.wait();", "wait", api)).toEqual({
      path: "scripts/ScriptingAPI.as",
      line: 5,
    });
    expect(resolve("A::Object obj;", "Object", api)).toEqual({
      path: "scripts/ScriptingAPI.as",
      line: 1,
    });
    expect(resolve("Object obj;", "Object", api)).toBeNull();
    expect(resolve("namespace B { Object obj; }", "Object", api)).toEqual({
      path: "scripts/ScriptingAPI.as",
      line: 4,
    });
  });

  it("does not mistake comments, strings, calls, or unknown receivers for definitions", () => {
    const api = "void wait();\nclass World { void run(); }";
    for (const source of ["// wait()", '"wait()"', '"""\nwait()\n"""', "/* wait() */"]) {
      expect(resolve(source, "wait", api)).toBeNull();
    }
    expect(resolve("mystery.wait();", "wait", api)).toBeNull();
    expect(resolve("void run() { unknown(); unknown(); }", "unknown")).toBeNull();
    expect(resolve("void run() { return madeUp; }\nmadeUp;", "madeUp")).toBeNull();
  });

  it("leaves overloads ambiguous and observes the current edited buffer", () => {
    expect(resolve("run(value);", "run", "void run(int a); void run(string a);")).toBeNull();
    expect(resolve("run();", "run", "void run(int a); void run(string a);")).toBeNull();
    expect(resolve("\n\nvoid helper() {}\nhelper();", "helper")).toEqual({
      path: "scripts/main.as",
      line: 3,
    });
  });
});

it("resolves includes and namespace filenames within the workspace", () => {
  const file = (contents: string, needle: string) =>
    angelScriptNavigationFile({ path: "scripts/main.as", contents }, contents.indexOf(needle));
  expect(file('#include "other.as"', "other")).toBe("scripts/other.as");
  expect(file('#include "../shared/other.as"', "include")).toBe("shared/other.as");
  expect(file('#include "../../outside.as"', "outside")).toBeNull();
  expect(file("Bee::Object obj;", "Object")).toBe("scripts/Bee.as");
  expect(file("Bee::Object obj;", "Bee")).toBe("scripts/Bee.as");
  expect(file("// Bee::Object", "Bee")).toBeNull();
  expect(file('"Bee::Object"', "Bee")).toBeNull();
  expect(file('/*\n#include "other.as"\n*/', "other")).toBeNull();
});

const treeHeader = "// State tree (generated; update with --check-script <file> --write-tree):";

it("navigates generated tree roots and conditional/loop children to their namespace's states", () => {
  const source = `${treeHeader}\n//   Main  [initial]\n//   |-- Rest ? *\n//   \`-- Main\nnamespace Capybara {\n state Main {}\n state Rest {}\n}\nnamespace Other { state Rest {} }`;
  expect(resolve(source, "Main", "", "first")).toEqual({ path: "scripts/main.as", line: 6 });
  expect(resolve(source, "Rest", "", "first")).toEqual({ path: "scripts/main.as", line: 7 });
  expect(resolve(source, "initial", "", "first")).toBeNull();
  expect(
    resolve(source.replace(treeHeader, "// unrelated diagram"), "Main", "", "first"),
  ).toBeNull();
  expect(resolve(`/*\n${source}\n*/`, "Main", "", "first")).toBeNull();
  expect(resolve(`"""\n${source}\n"""`, "Main", "", "first")).toBeNull();
});

it("resolves generated library tree entries without borrowing another same-named state", () => {
  const main = {
    path: "scripts/main.as",
    contents: `${treeHeader}\n//   Main [initial]\n//   |-- Hunt::Approach ? (Hunt.as)\n//   Captured\n//   \`-- AwaitRelease (Life.as)\nnamespace Otter {\n state Main {}\n state AwaitRelease {}\n}`,
  };
  const library = {
    path: "scripts/Life.as",
    contents: "namespace Life {\n state Captured {}\n state AwaitRelease {}\n}",
  };
  const hunt = { path: "scripts/Hunt.as", contents: "namespace Hunt {\n state Approach {}\n}" };
  const nav = createAngelScriptNavigation([main, library, hunt]);
  expect(nav.resolve(main.path, main.contents.indexOf("Approach"))).toEqual({
    path: hunt.path,
    line: 2,
  });
  expect(nav.resolve(main.path, main.contents.indexOf("Captured"))).toEqual({
    path: library.path,
    line: 2,
  });
  expect(nav.resolve(main.path, main.contents.indexOf("AwaitRelease"))).toEqual({
    path: library.path,
    line: 3,
  });
  expect(angelScriptNavigationFile(main, main.contents.indexOf("AwaitRelease"))).toBe(library.path);
  expect(
    createAngelScriptNavigation([main, hunt]).resolve(
      main.path,
      main.contents.indexOf("AwaitRelease"),
    ),
  ).toBeNull();
  expect(
    createAngelScriptNavigation([
      main,
      library,
      { path: "scripts/Other.as", contents: "namespace Other { state Captured {} }" },
    ]).resolve(main.path, main.contents.indexOf("Captured")),
  ).toBeNull();
});

it("resolves implicit context getters and namespace-local Params/Object members", () => {
  const api =
    "World@ get_w();\nEntity get_e();\nclass World { Entity entity(uint64); }\nclass Entity { uint64 id(); }\nT awaitedEvent<T>();\nclass HuntEvent { uint64 prey; }";
  const source = `namespace Otter {\n class Params { float duration; }\n class Object { uint64 target; }\n state Main { void run() {\n w.entity(o.target).id();\n p.duration; e.id(); awaitedEvent<HuntEvent>().prey;\n } }\n}`;
  expect(resolve(source, "w.entity", api)).toEqual({ path: "scripts/ScriptingAPI.as", line: 1 });
  expect(resolve(source, "entity(o", api)).toEqual({ path: "scripts/ScriptingAPI.as", line: 3 });
  expect(resolve(source, "target)", api)).toEqual({ path: "scripts/main.as", line: 3 });
  expect(resolve(source, "duration; e", api)).toEqual({ path: "scripts/main.as", line: 2 });
  expect(resolve(source, "e.id", api)).toEqual({ path: "scripts/ScriptingAPI.as", line: 2 });
  expect(resolve(source, "id(); awaited", api)).toEqual({
    path: "scripts/ScriptingAPI.as",
    line: 4,
  });
  expect(resolve(source, "prey", api)).toEqual({ path: "scripts/ScriptingAPI.as", line: 6 });
  expect(
    resolve(
      "namespace A { class Object { int target; } }\nnamespace B { void run() { o.target; } }",
      "target;",
    ),
  ).toBeNull();
  expect(
    resolve(
      "namespace A { class Object { int target; } void run(int o) { o.target; } }",
      "target;",
    ),
  ).toBeNull();
});

it("resolves state handles and members in nested and reopened namespaces", () => {
  const source =
    "namespace Animals::Otter {\n class Object { int target; }\n state Main {}\n}\nnamespace Animals::Otter {\n void end() { c.nextState !is Main; o.target; transition(@Main); }\n}";
  const api =
    "class Context { StateEntry@ get_nextState() const; }\nContext@ get_c();\nfuncdef bool StateEntry();";
  expect(resolve(source, "nextState", api)).toEqual({ path: "scripts/ScriptingAPI.as", line: 1 });
  expect(resolve(source, "Main;", api)).toEqual({ path: "scripts/main.as", line: 3 });
  expect(resolve(source, "Main);", api)).toEqual({ path: "scripts/main.as", line: 3 });
  expect(resolve(source, "target;", api)).toEqual({ path: "scripts/main.as", line: 2 });
  expect(resolve("StateEntry@ entry;", "StateEntry", api)).toEqual({
    path: "scripts/ScriptingAPI.as",
    line: 3,
  });
});

it("follows nested script arrays and native vector indexers", () => {
  const source =
    "namespace Bird {\n class Egg { int count; }\n class Object { array<Egg> eggs; Egg[] other; }\n void run() { o.eggs[0].count; o.other[1].count; }\n}";
  expect(resolve(source, "count;", "", "first")).toEqual({ path: "scripts/main.as", line: 2 });
  expect(resolve(source, "count;")).toEqual({ path: "scripts/main.as", line: 2 });
  const api =
    "class Joint { vec2 position; }\nclass vector_Joint { Joint@ opIndex(uint); }\nclass Pose { vector_Joint joints; }\nclass Entity { T@ get<T>(); }\nEntity get_e();";
  expect(resolve("e.get<Pose>().joints[0].position;", "position", api)).toEqual({
    path: "scripts/ScriptingAPI.as",
    line: 1,
  });
  expect(
    resolve("e.get<Pose>().joints[0].position;", "position", api.replace("opIndex", "get_opIndex")),
  ).toEqual({ path: "scripts/ScriptingAPI.as", line: 1 });
});

it("keeps typed event callbacks and failure-handler parameters in their own state scope", () => {
  const source = `namespace Otter {
 state Main {
 void onEvent(ClickEvent ev) { ev.shift; }
 void onEvent(HuntStartedEvent ev) { ev.prey; }
 void onFailed(Movement@ failed) { failed.stop(); }
 }
 state Dive { void onEvent(ClickEvent ev) { ev.prey; } }
}`;
  const api =
    "class ClickEvent { bool shift; }\nclass HuntStartedEvent { uint64 prey; }\nclass Movement { void stop(); }";
  expect(resolve(source, "shift;", api)).toEqual({ path: "scripts/ScriptingAPI.as", line: 1 });
  expect(resolve(source, "prey;", api, "first")).toEqual({
    path: "scripts/ScriptingAPI.as",
    line: 2,
  });
  expect(resolve(source, "prey;", api)).toBeNull();
  expect(resolve(source, "stop();", api)).toEqual({ path: "scripts/ScriptingAPI.as", line: 3 });
});

it("infers generated vector elements even when the API omits their wrapper declarations", () => {
  const api =
    "class Joint { vec2 position; }\nclass Pose { vector_Joint joints; }\nclass Entity { T@ get<T>(); }\nEntity get_e();";
  expect(resolve("e.get<Pose>().joints[0].position;", "position", api)).toEqual({
    path: "scripts/ScriptingAPI.as",
    line: 1,
  });
  expect(resolve("vector_Missing unknown; unknown[0].position;", "position", api)).toBeNull();
});

it("resolves relative and absolute nested state qualifiers in calls and tree comments", () => {
  const source = `${treeHeader}\n//   Main [initial]\n//   \`-- Tasks::Rest\nnamespace Otter {\n namespace Tasks { state Rest {} }\n state Main { void run() { Tasks::Rest(); ::Tasks::Rest(); } }\n}\nnamespace Tasks {\n state Rest {}\n}`;
  expect(resolve(source, "Rest", "", "first")).toEqual({ path: "scripts/main.as", line: 5 });
  expect(resolve(source, "Rest();", "", "first")).toEqual({ path: "scripts/main.as", line: 5 });
  expect(resolve(source, "Rest();")).toEqual({ path: "scripts/main.as", line: 9 });
});

it("highlights variable references by declaration identity, excluding shadows, comments and strings", () => {
  const source = {
    path: "main.as",
    contents: [
      "int value;",
      "void first(int value) {",
      "  value++;",
      "  { int value; value++; } value++;",
      '  print("value"); // value',
      "}",
      "void second() { value++; }",
    ].join("\n"),
  };
  const nav = createAngelScriptNavigation([source]);
  const occurrences = (offset: number) =>
    nav.references(source.path, offset).map((range) => range.start);
  const parameter = source.contents.indexOf("value)");
  expect(occurrences(parameter)).toEqual([
    parameter,
    source.contents.indexOf("value++"),
    source.contents.indexOf("value++", source.contents.indexOf("} value")),
  ]);
  expect(occurrences(source.contents.indexOf("int value; value") + 4)).toEqual([
    source.contents.indexOf("int value; value") + 4,
    source.contents.indexOf("value++; }"),
  ]);
  expect(occurrences(source.contents.indexOf("value;"))).toEqual([
    source.contents.indexOf("value;"),
    source.contents.lastIndexOf("value++"),
  ]);
  expect(occurrences(source.contents.indexOf('"value"') + 1)).toEqual([]);
  expect(occurrences(source.contents.indexOf("// value") + 3)).toEqual([]);
  expect(occurrences(source.contents.indexOf("first"))).toEqual([]);
});

it("distinguishes members from same-named locals and other classes", () => {
  const source = {
    path: "main.as",
    contents: [
      "class A { int count; void run(int count) { this.count += count; } }",
      "class B { int count; }",
      "void run(A a, B b) { a.count++; b.count++; }",
    ].join("\n"),
  };
  const nav = createAngelScriptNavigation([source]);
  expect(
    nav.references(source.path, source.contents.indexOf("count;")).map((range) => range.start),
  ).toEqual([
    source.contents.indexOf("count;"),
    source.contents.indexOf("this.count") + 5,
    source.contents.indexOf("a.count") + 2,
  ]);
});

it("finds references to API members while returning only occurrences in the open script", () => {
  const source = { path: "main.as", contents: "void run(Entity e) { e.health++; e.health = 5; }" };
  const api = { path: "ScriptingAPI.as", contents: "class Entity { int health; }" };
  const nav = createAngelScriptNavigation([source, api]);
  expect(
    nav.references(source.path, source.contents.indexOf("health")).map((range) => range.start),
  ).toEqual([source.contents.indexOf("health"), source.contents.lastIndexOf("health")]);
});

it("resolves deadline waits, typed pair handlers and generic event payloads in the current API", () => {
  const api = `bool waitUntil(double);
class Action {} const Action Action_Hunt;
class GridSensor { void stop(); }
class BirthDue { Entity parent; }
T awaitedEvent<T>();`;
  const source = `namespace Animal {
    void onSucceeded<Action_Hunt>(GridSensor sensor) { sensor.stop(); }
    state Main { void run() { waitUntil(10); awaitedEvent<BirthDue>().parent; } }
  }`;
  for (const [needle, line] of [
    ["waitUntil", 1],
    ["Action_Hunt", 2],
    ["stop", 3],
    ["parent", 4],
  ] as const) {
    expect(resolve(source, needle, api), needle).toEqual({ path: "scripts/ScriptingAPI.as", line });
  }
  expect(resolve(source + "\nvoid outside() { sensor.stop(); }", "stop", api)).toBeNull();
});

it("resolves library p/o to the library classes and fields, including when embedded under different names", () => {
  const library = `library Relay {
 class Params { float interval; }
 class Object { Entity target; }
 double dueT() { p.interval; o.target; return 0; }
 state Rest { void run() { WaitUntil(p.interval); } }
 void helper(Entity o) { o.destroy(); }
}`;
  const behavior = `#include "Relay.as"
behavior Animal {
 class Params { Relay::Params eggSettings; }
 class Object { Relay::Object egg; }
 state Main { void run() { p.eggSettings.interval; o.egg.target; Relay::Rest(); } }
}`;
  const api = `class Entity { void destroy(); }\nbool WaitUntil(double);`;
  const navigation = createAngelScriptNavigation([
    { path: "Relay.as", contents: library },
    { path: "Animal.as", contents: behavior },
    { path: "ScriptingAPI.as", contents: api },
  ]);
  for (const [text, line] of [
    ["p.interval", 2],
    ["o.target", 3],
    ["interval;", 2],
    ["target;", 3],
  ] as const) {
    expect(navigation.resolve("Relay.as", library.lastIndexOf(text)), text).toEqual({
      path: "Relay.as",
      line,
    });
  }
  expect(navigation.resolve("Relay.as", library.indexOf("destroy"))).toEqual({
    path: "ScriptingAPI.as",
    line: 1,
  });
  for (const [text, path, line] of [
    ["p.egg", "Animal.as", 3],
    ["o.egg", "Animal.as", 4],
    ["interval;", "Relay.as", 2],
    ["target;", "Relay.as", 3],
    ["Rest();", "Relay.as", 5],
  ] as const) {
    expect(navigation.resolve("Animal.as", behavior.lastIndexOf(text)), text).toEqual({
      path,
      line,
    });
  }
});

it.each(["behavior", "library"])("resolves generated tree links above %s blocks", (keyword) => {
  const source = `// State tree (generated; update with --check-script <file> --write-tree):
//   Main [initial]
//   \`-- Rest ?
${keyword} Animal {
 state Main { void run() { Rest(); } }
 state Rest { void run() {} }
}`;
  expect(resolve(source, "Rest", "", "first")).toEqual({ path: "scripts/main.as", line: 6 });
});
