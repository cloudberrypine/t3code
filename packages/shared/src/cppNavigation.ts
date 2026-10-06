import { parseAngelScriptApi, tokenizeAngelScript } from "./angelscript.ts";
import {
  createAngelScriptNavigation,
  indexNavigationSource,
  qualifiedScope,
  type AngelScriptSource,
} from "./angelscriptNavigation.ts";

export const isCppPath = (path: string) =>
  /\.(?:c|cc|cpp|cxx|h|hh|hpp|hxx|inl|ipp|tpp|ixx|cppm)$/i.test(path);
export interface CppSymbol {
  name: string;
  /** Generated await bindings capitalize the script name, retaining the C++ name. */
  nativeName?: string;
  owner?: string;
  arity?: number;
  typeOnly?: boolean;
  implementationOnly?: boolean;
  declarationOnly?: boolean;
  contextOwner?: string;
  namespace?: string;
  macroPaths?: readonly string[];
}
const identifier = /^[A-Za-z_]\w*$/;
const leaf = (name: string) => name.split("::").at(-1)!;

/** Describe a generated API declaration using its lexical owner, including nested types. */
export function angelScriptCppSymbol(source: AngelScriptSource, offset: number): CppSymbol | null {
  if (!/(?:^|\/)ScriptingAPI\.as$/.test(source.path)) return null;
  const index = indexNavigationSource(source);
  const token = index.tokens.find((t) => t.start <= offset && offset < t.end);
  if (!token || !identifier.test(token.text)) return null;
  const declaration = index.declarations.find((d) => d.token === token);
  // Type references in API member/parameter/return types still resolve in AngelScript.
  // Only clicking a declaration itself crosses over to its C++ implementation.
  if (!declaration) return null;
  const owner = qualifiedScope(declaration.scope).replaceAll("_", "::");
  const nativeName =
    owner &&
    declaration.kind === "function" &&
    /^[A-Z]/.test(token.text) &&
    parseAngelScriptApi(source.contents)
      .members.get(qualifiedScope(declaration.scope))
      ?.get(token.text)?.await
      ? token.text[0]!.toLowerCase() + token.text.slice(1)
      : undefined;
  return {
    ...(nativeName ? { nativeName } : {}),
    name: declaration.kind === "type" ? token.text.replaceAll("_", "::") : token.text,
    ...(owner ? { owner } : {}),
    ...(declaration.kind === "type" ? { typeOnly: true } : {}),
    ...(declaration.arity ? { arity: declaration.arity.max } : {}),
  };
}

