/**
 * Polyzonia: the prototype's C-like behaviour language (`.beh`, formerly `.pzb`). Highlights has
 * no lexer for it, so clients render it as plain text and paint these tokens over it. A line waits
 * when a statement on it holds `await`, `wait_for(` or `wait(`: every place time passes.
 */

export type BehaviourTokenKind =
  | "comment"
  | "string"
  | "number"
  | "keyword"
  | "control"
  | "wait"
  | "type"
  | "constant"
  | "state"
  | "function"
  | "param"
  | "memory"
  | "qualifier"
  | "event";

export const BEHAVIOUR_TOKEN_KINDS: readonly BehaviourTokenKind[] = [
  "comment",
  "string",
  "number",
  "keyword",
  "control",
  "wait",
  "type",
  "constant",
  "state",
  "function",
  "param",
  "memory",
  "qualifier",
  "event",
];

/** `wait`: a statement on the line yields until a later tick (a wait or a state call). */
export type BehaviourLineKind = "wait";

export interface BehaviourSemanticToken {
  /** Offsets into the analyzed source (or into the line, from `behaviourLineSemantics`). */
  start: number;
  end: number;
  /** 1-based line. */
  line: number;
  kind: BehaviourTokenKind;
}

export interface BehaviourAnalysis {
  tokens: BehaviourSemanticToken[];
  /** 1-based line → its line kind, for every physical line of a waiting statement. */
  lines: Map<number, BehaviourLineKind>;
}

const BEHAVIOUR_PATH = /\.(?:beh|pzb)$/i;

export function isBehaviourPath(path: string): boolean {
  return BEHAVIOUR_PATH.test(path);
}

const FENCE_LANGUAGES = new Set(["beh", "pzb", "behaviour", "behavior"]);

/** Chat code fences tagged `beh` or `pzb` (and the spelled-out names). */
export function isBehaviourLanguage(language: string | null | undefined): boolean {
  return language !== null && language !== undefined && FENCE_LANGUAGES.has(language.toLowerCase());
}

// Lexer.

export type BehaviourLexKind = "name" | "num" | "str" | "op" | "comment" | "directive";

export interface BehaviourLexToken {
  kind: BehaviourLexKind;
  text: string;
  /** Absolute offsets into the source. A token never spans lines: a block comment is one a line. */
  start: number;
  end: number;
  /** 1-based physical line. */
  line: number;
}

const TOKEN = new RegExp(
  [
    /([ \t\r\f\v]+|\n)/.source, // 1 whitespace
    /(\/\/[^\r\n]*)/.source, // 2 line comment
    /(\/\*[\s\S]*?(?:\*\/|$))/.source, // 3 block comment, to the end of the source if unclosed
    /("(?:[^"\\\r\n]|\\.)*"?)/.source, // 4 string, to the end of the line if unclosed
    /(#[ \t]*[A-Za-z_]\w*)/.source, // 5 directive: #include
    /(\d+(?:\.\d+)?(?:cm|s|t|%)?(?![A-Za-z_\d]))/.source, // 6 number with its unit
    /([A-Za-z_]\w*(?:::[A-Za-z_]\w*)*)/.source, // 7 name, qualified: Lib::name
    /(\.\.|->|::|==|!=|<=|>=|&&|\|\||\+\+|--|[+\-*/%&|^]=|[-+*/%<>=(),.:?!{}[\];&|^~])/.source, // 8
  ].join("|"),
  "y",
);

/** Every token of the source, comments included. Unknown characters are skipped. */
export function tokenizeBehaviour(source: string): BehaviourLexToken[] {
  const tokens: BehaviourLexToken[] = [];
  let pos = 0;
  let line = 1;
  while (pos < source.length) {
    TOKEN.lastIndex = pos;
    const match = TOKEN.exec(source);
    if (!match) {
      if (source[pos] === "\n") line++;
      pos++;
      continue;
    }
    const text = match[0];
    if (match[1] !== undefined) {
      if (text === "\n") line++;
    } else if (match[3] !== undefined) {
      // One comment token a line, so every row paints on its own.
      let start = pos;
      for (const part of text.split("\n")) {
        const content = part.replace(/\r$/, "");
        if (content.length > 0)
          tokens.push({ kind: "comment", text: content, start, end: start + content.length, line });
        start += part.length + 1;
        line++;
      }
      line--;
    } else {
      const kind: BehaviourLexKind =
        match[2] !== undefined
          ? "comment"
          : match[4] !== undefined
            ? "str"
            : match[5] !== undefined
              ? "directive"
              : match[6] !== undefined
                ? "num"
                : match[7] !== undefined
                  ? "name"
                  : "op";
      tokens.push({ kind, text, start: pos, end: pos + text.length, line });
    }
    pos += text.length;
  }
  return tokens;
}

