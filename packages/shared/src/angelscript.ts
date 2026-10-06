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
        "\\b(?:if|else|for|while|do|switch|case|default|break|continue|return|try|catch|throw|restart|transition|transitionToInitialState|fail|state)\\b",
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
      match:
        "\\b(?:class|interface|enum|namespace|behavior|library|funcdef|typedef|mixin|import|from|function)\\b",
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
  string?: boolean;
}

/** Highlighting skips strings; navigation keeps them to count call arguments. */
export function tokenizeAngelScript(source: string, includeStrings = false): Token[] {
  const result: Token[] = [];
  const pattern =
    /R"([^ ()\\\t\r\n]{0,16})\([\s\S]*?\)\1"|\/\*[\s\S]*?(?:\*\/|$)|\/\/[^\n]*|"""[\s\S]*?(?:"""|$)|"(?:\\[\s\S]|[^"\\])*(?:"|$)|'(?:\\[\s\S]|[^'\\])*(?:'|$)|[A-Za-z_]\w*|\d+(?:\.\d+)?|::|->|[^\s]/g;
  let line = 1;
  let previous = 0;
  for (const match of source.matchAll(pattern)) {
    for (let i = previous; i < match.index; i++) if (source[i] === "\n") line++;
    const text = match[0];
    const string = text.startsWith('"') || text.startsWith("'") || text.startsWith('R"');
    if (includeStrings || !string) {
      result.push({
        text,
        start: match.index,
        end: match.index + text.length,
        line,
        ...(string ? { string: true } : {}),
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
  genericType?: string;
}
export interface AngelScriptApi {
  source?: { path: string; contents: string };
  types: Set<string>;
  enums: Set<string>;
  constants: Set<string>;
  constantScopes?: Map<string, Set<string>>;
  globals: Map<string, string>;
  functions: Map<string, AngelScriptCallable>;
  members: Map<string, Map<string, AngelScriptCallable>>;
  properties: Map<string, Map<string, string>>;
}

const identifier = /^[A-Za-z_]\w*$/;
/** Generated tree rows are references, not declarations. Fragments are only used for hit testing;
 * resolution always validates the header and its following module block in the complete source. */
export function angelScriptStateTree(contents: string, fragments = false) {
  if (!fragments && !contents.includes("// State tree (generated;")) return [];
  const tokens = tokenizeAngelScript(contents, true);
  const entries: Array<{
    name: string;
    start: number;
    end: number;
    line: number;
    namespace: string;
    file?: string;
    fileStart?: number;
  }> = [];
  let active = fragments;
  let groupStart = 0;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.comment && /^\/\/ State tree \(generated;.*\):\s*$/.test(token.text)) {
      active = true;
      groupStart = entries.length;
      continue;
    }
    if (active && token.comment) {
      const match =
        /^\/\/([ |`-]+)([A-Za-z_]\w*(?:::[A-Za-z_]\w*)*)(?:\s+[?*])*(?:\s+\[(?:initial|entered by name)\])?(?:\s+\(([^()]+\.as)\))?\s*$/.exec(
          token.text,
        );
      if (match) {
        const start = token.start + 2 + match[1]!.length;
        entries.push({
          name: match[2]!,
          start,
          end: start + match[2]!.length,
          line: token.line,
          namespace: "",
          ...(match[3]
            ? { file: match[3], fileStart: token.start + token.text.lastIndexOf(match[3]) }
            : {}),
        });
        continue;
      }
    }
    if (active) {
      if (
        ["namespace", "behavior", "library"].includes(token.text) &&
        identifier.test(tokens[i + 1]?.text ?? "")
      ) {
        let name = tokens[i + 1]!.text;
        let next = i + 2;
        while (tokens[next]?.text === "::" && identifier.test(tokens[next + 1]?.text ?? "")) {
          name += `::${tokens[next + 1]!.text}`;
          next += 2;
        }
        if (tokens[next]?.text === "{") {
          for (const entry of entries.slice(groupStart)) entry.namespace = name;
        }
      }
      if (!fragments && !entries[groupStart]?.namespace) entries.splice(groupStart);
      active = fragments;
      groupStart = entries.length;
    }
  }
  return fragments ? entries : entries.filter((entry) => entry.namespace);
}

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
    constantScopes: new Map(),
    globals: new Map(),
    functions: new Map(),
    members: new Map(),
    properties: new Map(),
  };
  const tokens = tokenizeAngelScript(source);
  const scopes: Array<{ kind: string; name: string }> = [];
  let statement: Token[] = [];
  let lastCallable: AngelScriptCallable | undefined;
  let lastLine = -1;
  let pendingAwait = false;
  const addConstant = (name: string, enumValue = false) => {
    api.constants.add(name);
    const path = scopes.map((scope) => scope.name).filter(Boolean);
    for (const owner of enumValue
      ? [path.join("::"), path.slice(0, -1).join("::")]
      : [path.join("::")]) {
      const constants = api.constantScopes!.get(owner) ?? new Set<string>();
      constants.add(name);
      api.constantScopes!.set(owner, constants);
    }
  };
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
      if (statement.length === 0 && identifier.test(token.text)) addConstant(token.text, true);
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
      const generic = parts[open - 1]?.text === ">" && parts[open - 3]?.text === "<";
      const name = parts[open - (generic ? 4 : 1)]!.text;
      if (parts[0]?.text === "funcdef") {
        api.types.add(name);
        statement = [];
        pendingAwait = false;
        continue;
      }
      const callable: AngelScriptCallable = {
        returnType: parts[0]?.text ?? "",
        await: pendingAwait,
        ...(generic ? { genericType: parts[open - 2]!.text } : {}),
      };
      const methods = owner
        ? (api.members.get(owner) ?? new Map<string, AngelScriptCallable>())
        : api.functions;
      // Any annotated overload is a suspension point for this method.
      callable.await ||= methods.get(name)?.await ?? false;
      methods.set(name, callable);
      if (owner) api.members.set(owner, methods);
      if (name.startsWith("get_") && parts[open + 1]?.text === ")") {
        const properties = owner ? (api.properties.get(owner) ?? new Map()) : api.globals;
        properties.set(name.slice(4), callable.returnType);
        if (owner) api.properties.set(owner, properties);
      }
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
        if (statement.some((part) => part.text === "const")) addConstant(name);
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

interface EnumHighlightScope {
  parent?: EnumHighlightScope;
  path: string;
  kind: string;
  children: Map<string, EnumHighlightScope>;
  constants: Set<string>;
}

/** Predeclare enums, script classes and HSM states, including reopened namespaces. */
function indexEnumHighlightScopes(tokens: Token[]) {
  const root: EnumHighlightScope = {
    path: "",
    kind: "namespace",
    children: new Map(),
    constants: new Set(),
  };
  const scopes: EnumHighlightScope[] = [];
  let scope = root;
  const parents: EnumHighlightScope[] = [];
  let memberExpected = false;
  let expressionDepth = 0;
  for (let i = 0; i < tokens.length; i++) {
    const text = tokens[i]!.text;
    if (text === "{") {
      parents.push(scope);
      let start = i - 1;
      while (start > 1 && tokens[start - 1]?.text === "::") start -= 2;
      const keyword = tokens[start - 1]?.text ?? "";
      const kind = keyword === "behavior" || keyword === "library" ? "namespace" : keyword;
      if (
        ["namespace", "enum", "class", "interface", "state"].includes(kind) &&
        identifier.test(tokens[start]?.text ?? "")
      ) {
        for (let nameIndex = start; nameIndex < i; nameIndex += 2) {
          const name = tokens[nameIndex]!.text;
          if (kind === "state") scope.constants.add(name);
          let child = scope.children.get(name);
          if (!child) {
            child = {
              parent: scope,
              path: [scope.path, name].filter(Boolean).join("::"),
              kind,
              children: new Map(),
              constants: new Set(),
            };
            scope.children.set(name, child);
          }
          scope = child;
        }
      } else {
        scope = {
          parent: scope,
          path: scope.path,
          kind: "block",
          children: new Map(),
          constants: new Set(),
        };
      }
      memberExpected = scope.kind === "enum";
      expressionDepth = 0;
    }
    scopes[i] = scope;
    if (text === "}") scope = parents.pop() ?? root;
    else if (scope.kind === "enum" && text !== "{") {
      if (memberExpected && identifier.test(text)) {
        scope.constants.add(text);
        scope.parent?.constants.add(text);
        memberExpected = false;
      }
      if (text === "(" || text === "[") expressionDepth++;
      if (text === ")" || text === "]") expressionDepth--;
      if (text === "," && expressionDepth === 0) memberExpected = true;
    }
  }
  return { root, scopes };
}

function highlightQualifier(tokens: Token[], index: number) {
  const names: string[] = [];
  let start = index;
  while (tokens[start - 1]?.text === "::" && identifier.test(tokens[start - 2]?.text ?? "")) {
    names.unshift(tokens[start - 2]!.text);
    start -= 2;
  }
  return { names, absolute: tokens[start - 1]?.text === "::" };
}

/** Conservative receiver inference: parameters, locals, properties, return types and get<T>(). */
export function analyzeAngelScript(
  source: string,
  api: AngelScriptApi,
): AngelScriptSemanticToken[] {
  const tokens = tokenizeAngelScript(source).filter((token) => !token.comment);
  const result: AngelScriptSemanticToken[] = [];
  const enums = indexEnumHighlightScopes(tokens);
  // The generated tree also describes calls into included state libraries. Only
  // qualified names identify those states without reading more workspace files.
  const libraryStates = new Set(
    angelScriptStateTree(source)
      .filter((entry) => entry.name.includes("::"))
      .map((entry) => entry.name),
  );
  const localVariables = new WeakMap<Map<string, string>, Set<string>>();
  function enumSymbol(index: number, name: string, type: boolean | "state" = false): boolean {
    const { names, absolute } = highlightQualifier(tokens, index);
    if (
      (type === false || type === "state") &&
      names.length &&
      libraryStates.has([...names, name].join("::"))
    )
      return true;
    let scope: EnumHighlightScope | undefined = absolute ? enums.root : enums.scopes[index];
    for (; scope; scope = absolute ? undefined : scope.parent) {
      let owner: EnumHighlightScope | undefined = scope;
      for (const part of names) owner = owner?.children.get(part);
      if (
        type
          ? (type === "state" ? ["state"] : ["enum", "class", "interface"]).includes(
              owner?.children.get(name)?.kind ?? "",
            )
          : owner?.constants.has(name)
      )
        return true;
      // A local qualifier owns the lookup, including when an API enum has the same name.
      if (names.length && scope.children.has(names[0]!)) return false;
      if (!type) {
        const path = [scope.path, ...names].filter(Boolean).join("::");
        if (api.constantScopes?.get(path)?.has(name)) return true;
      }
    }
    return !type && !api.constantScopes && names.length === 0 && api.constants.has(name);
  }
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
  function callAt(index: number) {
    let open = index + 1;
    let genericType: string | undefined;
    if (tokens[open]?.text === "<") {
      const start = ++open;
      while (/^(?:[A-Za-z_]\w*|::)$/.test(tokens[open]?.text ?? "")) open++;
      if (tokens[open]?.text !== ">") return undefined;
      genericType = tokens
        .slice(start, open)
        .map((part) => part.text)
        .join("");
      open++;
    }
    return tokens[open]?.text === "(" ? { genericType } : undefined;
  }
  function receiverType(end: number, depth = 0): string | undefined {
    if (end < 0 || depth > 12) return undefined;
    const token = tokens[end]!;
    if (token.text === "]") {
      const open = matchOpen(end, "]", "[");
      const owner = receiverType(open - 1, depth + 1);
      if (owner?.startsWith("vector_") && api.types.has(owner.slice(7))) return owner.slice(7);
      return owner
        ? (api.members.get(owner)?.get("opIndex") ?? api.members.get(owner)?.get("get_opIndex"))
            ?.returnType
        : undefined;
    }
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
      let callable: AngelScriptCallable | undefined;
      if (tokens[nameIndex - 1]?.text === ".") {
        const owner = receiverType(nameIndex - 2, depth + 1);
        callable = owner ? api.members.get(owner)?.get(name) : undefined;
      } else callable = api.functions.get(name);
      return api.types.has(name)
        ? name
        : callable?.genericType && callable.genericType === callable.returnType
          ? callAt(nameIndex)?.genericType
          : callable?.returnType;
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
      enumSymbol(i, token.text, true) ||
      primitiveTypes.has(token.text) ||
      tokens[i + 1]?.text === "@"
    ) {
      if (api.types.has(token.text) || enumSymbol(i, token.text, true)) kind = "type";
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
        if (callAt(next)) {
          variables.push(new Map());
          pendingFunctionBody = true;
        } else {
          let type = token.text;
          if (type === "auto" && tokens[next + 1]?.text === "=") {
            let end = next + 2;
            while (end < tokens.length && tokens[end]?.text !== ";") end++;
            type = receiverType(end - 1) ?? type;
          }
          const scope = variables.at(-1)!;
          scope.set(name, type);
          let names = localVariables.get(scope);
          if (!names) localVariables.set(scope, (names = new Set()));
          names.add(name);
        }
      }
    } else if (
      !member &&
      (previous === "::" ||
        !variables.some((scope) => localVariables.get(scope)?.has(token.text))) &&
      enumSymbol(i, token.text)
    )
      kind = "constant";
    else if (!member && !variables.some((scope) => localVariables.get(scope)?.has(token.text))) {
      if (api.globals.has(token.text)) kind = "global";
      else if (
        (token.text === "p" || token.text === "o") &&
        enumSymbol(i, token.text === "p" ? "Params" : "Object", true)
      )
        kind = "global";
    }
    if (callAt(i)) {
      const owner = member ? receiverType(i - 2) : undefined;
      const callable = member
        ? owner
          ? api.members.get(owner)?.get(token.text)
          : undefined
        : api.functions.get(token.text);
      // Polyzonia registers these global suspension points without the method
      // await annotations in ScriptingAPI.as. Condition builders do not suspend.
      const builtinAwait =
        !member &&
        ["AwaitAny", "WaitUntil", "awaitAny", "waitUntil"].includes(token.text) &&
        highlightQualifier(tokens, i).names.length === 0;
      const stateCall =
        !member &&
        enumSymbol(i, token.text, "state") &&
        !variables.some((scope) => localVariables.get(scope)?.has(token.text));
      if (builtinAwait || stateCall) kind = "await";
      else if (callable) kind = callable.await ? "await" : "function";
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
  const code = tokenizeAngelScript(source.slice(0, 16_000))
    .filter((token) => !token.comment)
    .map((token) => token.text)
    .join(" ");
  return /\b(?:behavior|library)\s+\w+\s*\{|\b(?:void|bool|int|uint|float|double)\s+\w+\s*\(|\b\w+\s*@|\b(?:funcdef|mixin|inout)\b/.test(
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

/** Analyze each complete revision once, then align its tokens to displayed diff
 * rows. A patch may omit declarations or change whitespace in context lines. */
export function createAngelScriptRevisionSemantics(
  contents: { oldContents: string; newContents: string },
  api: AngelScriptApi,
) {
  const sides = [contents.oldContents, contents.newContents].map((source) => ({
    lines: source.length <= 2_000_000 ? source.split("\n") : [],
    semantics: angelScriptLineSemantics(source, api),
  }));
  return (side: "additions" | "deletions", line: number, displayed: string) => {
    const entry = sides[side === "additions" ? 1 : 0]!;
    const actual = entry.lines[line - 1];
    const semantics = entry.semantics.get(line) ?? [];
    if (actual === undefined || !semantics.length) return [];
    displayed = displayed.replace(/\r?\n$/, "");
    if (displayed === actual) return semantics;
    const original = tokenizeAngelScript(actual, true);
    const visible = tokenizeAngelScript(displayed, true);
    if (
      original.length !== visible.length ||
      original.some((token, i) => token.text !== visible[i]!.text)
    )
      return [];
    const offsets = new Map(original.map((token, i) => [token.start, visible[i]!]));
    return semantics.flatMap((token) => {
      const target = offsets.get(token.start);
      return target ? [{ ...token, start: target.start, end: target.end }] : [];
    });
  };
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
      });
      cursor = stop;
    }
    if (cursor < end) result.push({ ...token, content: token.content.slice(cursor - offset) });
    offset = end;
  }
  return result;
}
