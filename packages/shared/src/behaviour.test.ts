// @effect-diagnostics nodeBuiltinImport:off - reads the prototype's real sources from disk when present.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import {
  analyzeBehaviour,
  behaviourColors,
  behaviourDefinitions,
  behaviourIncludes,
  behaviourLineSemantics,
  behaviourNavigationTargets,
  colorBehaviourTokens,
  createBehaviourRevisionSemantics,
  highlightBehaviour,
  isBehaviourLanguage,
  isBehaviourPath,
  joinBehaviourPath,
  resolveBehaviourDefinitions,
  tokenizeBehaviour,
  type BehaviourTokenKind,
} from "./behaviour.ts";

// Part of the Sloth in the C-like syntax (the approved target look, 2026-11-23).
const SLOTH = `#include "../engine.beh"
#include "mating.beh"

behaviour Sloth {
  use MammalBirth;

  params {
    tick  dig_duration = 2s;
    range rest_after_meal_range = 4s..8s;
    dist  conceal_min_height = 300cm;
    SlothDung::Params dung = { .stop_above_ground_cells = 1, .blend = 45% };
  }

  memory {
    entity current_tree;
    bool   sleep_after_next_meal = false;
  }

  initial state Falling() requests(park) {
    defer { climb.paused = false; }
    fall.start();
    await fall.done();
    transition Browsing;
  }

  // Its normal life: eat leaves, or wander and rest when there is nothing to eat.
  state Browsing() {
    on failed(climb) {
      if (!Mating::climb_route_lost_ahead()) transition Falling;
    }
    on event GroupMove(meet) {
      if (SlothMating::accept_invitation(meet)) transition JoiningMate;
    }
    if (MammalPregnancy::update() == MammalPregnancy::MateNeeded && Mating::ready()) {
      entity mate = SlothMating::find_mate();
      if (mate && await MeetAtStemTop(mate, plant_holding(mate))) {
        o.current_tree = plant_holding(self);
      }
    }
    if (await EatLeaves()) {
      bool take_nap = o.sleep_after_next_meal;
      await HangStill(random_in(p.rest_after_meal_range), take_nap);
    } else {
      await Wander();
    }
    restart;
  }

  state Dunging() requests(wait) {
    entity tree = home_tree();
    if (await SlothDung::ClimbDown(tree)) await DungInHollow(tree);
    transition Browsing;
  }

  // The tail digs a hollow, the dung goes in, and it covers it.
  state DungInHollow(entity tree) {
    wait_for(p.dig_duration);
    if (!SlothDung::has_dung()) fail EmptyStomach;
    entity dung = Pooping::spawn(poop_preset());
    perform(DungAtTree, .at = self.position);   // 100 bp
    wait_for(p.cover_duration);
  }

  state HangStill(tick duration, bool take_nap) {
    tick rest_until = now + duration;
    if (take_nap) {
      await after(p.settle_before_sleep);
    }
    await until(rest_until);
  }

  on event Moved { o.current_tree = none; }

  refusal availability DungAtTree() {
    if (!SlothDung::has_dung()) return StomachEmpty;
    return available;
  }
  on request DungAtTree { accept Dunging; }

  entity home_tree() {
    return o.current_tree;
  }
}

library SlothDung requires climb, path {
  state ClimbDown(entity tree) {
    await DungInHollow(tree);
  }
  state DungInHollow(entity tree) {
    wait_for(1t);
  }
}
`;

/** Each token's text and kind, in order, on the 1-based line. */
function kindsOn(source: string, line: number): Array<[string, BehaviourTokenKind]> {
  return analyzeBehaviour(source)
    .tokens.filter((token) => token.line === line)
    .map((token) => [source.slice(token.start, token.end), token.kind]);
}

function lineOf(source: string, text: string, from = 0): number {
  const index = source.indexOf(text, from);
  if (index < 0) throw new Error(`no line with ${text}`);
  return source.slice(0, index).split("\n").length;
}