// Words.

const WAIT_CALLS = new Set(["wait", "wait_for"]);
/** What `await` waits on besides a state: `await after(d)`, `until(t)`, `event(E)`, `any { }`. */
const AWAIT_CONDITIONS = new Set(["after", "until", "event", "any"]);
const BUILTIN_TYPES = new Set([
  "int",
  "bool",
  "tick",
  "dist",
  "entity",
  "pos",
  "cell",
  "percent",
  "range",
  "refusal",
  "prefab",
  "list",
  "view",
  "void",
]);
const CONSTANTS = new Set([
  "true",
  "false",
  "none",
  "unset",
  "available",
  "no_cell",
  "no_prefab",
  "self",
  "now",
]);
const CONTROL = new Set([
  "if",
  "else",
  "while",
  "for",
  "do",
  "switch",
  "case",
  "default",
  "break",
  "continue",
  "return",
  "goto",
  "fail",
  "refuse",
  "transition",
  "restart",
  "finish",
  "accept",
  "perform",
  "send",
  "discard",
  "wait_for_current",
  "sizeof",
]);
const STRUCTURE = new Set([
  "behaviour",
  "library",
  "params",
  "memory",
  "enum",
  "state",
  "defer",
  "on",
  "availability",
  "bindings",
]);
// Section words read in place: a name elsewhere (a run called `run`, a field `.on`).
const IN_PLACE = new Set([
  "requires",
  "use",
  "initial",
  "requests",
  "failure",
  "query",
  "effect",
  "condition",
  "const",
  "input",
  "run",
  "struct",
  "event",
]);

const isWord = (token: BehaviourLexToken | undefined, text: string) =>
  token !== undefined && token.kind === "name" && token.text === text;
const isOp = (token: BehaviourLexToken | undefined, text: string) =>
  token !== undefined && token.kind === "op" && token.text === text;
const isPascal = (text: string) => /^[A-Z]/.test(lastName(text));

function lastName(text: string) {
  const split = text.lastIndexOf("::");
  return split < 0 ? text : text.slice(split + 2);
}

type ScopeKind =
  | "unit"
  | "params"
  | "memory"
  | "bindings"
  | "enum"
  | "state"
  | "fn"
  | "handler"
  | "defer"
  | "awaitAny"
  | "init"
  | "list"
  | "block";

interface Scope {
  kind: ScopeKind;
  /** The behaviour or library it is in, "" outside any. */
  unit: string;
}

/** What a `{` opens, from the statement's tokens before it. */
function scopeKind(header: readonly BehaviourLexToken[], parent: Scope | undefined): ScopeKind {
  if (parent?.kind === "init") return "init";
  if (header.some((token) => isOp(token, "="))) return "init";
  const first = header[0];
  if (!first) return "block";
  const word = first.kind === "name" ? first.text : "";
  if (word === "behaviour" || word === "library") return "unit";
  if (word === "params" && header.length === 1) return "params";
  if (word === "memory" && header.length === 1) return "memory";
  if (word === "bindings" && header.length === 1) return "bindings";
  if (word === "enum") return "enum";
  if (word === "state" || (word === "initial" && isWord(header[1], "state"))) return "state";
  if (word === "on") return "handler";
  if (word === "defer") return "defer";
  if ((word === "failure" || word === "refusal" || word === "input") && header.length === 1)
    return "list";
  if (header.some((token, i) => isWord(token, "await") && isWord(header[i + 1], "any")))
    return "awaitAny";
  if (
    (parent === undefined || parent.kind === "unit" || parent.kind === "bindings") &&
    header.length >= 3 &&
    header[0]!.kind === "name" &&
    !CONTROL.has(word) &&
    isOp(header[header.length - 1], ")")
  )
    return "fn";
  return "block";
}

