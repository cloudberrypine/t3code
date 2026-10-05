import { describe, expect, it } from "vite-plus/test";
import {
  analyzeAngelScript,
  parseAngelScriptApi,
  usesAngelScript,
  colorAngelScriptTokens,
} from "./angelscript.ts";

const apiText = `
const float PI;
uint64 Prefab_Capybara;
class Shot {
  void wait(float seconds); /** await */
  void moveCamera(vec2 position); /** await(Succeeded) */
  World@ world();
}
class World { Entity@ entity(); }
class Entity { void destroy(); }
class Timer { void wait(); /** await */ }
enum State { Idle, Finished }
/** await */
void suspend();
`;

describe("AngelScript API highlighting", () => {
  it("indexes generated declarations and both await annotation forms", () => {
    const api = parseAngelScriptApi(apiText);
    expect([...api.types]).toEqual(["Shot", "World", "Entity", "Timer", "State"]);
    expect(api.members.get("Shot")?.get("wait")?.await).toBe(true);
    expect(api.members.get("Shot")?.get("moveCamera")?.await).toBe(true);
    expect(api.functions.get("suspend")?.await).toBe(true);
    expect(api.constants.has("Finished")).toBe(true);
  });
  it("resolves typed receivers and get<T>(), without matching strings, comments or unknown receivers", () => {
    const source = `void shot(Shot@ s) {
 s.wait(1);
 s.moveCamera(vec2());
 Entity@ e;
 e.get<Timer>().wait();
 unknown.wait();
 print("s.wait(2)");
 // s.wait(3);
 /* s.wait(4); */
 suspend();
}`;
    const tokens = analyzeAngelScript(source, parseAngelScriptApi(apiText));
    expect(tokens.filter((token) => token.kind === "await").map((token) => token.line)).toEqual([
      2, 3, 5, 10,
    ]);
  });
  it("updates annotations when a different API is supplied", () => {
    const source = "Shot@ s; s.wait(1);";
    expect(
      analyzeAngelScript(source, parseAngelScriptApi(apiText)).some(
        (token) => token.kind === "await",
      ),
    ).toBe(true);
    expect(
      analyzeAngelScript(source, parseAngelScriptApi(apiText.replaceAll("/** await */", ""))).some(
        (token) => token.kind === "await",
      ),
    ).toBe(false);
  });
  it("respects a local shadow and restores the outer receiver after its block", () => {
    const source = "Shot@ s; { int s; s.wait(); } s.wait();";
    expect(
      analyzeAngelScript(source, parseAngelScriptApi(apiText))
        .filter((token) => token.kind === "await")
        .map((token) => token.start),
    ).toEqual([source.lastIndexOf("wait")]);
  });
  it("keeps function parameters local and infers auto handles from get<T>()", () => {
    const source =
      "Entity@ s; void first(Shot@ s) { s.wait(1); } void second() { s.wait(1); auto@ t = s.get<Timer>(); t.wait(); }";
    const tokens = analyzeAngelScript(source, parseAngelScriptApi(apiText)).filter(
      (token) => token.kind === "await",
    );
    expect(tokens.map((token) => token.start)).toEqual([
      source.indexOf("s.wait") + 2,
      source.lastIndexOf("t.wait") + 2,
    ]);
  });
  it("keeps ActionScript detection outside AngelScript worktrees and recognizes typed scripts without an API", () => {
    expect(usesAngelScript("file.as", "package game { public function run():void {} }", null)).toBe(
      false,
    );
    expect(usesAngelScript("file.as", "void run(Shot@ s) {}", null)).toBe(true);
    expect(usesAngelScript("file.ts", "Shot@ s", parseAngelScriptApi(apiText))).toBe(false);
  });
  it("preserves syntax token text when a semantic boundary falls inside a token", () => {
    const tokens = colorAngelScriptTokens(
      [{ content: "s.wait(1);", color: "#fff" }],
      [{ start: 2, end: 6, line: 1, kind: "await" }],
      "dark",
    );
    expect(tokens.map((token) => token.content).join("")).toBe("s.wait(1);");
    expect(tokens.find((token) => token.content === "wait")?.color).toBe("#edc65e");
  });
});

function semanticWords(source: string, apiSource = "") {
  return analyzeAngelScript(source, parseAngelScriptApi(apiSource)).map((token) => ({
    word: source.slice(token.start, token.end),
    kind: token.kind,
    start: token.start,
  }));
}

