import { expect, it } from "vite-plus/test";
import { createAngelScriptNavigation } from "./angelscriptNavigation.js";
import {
  angelScriptCppSymbol,
  cppBindingTargets,
  cppSymbolAt,
  findCppDefinition,
} from "./cppNavigation.js";
const header = {
  path: "src/model.h",
  contents: `namespace Process {
struct Position {
  float x = 0;
  void move(int amount);
  struct Bounds { int width; };
};
enum class Mode { Roaming, Swimming };
}`,
};
const implementation = {
  path: "src/model.cpp",
  contents: `namespace Process {
void Position::move(int amount) { x += amount; }
void run(Position* position) {
 position->move(3);
 position->x++;
}
}`,
};
it("finds types, nested types, fields, scoped enums, and method bodies over prototypes", () => {
  const sources = [header, implementation];
  expect(findCppDefinition(sources, { name: "Position", typeOnly: true })).toEqual({
    path: header.path,
    line: 2,
  });
  expect(findCppDefinition(sources, { name: "Position::Bounds", typeOnly: true })).toEqual({
    path: header.path,
    line: 5,
  });
  expect(findCppDefinition(sources, { owner: "Position", name: "x" })).toEqual({
    path: header.path,
    line: 3,
  });
  expect(findCppDefinition(sources, { owner: "Position", name: "move", arity: 1 })).toEqual({
    path: implementation.path,
    line: 2,
  });
  expect(findCppDefinition(sources, { name: "Mode", typeOnly: true })).toEqual({
    path: header.path,
    line: 7,
  });
});
it("infers pointer receiver types and resolves scoped locals", () => {
  const offset = implementation.contents.indexOf("move(3)");
  expect(cppSymbolAt(implementation, offset)).toEqual({
    name: "move",
    owner: "Position",
    arity: 1,
  });
  const source = {
    path: "main.cpp",
    contents:
      "void run(int value) {\n int count = 3;\n { int count = 4; count++; }\n count++;\n value++;\n}",
  };
  expect(
    createAngelScriptNavigation([source], true).resolve(
      source.path,
      source.contents.lastIndexOf("count++"),
    ),
  ).toEqual({ path: source.path, line: 2 });
  expect(
    createAngelScriptNavigation([source], true).resolve(
      source.path,
      source.contents.lastIndexOf("value++"),
    ),
  ).toEqual({ path: source.path, line: 1 });
});
it("describes API declarations and underscore nested type aliases", () => {
  const api = {
    path: "assets/ScriptingAPI.as",
    contents:
      "class Position_Bounds {\n int width;\n}\nclass World {\n Entity entity(entity_t id);\n}",
  };
  expect(angelScriptCppSymbol(api, api.contents.indexOf("Position_Bounds"))).toEqual({
    name: "Position::Bounds",
    typeOnly: true,
  });
  expect(angelScriptCppSymbol(api, api.contents.indexOf("width"))).toEqual({
    name: "width",
    owner: "Position::Bounds",
  });
  expect(angelScriptCppSymbol(api, api.contents.indexOf("entity("))).toEqual({
    name: "entity",
    owner: "World",
    arity: 1,
  });
});
it("keeps API type references in AngelScript and sends declaration names to C++", () => {
  const api = {
    path: "assets/ScriptingAPI.as",
    contents: [
      "class Entity {",
      "  Entity parent;",
      "  Entity creator();",
      "  void setCreator(Entity creator);",
      "}",
      "class Target {",
      "  Entity entity;",
      "  array<Entity> children;",
      "  Entity@ handle;",
      "}",
    ].join("\n"),
  };
  const navigation = createAngelScriptNavigation([api]);
  for (const usage of [
    "Entity parent",
    "Entity creator()",
    "Entity creator)",
    "Entity entity",
    "Entity>",
    "Entity@",
  ]) {
    const offset = api.contents.indexOf(usage);
    expect(offset).toBeGreaterThan(0);
    expect(angelScriptCppSymbol(api, offset)).toBeNull();
    expect(navigation.resolve(api.path, offset)).toEqual({ path: api.path, line: 1 });
  }
  expect(angelScriptCppSymbol(api, api.contents.indexOf("Entity"))).toEqual({
    name: "Entity",
    typeOnly: true,
  });
  expect(angelScriptCppSymbol(api, api.contents.indexOf("parent;"))).toEqual({
    name: "parent",
    owner: "Entity",
  });
});
it("follows multiline bindings, overload arity, namespaces, and method macros without reading comments", () => {
  const source = {
    path: "src/bindings.cpp",
    contents: `// engine->RegisterObjectMethod("World", "Entity entity(int id)", asFUNCTION(wrong));
 engine->RegisterObjectMethod(
 "World", "Entity entity(int id)", asFUNCTION(Process::World_entity), asCALL_GENERIC);
 engine->RegisterObjectMethod("World", "Entity entity(int id, int flags)", asFUNCTION(World_entity2), asCALL_GENERIC);
 engine->RegisterObjectMethod("World", "void save()", asMETHODPR(Engine, save, (), void), asCALL_THISCALL);`,
  };
  expect(cppBindingTargets([source], { owner: "World", name: "entity", arity: 1 })).toEqual([
    { name: "World_entity", owner: "Process" },
  ]);
  expect(cppBindingTargets([source], { owner: "World", name: "save", arity: 0 })).toEqual([
    { name: "save", owner: "Engine" },
  ]);
});
it("does not guess between unrelated classes or equal-arity overloads", () => {
  const source = {
    path: "types.h",
    contents:
      "struct A { int value; };\nstruct B { int value; };\nvoid call(int x) {}\nvoid call(float x) {}",
  };
  expect(findCppDefinition([source], { name: "value" })).toBeNull();
  expect(findCppDefinition([source], { owner: "A", name: "value" })).toEqual({
    path: source.path,
    line: 1,
  });
  expect(findCppDefinition([source], { name: "call", arity: 1 })).toBeNull();
});
it("transition arguments navigate to a state in their own behavior, while ordinary references stay enums", () => {
  const source = {
    path: "main.as",
    contents:
      "namespace Otter {\n enum State { Roaming, Diving }\n state Roaming {}\n state Diving { void run() { transition(State::Roaming); } }\n void run() { transition(Roaming); }\n State mode = State::Roaming;\n}\nnamespace Bee { enum State { Roaming } state Roaming {} }",
  };
  const nav = createAngelScriptNavigation([source]);
  expect(nav.resolve(source.path, source.contents.indexOf("Roaming);"))).toEqual({
    path: source.path,
    line: 3,
  });
  expect(nav.resolve(source.path, source.contents.lastIndexOf("Roaming);"))).toEqual({
    path: source.path,
    line: 3,
  });
  expect(nav.resolve(source.path, source.contents.indexOf("Roaming;"))).toEqual({
    path: source.path,
    line: 2,
  });
});