/** The name a scope's header defines: the unit, state or function name. */
function headerName(header: readonly BehaviourLexToken[], kind: ScopeKind): string | null {
  if (kind === "unit") return header[1]?.kind === "name" ? header[1].text : null;
  if (kind === "state") {
    const at = header.findIndex((token) => isWord(token, "state"));
    return header[at + 1]?.kind === "name" ? header[at + 1]!.text : null;
  }
  if (kind === "fn") {
    const open = header.findIndex((token) => isOp(token, "("));
    const name = header[open - 1];
    return name?.kind === "name" ? name.text : null;
  }
  return null;
}

/** Walks a token stream keeping the brace scopes and where the current statement starts. */
function walkScopes(
  code: readonly BehaviourLexToken[],
  visit: (index: number, statement: number, scope: Scope | undefined) => void,
  onOpen?: (header: readonly BehaviourLexToken[], kind: ScopeKind, scope: Scope) => void,
  onStatement?: (header: readonly BehaviourLexToken[], scope: Scope | undefined) => void,
) {
  const scopes: Scope[] = [];
  let statement = 0;
  for (let i = 0; i < code.length; i++) {
    const token = code[i]!;
    const top = scopes[scopes.length - 1];
    if (isOp(token, "{")) {
      const header = code.slice(statement, i);
      const kind = scopeKind(header, top);
      const scope = {
        kind,
        unit: kind === "unit" ? (headerName(header, kind) ?? "") : (top?.unit ?? ""),
      };
      onOpen?.(header, kind, scope);
      scopes.push(scope);
      statement = i + 1;
    } else if (isOp(token, "}")) {
      scopes.pop();
      statement = i + 1;
    } else if (isOp(token, ";")) {
      onStatement?.(code.slice(statement, i), top);
      statement = i + 1;
    } else if (token.kind === "directive") {
      // `#include "x.beh"` ends at its line, with no `;`.
      const operand = code[i + 1];
      statement = operand && operand.line === token.line && operand.kind === "str" ? i + 2 : i + 1;
    } else visit(i, statement, top);
  }
}

// Classification.

/**
 * Colours every token and marks every waiting line of a source or a fragment of one (a diff
 * hunk, a search result, a chat code fence). A fragment that starts inside a block reads as
 * statements.
 */
export function analyzeBehaviour(source: string): BehaviourAnalysis {
  const lexed = tokenizeBehaviour(source);
  const kinds = new Map<BehaviourLexToken, BehaviourTokenKind>();
  const lineKinds = new Map<number, BehaviourLineKind>();
  const set: Setter = (token, kind) => {
    if (token && !kinds.has(token)) kinds.set(token, kind);
  };

  const code: BehaviourLexToken[] = [];
  for (const token of lexed) {
    if (token.kind === "comment") kinds.set(token, "comment");
    else {
      if (token.kind === "str") kinds.set(token, "string");
      else if (token.kind === "num") kinds.set(token, "number");
      else if (token.kind === "directive") kinds.set(token, "keyword");
      code.push(token);
    }
  }

  walkScopes(code, (i, statement, scope) => {
    if (code[i]!.kind === "name") classifyName(code, i, statement, scope, set);
  });

  // Waiting lines: the lines of the wait itself, from its keyword to the end of its call
  // (`await Mating::contact(mate,\n    distance)` is two), and the whole of an `await any { }`.
  // A wait never reaches past the statement it is in.
  const ends = (token: BehaviourLexToken | undefined) =>
    token === undefined || isOp(token, ";") || isOp(token, "{") || isOp(token, "}");
  for (let i = 0; i < code.length; i++) {
    if (kinds.get(code[i]!) !== "wait" || isWord(code[i - 1], "await")) continue;
    let end = i;
    if (isWord(code[i + 1], "any")) {
      let open = i + 2;
      while (open < code.length && !isOp(code[open], "{") && !isOp(code[open], ";")) open++;
      if (isOp(code[open], "{")) {
        let braces = 0;
        for (end = open; end < code.length; end++) {
          if (isOp(code[end], "{")) braces++;
          else if (isOp(code[end], "}") && --braces === 0) break;
        }
      }
    } else {
      // The first bracket after the keyword opens the call that waits: `wait_for(d)`,
      // `await HangStill(d)`, `await climb.done()`, `await event(Ping)`.
      let open = i + 1;
      while (!ends(code[open]) && !isOp(code[open], "(")) open++;
      if (isOp(code[open], "(")) {
        let depth = 0;
        for (end = open; !ends(code[end]); end++) {
          if (isOp(code[end], "(")) depth++;
          else if (isOp(code[end], ")") && --depth === 0) break;
        }
        if (ends(code[end])) end--;
      }
    }
    const last = code[Math.min(end, code.length - 1)]!;
    for (let line = code[i]!.line; line <= last.line; line++) lineKinds.set(line, "wait");
  }

  const result: BehaviourSemanticToken[] = [];
  for (const token of lexed) {
    const kind = kinds.get(token);
    if (!kind) continue;
    if (token.kind === "name" && token.text.includes("::")) {
      // `Lib::name`: the qualifier, then the name in its own colour.
      const qualifierEnd = token.start + token.text.lastIndexOf("::") + 2;
      result.push({ start: token.start, end: qualifierEnd, line: token.line, kind: "qualifier" });
      if (kind !== "qualifier")
        result.push({ start: qualifierEnd, end: token.end, line: token.line, kind });
      continue;
    }
    result.push({ start: token.start, end: token.end, line: token.line, kind });
  }
  return { tokens: result, lines: lineKinds };
}