it("colors every local state value consistently despite an API name collision", () => {
  const source = `namespace Otter {
    enum State { Roaming, EnteringWater, Diving, JoiningHunt }
    void run() { transition(Roaming); transition(State::EnteringWater); transition(Diving); }
    state JoiningHunt {}
  }`;
  const tokens = semanticWords(source, "enum MovementMode { Diving }");
  expect(tokens.filter((t) => t.kind === "constant").map((t) => t.word)).toEqual([
    "Roaming",
    "EnteringWater",
    "Diving",
    "JoiningHunt",
    "Roaming",
    "EnteringWater",
    "Diving",
    "JoiningHunt",
  ]);
});

it("resolves forward references and reopened or nested namespaces without leaking enum values", () => {
  const source = `namespace A::B { void first() { transition(Roaming); } }
    namespace A::B { enum State { Roaming, Diving } }
    void other() { Roaming; A::B::State::Roaming; A::B::Diving; }
    namespace C { enum State { Resting } void run() { State::Diving; State::Resting; } }`;
  const constants = semanticWords(source).filter((t) => t.kind === "constant");
  expect(constants.map((t) => t.word)).toEqual([
    "Roaming",
    "Roaming",
    "Diving",
    "Roaming",
    "Diving",
    "Resting",
    "Resting",
  ]);
  expect(constants.some((t) => t.start === source.indexOf("Roaming;"))).toBe(false);
});

it("does not confuse local variables, object members, or a different enum with API constants", () => {
  const source = `namespace Otter {
    enum State { Roaming }
    void run(int Diving) { Diving; State::Diving; obj.Diving; ::SurfaceMode::Diving; State::Roaming; }
    void next() { Diving; }
  }`;
  const constants = semanticWords(
    source,
    "enum State { Diving } enum SurfaceMode { Diving }",
  ).filter((t) => t.kind === "constant");
  expect(constants.map((t) => t.word)).toEqual(["Roaming", "Diving", "Roaming", "Diving"]);
  expect(constants.filter((t) => t.word === "Diving").map((t) => t.start)).toEqual([
    source.indexOf("SurfaceMode::Diving") + "SurfaceMode::".length,
    source.lastIndexOf("Diving"),
  ]);
});

it("keeps API constants in their namespace and recognizes explicit enum and namespace qualifiers", () => {
  const source = `void outside() { Hidden; Constants::Hidden; Constants::Mode::Hidden; Wrong::Hidden; }
    namespace Constants { void inside() { Hidden; Mode::Hidden; } }`;
  expect(
    semanticWords(source, "namespace Constants { enum Mode { Hidden } }")
      .filter((t) => t.kind === "constant")
      .map((t) => t.start),
  ).toEqual([
    source.indexOf("Constants::Hidden") + "Constants::".length,
    source.indexOf("Constants::Mode::Hidden") + "Constants::Mode::".length,
    source.indexOf("inside() { Hidden") + "inside() { ".length,
    source.lastIndexOf("Hidden"),
  ]);
});

it("handles explicit enum values and skips commas inside initializer expressions", () => {
  const source = `enum State { First = 1, Second = First + int(max(2, 3)), Third = 8, }
    void run() { Third; } // Fourth
    string text = "Fifth, Sixth";`;
  expect(
    semanticWords(source)
      .filter((t) => t.kind === "constant")
      .map((t) => t.word),
  ).toEqual(["First", "Second", "First", "Third", "Third"]);
});

it("colors current global waits, excluding removed awaitAll and qualified lookalikes", () => {
  const source = `void run() {
    awaitAny(first, second);
    waitUntil(deadline);
    ::waitUntil(deadline);
    obj.waitUntil(deadline);
    Other::waitUntil(deadline);
    awaitAll(first, second);
    string text = "waitUntil(deadline)";
    // waitUntil(deadline);
  }`;
  const tokens = analyzeAngelScript(
    source,
    parseAngelScriptApi("int awaitAny(WaitCondition); bool waitUntil(double);"),
  );
  const awaits = tokens.filter((t) => t.kind === "await");
  expect(awaits.map((t) => t.line)).toEqual([2, 3, 4]);
  expect(
    colorAngelScriptTokens([{ content: source, color: "#fff", fontStyle: 0 }], awaits, "dark")
      .filter((t) => t.fontStyle === 2)
      .map((t) => ({ content: t.content, color: t.color })),
  ).toEqual([
    { content: "awaitAny", color: "#edc65e" },
    { content: "waitUntil", color: "#edc65e" },
    { content: "waitUntil", color: "#edc65e" },
  ]);
});

