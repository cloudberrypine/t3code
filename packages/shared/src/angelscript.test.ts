import { describe, expect, it } from "vite-plus/test";
import {
  analyzeAngelScript,
  parseAngelScriptApi,
  usesAngelScript,
  colorAngelScriptTokens,
} from "./angelscript";

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