export function cppSymbolAt(
  source: AngelScriptSource,
  offset: number,
  sources: readonly AngelScriptSource[] = [source],
): CppSymbol | null {
  const index = indexNavigationSource(source, true);
  const i = index.tokens.findIndex((t) => t.start <= offset && offset < t.end);
  const token = index.tokens[i];
  if (!token || !identifier.test(token.text)) return null;
  const declaration = index.declarations.find((d) => d.token === token);
  if (declaration?.kind === "function" || declaration?.kind === "type") {
    const owner = declaration.owner ?? qualifiedScope(declaration.scope);
    return {
      name: token.text,
      ...(owner ? { owner } : {}),
      ...(declaration.kind === "type"
        ? { typeOnly: true }
        : {
            ...(declaration.arity ? { arity: declaration.arity.max } : {}),
            implementationOnly: !declaration.definition,
            ...(declaration.definition ? { declarationOnly: true } : {}),
          }),
    };
  }
  let owner: string | undefined;
  if (index.tokens[i - 1]?.text === "::") {
    const parts: string[] = [];
    for (let n = i - 2; n >= 0; n -= 2) {
      if (!identifier.test(index.tokens[n]?.text ?? "")) break;
      parts.unshift(index.tokens[n]!.text);
      if (index.tokens[n - 1]?.text !== "::") break;
    }
    owner = parts.join("::");
  } else if ([".", "->"].includes(index.tokens[i - 1]?.text ?? "")) {
    const indices = sources.map((s) =>
      s.path === source.path ? index : indexNavigationSource(s, true),
    );
    const navigation = createAngelScriptNavigation(sources, true);
    const declarationAt = (
      end: number,
      depth = 0,
    ): (typeof index.declarations)[number] | undefined => {
      if (depth > 12) return undefined;
      const token = index.tokens[end];
      if (!token || !identifier.test(token.text)) return undefined;
      const previous = index.tokens[end - 1]?.text;
      if ([".", "->"].includes(previous ?? "")) {
        const owner = receiverType(end - 2, depth + 1);
        if (!owner) return undefined;
        const matches = indices.flatMap((entry) =>
          entry.declarations.filter((d) => {
            const scope = d.owner ?? qualifiedScope(d.scope);
            return d.token.text === token.text && (scope === owner || scope.endsWith(`::${owner}`));
          }),
        );
        return matches.length === 1 ? matches[0] : undefined;
      }
      const location = navigation.resolve(source.path, token.start);
      return indices
        .find((entry) => entry.source.path === location?.path)
        ?.declarations.find((d) => d.token.text === token.text && d.token.line === location?.line);
    };
    const receiverType = (end: number, depth = 0): string | undefined => {
      if (depth > 12) return undefined;
      const receiver = index.tokens[end];
      if (receiver?.text === "this") {
        for (let scope = index.scopeAt(offset); scope.parent; scope = scope.parent) {
          if (scope.kind === "class" || (scope.kind === "function" && scope.name))
            return qualifiedScope(scope);
        }
      }
      if (receiver?.text === "]") {
        const open = index.pairs.get(end);
        if (open === undefined) return undefined;
        return declarationAt(open - 1, depth + 1)?.elementType;
      }
      const declaration = declarationAt(end, depth + 1);
      return declaration?.type !== "auto" ? declaration?.type : undefined;
    };
    owner = receiverType(i - 2);
  }
  let arity: number | undefined;
  const close = index.pairs.get(i + 1);
  if (index.tokens[i + 1]?.text === "(" && close !== undefined) {
    arity = close === i + 2 ? 0 : 1;
    for (let n = i + 2; n < close; n++) {
      if (index.tokens[n]?.text === ",") arity++;
      if (["(", "[", "{"].includes(index.tokens[n]?.text ?? "")) n = index.pairs.get(n) ?? n;
    }
  }
  let contextOwner: string | undefined;
  if (!owner)
    for (let scope = index.scopeAt(offset); scope.parent; scope = scope.parent) {
      if (scope.kind === "class" || (scope.kind === "function" && scope.name)) {
        contextOwner = qualifiedScope(scope);
        break;
      }
    }
  let namespace: string | undefined;
  for (let scope = index.scopeAt(offset); scope.parent; scope = scope.parent) {
    if (scope.kind === "namespace" && scope.name) {
      namespace = qualifiedScope(scope);
      break;
    }
  }
  return {
    name: token.text,
    ...(!owner && namespace ? { namespace } : {}),
    ...(owner ? { owner } : {}),
    ...(contextOwner ? { contextOwner } : {}),
    ...(arity === undefined ? {} : { arity }),
  };
}