type Setter = (token: BehaviourLexToken | undefined, kind: BehaviourTokenKind) => void;

function classifyName(
  code: readonly BehaviourLexToken[],
  i: number,
  statement: number,
  scope: Scope | undefined,
  set: Setter,
) {
  const token = code[i]!;
  const text = token.text;
  const previous = code[i - 1];
  const next = code[i + 1];

  // A field or a method: `climb.done()`, `x.position`, a designated argument `.on = x`.
  if (isOp(previous, ".")) {
    if (isOp(next, "(")) set(token, "function");
    return;
  }
  // `p.name` and `o.name`: the unit's params and memory.
  if ((text === "p" || text === "o") && isOp(next, ".") && code[i + 2]?.kind === "name") {
    const kind = text === "p" ? "param" : "memory";
    set(token, kind);
    set(code[i + 2], kind);
    // p.dung.stop_above_ground_cells: a parameter path is all params.
    if (kind === "param")
      for (let j = i + 3; isOp(code[j], ".") && code[j + 1]?.kind === "name"; j += 2)
        set(code[j + 1], kind);
    return;
  }

  // Waits: `await X`, `wait_for(d)`, `wait(t)`. `requests(wait)` is a request policy.
  if (text === "await" && next && !isOp(next, ";") && !isOp(next, ")")) {
    set(token, "wait");
    if (next.kind === "name" && AWAIT_CONDITIONS.has(next.text)) {
      set(next, next.text === "any" ? "wait" : "keyword");
      if (next.text === "event" && isOp(code[i + 2], "(")) set(code[i + 3], "event");
    } else if (next.kind === "name" && isPascal(next.text) && isOp(code[i + 2], "(")) {
      set(next, "state"); // a state call: `await HangStill(d, false)`
    }
    return;
  }
  if (WAIT_CALLS.has(text) && isOp(next, "(") && !isWord(code[i - 2], "requests")) {
    set(token, "wait");
    return;
  }

  if (CONSTANTS.has(text)) {
    set(token, "constant");
    return;
  }

  // Sections and handlers.
  if (text === "on" && next?.kind === "name") {
    set(token, "keyword");
    const kind = next.text;
    if (kind === "failed" || kind === "event" || kind === "request" || kind === "end") {
      set(next, "keyword");
      const subject = code[i + 2];
      if (kind === "event") set(subject, "event");
      else if (kind === "request") set(subject, "constant");
    }
    return;
  }
  if (text === "availability" && next?.kind === "name") {
    set(token, "keyword");
    set(next, "constant"); // the action
    return;
  }
  if (text === "requests" && isOp(next, "(")) {
    set(token, "keyword");
    set(code[i + 2], "keyword"); // the request policy: park, wait, refuse...
    return;
  }
  if ((text === "behaviour" || text === "library") && next?.kind === "name") {
    set(token, "keyword");
    set(next, "qualifier");
    return;
  }
  if (text === "use" && next?.kind === "name" && isOp(code[i + 2], ";")) {
    set(token, "keyword");
    set(next, "qualifier");
    return;
  }
  if (text === "state" && next?.kind === "name") {
    set(token, "keyword");
    set(next, "state");
    return;
  }
  if (text === "enum" && next?.kind === "name") {
    set(token, "keyword");
    set(next, "type");
    return;
  }
  if (scope?.kind === "enum" || scope?.kind === "list") {
    set(token, "constant");
    return;
  }
  if (IN_PLACE.has(text)) {
    // A section word only where one stands: at a statement's start (`event Ping(int n);`), or
    // `requires` in a library header, `initial` before `state`.
    if (
      (text === "requires" && code.slice(statement, i).some((t) => isWord(t, "library"))) ||
      (text === "initial" && isWord(next, "state")) ||
      (i === statement &&
        text !== "requires" &&
        text !== "initial" &&
        (next?.kind === "name" || (isOp(next, "{") && (text === "failure" || text === "input"))))
    ) {
      set(token, "keyword");
      if (text === "event") set(next, "event");
      return;
    }
  } else if (STRUCTURE.has(text)) {
    set(token, "keyword");
    return;
  }

  // Control flow, and what it names.
  if (CONTROL.has(text)) {
    set(token, "control");
    if (text === "transition" || text === "accept") {
      if (isWord(next, "initial")) set(next, "keyword");
      else if (next?.kind === "name") set(next, "state");
    } else if ((text === "fail" || text === "refuse") && next?.kind === "name") {
      set(next, "constant");
    } else if ((text === "send" || text === "discard") && next?.kind === "name") {
      set(next, "event");
    }
    return;
  }

  // Declarations: `Type name`, `Lib::Params dung`, `refusal availability`. In params and memory
  // the declared name is the unit's param or memory field.
  const declares =
    next?.kind === "name" &&
    !CONTROL.has(next.text) &&
    !CONSTANTS.has(next.text) &&
    next.text !== "await";
  if (BUILTIN_TYPES.has(text) || declares || isOp(previous, "->")) {
    set(token, "type");
    if (declares && (scope?.kind === "params" || scope?.kind === "memory"))
      set(next, scope.kind === "params" ? "param" : "memory");
    return;
  }
  // `list<entity, 16> xs`, `Lib::Map<T> m`: a generic type before its declared name.
  if (isOp(next, "<") && scope && (scope.kind === "params" || scope.kind === "memory")) {
    set(token, "type");
    return;
  }

  if (isOp(next, "(")) {
    set(token, "function");
    return;
  }
  // PascalCase names are catalog values: actions, attributes, failures, refusals, enum values.
  if (isPascal(text)) set(token, "constant");
}

