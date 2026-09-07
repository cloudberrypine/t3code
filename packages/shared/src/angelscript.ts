/** AngelScript lexical rules shared by the web and native Shiki renderers. */
export const angelScriptGrammar = {
  name: "angelscript",
  scopeName: "source.angelscript",
  repository: {},
  patterns: [
    { name: "comment.line.double-slash.angelscript", begin: "//", end: "$" },
    { name: "comment.block.angelscript", begin: "/\\*", end: "\\*/" },
    { name: "string.quoted.triple.angelscript", begin: '"""', end: '"""' },
    ...['"', "'"].map((quote) => ({
      name: "string.quoted.angelscript",
      begin: quote,
      end: quote,
      patterns: [{ name: "constant.character.escape.angelscript", match: "\\\\." }],
    })),
    { name: "keyword.control.directive.angelscript", match: "^\\s*#\\s*\\w+" },
    {
      name: "keyword.control.angelscript",
      match:
        "\\b(?:if|else|for|while|do|switch|case|default|break|continue|return|try|catch|throw|restart|transition|state)\\b",
    },
    {
      name: "storage.modifier.angelscript",
      match:
        "\\b(?:const|in|out|inout|private|protected|shared|external|abstract|final|override|explicit|property)\\b",
    },
    {
      name: "storage.type.angelscript",
      match:
        "\\b(?:void|auto|bool|int(?:8|16|32|64)?|uint(?:8|16|32|64)?|float|double|string|entity_t)\\b",
    },
    {
      name: "keyword.declaration.angelscript",
      match: "\\b(?:class|interface|enum|namespace|funcdef|typedef|mixin|import|from|function)\\b",
    },
    { name: "constant.language.angelscript", match: "\\b(?:true|false|null)\\b" },
    { name: "variable.language.angelscript", match: "\\b(?:this|super)\\b" },
    {
      name: "keyword.operator.angelscript",
      match: "\\b(?:and|or|xor|not|is|cast)\\b|[@+*/%=!<>~&|^?:-]+",
    },
    {
      name: "constant.numeric.angelscript",
      match:
        "\\b(?:0[xX][0-9a-fA-F]+|0[bB][01]+|[0-9]+(?:\\.[0-9]*)?(?:[eE][+-]?[0-9]+)?)[fFuUlL]*\\b|\\.[0-9]+(?:[eE][+-]?[0-9]+)?[fF]?",
    },
    {
      name: "entity.name.function.angelscript",
      match: "\\b[A-Za-z_]\\w*(?=\\s*(?:<[^<>\\n]+>\\s*)?\\()",
    },
    { name: "punctuation.angelscript", match: "[{}()\\[\\],.;]" },
  ],
};

interface Token {
  text: string;
  start: number;
  end: number;
  line: number;
  comment?: boolean;
}

/** Strings are skipped, comments retained only for declaration annotations. */
function lex(source: string): Token[] {
  const result: Token[] = [];
  const pattern =
    /\/\*[\s\S]*?(?:\*\/|$)|\/\/[^\n]*|"""[\s\S]*?(?:"""|$)|"(?:\\[\s\S]|[^"\\])*(?:"|$)|'(?:\\[\s\S]|[^'\\])*(?:'|$)|[A-Za-z_]\w*|\d+(?:\.\d+)?|::|[^\s]/g;
  let line = 1;
  let previous = 0;
  for (const match of source.matchAll(pattern)) {
    for (let i = previous; i < match.index; i++) if (source[i] === "\n") line++;
    const text = match[0];
    if (!text.startsWith('"') && !text.startsWith("'")) {
      result.push({
        text,
        start: match.index,
        end: match.index + text.length,
        line,
        ...(text.startsWith("//") || text.startsWith("/*") ? { comment: true } : {}),
      });
    }
    for (const char of text) if (char === "\n") line++;
    previous = match.index + text.length;
  }
  return result;
}

export interface AngelScriptCallable {
  returnType: string;
  await: boolean;
}
export interface AngelScriptApi {
  types: Set<string>;
  enums: Set<string>;
  constants: Set<string>;
  globals: Map<string, string>;
  functions: Map<string, AngelScriptCallable>;
  members: Map<string, Map<string, AngelScriptCallable>>;
  properties: Map<string, Map<string, string>>;
}

const identifier = /^[A-Za-z_]\w*$/;
const qualifiers = new Set(["const", "in", "out", "inout", "shared", "private", "protected"]);
const primitiveTypes = new Set([
  "void",
  "bool",
  "int",
  "int8",
  "int16",
  "int32",
  "int64",
  "uint",
  "uint8",
  "uint16",
  "uint32",
  "uint64",
  "float",
  "double",
  "string",
  "entity_t",
  "auto",
]);

