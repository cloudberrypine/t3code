import { angelScriptStateTree, tokenizeAngelScript } from "./angelscript.js";

export interface AngelScriptSource {
  path: string;
  contents: string;
}

export interface AngelScriptDefinition {
  path: string;
  line: number;
}

type Token = ReturnType<typeof tokenizeAngelScript>[number];
interface Scope {
  start: number;
  end: number;
  kind: "block" | "function" | "class" | "enum" | "namespace" | "state";
  name: string;
  parent?: Scope;
}
interface Declaration {
  token: Token;
  type: string;
  kind: "type" | "variable" | "function" | "namespace" | "state";
  scope: Scope;
  arity?: { min: number; max: number };
  elementType?: string;
  genericType?: string;
  owner?: string;
  definition?: boolean;
}

const identifier = /^[A-Za-z_]\w*$/;

function relativeScriptPath(source: AngelScriptSource, name: string): string | null {
  if (name.startsWith("/") || name.includes("\\")) return null;
  const parts = source.path.split("/").slice(0, -1);
  for (const part of name.split("/")) {
    if (part === "..") {
      if (!parts.length) return null;
      parts.pop();
    } else if (part !== "." && part !== "") parts.push(part);
  }
  return parts.join("/");
}
const modifiers = new Set([
  "const",
  "shared",
  "private",
  "protected",
  "external",
  "abstract",
  "final",
  "override",
  "explicit",
  "property",
  "in",
  "out",
  "inout",
]);
const nonTypes = new Set([
  "return",
  "if",
  "else",
  "while",
  "for",
  "switch",
  "case",
  "break",
  "continue",
  "throw",
  "restart",
  "transition",
  "import",
  "from",
  "new",
  "delete",
  "namespace",
  "behavior",
  "library",
  "class",
  "interface",
  "enum",
  "state",
  "using",
  "typedef",
  "funcdef",
  "mixin",
]);