// Per-line views for renderers that paint row by row.

export interface BehaviourLineSemantics {
  /** 1-based line → its tokens, with offsets relative to the line's start. */
  tokens: Map<number, BehaviourSemanticToken[]>;
  lines: Map<number, BehaviourLineKind>;
}

const MAX_ANALYZED = 2_000_000;

export function behaviourLineSemantics(source: string): BehaviourLineSemantics {
  const tokens = new Map<number, BehaviourSemanticToken[]>();
  if (source.length > MAX_ANALYZED) return { tokens, lines: new Map() };
  const offsets = [0];
  for (let i = 0; i < source.length; i++) if (source[i] === "\n") offsets.push(i + 1);
  const analysis = analyzeBehaviour(source);
  for (const token of analysis.tokens) {
    const lineStart = offsets[token.line - 1]!;
    const list = tokens.get(token.line) ?? [];
    list.push({ ...token, start: token.start - lineStart, end: token.end - lineStart });
    tokens.set(token.line, list);
  }
  return { tokens, lines: analysis.lines };
}

/**
 * Analyze each complete revision once, then align its tokens to displayed diff rows, which may be
 * a fragment whose omitted lines would change how a line reads (inside a block comment, inside an
 * `await any { }` block, a statement continued from an omitted line).
 */
export function createBehaviourRevisionSemantics(contents: {
  oldContents: string;
  newContents: string;
}) {
  const sides = [contents.oldContents, contents.newContents].map((source) => ({
    lines: source.length <= MAX_ANALYZED ? source.split("\n").map(stripCr) : [],
    semantics: behaviourLineSemantics(source),
  }));
  return (side: "additions" | "deletions", line: number, displayed: string) => {
    const entry = sides[side === "additions" ? 1 : 0]!;
    const actual = entry.lines[line - 1];
    if (actual === undefined || stripCr(displayed.replace(/\n$/, "")) !== actual) return null;
    return {
      tokens: entry.semantics.tokens.get(line) ?? [],
      lineKind: entry.semantics.lines.get(line) ?? null,
    };
  };
}