describe("paths and fences", () => {
  it("recognizes .beh and .pzb sources and fence tags", () => {
    expect(isBehaviourPath("behaviours/drafts/sloth_full.beh")).toBe(true);
    expect(isBehaviourPath("behaviours/sloth.pzb")).toBe(true);
    expect(isBehaviourPath("Sloth.BEH")).toBe(true);
    expect(isBehaviourPath("behaviours/sloth.bindings")).toBe(false);
    expect(isBehaviourPath("Sloth.as")).toBe(false);
    expect(isBehaviourLanguage("beh")).toBe(true);
    expect(isBehaviourLanguage("pzb")).toBe(true);
    expect(isBehaviourLanguage("angelscript")).toBe(false);
    expect(isBehaviourLanguage(undefined)).toBe(false);
  });
});

describe("tokens", () => {
  it("lexes units, strings, qualified names, directives and comments", () => {
    expect(
      tokenizeBehaviour('wait_for(0.25s); // "quoted" wait\n#include "a//b.beh"').map((token) => [
        token.kind,
        token.text,
      ]),
    ).toEqual([
      ["name", "wait_for"],
      ["op", "("],
      ["num", "0.25s"],
      ["op", ")"],
      ["op", ";"],
      ["comment", '// "quoted" wait'],
      ["directive", "#include"],
      ["str", '"a//b.beh"'],
    ]);
    expect(tokenizeBehaviour("x 2t 4000cm 45% 3..8 Lib::A::b").map((t) => t.text)).toEqual([
      "x",
      "2t",
      "4000cm",
      "45%",
      "3",
      "..",
      "8",
      "Lib::A::b",
    ]);
  });

  it("splits a block comment into one token a line", () => {
    const tokens = tokenizeBehaviour("a /* one\n  two */ b");
    expect(tokens.map((token) => [token.kind, token.text, token.line])).toEqual([
      ["name", "a", 1],
      ["comment", "/* one", 1],
      ["comment", "  two */", 2],
      ["name", "b", 2],
    ]);
  });

  it("colours declarations, params, memory and literals", () => {
    expect(kindsOn(SLOTH, lineOf(SLOTH, "tick  dig_duration"))).toEqual([
      ["tick", "type"],
      ["dig_duration", "param"],
      ["2s", "number"],
    ]);
    expect(kindsOn(SLOTH, lineOf(SLOTH, "range rest_after"))).toEqual([
      ["range", "type"],
      ["rest_after_meal_range", "param"],
      ["4s", "number"],
      ["8s", "number"],
    ]);
    expect(kindsOn(SLOTH, lineOf(SLOTH, "SlothDung::Params dung"))).toEqual([
      ["SlothDung::", "qualifier"],
      ["Params", "type"],
      ["dung", "param"],
      ["1", "number"],
      ["45%", "number"],
    ]);
    expect(kindsOn(SLOTH, lineOf(SLOTH, "entity current_tree;"))).toEqual([
      ["entity", "type"],
      ["current_tree", "memory"],
    ]);
    expect(kindsOn(SLOTH, lineOf(SLOTH, "bool take_nap"))).toEqual([
      ["bool", "type"],
      ["o", "memory"],
      ["sleep_after_next_meal", "memory"],
    ]);
    expect(kindsOn(SLOTH, lineOf(SLOTH, '#include "mating'))).toEqual([
      ["#include", "keyword"],
      ['"mating.beh"', "string"],
    ]);
  });

  it("colours states where they are defined, entered and awaited", () => {
    expect(kindsOn(SLOTH, lineOf(SLOTH, "initial state Falling"))).toEqual([
      ["initial", "keyword"],
      ["state", "keyword"],
      ["Falling", "state"],
      ["requests", "keyword"],
      ["park", "keyword"],
    ]);
    expect(kindsOn(SLOTH, lineOf(SLOTH, "state DungInHollow(entity"))).toEqual([
      ["state", "keyword"],
      ["DungInHollow", "state"],
      ["entity", "type"],
    ]);
    expect(kindsOn(SLOTH, lineOf(SLOTH, "if (mate && await"))).toEqual([
      ["if", "control"],
      ["await", "wait"],
      ["MeetAtStemTop", "state"],
      ["plant_holding", "function"],
    ]);
    expect(kindsOn(SLOTH, lineOf(SLOTH, "if (await SlothDung::ClimbDown"))).toEqual([
      ["if", "control"],
      ["await", "wait"],
      ["SlothDung::", "qualifier"],
      ["ClimbDown", "state"],
      ["await", "wait"],
      ["DungInHollow", "state"],
    ]);
    expect(kindsOn(SLOTH, lineOf(SLOTH, "on request DungAtTree"))).toEqual([
      ["on", "keyword"],
      ["request", "keyword"],
      ["DungAtTree", "constant"],
      ["accept", "control"],
      ["Dunging", "state"],
    ]);
  });

  it("colours waits, handlers, events, qualifiers and catalog names", () => {
    expect(kindsOn(SLOTH, lineOf(SLOTH, "wait_for(p.dig_duration)"))).toEqual([
      ["wait_for", "wait"],
      ["p", "param"],
      ["dig_duration", "param"],
    ]);
    expect(kindsOn(SLOTH, lineOf(SLOTH, "await after("))).toEqual([
      ["await", "wait"],
      ["after", "keyword"],
      ["p", "param"],
      ["settle_before_sleep", "param"],
    ]);
    expect(kindsOn(SLOTH, lineOf(SLOTH, "await fall.done()"))).toEqual([
      ["await", "wait"],
      ["done", "function"],
    ]);
    expect(kindsOn(SLOTH, lineOf(SLOTH, "on event GroupMove"))).toEqual([
      ["on", "keyword"],
      ["event", "keyword"],
      ["GroupMove", "event"],
    ]);
    expect(kindsOn(SLOTH, lineOf(SLOTH, "if (MammalPregnancy::update()"))).toEqual([
      ["if", "control"],
      ["MammalPregnancy::", "qualifier"],
      ["update", "function"],
      ["MammalPregnancy::", "qualifier"],
      ["MateNeeded", "constant"],
      ["Mating::", "qualifier"],
      ["ready", "function"],
    ]);
    expect(kindsOn(SLOTH, lineOf(SLOTH, "if (!SlothDung::has_dung()) fail"))).toEqual([
      ["if", "control"],
      ["SlothDung::", "qualifier"],
      ["has_dung", "function"],
      ["fail", "control"],
      ["EmptyStomach", "constant"],
    ]);
    expect(kindsOn(SLOTH, lineOf(SLOTH, "perform(DungAtTree"))).toEqual([
      ["perform", "control"],
      ["DungAtTree", "constant"],
      ["self", "constant"],
      ["// 100 bp", "comment"],
    ]);
    expect(kindsOn(SLOTH, lineOf(SLOTH, "refusal availability"))).toEqual([
      ["refusal", "type"],
      ["availability", "keyword"],
      ["DungAtTree", "constant"],
    ]);
    expect(kindsOn(SLOTH, lineOf(SLOTH, "library SlothDung"))).toEqual([
      ["library", "keyword"],
      ["SlothDung", "qualifier"],
      ["requires", "keyword"],
    ]);
  });

  it("reads a request policy as a keyword, never a wait", () => {
    const line = lineOf(SLOTH, "state Dunging() requests(wait)");
    expect(kindsOn(SLOTH, line)).toEqual([
      ["state", "keyword"],
      ["Dunging", "state"],
      ["requests", "keyword"],
      ["wait", "keyword"],
    ]);
    expect(analyzeBehaviour(SLOTH).lines.get(line)).toBeUndefined();
  });
});