/** Index lexical scopes and declaration locations without treating calls or comments as definitions. */
export function indexNavigationSource(source: AngelScriptSource, cpp = false) {
  const directiveLines = new Set<number>();
  if (cpp)
    source.contents.split("\n").forEach((line, index) => {
      if (/^\s*#/.test(line)) directiveLines.add(index + 1);
    });
  let tokens = tokenizeAngelScript(source.contents, true).filter(
    (token) => !token.comment && !directiveLines.has(token.line),
  );
  if (cpp) {
    // A template parameter list prefixes a declaration; it is neither a return type nor
    // a class body. Preserve original offsets while letting the declaration parser see past it.
    const headers = new Set<number>();
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i]!.text !== "template" || tokens[i + 1]?.text !== "<") continue;
      let depth = 1;
      let parentheses = 0;
      let end = i + 2;
      for (; end < tokens.length && depth > 0; end++) {
        const text = tokens[end]!.text;
        if (text === "(") parentheses++;
        else if (text === ")") parentheses--;
        else if (parentheses === 0) {
          if (text === "<") depth++;
          else if (text === ">") depth--;
          else if ([";", "{"].includes(text)) break;
        }
      }
      if (depth !== 0) continue;
      for (let n = i; n < end; n++) headers.add(n);
      i = end - 1;
    }
    tokens = tokens.filter((_, index) => !headers.has(index));
  }
  const typeModifiers = cpp
    ? new Set([
        ...modifiers,
        "static",
        "inline",
        "virtual",
        "constexpr",
        "consteval",
        "extern",
        "mutable",
        "volatile",
        "typename",
      ])
    : modifiers;
  const functionModifiers = new Set([...typeModifiers, ...(cpp ? ["noexcept", "&"] : [])]);
  const pairs = new Map<number, number>();
  const stack: number[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const text = tokens[i]!.text;
    if (["(", "{", "["].includes(text)) stack.push(i);
    else if ([")", "}", "]"].includes(text)) {
      const open = stack.at(-1);
      if (open !== undefined && { ")": "(", "}": "{", "]": "[" }[text] === tokens[open]!.text) {
        stack.pop();
        pairs.set(open, i);
        pairs.set(i, open);
      }
    }
  }
  const root: Scope = { start: 0, end: source.contents.length, kind: "namespace", name: "" };
  const scopes: Scope[] = [root];
  const braces = new Map<number, Scope>();
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i]!.text !== "{") continue;
    const scope: Scope = {
      start: tokens[i]!.start,
      end: tokens[pairs.get(i) ?? tokens.length]?.end ?? source.contents.length,
      kind: "block",
      name: "",
    };
    scopes.push(scope);
    braces.set(i, scope);
  }
  const named: Array<{ token: Token; scope: Scope; brace: number }> = [];
  for (let i = 0; i < tokens.length; i++) {
    const keyword = tokens[i]!.text;
    // Both module declarations have namespace lookup rules. In a library,
    // p/o still have its own Params/Object type, regardless of the host member name.
    const kind = !cpp && (keyword === "behavior" || keyword === "library") ? "namespace" : keyword;
    if (cpp && ["class", "struct"].includes(kind) && tokens[i - 1]?.text === "enum") continue;
    if (cpp && kind === "namespace" && tokens[i + 1]?.text === "{") {
      const scope = braces.get(i + 1);
      if (scope) scope.kind = "namespace";
      continue;
    }
    if (kind === "for" && tokens[i + 1]?.text === "(") {
      const close = pairs.get(i + 1);
      if (close !== undefined) {
        let end = close + 1;
        if (tokens[end]?.text === "{") end = pairs.get(end) ?? end;
        else while (end < tokens.length && tokens[end]?.text !== ";") end++;
        scopes.push({
          start: tokens[i + 1]!.start,
          end: tokens[end]?.end ?? source.contents.length,
          kind: "block",
          name: "",
        });
      }
    }
    const name =
      tokens[
        i +
          (cpp && kind === "enum" && ["class", "struct"].includes(tokens[i + 1]?.text ?? "")
            ? 2
            : 1)
      ];
    if (
      !["class", "interface", "enum", "namespace", "state", ...(cpp ? ["struct"] : [])].includes(
        kind,
      ) ||
      !name ||
      !identifier.test(name.text)
    )
      continue;
    let brace = i + 2;
    while (brace < tokens.length && !["{", ";", "}"].includes(tokens[brace]!.text)) brace++;
    const scope = braces.get(brace);
    if (!scope) continue;
    scope.kind = kind === "interface" || kind === "struct" ? "class" : (kind as Scope["kind"]);
    scope.name = name.text;
    if (kind === "namespace") {
      let n = i + 2;
      while (tokens[n]?.text === "::" && identifier.test(tokens[n + 1]?.text ?? "")) {
        scope.name += `::${tokens[n + 1]!.text}`;
        n += 2;
      }
    }
    named.push({ token: name, scope, brace });
  }
  const scopeAt = (offset: number) => {
    let found = root;
    for (const scope of scopes) {
      if (scope.start <= offset && offset < scope.end && scope.start >= found.start) found = scope;
    }
    return found;
  };
  // Returns the base (possibly qualified) type and the following declaration name.
  const readType = (start: number) => {
    let i = start;
    while (typeModifiers.has(tokens[i]?.text ?? "")) i++;
    // Elaborated type names are valid in variable declarations, but the struct
    // keyword itself must never be indexed as a variable's type.
    if (cpp && ["struct", "class", "enum"].includes(tokens[i]?.text ?? "")) i++;
    const first = tokens[i];
    if (!first || !identifier.test(first.text) || nonTypes.has(first.text)) return null;
    let type = first.text;
    i++;
    if (cpp && ["unsigned", "signed", "long", "short"].includes(type))
      while (["long", "short", "int", "char", "double"].includes(tokens[i]?.text ?? "")) i++;
    while (tokens[i]?.text === "::" && identifier.test(tokens[i + 1]?.text ?? "")) {
      type += `::${tokens[i + 1]!.text}`;
      i += 2;
    }
    let elementType: string | undefined;
    if (tokens[i]?.text === "<") {
      if ((cpp ? ["vector", "array", "span"] : ["array"]).includes(type.split("::").at(-1)!)) {
        let n = i + 1;
        while (tokens[n]?.text === "const") n++;
        const parts: string[] = [];
        while (/^(?:[A-Za-z_]\w*|::)$/.test(tokens[n]?.text ?? "")) parts.push(tokens[n++]!.text);
        if ([">", ",", "@"].includes(tokens[n]?.text ?? "")) elementType = parts.join("");
      }
      let depth = 1;
      i++;
      while (i < tokens.length && depth > 0) {
        if (tokens[i]!.text === "<") depth++;
        if (tokens[i]!.text === ">") depth--;
        if ([";", "{"].includes(tokens[i]!.text)) return null;
        i++;
      }
      if (depth) return null;
    }
    if (!cpp && elementType) type = `${elementType}[]`;
    while (
      ["@", "&", "[", "]", ...(cpp ? ["*"] : [])].includes(tokens[i]?.text ?? "") ||
      modifiers.has(tokens[i]?.text ?? "")
    ) {
      if (!cpp && tokens[i]?.text === "[" && tokens[i + 1]?.text === "]") type += "[]";
      i++;
    }
    return { type, nameIndex: i, ...(elementType ? { elementType } : {}) };
  };
  const declarations: Declaration[] = [];
  const pending: Array<Omit<Declaration, "scope">> = [];
  for (let i = 0; i < tokens.length; i++) {
    const previous = tokens[i - 1]?.text;
    if (previous && !["{", "}", ";", "(", ",", ":"].includes(previous)) continue;
    if (!cpp && tokens[i]?.text === "funcdef") {
      const callable = readType(i + 1);
      const name = callable && tokens[callable.nameIndex];
      if (name && identifier.test(name.text) && tokens[callable!.nameIndex + 1]?.text === "(")
        pending.push({ token: name, type: name.text, kind: "type" });
      continue;
    }
    const parsed = readType(i);
    if (
      cpp &&
      tokens[i]?.text === "using" &&
      identifier.test(tokens[i + 1]?.text ?? "") &&
      tokens[i + 2]?.text === "="
    ) {
      pending.push({ token: tokens[i + 1]!, type: tokens[i + 3]?.text ?? "", kind: "type" });
      continue;
    }
    if (cpp && parsed && tokens[parsed.nameIndex]?.text === "(") {
      const parts = parsed.type.split("::");
      const scope = scopeAt(tokens[i]!.start);
      if (
        (scope.kind === "class" && scope.name === parts.at(-1)) ||
        (parts.length > 1 && parts.at(-1) === parts.at(-2))
      )
        parsed.nameIndex--;
    }
    let name = parsed && tokens[parsed.nameIndex];
    let owner: string | undefined;
    if (
      cpp &&
      parsed &&
      name &&
      parsed.nameIndex > i &&
      tokens[parsed.nameIndex - 1]?.text === "::"
    )
      owner = parsed.type.split("::").slice(0, -1).join("::");
    if (cpp && parsed && name) {
      const parts: string[] = [];
      while (
        tokens[parsed.nameIndex + 1]?.text === "::" &&
        identifier.test(tokens[parsed.nameIndex + 2]?.text ?? "")
      ) {
        parts.push(name!.text);
        parsed.nameIndex += 2;
        name = tokens[parsed.nameIndex];
      }
      if (parts.length) owner = parts.join("::");
    }
    if (!parsed || !name || !identifier.test(name.text)) continue;
    let afterName = parsed.nameIndex + 1;
    let genericType: string | undefined;
    if (tokens[afterName]?.text === "<" && tokens[afterName + 2]?.text === ">") {
      genericType = tokens[afterName + 1]?.text;
      afterName += 3;
    }
    const next = tokens[afterName]?.text;
    if (next === "(") {
      const close = pairs.get(afterName);
      if (close === undefined) continue;
      let after = close + 1;
      while (functionModifiers.has(tokens[after]?.text ?? "")) after++;
      if (cpp && tokens[after]?.text === "->") {
        while (after < tokens.length && !["{", ";"].includes(tokens[after]!.text)) after++;
      }
      if (!["{", ";"].includes(tokens[after]?.text ?? "")) continue;
      const scope = braces.get(after) ?? {
        start: name.end,
        end: tokens[after]!.end,
        kind: "function" as const,
        name: "",
      };
      scope.start = tokens[afterName]!.start;
      scope.kind = "function";
      if (owner) scope.name = owner;
      if (!braces.has(after)) scopes.push(scope);
      let min = 0;
      let max = 0;
      let optional = false;
      let hasParameter = false;
      for (let parameter = afterName + 1; parameter <= close; parameter++) {
        const text = tokens[parameter]!.text;
        if (parameter === close || text === ",") {
          if (hasParameter) {
            max++;
            if (!optional) min++;
          }
          optional = false;
          hasParameter = false;
        } else {
          hasParameter = !(
            cpp &&
            text === "void" &&
            parameter === afterName + 1 &&
            parameter + 1 === close
          );
          if (text === "=") optional = true;
          if (["(", "[", "{"].includes(text)) parameter = pairs.get(parameter) ?? parameter;
        }
      }
      pending.push({
        token: name,
        type: parsed.type,
        kind: "function",
        ...(owner ? { owner } : {}),
        definition: tokens[after]?.text === "{",
        arity: { min, max },
        ...(genericType ? { genericType } : {}),
      });
    } else if ([";", "=", ",", ")", "[", ...(cpp ? ["{"] : [])].includes(next ?? "")) {
      pending.push({
        token: name,
        type: parsed.type,
        kind: "variable",
        ...(parsed.elementType ? { elementType: parsed.elementType } : {}),
      });
    }
  }
  for (const scope of scopes) {
    if (scope !== root) scope.parent = scopeAt(scope.start - 1);
  }
  for (const { token, scope, brace } of named) {
    declarations.push({
      token,
      type: token.text,
      kind: scope.kind === "namespace" || scope.kind === "state" ? scope.kind : "type",
      scope: scope.parent ?? root,
    });
    if (scope.kind === "enum") {
      for (let i = brace + 1; i < (pairs.get(brace) ?? tokens.length); i++) {
        if (["(", "[", "{"].includes(tokens[i]!.text)) {
          i = pairs.get(i) ?? tokens.length;
          continue;
        }
        const value = tokens[i]!;
        if (identifier.test(value.text) && ["{", ","].includes(tokens[i - 1]?.text ?? "")) {
          declarations.push({ token: value, type: token.text, kind: "variable", scope });
        }
      }
    }
  }
  for (const entry of pending) {
    const scope = scopeAt(entry.token.start);
    const prefix = qualifiedScope(scope);
    const owner =
      entry.owner && prefix && !entry.owner.startsWith(`${prefix}::`)
        ? `${prefix}::${entry.owner}`
        : entry.owner;
    declarations.push({ ...entry, ...(owner ? { owner } : {}), scope });
    if (
      !cpp &&
      entry.kind === "function" &&
      entry.token.text.startsWith("get_") &&
      entry.arity?.max === 0
    ) {
      declarations.push({
        token: { ...entry.token, text: entry.token.text.slice(4) },
        type: entry.type,
        kind: "variable",
        scope,
      });
    }
  }
  return { source, tokens, pairs, scopes, declarations, root, scopeAt };
}