it("finds constructors, macros, aliases, and zero-argument void prototypes", () => {
  const source = {
    path: "types.cpp",
    contents:
      "namespace Demo {\nstruct Model { Model(int value); };\nModel::Model(int value) {}\nusing Count = int;\nvoid run(void) {}\n}\n#define COUNT 4",
  };
  expect(findCppDefinition([source], { owner: "Demo::Model", name: "Model", arity: 1 })).toEqual({
    path: source.path,
    line: 3,
  });
  expect(findCppDefinition([source], { name: "Count", typeOnly: true })).toEqual({
    path: source.path,
    line: 4,
  });
  expect(findCppDefinition([source], { name: "run", arity: 0 })).toEqual({
    path: source.path,
    line: 5,
  });
  expect(findCppDefinition([source], { name: "COUNT" })).toEqual({ path: source.path, line: 7 });
});

it("ignores declarations inside comments and raw strings, and resolves built-in integer locals", () => {
  const source = {
    path: "main.cpp",
    contents:
      '/* struct Fake {}; */\nconst char* text = R"tag(struct Fake {}; void wrong() {})tag";\nvoid run() { unsigned long count = 0;\n count++; }',
  };
  expect(findCppDefinition([source], { name: "Fake", typeOnly: true })).toBeNull();
  expect(findCppDefinition([source], { name: "wrong" })).toBeNull();
  expect(
    createAngelScriptNavigation([source], true).resolve(
      source.path,
      source.contents.lastIndexOf("count"),
    ),
  ).toEqual({ path: source.path, line: 3 });
});

it.each([
  "typename Callback",
  "class Callback",
  "class Callback, class Values = std::vector<std::pair<int, int>>",
  "class Callback, int N = (1 << 2)",
  "template<class> class Container, class Callback",
])("indexes function templates with %s without inventing parameter classes", (parameters) => {
  const source = {
    path: "helper.cpp",
    contents: `namespace Process {
template <${parameters}>
static void Visit(int value, Callback &&callback) { callback(value); }
void run() { Visit(1, [](int value) {}); }
}`,
  };
  expect(
    createAngelScriptNavigation([source], true).resolve(
      source.path,
      source.contents.indexOf("Visit(1"),
    ),
  ).toEqual({ path: source.path, line: 3 });
  expect(findCppDefinition([source], { name: "Visit", owner: "Process", arity: 2 })).toEqual({
    path: source.path,
    line: 3,
  });
  expect(findCppDefinition([source], { name: "Callback", typeOnly: true })).toBeNull();
});

it("retains the actual class scope after a template parameter list", () => {
  const source = {
    path: "box.h",
    contents: `template <class T>
struct Box {
  int size;
  void reset() { size = 0; }
};`,
  };
  expect(
    createAngelScriptNavigation([source], true).resolve(
      source.path,
      source.contents.lastIndexOf("size"),
    ),
  ).toEqual({ path: source.path, line: 3 });
  expect(findCppDefinition([source], { name: "Box", typeOnly: true })).toEqual({
    path: source.path,
    line: 2,
  });
});

it("maps PascalCase await declarations to native methods without renaming other API symbols", () => {
  const source = {
    path: "ScriptingAPI.as",
    contents: `class Timer {
    bool Wait(float duration); /** await(Succeeded) */
    void Reset();
    bool Await(int); /** await */
  }`,
  };
  const wait = angelScriptCppSymbol(source, source.contents.indexOf("Wait("))!;
  expect(wait).toEqual({ name: "Wait", nativeName: "wait", owner: "Timer", arity: 1 });
  expect(
    findCppDefinition(
      [{ path: "Timer.cpp", contents: "void Timer::wait(World& w, Entity e, float seconds) {}" }],
      wait,
    ),
  ).toEqual({ path: "Timer.cpp", line: 1 });
  expect(angelScriptCppSymbol(source, source.contents.indexOf("Reset("))).toEqual({
    name: "Reset",
    owner: "Timer",
    arity: 0,
  });
  const awaited = angelScriptCppSymbol(source, source.contents.indexOf("Await("))!;
  expect(
    cppBindingTargets(
      [
        {
          path: "bindings.cpp",
          contents:
            'engine->RegisterObjectMethod("Timer", "bool Await(int)", asFUNCTION(Component_await<Timer>), asCALL_GENERIC);',
        },
      ],
      awaited,
    ),
  ).toEqual([{ name: "Component_await" }]);
});