describe("wait lines", () => {
  it("marks every line that waits or awaits a state, and nothing else", () => {
    const { lines } = analyzeBehaviour(SLOTH);
    const waiting = SLOTH.split("\n")
      .map((text, index) => [text.trim(), lines.get(index + 1)] as const)
      .filter(([, kind]) => kind === "wait")
      .map(([text]) => text);
    expect(waiting).toEqual([
      "await fall.done();",
      "if (mate && await MeetAtStemTop(mate, plant_holding(mate))) {",
      "if (await EatLeaves()) {",
      "await HangStill(random_in(p.rest_after_meal_range), take_nap);",
      "await Wander();",
      "if (await SlothDung::ClimbDown(tree)) await DungInHollow(tree);",
      "wait_for(p.dig_duration);",
      "wait_for(p.cover_duration);",
      "await after(p.settle_before_sleep);",
      "await until(rest_until);",
      "await DungInHollow(tree);",
      "wait_for(1t);",
    ]);
  });

  it("marks an await any block, a continued statement and an awaited event", () => {
    const source = `state Meet(entity mate) {
  while (!coming && now < reply_by) {
    await any {
      Courted reply = event(Courted);
      after(p.reply_wait);
    }
    if (!reply) break;
  }
  Ping m = await event(Ping);
  await Mating::contact(mate,
      Mating::contact_distance());
  wait_for_current;
  /* await not here */
  log("await not here");
}
`;
    const { lines, tokens } = analyzeBehaviour(source);
    expect([...lines.keys()].sort((a, b) => a - b)).toEqual([3, 4, 5, 6, 9, 10, 11]);
    const text = (line: number) =>
      tokens
        .filter((token) => token.line === line)
        .map((token) => `${source.slice(token.start, token.end)}=${token.kind}`);
    expect(text(3)).toEqual(["await=wait", "any=wait"]);
    expect(text(9)).toEqual(["Ping=type", "await=wait", "event=keyword", "Ping=event"]);
    expect(text(12)).toEqual(["wait_for_current=control"]);
  });

  it("reads a lone fragment (a diff hunk or a search result)", () => {
    expect(analyzeBehaviour("    await fall.done();").lines.get(1)).toBe("wait");
    expect(analyzeBehaviour("  } else if (await X()) {").lines.get(1)).toBe("wait");
    expect(analyzeBehaviour("  // wait_for(p.x);").lines.size).toBe(0);
    expect(analyzeBehaviour('  log("await");').lines.size).toBe(0);
  });
});