type SourceIndex = ReturnType<typeof indexNavigationSource>;
export function qualifiedScope(scope: Scope): string {
  const names: string[] = [];
  for (let current: Scope | undefined = scope; current; current = current.parent) {
    if (current.name) names.unshift(current.name);
  }
  return names.join("::");
}

/** Resolve against the current buffer and explicitly supplied API/include files. Ambiguity yields no jump. */
export function createAngelScriptNavigation(sources: readonly AngelScriptSource[], cpp = false) {
  const indices = sources
    .filter((source) => source.contents.length <= 2_000_000)
    .map((source) => indexNavigationSource(source, cpp));
  const stateTrees = new Map<SourceIndex, ReturnType<typeof angelScriptStateTree>>();
  const navigation = {
    resolve(
      path: string,
      offset: number,
      withIdentity = false,
    ): (AngelScriptDefinition & { start?: number; kind?: Declaration["kind"] }) | null {
      const current = indices.find((entry) => entry.source.path === path);
      if (!current) return null;
      if (!cpp) {
        let entries = stateTrees.get(current);
        if (!entries) {
          entries = angelScriptStateTree(current.source.contents);
          stateTrees.set(current, entries);
        }
        const tree = entries.find((entry) => entry.start <= offset && offset < entry.end);
        if (tree) {
          const file = tree.file ? relativeScriptPath(current.source, tree.file) : undefined;
          if (tree.file && !file) return null;
          const candidates = indices.flatMap((index) =>
            index.declarations
              .filter(
                (entry) =>
                  entry.kind === "state" &&
                  (!file || index.source.path === file) &&
                  (tree.name.includes("::")
                    ? [tree.name, `${tree.namespace}::${tree.name}`].includes(
                        `${qualifiedScope(entry.scope)}::${entry.token.text}`,
                      )
                    : entry.token.text === tree.name),
              )
              .map((entry) => ({ index, entry })),
          );
          const local = candidates.filter(({ entry }) =>
            tree.name.includes("::")
              ? `${qualifiedScope(entry.scope)}::${entry.token.text}` ===
                `${tree.namespace}::${tree.name}`
              : qualifiedScope(entry.scope) === tree.namespace,
          );
          const matches = !tree.file && local.length ? local : candidates;
          return matches.length === 1
            ? { path: matches[0]!.index.source.path, line: matches[0]!.entry.token.line }
            : null;
        }
      }
      const tokenIndex = current.tokens.findIndex(
        (token) => token.start <= offset && offset < token.end,
      );
      const token = current.tokens[tokenIndex];
      if (!token || !identifier.test(token.text)) return null;
      const scope = current.scopeAt(offset);
      const location = (index: SourceIndex, declaration: Declaration) => ({
        path: index.source.path,
        line: declaration.token.line,
        ...(withIdentity ? { start: declaration.token.start, kind: declaration.kind } : {}),
      });
      // Behavior scripts pair enum State members with executable state blocks.
      // Match the containing scope so another behavior's same-named state cannot win.
      const stateMember = current.declarations.find(
        (entry) =>
          entry.token === token && entry.scope.kind === "enum" && entry.scope.name === "State",
      );
      if (stateMember) {
        const states = current.declarations.filter(
          (entry) =>
            entry.kind === "state" &&
            entry.token.text === token.text &&
            entry.scope === stateMember.scope.parent,
        );
        return states.length === 1 ? location(current, states[0]!) : null;
      }
      const callInfo = (nameIndex: number) => {
        let open = nameIndex + 1;
        let genericType: string | undefined;
        if (current.tokens[open]?.text === "<") {
          const start = ++open;
          while (
            open < current.tokens.length &&
            /^(?:[A-Za-z_]\w*|::)$/.test(current.tokens[open]!.text)
          )
            open++;
          if (current.tokens[open]?.text !== ">") return undefined;
          genericType = current.tokens
            .slice(start, open)
            .map((part) => part.text)
            .join("");
          open++;
        }
        const close = current.pairs.get(open);
        if (current.tokens[open]?.text !== "(" || close === undefined) return undefined;
        let count = close === open + 1 ? 0 : 1;
        for (let i = open + 1; i < close; i++) {
          if (current.tokens[i]!.text === ",") count++;
          if (["(", "[", "{"].includes(current.tokens[i]!.text)) i = current.pairs.get(i) ?? i;
        }
        return { count, genericType };
      };
      const choose = (
        candidates: Array<{ index: SourceIndex; declaration: Declaration }>,
        count?: number,
      ) => {
        if (candidates.some((entry) => entry.declaration.kind !== "state"))
          candidates = candidates.filter((entry) => entry.declaration.kind !== "state");
        if (count !== undefined)
          candidates = candidates.filter(
            ({ declaration }) =>
              !declaration.arity ||
              (declaration.arity.min <= count && count <= declaration.arity.max),
          );
        if (cpp && candidates.some((entry) => entry.declaration.definition))
          candidates = candidates.filter((entry) => entry.declaration.definition);
        if (candidates.length === 1) return candidates[0];
        // Equal-arity overloads still need argument typing; never pick arbitrarily.
        return undefined;
      };
      const lookup = (name: string, at: number, owner?: string, count?: number) => {
        if (owner === undefined) {
          for (let local: Scope | undefined = current.scopeAt(at); local; local = local.parent) {
            const candidates = current.declarations.filter(
              (entry) =>
                entry.token.text === name &&
                (entry.scope === local ||
                  (!cpp &&
                    local!.kind === "namespace" &&
                    entry.scope.kind === "namespace" &&
                    qualifiedScope(entry.scope) === qualifiedScope(local!)) ||
                  (cpp &&
                    entry.scope.kind === "namespace" &&
                    entry.scope.name === "" &&
                    entry.scope.parent === local) ||
                  (entry.scope.kind === "enum" && entry.scope.parent === local)) &&
                (entry.kind !== "variable" ||
                  !["block", "function"].includes(local!.kind) ||
                  entry.token.start <= at),
            );
            if (candidates.length)
              return choose(
                candidates.map((declaration) => ({ index: current, declaration })),
                count,
              );
            if (!cpp && local.kind === "namespace" && (name === "p" || name === "o")) {
              const type = name === "p" ? "Params" : "Object";
              const implicit = indices.flatMap((index) =>
                index.declarations
                  .filter(
                    (entry) =>
                      entry.kind === "type" &&
                      entry.token.text === type &&
                      qualifiedScope(entry.scope) === qualifiedScope(local!),
                  )
                  .map((declaration) => ({ index, declaration })),
              );
              if (implicit.length) return choose(implicit);
            }
            if (local.kind === "namespace" && local.name) {
              const prefix = qualifiedScope(local);
              const external = indices
                .filter((index) => index !== current)
                .flatMap((index) =>
                  index.declarations
                    .filter(
                      (entry) =>
                        entry.token.text === name &&
                        qualifiedScope(
                          entry.scope.kind === "enum" ? entry.scope.parent! : entry.scope,
                        ) === prefix,
                    )
                    .map((declaration) => ({ index, declaration })),
                );
              if (external.length) return choose(external, count);
            }
          }
        }
        const candidates = indices.flatMap((index) =>
          index.declarations
            .filter((entry) => {
              if (entry.token.text !== name) return false;
              if (owner !== undefined)
                return (
                  !["block", "function"].includes(entry.scope.kind) &&
                  (entry.owner ?? qualifiedScope(entry.scope)) === owner
                );
              return (
                entry.scope === index.root ||
                (entry.scope.kind === "enum" && entry.scope.parent === index.root)
              );
            })
            .map((declaration) => ({ index, declaration })),
        );
        return choose(candidates, count);
      };
      const qualifyType = (type: string, context: Scope): string => {
        if (type.endsWith("[]")) return `${qualifyType(type.slice(0, -2), context)}[]`;
        if (cpp && type.includes("::")) return type;
        for (let parent: Scope | undefined = context; parent; parent = parent.parent) {
          const prefix = qualifiedScope(parent);
          const candidate = prefix ? `${prefix}::${type}` : type;
          if (
            indices.some((index) =>
              index.scopes.some((entry) => qualifiedScope(entry) === candidate),
            )
          )
            return candidate;
        }
        return type;
      };
      const receiverType = (end: number, depth = 0): string | undefined => {
        if (depth > 12 || end < 0) return undefined;
        const part = current.tokens[end]!;
        if (!cpp && part.text === "]") {
          const open = current.pairs.get(end);
          if (open === undefined) return undefined;
          const owner = receiverType(open - 1, depth + 1);
          if (!owner) return undefined;
          if (owner.endsWith("[]")) return owner.slice(0, -2);
          // Polyzonia omits generated vector_* wrappers from ScriptingAPI.as,
          // but their element type is encoded in the registered name.
          if (
            owner.startsWith("vector_") &&
            indices.some((index) =>
              index.declarations.some(
                (entry) => entry.kind === "type" && entry.token.text === owner.slice(7),
              ),
            )
          )
            return owner.slice(7);
          const indexer =
            lookup("opIndex", part.start, owner, 1) ?? lookup("get_opIndex", part.start, owner, 1);
          return indexer
            ? qualifyType(indexer.declaration.type, indexer.declaration.scope)
            : undefined;
        }
        if (part.text === "this") {
          for (let owner: Scope | undefined = scope; owner; owner = owner.parent)
            if (owner.kind === "class") return qualifiedScope(owner);
          return undefined;
        }
        if (part.text === ")") {
          const open = current.pairs.get(end);
          if (open === undefined) return undefined;
          let name = open - 1;
          if (current.tokens[name]?.text === ">") {
            while (name >= 0 && current.tokens[name]?.text !== "<") name--;
            name--;
          }
          return receiverType(name, depth + 1);
        }
        if (!identifier.test(part.text)) return undefined;
        const previous = current.tokens[end - 1]?.text;
        const owner =
          previous === "." || (cpp && previous === "->")
            ? receiverType(end - 2, depth + 1)
            : previous === "::"
              ? qualifiedOwner(end)
              : undefined;
        if ((previous === "." || (cpp && previous === "->")) && !owner) return undefined;
        const call = callInfo(end);
        const found = lookup(part.text, part.start, owner, call?.count);
        if (!found)
          return call?.genericType &&
            ["get", "gett", "try_get", "try_gett", "getObject", "getParams"].includes(part.text)
            ? qualifyType(call.genericType, scope)
            : undefined;
        if (found.declaration.type === "auto" && found.index === current) {
          const nameIndex = current.tokens.indexOf(found.declaration.token);
          if (current.tokens[nameIndex + 1]?.text !== "=") return undefined;
          let last = nameIndex + 2;
          while (last < current.tokens.length && current.tokens[last]!.text !== ";") last++;
          return receiverType(last - 1, depth + 1);
        }
        return found.declaration.genericType === found.declaration.type && call?.genericType
          ? qualifyType(call.genericType, scope)
          : qualifyType(found.declaration.type, found.declaration.scope);
      };
      const qualifiedOwner = (index: number) => {
        const parts: string[] = [];
        let first = index;
        for (let i = index - 2; i >= 0; i -= 2) {
          if (!identifier.test(current.tokens[i]?.text ?? "")) break;
          first = i;
          parts.unshift(current.tokens[i]!.text);
          if (current.tokens[i - 1]?.text !== "::") break;
        }
        return current.tokens[first - 1]?.text === "::"
          ? parts.join("::")
          : qualifyType(parts.join("::"), scope);
      };
      const previous = current.tokens[tokenIndex - 1]?.text;
      let owner: string | undefined;
      if (previous === "." || (cpp && previous === "->")) {
        owner = receiverType(tokenIndex - 2);
        if (!owner) return null;
      } else if (previous === "::") {
        owner = qualifiedOwner(tokenIndex);
      }
      const found = lookup(token.text, offset, owner, callInfo(tokenIndex)?.count);
      if (
        !cpp &&
        found?.index === current &&
        found.declaration.scope.kind === "enum" &&
        found.declaration.scope.name === "State"
      ) {
        // Only transition's state argument redirects enum references; ordinary enum uses retain their declaration.
        let argument = tokenIndex;
        while (current.tokens[argument - 1]?.text === "::") argument -= 2;
        if (
          current.tokens[argument - 1]?.text === "(" &&
          current.tokens[argument - 2]?.text === "transition" &&
          ![".", "::"].includes(current.tokens[argument - 3]?.text ?? "")
        ) {
          const states = current.declarations.filter(
            (entry) =>
              entry.kind === "state" &&
              entry.token.text === token.text &&
              entry.scope === found.declaration.scope.parent,
          );
          if (states.length === 1) return location(current, states[0]!);
        }
      }
      return found ? location(found.index, found.declaration) : null;
    },
  };
  const references = new Map<string, Array<{ start: number; end: number; line: number }>>();
  return {
    resolve: (path: string, offset: number): AngelScriptDefinition | null =>
      navigation.resolve(path, offset),
    /** Exact declaration offsets keep shadowed variables separate, even on one line. */
    references(path: string, offset: number) {
      const current = indices.find((entry) => entry.source.path === path);
      const target = navigation.resolve(path, offset, true);
      if (!current || target?.kind !== "variable" || target.start === undefined) return [];
      const key = JSON.stringify([path, target.path, target.start]);
      const cached = references.get(key);
      if (cached) return cached;
      const token = current.tokens.find((token) => token.start <= offset && offset < token.end);
      if (!token) return [];
      const matches = current.tokens
        .filter((candidate) => {
          if (candidate.text !== token.text) return false;
          const location = navigation.resolve(path, candidate.start, true);
          return (
            location?.kind === "variable" &&
            location.path === target.path &&
            location.start === target.start
          );
        })
        .map(({ start, end, line }) => ({ start, end, line }));
      references.set(key, matches);
      return matches;
    },
  };
}