function stripCr(text: string) {
  return text.endsWith("\r") ? text.slice(0, -1) : text;
}

// Colours. Light colours stay readable on the darkest light code surface (a changed word on a
// deleted line), as upstream's readable light theme does.

export interface BehaviourPalette extends Record<BehaviourTokenKind, string> {
  /** A waiting line's background. */
  waitBackground: string;
  /** A waiting line's gutter stripe. */
  waitStripe: string;
  /** The wait keyword's own background. */
  waitKeywordBackground: string;
}

export const behaviourColors: Record<"light" | "dark", BehaviourPalette> = {
  light: {
    comment: "#5c5c5c",
    string: "#106b2c",
    number: "#11657d",
    keyword: "#8c2b9e",
    control: "#b02450",
    wait: "#6b4a00",
    type: "#146673",
    constant: "#8a4e21",
    state: "#1259a8",
    function: "#6545a0",
    param: "#814578",
    memory: "#8e460e",
    qualifier: "#4a6073",
    event: "#a23c19",
    waitBackground: "#fff1c2",
    waitStripe: "#d49b00",
    waitKeywordBackground: "#ffdd75",
  },
  dark: {
    comment: "#8a8a8a",
    string: "#5ecc71",
    number: "#68cdf2",
    keyword: "#d58cf0",
    control: "#ff678d",
    wait: "#ffd25e",
    type: "#7dcbd4",
    constant: "#e9af78",
    state: "#78b6ff",
    function: "#c6a5ed",
    param: "#e0a3d6",
    memory: "#ffa359",
    qualifier: "#93aec4",
    event: "#ff8a66",
    waitBackground: "#3a3420",
    waitStripe: "#e5b53a",
    waitKeywordBackground: "#6a5313",
  },
};

/** Split syntax tokens at semantic boundaries and colour them, preserving all original text. */
export function colorBehaviourTokens<
  T extends { content: string; color?: string | null; fontStyle?: number | null },
>(
  tokens: readonly T[],
  semantics: readonly BehaviourSemanticToken[],
  theme: "light" | "dark",
): T[] {
  const palette = behaviourColors[theme];
  const result: T[] = [];
  let offset = 0;
  for (const token of tokens) {
    const end = offset + token.content.length;
    let cursor = offset;
    for (const semantic of semantics) {
      if (semantic.end <= cursor || semantic.start >= end) continue;
      const start = Math.max(cursor, semantic.start);
      const stop = Math.min(end, semantic.end);
      if (cursor < start)
        result.push({ ...token, content: token.content.slice(cursor - offset, start - offset) });
      result.push({
        ...token,
        content: token.content.slice(start - offset, stop - offset),
        color: palette[semantic.kind],
        // Bold for the wait word itself; italics for comments.
        ...(semantic.kind === "wait"
          ? { fontStyle: (token.fontStyle ?? 0) | 2 }
          : semantic.kind === "comment"
            ? { fontStyle: (token.fontStyle ?? 0) | 1 }
            : {}),
      });
      cursor = stop;
    }
    if (cursor < end) result.push({ ...token, content: token.content.slice(cursor - offset) });
    offset = end;
  }
  return result;
}

export interface BehaviourHighlightedLine {
  tokens: Array<{ content: string; kind: BehaviourTokenKind | null }>;
  lineKind: BehaviourLineKind | null;
}

/** A whole snippet as coloured lines, for surfaces without a syntax highlighter (chat code fences). */
export function highlightBehaviour(source: string): BehaviourHighlightedLine[] {
  const semantics = behaviourLineSemantics(source);
  return source.split("\n").map((raw, index) => {
    const text = stripCr(raw);
    const lineTokens = semantics.tokens.get(index + 1) ?? [];
    const tokens: BehaviourHighlightedLine["tokens"] = [];
    let cursor = 0;
    for (const token of lineTokens) {
      if (token.start > cursor)
        tokens.push({ content: text.slice(cursor, token.start), kind: null });
      tokens.push({ content: text.slice(token.start, token.end), kind: token.kind });
      cursor = token.end;
    }
    if (cursor < text.length) tokens.push({ content: text.slice(cursor), kind: null });
    return { tokens, lineKind: semantics.lines.get(index + 1) ?? null };
  });
}

// Go to definition: units, states, functions, enums and events in this file and the files it
// includes.