/** Parse declarations, not executable code; comments and bodies cannot invent API symbols. */
export function parseAngelScriptApi(source: string): AngelScriptApi {
  const api: AngelScriptApi = {
    types: new Set(),
    enums: new Set(),
    constants: new Set(),
    globals: new Map(),
    functions: new Map(),
    members: new Map(),
    properties: new Map(),
  };
  const tokens = lex(source);
  const scopes: Array<{ kind: string; name: string }> = [];
  let statement: Token[] = [];
  let lastCallable: AngelScriptCallable | undefined;
  let lastLine = -1;
  let pendingAwait = false;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.comment) {
      if (/^\/\*\*\s*await(?:\(\w+\))?\s*\*\/$/.test(token.text)) {
        if (lastCallable && token.line === lastLine) lastCallable.await = true;
        else pendingAwait = true;
      }
      continue;
    }
    if (token.text === "{") {
      const kindIndex = statement.findIndex((part) =>
        ["class", "interface", "enum", "namespace"].includes(part.text),
      );
      const kind = statement[kindIndex]?.text ?? "body";
      const name = statement[kindIndex + 1]?.text ?? "";
      if (kind === "class" || kind === "interface" || kind === "enum") api.types.add(name);
      if (kind === "enum") api.enums.add(name);
      scopes.push({ kind, name });
      statement = [];
      lastCallable = undefined;
      continue;
    }
    if (token.text === "}") {
      scopes.pop();
      statement = [];
      pendingAwait = false;
      continue;
    }
    const scope = scopes.at(-1);
    if (scope?.kind === "body") continue;
    if (scope?.kind === "enum") {
      if (statement.length === 0 && identifier.test(token.text)) api.constants.add(token.text);
      if (token.text === ",") statement = [];
      else statement.push(token);
      continue;
    }
    if (token.text !== ";") {
      statement.push(token);
      continue;
    }
    const parts = statement.filter((part) => !qualifiers.has(part.text));
    const open = parts.findIndex((part) => part.text === "(");
    const owner = scope && ["class", "interface"].includes(scope.kind) ? scope.name : null;
    lastCallable = undefined;
    if (open > 0) {
      const name = parts[open - 1]!.text;
      const callable = { returnType: parts[0]?.text ?? "", await: pendingAwait };
      const methods = owner
        ? (api.members.get(owner) ?? new Map<string, AngelScriptCallable>())
        : api.functions;
      // Any annotated overload is a suspension point for this method.
      callable.await ||= methods.get(name)?.await ?? false;
      methods.set(name, callable);
      if (owner) api.members.set(owner, methods);
      lastCallable = callable;
      lastLine = token.line;
    } else if (parts[0]?.text === "typedef") {
      const name = parts.at(-1)?.text;
      if (name) api.types.add(name);
    } else {
      const names = parts.filter((part) => identifier.test(part.text));
      const type = names[0]?.text;
      const name = names[1]?.text;
      if (type && name) {
        const properties = owner
          ? (api.properties.get(owner) ?? new Map<string, string>())
          : api.globals;
        properties.set(name, type);
        if (owner) api.properties.set(owner, properties);
        if (statement.some((part) => part.text === "const")) api.constants.add(name);
      }
    }
    statement = [];
    pendingAwait = false;
  }
  return api;
}

export type AngelScriptSemanticKind = "type" | "constant" | "global" | "function" | "await";
export interface AngelScriptSemanticToken {
  start: number;
  end: number;
  line: number;
  kind: AngelScriptSemanticKind;
}