/** Only explicit includes and namespace qualifiers may request another file. */
export function angelScriptNavigationFile(
  source: AngelScriptSource,
  offset: number,
): string | null {
  const tree = angelScriptStateTree(source.contents).find(
    (entry) =>
      (entry.start <= offset && offset < entry.end) ||
      (entry.fileStart !== undefined &&
        entry.fileStart <= offset &&
        offset < entry.fileStart + entry.file!.length),
  );
  if (tree) {
    const name = tree.file ?? (tree.name.includes("::") ? `${tree.name.split("::")[0]}.as` : null);
    return name ? relativeScriptPath(source, name) : null;
  }
  const tokens = tokenizeAngelScript(source.contents);
  if (tokens.some((token) => token.comment && token.start <= offset && offset < token.end))
    return null;
  const start = source.contents.lastIndexOf("\n", offset - 1) + 1;
  const end = source.contents.indexOf("\n", start);
  const line = source.contents.slice(start, end < 0 ? undefined : end);
  const include = /^\s*#\s*include\s+["']([^"']+)["']/.exec(line);
  let name: string | undefined;
  if (include && offset >= start + line.indexOf("#") && offset < start + include[0].length)
    name = include[1];
  else {
    const index = tokens.findIndex((token) => token.start <= offset && offset < token.end);
    if (index < 0) return null;
    let first = index;
    while (tokens[first - 1]?.text === "::") first -= 2;
    if (tokens[first + 1]?.text === "::" && identifier.test(tokens[first]?.text ?? ""))
      name = `${tokens[first]!.text}.as`;
  }
  return name ? relativeScriptPath(source, name) : null;
}

/** A bounded set of explicit script dependencies, read only after an unresolved click. */
export function angelScriptNavigationDependencies(
  source: AngelScriptSource,
  includesOnly = false,
): string[] {
  const paths = new Set<string>();
  const namespaces = new Set<string>();
  const tokens = tokenizeAngelScript(source.contents, true);
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.comment) continue;
    let name: string | undefined;
    if (token.text === "include" && tokens[i - 1]?.text === "#" && tokens[i + 1]?.string) {
      name = tokens[i + 1]!.text.slice(1, -1);
    } else if (
      !includesOnly &&
      tokens[i + 1]?.text === "::" &&
      tokens[i - 1]?.text !== "::" &&
      identifier.test(token.text)
    ) {
      if (namespaces.has(token.text)) continue;
      namespaces.add(token.text);
      name = `${token.text}.as`;
    }
    if (name) {
      const path = relativeScriptPath(source, name);
      if (path && path !== source.path) paths.add(path);
    }
  }
  return [...paths];
}