export interface BehaviourDefinitionSite {
  name: string;
  /** The library or behaviour the definition belongs to, "" at file level (bindings). */
  unit: string;
  kind: "unit" | "state" | "fn" | "enum" | "event";
  line: number;
}

export function behaviourDefinitions(source: string): BehaviourDefinitionSite[] {
  const sites: BehaviourDefinitionSite[] = [];
  const code = tokenizeBehaviour(source).filter((token) => token.kind !== "comment");
  walkScopes(
    code,
    () => {},
    (header, kind, scope) => {
      const name = headerName(header, kind);
      const at = name ? header.find((entry) => entry.text === name) : undefined;
      if (name && at && (kind === "unit" || kind === "state" || kind === "fn"))
        sites.push({ name, unit: kind === "unit" ? "" : scope.unit, kind, line: at.line });
      if (kind === "enum" && header[1]?.kind === "name")
        sites.push({ name: header[1].text, unit: scope.unit, kind: "enum", line: header[1].line });
    },
    (header, scope) => {
      // A declaration with no body: a binding (`query int distance(pos a, pos b);`) or an
      // event (`event Ping(int n);`, `event Moved;`).
      const unit = scope?.kind === "unit" ? scope.unit : "";
      if (scope && scope.kind !== "unit" && scope.kind !== "bindings") return;
      if (isWord(header[0], "event") && header[1]?.kind === "name") {
        sites.push({ name: header[1].text, unit, kind: "event", line: header[1].line });
        return;
      }
      const open = header.findIndex((entry) => isOp(entry, "("));
      const named = header[open - 1];
      if (
        open >= 2 &&
        named?.kind === "name" &&
        header.slice(0, open).every((entry) => entry.kind === "name" || isOp(entry, "?")) &&
        !CONTROL.has(header[0]!.text) &&
        header[0]!.text !== "await" &&
        !WAIT_CALLS.has(header[0]!.text)
      )
        sites.push({ name: named.text, unit, kind: "fn", line: named.line });
    },
  );
  return sites;
}

const isInclude = (token: BehaviourLexToken | undefined) =>
  token?.kind === "directive" && /include$/.test(token.text);

/** The `#include "file"` paths of a source, in order. */
export function behaviourIncludes(source: string): string[] {
  const paths: string[] = [];
  const tokens = tokenizeBehaviour(source);
  for (let i = 0; i < tokens.length; i++) {
    const path = tokens[i + 1];
    if (isInclude(tokens[i]) && path?.kind === "str") paths.push(path.text.replace(/^"|"$/g, ""));
  }
  return paths;
}

export interface BehaviourNavigationTarget {
  line: number;
  start: number;
  end: number;
}

/** Ranges a click may follow: state, function, event, type and constant names, and include paths. */
export function behaviourNavigationTargets(source: string): BehaviourNavigationTarget[] {
  const targets: BehaviourNavigationTarget[] = [];
  const followed = new Set<BehaviourTokenKind>([
    "state",
    "function",
    "event",
    "type",
    "constant",
    "qualifier",
  ]);
  for (const token of analyzeBehaviour(source).tokens) {
    const text = source.slice(token.start, token.end);
    // Builtin types and constants have no definition to go to.
    if (followed.has(token.kind) && !BUILTIN_TYPES.has(text) && !CONSTANTS.has(text))
      targets.push({ line: token.line, start: token.start, end: token.end });
  }
  const tokens = tokenizeBehaviour(source);
  for (let i = 0; i < tokens.length; i++) {
    const path = tokens[i + 1];
    if (isInclude(tokens[i]) && path?.kind === "str")
      targets.push({ line: path.line, start: path.start + 1, end: path.end - 1 });
  }
  return targets;
}

/**
 * The name a click at `offset` follows: in `Lib::name`, a click on `Lib` names the library
 * (`unit`) and a click on `name` names `name` qualified by `Lib`. A click on an include's path
 * names the file.
 */