/** Prefer a body over a prototype. Equal-ranked overloads and unrelated owners stay unresolved. */
export function findCppDefinition(sources: readonly AngelScriptSource[], symbol: CppSymbol) {
  const names = [symbol.name, ...(symbol.nativeName ? [symbol.nativeName] : [])];
  const qualified = names.map((name) => [symbol.owner, name].filter(Boolean).join("::"));
  const candidates = sources
    .filter((s) => isCppPath(s.path) && s.contents.length <= 2_000_000)
    .flatMap((source) => {
      const index = indexNavigationSource(source, true);
      const macros = [...source.contents.matchAll(/^[ \t]*#[ \t]*define[ \t]+([A-Za-z_]\w*)/gm)]
        .filter(
          (m) =>
            m[1] === symbol.name &&
            !symbol.owner &&
            !symbol.typeOnly &&
            !symbol.declarationOnly &&
            (!symbol.macroPaths || symbol.macroPaths.includes(source.path)) &&
            !tokenizeAngelScript(source.contents, true).some(
              (t) => (t.comment || t.string) && t.start <= m.index && m.index < t.end,
            ),
        )
        .map((m) => ({
          path: source.path,
          line: source.contents.slice(0, m.index).split("\n").length,
          definition: true,
          owner: "",
        }));
      return [
        ...macros,
        ...index.declarations
          .filter((d) => {
            if (
              !names.some((name) => d.token.text === leaf(name)) ||
              ["block", "function", "state"].includes(d.scope.kind)
            )
              return false;
            if (symbol.typeOnly && d.kind !== "type") return false;
            if (symbol.implementationOnly && !d.definition) return false;
            if (symbol.declarationOnly && (d.kind !== "function" || d.definition)) return false;
            const owner = d.owner ?? qualifiedScope(d.scope);
            const fullName = [owner, d.token.text].filter(Boolean).join("::");
            if (
              qualified.some((name) => name.includes("::")) &&
              !qualified.some((name) => fullName === name || fullName.endsWith(`::${name}`))
            )
              return false;
            return (
              symbol.arity === undefined ||
              !d.arity ||
              (d.arity.min <= symbol.arity && symbol.arity <= d.arity.max) ||
              // Generated component methods omit the native world and entity parameters.
              (d.token.text === symbol.nativeName &&
                d.arity.min <= symbol.arity + 2 &&
                symbol.arity + 2 <= d.arity.max)
            );
          })
          .map((d) => ({
            path: source.path,
            line: d.token.line,
            definition: d.definition === true,
            owner: d.owner ?? qualifiedScope(d.scope),
          })),
      ];
    });
  const definitions = candidates.filter((d) => d.definition);
  const choices = definitions.length ? definitions : candidates;
  if (choices.length !== 1) return null;
  return { path: choices[0]!.path, line: choices[0]!.line };
}

/** Registration macros can rename a script member to an unrelated C++ wrapper. */
export function cppBindingTargets(
  sources: readonly AngelScriptSource[],
  symbol: CppSymbol,
): CppSymbol[] {
  const targets: CppSymbol[] = [];
  for (const source of sources) {
    const tokens = tokenizeAngelScript(source.contents, true).filter((t) => !t.comment);
    for (let i = 0; i < tokens.length; i++) {
      const method = tokens[i]?.text;
      if (
        !["RegisterObjectMethod", "RegisterGlobalFunction"].includes(method ?? "") ||
        tokens[i + 1]?.text !== "("
      )
        continue;
      let end = i + 2,
        depth = 1;
      const args: (typeof tokens)[] = [[]];
      for (; end < tokens.length && depth; end++) {
        const t = tokens[end]!;
        if (t.text === "(") depth++;
        if (t.text === ")") depth--;
        if (!depth) break;
        if (t.text === "," && depth === 1) args.push([]);
        else args.at(-1)!.push(t);
      }
      const object = method === "RegisterObjectMethod";
      const owner = object ? args[0]?.[0]?.text.slice(1, -1) : undefined;
      if (owner !== symbol.owner?.replaceAll("::", "_")) continue;
      const signature =
        args[object ? 1 : 0]
          ?.filter((t) => t.string)
          .map((t) => t.text.slice(1, -1))
          .join("") ?? "";
      const match = /(\w+)\s*(?:<[^>]+>)?\s*\((.*)\)/.exec(signature);
      if (!match || match[1] !== symbol.name) continue;
      const arity = match[2]?.trim() ? match[2].split(",").length : 0;
      if (symbol.arity !== undefined && arity !== symbol.arity) continue;
      const binding = args[object ? 2 : 1] ?? [];
      const macro = binding.findIndex((t) => /^(?:asFUNCTION|asMETHOD)(?:PR)?$/.test(t.text));
      if (macro < 0) continue;
      const parts: string[] = [];
      let n = macro + 2;
      while (identifier.test(binding[n]?.text ?? "") || binding[n]?.text === "::")
        parts.push(binding[n++]!.text);
      if (binding[macro]!.text.startsWith("asMETHOD")) {
        targets.push({ owner: parts.join(""), name: binding[n + 1]?.text ?? "" });
      } else {
        const path = parts.join("").split("::");
        targets.push({ name: path.pop()!, ...(path.length ? { owner: path.join("::") } : {}) });
      }
    }
  }
  return [...new Map(targets.filter((t) => t.name).map((t) => [JSON.stringify(t), t])).values()];
}

export function cppDefinitionQuery(name: string) {
  const word = leaf(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return `(?:\\b(?:class|struct|enum|define|using)\\s+(?:class\\s+)?${word}\\b|(?:^|[;{}])\\s*[\\w:<>,*& \\t]+\\b${word}\\s*(?:\\(|[;={\\[]))`;
}

export function cppIncludes(source: AngelScriptSource) {
  return [...source.contents.matchAll(/^\s*#\s*include\s*["<]([^">]+)[">]/gm)].map((m) => m[1]!);
}

/** Qualified method searches avoid spending the read budget on unrelated start()/setup() methods. */
export function cppImplementationQuery(symbol: CppSymbol) {
  const scope = symbol.owner ?? symbol.contextOwner;
  if (!scope || symbol.arity === undefined) return null;
  const owner = leaf(scope).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const name = [symbol.name, ...(symbol.nativeName ? [symbol.nativeName] : [])]
    .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  return `\\b${owner}\\s*::\\s*(?:${name})\\s*\\(`;
}