it("parses generic API methods and native property getters without losing their names", () => {
  const api = parseAngelScriptApi(
    "World@ get_w(); Entity get_e(); WaitCondition event<T>(); T awaitedEvent<T>(); bool awaited<T>(); bool awaited(WaitCondition); class Entity { T@ get<T>(); }",
  );
  expect([...api.functions.keys()]).toEqual(["get_w", "get_e", "event", "awaitedEvent", "awaited"]);
  expect(api.functions.get("awaitedEvent")).toEqual({
    returnType: "T",
    genericType: "T",
    await: false,
  });
  expect(api.members.get("Entity")?.get("get")?.genericType).toBe("T");
  expect([...api.globals]).toEqual([
    ["w", "World"],
    ["e", "Entity"],
  ]);
});

it("colors HSM state calls as suspension points and state references without an enum", () => {
  const source = `namespace Otter {
    class Params { float duration; }
    class Object { uint64 target; }
    state Main { void run() { Dive(); transition(Dive); p.duration; o.target; } }
    state Dive { void run() {} }
  }
  void outside() { Dive(); Otter::Dive(); unknown.Dive(); }
  namespace Other { void run() { Dive(); } }`;
  const tokens = semanticWords(source);
  expect(tokens.filter((t) => t.kind === "await").map((t) => t.start)).toEqual([
    source.indexOf("Dive();"),
    source.indexOf("Otter::Dive") + "Otter::".length,
  ]);
  expect(tokens.filter((t) => t.kind === "global").map((t) => t.word)).toEqual(["p", "o"]);
  expect(tokens.find((t) => t.start === source.indexOf("transition(Dive)") + 11)?.kind).toBe(
    "constant",
  );
});

it("highlights generic event calls and infers event and native getter receivers", () => {
  const source =
    "w.wait(); event<ClickEvent>(); awaited<ClickEvent>(); awaitedEvent<ClickEvent>().wait(); now(); random().wait();";
  const api =
    "World@ get_w(); class World { void wait(); /** await */ } WaitCondition event<T>(); bool awaited<T>(); T awaitedEvent<T>(); class ClickEvent { void wait(); /** await */ } double now(); World@ random();";
  const tokens = semanticWords(source, api);
  expect(tokens.filter((t) => t.kind === "function").map((t) => t.word)).toEqual([
    "event",
    "awaited",
    "awaitedEvent",
    "now",
    "random",
  ]);
  expect(tokens.filter((t) => t.kind === "await").map((t) => t.start)).toEqual([
    source.indexOf("wait"),
    source.indexOf(".wait", 10) + 1,
    source.lastIndexOf("wait"),
  ]);
});

it("recognizes qualified library sub-state calls from the generated tree", () => {
  const source = `// State tree (generated; update with --check-script <file> --write-tree):
//   Main [initial]
//   \`-- NestTrip::FlyToNest ? (NestTrip.as)
namespace Toucan {
 state Main { void run() { NestTrip::FlyToNest(); NestTrip::helper(); } }
}`;
  expect(
    semanticWords(source)
      .filter((t) => t.kind === "await")
      .map((t) => t.word),
  ).toEqual(["FlyToNest"]);
  expect(
    semanticWords(source.replace("State tree (generated;", "Notes (")).filter(
      (t) => t.kind === "await",
    ),
  ).toEqual([]);
});

it("does not infer generic return types for unknown event helpers", () => {
  expect(
    semanticWords("unknown<World>().wait();", "class World { void wait(); /** await */ }").filter(
      (t) => t.kind === "await",
    ),
  ).toEqual([]);
});

it("recognizes state-handle funcdefs as types rather than callable API functions", () => {
  const api = parseAngelScriptApi(
    "funcdef bool StateEntry(); void transition(StateEntry@); class Context { StateEntry@ get_nextState() const; }",
  );
  expect(api.types.has("StateEntry")).toBe(true);
  expect(api.functions.has("StateEntry")).toBe(false);
  expect(api.properties.get("Context")?.get("nextState")).toBe("StateEntry");
});