/** Conservative receiver inference: parameters, locals, properties, return types and get<T>(). */
export function analyzeAngelScript(
  source: string,
  api: AngelScriptApi,
): AngelScriptSemanticToken[] {
  const tokens = lex(source).filter((token) => !token.comment);
  const result: AngelScriptSemanticToken[] = [];
  const variables = [new Map(api.globals)];
  let pendingFunctionBody = false;
  const lookup = (name: string) => {
    for (let i = variables.length - 1; i >= 0; i--)
      if (variables[i]!.has(name)) return variables[i]!.get(name);
    return undefined;
  };
  const matchOpen = (end: number, close: string, open: string) => {
    let depth = 1;
    for (let i = end - 1; i >= 0; i--) {
      if (tokens[i]!.text === close) depth++;
      if (tokens[i]!.text === open && --depth === 0) return i;
    }
    return -1;
  };
  function receiverType(end: number, depth = 0): string | undefined {
    if (end < 0 || depth > 12) return undefined;
    const token = tokens[end]!;
    if (token.text === ")") {
      const open = matchOpen(end, ")", "(");
      let nameIndex = open - 1;
      if (tokens[nameIndex]?.text === ">") {
        const genericOpen = matchOpen(nameIndex, ">", "<");
        if (tokens[genericOpen - 1]?.text === "get") return tokens[genericOpen + 1]?.text;
        nameIndex = genericOpen - 1;
      }
      const name = tokens[nameIndex]?.text;
      if (!name) return undefined;
      if (tokens[nameIndex - 1]?.text === ".") {
        const owner = receiverType(nameIndex - 2, depth + 1);
        return owner ? api.members.get(owner)?.get(name)?.returnType : undefined;
      }
      return api.types.has(name) ? name : api.functions.get(name)?.returnType;
    }
    if (tokens[end - 1]?.text === ".") {
      const owner = receiverType(end - 2, depth + 1);
      return owner ? api.properties.get(owner)?.get(token.text) : undefined;
    }
    return lookup(token.text);
  }
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.text === "{") {
      if (pendingFunctionBody) pendingFunctionBody = false;
      else variables.push(new Map());
    }
    if (token.text === ";" && pendingFunctionBody) {
      variables.pop();
      pendingFunctionBody = false;
    }
    if (token.text === "}" && variables.length > 1) variables.pop();
    if (!identifier.test(token.text)) continue;
    const previous = tokens[i - 1]?.text;
    const member = previous === ".";
    let kind: AngelScriptSemanticKind | undefined;
    if (
      api.types.has(token.text) ||
      primitiveTypes.has(token.text) ||
      tokens[i + 1]?.text === "@"
    ) {
      if (api.types.has(token.text)) kind = "type";
      let next = i + 1;
      if (tokens[next]?.text === "<") {
        let depth = 1;
        next++;
        while (next < tokens.length && depth) {
          if (tokens[next]?.text === "<") depth++;
          if (tokens[next]?.text === ">") depth--;
          next++;
        }
      }
      while (["@", "&", "const", "in", "out", "inout"].includes(tokens[next]?.text ?? "")) next++;
      const name = tokens[next]?.text;
      if (name && identifier.test(name)) {
        if (tokens[next + 1]?.text === "(") {
          variables.push(new Map());
          pendingFunctionBody = true;
        } else {
          let type = token.text;
          if (type === "auto" && tokens[next + 1]?.text === "=") {
            let end = next + 2;
            while (end < tokens.length && tokens[end]?.text !== ";") end++;
            type = receiverType(end - 1) ?? type;
          }
          variables.at(-1)!.set(name, type);
        }
      }
    } else if (api.constants.has(token.text) && !member) kind = "constant";
    else if (api.globals.has(token.text) && !member) kind = "global";
    if (tokens[i + 1]?.text === "(") {
      const owner = member ? receiverType(i - 2) : undefined;
      const callable = member
        ? owner
          ? api.members.get(owner)?.get(token.text)
          : undefined
        : api.functions.get(token.text);
      if (callable) kind = callable.await ? "await" : "function";
    }
    if (kind) result.push({ start: token.start, end: token.end, line: token.line, kind });
  }
  return result;
}

export function isAngelScriptPath(path: string) {
  return /\.as$/i.test(path);
}

export function usesAngelScript(path: string, source: string, api: AngelScriptApi | null): boolean {
  if (!isAngelScriptPath(path)) return false;
  if (api || /(?:^|\/)ScriptingAPI\.as$/.test(path)) return true;
  const code = lex(source.slice(0, 16_000))
    .filter((token) => !token.comment)
    .map((token) => token.text)
    .join(" ");
  return /\b(?:void|bool|int|uint|float|double)\s+\w+\s*\(|\b\w+\s*@|\b(?:funcdef|mixin|inout)\b/.test(
    code,
  );
}

export function angelScriptLineSemantics(
  source: string,
  api: AngelScriptApi,
): Map<number, AngelScriptSemanticToken[]> {
  const lines = new Map<number, AngelScriptSemanticToken[]>();
  if (source.length > 2_000_000) return lines;
  const offsets = [0];
  for (let i = 0; i < source.length; i++) if (source[i] === "\n") offsets.push(i + 1);
  for (const token of analyzeAngelScript(source, api)) {
    const tokens = lines.get(token.line) ?? [];
    tokens.push({
      ...token,
      start: token.start - offsets[token.line - 1]!,
      end: token.end - offsets[token.line - 1]!,
    });
    lines.set(token.line, tokens);
  }
  return lines;
}

export const angelScriptColors = {
  light: {
    type: "#156b78",
    constant: "#915324",
    global: "#925188",
    function: "#7551ad",
    await: "#805900",
    background: "#fff3cb",
  },
  dark: {
    type: "#7dcbd4",
    constant: "#e9af78",
    global: "#d8a3d2",
    function: "#c6a5ed",
    await: "#edc65e",
    background: "#343225",
  },
};

/** Split existing syntax tokens only at semantic boundaries, preserving all original text. */
export function colorAngelScriptTokens<
  T extends { content: string; color?: string | null; fontStyle?: number | null },
>(
  tokens: readonly T[],
  semantics: readonly AngelScriptSemanticToken[],
  theme: "light" | "dark",
): T[] {
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
        color: angelScriptColors[theme][semantic.kind],
        ...(semantic.kind === "await" ? { fontStyle: 2 } : {}),
      });
      cursor = stop;
    }
    if (cursor < end) result.push({ ...token, content: token.content.slice(cursor - offset) });
    offset = end;
  }
  return result;
}