function behaviourSymbolAt(
  source: string,
  offset: number,
): { name: string; qualifier: string; unit?: boolean; include?: string } | null {
  const lexed = tokenizeBehaviour(source);
  const index = lexed.findIndex((entry) => entry.start <= offset && offset < entry.end);
  const token = lexed[index];
  if (!token) return null;
  if (token.kind === "str") {
    return isInclude(lexed[index - 1])
      ? { name: "", qualifier: "", include: token.text.replace(/^"|"$/g, "") }
      : null;
  }
  if (token.kind !== "name") return null;
  const parts = token.text.split("::");
  let partStart = token.start;
  for (let i = 0; i < parts.length; i++) {
    const last = i === parts.length - 1;
    // A qualifier's `::` belongs to the qualifier.
    const partEnd = partStart + parts[i]!.length + (last ? 0 : 2);
    if (offset < partEnd || last) {
      const qualifier = parts.slice(0, i).join("::");
      return last ? { name: parts[i]!, qualifier } : { name: parts[i]!, qualifier, unit: true };
    }
    partStart = partEnd;
  }
  return null;
}

/** The unit (behaviour or library) whose braces contain `offset`. */
function unitAt(source: string, offset: number) {
  const code = tokenizeBehaviour(source).filter(
    (token) => token.kind !== "comment" && token.start < offset,
  );
  let unit = "";
  walkScopes(code, (_i, _statement, scope) => {
    unit = scope?.unit ?? "";
  });
  return unit;
}

/**
 * Definitions of the symbol at `offset` among `files` (the source first, then what it includes):
 * the clicked unit's own names first, as the compiler resolves them, then file-level bindings,
 * then any other unit's.
 */
export function resolveBehaviourDefinitions(
  files: ReadonlyArray<{ path: string; contents: string }>,
  offset: number,
): Array<{ path: string; line: number }> {
  return rankBehaviourDefinitions(files, offset).definitions;
}

/**
 * As `resolveBehaviourDefinitions`, with the rank of what was found: 0 is the clicked unit's own
 * name (or the qualified one, or the include), so nothing an included file holds can beat it.
 */
export function rankBehaviourDefinitions(
  files: ReadonlyArray<{ path: string; contents: string }>,
  offset: number,
): { definitions: Array<{ path: string; line: number }>; rank: number } {
  const none = { definitions: [], rank: Number.POSITIVE_INFINITY };
  const source = files[0];
  if (!source) return none;
  const symbol = behaviourSymbolAt(source.contents, offset);
  if (!symbol) return none;
  if (symbol.include !== undefined) {
    const path = joinBehaviourPath(source.path, symbol.include);
    return files.some((file) => file.path === path)
      ? { definitions: [{ path, line: 1 }], rank: 0 }
      : none;
  }
  const here = unitAt(source.contents, offset + 1);
  const qualified = symbol.qualifier ? `${symbol.qualifier}::${symbol.name}` : symbol.name;
  const ranked: Array<{ path: string; line: number; rank: number }> = [];
  for (const [index, file] of files.entries()) {
    for (const site of behaviourDefinitions(file.contents)) {
      let rank: number | null = null;
      if (symbol.unit) {
        if (site.kind === "unit" && site.name === symbol.name) rank = 0;
      } else if (
        symbol.qualifier &&
        site.unit === "" &&
        site.kind !== "unit" &&
        site.name === qualified
      ) {
        // An engine binding declared by its qualified name (`effect MammalPregnancy::update();`).
        rank = 0;
      } else if (site.name === symbol.name) {
        if (site.kind === "unit") rank = 3;
        else if (symbol.qualifier) rank = site.unit === symbol.qualifier ? 0 : null;
        else rank = site.unit === here && index === 0 ? 0 : site.unit === "" ? 1 : 2;
      }
      if (rank !== null) ranked.push({ path: file.path, line: site.line, rank });
    }
  }
  if (!ranked.length) return none;
  const best = Math.min(...ranked.map((entry) => entry.rank));
  const seen = new Set<string>();
  const definitions = ranked
    .filter((entry) => entry.rank === best)
    .flatMap(({ path, line }) => {
      const key = `${path}:${line}`;
      if (seen.has(key)) return [];
      seen.add(key);
      return [{ path, line }];
    });
  return { definitions, rank: best };
}

/** `#include "../engine.beh"` relative to the including file, normalized. */
export function joinBehaviourPath(from: string, include: string): string {
  const parts = from.split("/").slice(0, -1);
  for (const part of include.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.length && parts[parts.length - 1] !== "..") parts.pop();
      else parts.push("..");
    } else parts.push(part);
  }
  return parts.join("/");
}

export type BehaviourRevisionSemantics = ReturnType<typeof createBehaviourRevisionSemantics>;