it("keeps condition builders, event predicates, sends, claims and non-blocking starts out of await highlighting", () => {
  const api = `Entity get_e(); World@ get_w(); T awaitedEvent<T>(); WaitCondition event<T>(); bool awaited<T>();
    bool claim(Entity); void release(Entity); void handOverClaim(Entity, Entity); void fail(const string&in); void transitionToInitialState();
    void raise(const ?&in); class ClickEvent { bool shift; }
    class World { void fire(const ?&in); }
    class Entity { T@ get<T>(); }
    class Movement { void startMoveTo(float); bool moveTo(float); /** await(Succeeded) */ WaitCondition conditionDone(); }
    class Animator { WaitCondition conditionTrigger(int); }`;
  const source = `void run() {
    e.get<Movement>().startMoveTo(4);
    bool reached = e.get<Movement>().moveTo(4);
    if (!e.get<Movement>().moveTo(5)) { fail("unreachable"); }
    awaitAny(e.get<Movement>().conditionDone(), e.get<Animator>().conditionTrigger(0), event<ClickEvent>());
    awaited<ClickEvent>(); awaitedEvent<ClickEvent>().shift; w.fire(ClickEvent()); raise(ClickEvent());
    claim(e); release(e); handOverClaim(e,e); transitionToInitialState();
  }`;
  expect(
    analyzeAngelScript(source, parseAngelScriptApi(api))
      .filter((t) => t.kind === "await")
      .map((t) => t.line),
  ).toEqual([3, 4, 5]);
});

it("infers members of generated vectors whose wrappers are omitted from the API", () => {
  const api =
    "class Joint { void wait(); /** await */ } class Pose { vector_Joint joints; } Entity get_e(); class Entity { T@ get<T>(); }";
  expect(
    semanticWords("e.get<Pose>().joints[0].wait();", api)
      .filter((t) => t.kind === "await")
      .map((t) => t.word),
  ).toEqual(["wait"]);
});

it("maps full-revision highlighting to whitespace-hidden hunks without borrowing changed code", async () => {
  const { createAngelScriptRevisionSemantics } = await import("./angelscript.ts");
  const contents =
    "namespace Otter {\n state Main { void run() { Rest(); } }\n state Rest { void run() {} }\n}";
  const read = createAngelScriptRevisionSemantics(
    { oldContents: contents, newContents: contents.replaceAll("Rest", "Dive") },
    parseAngelScriptApi(""),
  );
  const displayed = "state Main {void run(){ Rest( );}}";
  const token = read("deletions", 2, displayed).find((t) => t.kind === "await")!;
  expect(displayed.slice(token.start, token.end)).toBe("Rest");
  expect(read("additions", 2, displayed)).toEqual([]);
});

it("keeps pair-qualified handler parameters inside their own function scope", () => {
  const api = parseAngelScriptApi(`class Movement { bool moveTo(float); /** await(Succeeded) */ }
    class GridSensor { WaitCondition conditionDone(); }
    class Action {} const Action Action_Hunt;`);
  const source = `Movement sensor;
    void onSucceeded<Action_Hunt>(GridSensor sensor) { sensor.conditionDone(); }
    void onFailed<Action_Hunt>(GridSensor sensor) { sensor.conditionDone(); }
    void run() { sensor.moveTo(1); }`;
  const tokens = analyzeAngelScript(source, api);
  expect(tokens.filter((t) => t.kind === "await").map((t) => t.start)).toEqual([
    source.indexOf("moveTo"),
  ]);
  expect(
    tokens.filter((t) => t.kind === "constant").map((t) => source.slice(t.start, t.end)),
  ).toEqual(["Action_Hunt", "Action_Hunt"]);
  expect(
    tokens.filter((t) => t.kind === "function").map((t) => source.slice(t.start, t.end)),
  ).toEqual(["conditionDone", "conditionDone"]);
});