describe("line views and colours", () => {
  it("gives line-relative tokens and keeps the line kinds", () => {
    const semantics = behaviourLineSemantics("state A() {\n  wait_for(1t);\n}\n");
    expect(semantics.lines.get(2)).toBe("wait");
    expect(semantics.tokens.get(2)?.[0]).toMatchObject({ start: 2, end: 10, kind: "wait" });
  });

  it("splits syntax tokens at semantic boundaries and emphasizes the wait word", () => {
    const line = "  wait_for(p.dig_duration); // dig";
    const semantics = behaviourLineSemantics(line).tokens.get(1)!;
    const colored = colorBehaviourTokens([{ content: line, color: "#000" }], semantics, "dark");
    expect(colored.map((token) => token.content).join("")).toBe(line);
    expect(colored.find((token) => token.content === "wait_for")).toMatchObject({
      color: behaviourColors.dark.wait,
      fontStyle: 2,
    });
    expect(colored.find((token) => token.content === "// dig")?.color).toBe(
      behaviourColors.dark.comment,
    );
  });

  it("highlights a whole snippet line by line, preserving its text", () => {
    const source = "state A() {\r\n  await after(2s);\r\n}";
    const lines = highlightBehaviour(source);
    expect(lines.map((line) => line.tokens.map((token) => token.content).join(""))).toEqual([
      "state A() {",
      "  await after(2s);",
      "}",
    ]);
    expect(lines.map((line) => line.lineKind)).toEqual([null, "wait", null]);
  });

  it("aligns full-revision semantics to the displayed rows of a partial diff", () => {
    const oldContents = "state A() {\n  await any {\n    until(t);\n  }\n  /* a\n  b */\n}\n";
    const newContents = oldContents.replace("until(t)", "until(later)");
    const revision = createBehaviourRevisionSemantics({ oldContents, newContents });
    // Alone, a condition row would not read as part of a wait, nor a comment's second line.
    expect(analyzeBehaviour("    until(later);").lines.size).toBe(0);
    expect(revision("additions", 3, "    until(later);\n")?.lineKind).toBe("wait");
    expect(revision("deletions", 3, "    until(t);")?.lineKind).toBe("wait");
    expect(revision("additions", 6, "  b */")?.tokens).toEqual([
      { start: 0, end: 6, line: 6, kind: "comment" },
    ]);
    expect(revision("additions", 3, "    changed")).toBeNull();
  });

  it("keeps every colour readable on its theme's code surfaces", () => {
    const luminance = (hex: string) => {
      const [r, g, b] = [1, 3, 5].map((i) => {
        const value = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
        return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
      }) as [number, number, number];
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const kinds = Object.keys(behaviourColors.light).filter(
      (key) => !/Background|Stripe/.test(key),
    ) as BehaviourTokenKind[];
    for (const kind of kinds) {
      // The darkest light code surface (a changed word on a deleted line) is luminance 0.69.
      expect((0.69 + 0.05) / (luminance(behaviourColors.light[kind]) + 0.05), kind).toBeGreaterThan(
        4.5,
      );
      expect((luminance(behaviourColors.dark[kind]) + 0.05) / 0.05, kind).toBeGreaterThan(4.5);
    }
    // The wait word on its own background.
    for (const theme of ["light", "dark"] as const) {
      const { wait, waitKeywordBackground } = behaviourColors[theme];
      const [hi, lo] = [luminance(wait), luminance(waitKeywordBackground)].sort((a, b) => b - a);
      expect((hi! + 0.05) / (lo! + 0.05), theme).toBeGreaterThan(4.5);
    }
  });
});

describe("navigation", () => {
  it("lists definitions per unit, including library states and functions", () => {
    const sites = behaviourDefinitions(SLOTH);
    expect(
      sites.filter((site) => site.kind === "state").map((s) => `${s.unit}::${s.name}`),
    ).toEqual([
      "Sloth::Falling",
      "Sloth::Browsing",
      "Sloth::Dunging",
      "Sloth::DungInHollow",
      "Sloth::HangStill",
      "SlothDung::ClimbDown",
      "SlothDung::DungInHollow",
    ]);
    // An availability is a function of its action: a click on the action finds it.
    expect(sites.filter((site) => site.kind === "fn").map((site) => site.name)).toEqual([
      "DungAtTree",
      "home_tree",
    ]);
    expect(sites.filter((site) => site.kind === "unit").map((site) => site.name)).toEqual([
      "Sloth",
      "SlothDung",
    ]);
  });

  it("resolves states and functions in their unit, and qualified names to their library", () => {
    const files = [{ path: "behaviours/drafts/sloth_full.beh", contents: SLOTH }];
    const path = files[0]!.path;
    // In Sloth, DungInHollow is Sloth's own; in SlothDung, the library's own.
    const slothCall = SLOTH.indexOf("await DungInHollow(tree)") + "await ".length;
    expect(resolveBehaviourDefinitions(files, slothCall + 1)).toEqual([
      { path, line: lineOf(SLOTH, "state DungInHollow") },
    ]);
    const libraryCall =
      SLOTH.indexOf("await DungInHollow", SLOTH.indexOf("library SlothDung")) + "await ".length;
    expect(resolveBehaviourDefinitions(files, libraryCall + 1)).toEqual([
      { path, line: lineOf(SLOTH, "state DungInHollow", SLOTH.indexOf("library SlothDung")) },
    ]);
    const qualified = SLOTH.indexOf("SlothDung::ClimbDown") + "SlothDung::".length;
    expect(resolveBehaviourDefinitions(files, qualified + 1)).toEqual([
      { path, line: lineOf(SLOTH, "state ClimbDown") },
    ]);
    expect(resolveBehaviourDefinitions(files, SLOTH.indexOf("SlothDung::ClimbDown") + 2)).toEqual([
      { path, line: lineOf(SLOTH, "library SlothDung") },
    ]);
    expect(resolveBehaviourDefinitions(files, SLOTH.indexOf("home_tree()") + 2)).toEqual([
      { path, line: lineOf(SLOTH, "entity home_tree() {") },
    ]);
    expect(resolveBehaviourDefinitions(files, SLOTH.indexOf("transition Browsing") + 12)).toEqual([
      { path, line: lineOf(SLOTH, "state Browsing") },
    ]);
    expect(resolveBehaviourDefinitions(files, SLOTH.indexOf("JoiningMate") + 1)).toEqual([]);
  });

  it("follows includes and names the clickable ranges", () => {
    const engine =
      "bindings {\n  query int distance(pos a, pos b);\n  effect tick random_in(range r);\n}\n";
    const files = [
      { path: "behaviours/drafts/sloth_full.beh", contents: SLOTH },
      { path: "behaviours/engine.beh", contents: engine },
    ];
    expect(behaviourIncludes(SLOTH)).toEqual(["../engine.beh", "mating.beh"]);
    expect(joinBehaviourPath(files[0]!.path, "../engine.beh")).toBe("behaviours/engine.beh");
    expect(resolveBehaviourDefinitions(files, SLOTH.indexOf("random_in(") + 2)).toEqual([
      { path: "behaviours/engine.beh", line: 3 },
    ]);
    expect(resolveBehaviourDefinitions(files, SLOTH.indexOf("../engine") + 2)).toEqual([
      { path: "behaviours/engine.beh", line: 1 },
    ]);
    const targets = behaviourNavigationTargets(SLOTH).map((target) =>
      SLOTH.slice(target.start, target.end),
    );
    expect(targets).toContain("EatLeaves");
    expect(targets).toContain("home_tree");
    expect(targets).toContain("../engine.beh");
    expect(targets).not.toContain("wait_for");
  });
});

// The prototype's converted sources, where this machine has them: every line that holds a wait
// keyword outside comments and strings is a wait line.
const PROTOTYPE_ROOTS = [
  NodePath.join(NodeOS.homedir(), "Projects/polyc-prototype/.worktrees/beh/a/behaviours"),
  NodePath.join(NodeOS.homedir(), "Projects/polyc-prototype/behaviours"),
];
function sources(dir: string): string[] {
  return NodeFS.readdirSync(dir).flatMap((name) => {
    const path = NodePath.join(dir, name);
    if (NodeFS.statSync(path).isDirectory()) return sources(path);
    return /\.beh$/.test(path) ? [path] : [];
  });
}
// Files still in the old line-based syntax (`end` closes a block) are not this lexer's.
const prototypeSources = PROTOTYPE_ROOTS.filter(NodeFS.existsSync)
  .flatMap(sources)
  .filter((path) => !/^\s*end\s*$/m.test(NodeFS.readFileSync(path, "utf8")));
it.skipIf(prototypeSources.length === 0)("marks every wait in the prototype's sources", () => {
  for (const path of prototypeSources) {
    const source = NodeFS.readFileSync(path, "utf8");
    const { lines } = analyzeBehaviour(source);
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "))
      .split("\n")
      .map((line) => line.replace(/\/\/.*$/, "").replace(/"(?:[^"\\]|\\.)*"/g, '""'));
    code.forEach((line, index) => {
      if (
        /\bawait\b(?!\s*[;)])|\bwait(?:_for)?\s*\(/.test(line) &&
        !/requests\s*\(\s*wait\s*\)/.test(line)
      )
        expect(lines.get(index + 1), `${path}:${index + 1}: ${line.trim()}`).toBe("wait");
    });
  }
});