it("supports current deadline, scheduled-event, typed-constant and milestone API shapes", () => {
  const api = `class Action {} const Action Action_Hunt; class Entity { T get<T>(Action); int queued<T>(); }
    Entity get_e(); T get<T>(Action); T gett<T>(Entity); T try_get<T>(Action); T try_gett<T>(Entity);
    WaitCondition until(double); WaitCondition never(); WaitCondition event<T>();
    bool waitUntil(double); int awaitAny(WaitCondition, WaitCondition);
    void raiseAt(double, const ?&in); void raiseIn(double, const ?&in); bool scheduled<T>(); int discard<T>();
    T awaitedEvent<T>(); bool awaited<T>(); class BirthDue {} class WaitCondition {}
    class JointAnimator {
      bool runToTrigger(int, int); /** await(Milestone) */
      void finish(); /** await(Succeeded) */
      void start(int); WaitCondition conditionTrigger(int);
    }`;
  const source = `void run() {
    get<JointAnimator>(Action_Hunt).start(0);
    get<JointAnimator>(Action_Hunt).runToTrigger(0, 1);
    gett<JointAnimator>(e).finish();
    try_get<JointAnimator>(Action_Hunt).finish();
    try_gett<JointAnimator>(e).finish();
    e.get<JointAnimator>(Action_Hunt).finish();
    bool reached = waitUntil(10);
    if (!waitUntil(20)) { return; }
    awaitAny(until(30), never());
    raiseAt(40, BirthDue()); raiseIn(1, BirthDue());
    scheduled<BirthDue>(); e.queued<BirthDue>(); discard<BirthDue>();
    awaited<BirthDue>(); awaitedEvent<BirthDue>(); event<BirthDue>();
  }`;
  const tokens = analyzeAngelScript(source, parseAngelScriptApi(api));
  expect(tokens.filter((t) => t.kind === "await").map((t) => t.line)).toEqual([
    3, 4, 5, 6, 7, 8, 9, 10,
  ]);
  for (const name of [
    "until",
    "never",
    "raiseAt",
    "raiseIn",
    "scheduled",
    "queued",
    "discard",
    "awaited",
    "awaitedEvent",
    "event",
  ]) {
    const start = source.indexOf(
      name + (["until", "never", "raiseAt", "raiseIn"].includes(name) ? "(" : "<"),
    );
    expect(tokens.find((t) => t.start === start)?.kind, name).toBe("function");
  }
  expect(
    tokens.filter((t) => t.kind === "constant").map((t) => source.slice(t.start, t.end)),
  ).toEqual(Array(4).fill("Action_Hunt"));
});

it.each(["behavior", "library"])(
  "recognizes %s blocks, implicit data and state trees",
  (keyword) => {
    const source = `// State tree (generated; update with --check-script <file> --write-tree):
//   Main [initial]
//   \`-- Dive ?
${keyword} Animal {
 class Params { float duration; }
 class Object { Entity target; }
 state Main { void run() { p.duration; o.target; Dive(); WaitUntil(1); } }
 state Dive { void run() {} }
}`;
    expect(usesAngelScript("Animal.as", `${keyword} Animal {}`, null)).toBe(true);
    const tokens = analyzeAngelScript(
      source,
      parseAngelScriptApi("class Entity {} bool WaitUntil(double);"),
    );
    expect(
      tokens.filter((t) => t.kind === "await").map((t) => source.slice(t.start, t.end)),
    ).toEqual(["Dive", "WaitUntil"]);
    expect(
      tokens.filter((t) => t.kind === "global").map((t) => source.slice(t.start, t.end)),
    ).toEqual(["p", "o"]);
  },
);

it("recognizes renamed annotated waits without mistaking uppercase factories or constructors for waits", () => {
  const api = `class Entity { T get<T>(); } Entity get_e();
    class Timer { void Wait(float); /** await(Succeeded) */ bool Await(int); /** await */ void startWait(float); }
    class JointAnimator { bool RunToTrigger(int, int); /** await(Milestone) */ void Finish(); /** await(Succeeded) */ }
    class Shot { void PreRoll(float); /** await */ void MoveCamera(vec2); /** await */ }
    class BirthDue {} class GridCoord {} GridCoord GridCoordInvalid();
    bool WaitUntil(double); int AwaitAny(WaitCondition); WaitCondition until(double);`;
  const source = `void run(Shot shot) {
    e.get<Timer>().Wait(1); e.get<Timer>().Await(0); e.get<Timer>().startWait(1);
    e.get<JointAnimator>().RunToTrigger(0, 1); e.get<JointAnimator>().Finish();
    shot.PreRoll(1); shot.MoveCamera(vec2());
    WaitUntil(1); ::AwaitAny(until(2));
    GridCoordInvalid(); Entity(); BirthDue(); Unknown();
  }`;
  const tokens = analyzeAngelScript(source, parseAngelScriptApi(api));
  expect(tokens.filter((t) => t.kind === "await").map((t) => source.slice(t.start, t.end))).toEqual(
    ["Wait", "Await", "RunToTrigger", "Finish", "PreRoll", "MoveCamera", "WaitUntil", "AwaitAny"],
  );
});
